// 增量读取 Codex 的 rollout JSONL，并抽出计算速度所需的样本。
//
// 数据来源（均为 Codex 自身写入的会话日志，只读）：
//   session_meta             会话元信息（id / cwd / model / 版本）
//   turn_context             当前模型与 reasoning effort
//   event_msg/task_started   一轮开始（started_at 为 epoch 秒）
//   event_msg/task_complete  一轮结束（duration_ms / time_to_first_token_ms，权威耗时）
//   token_usage_record       单次响应级别的用量（usage + thread_token_usage 累计）
//   event_msg/token_count    累计与“本次响应”的 token 用量（token_usage_record 的兜底）
//   event_msg/item_completed 已完成条目（Reasoning / AgentMessage 的字符与生成耗时）
//
// 计时口径（重要）：
//   Codex 只在一次模型响应**结束后**才落盘 token 用量，流式增量事件不会写文件。
//   因此“速度”只能是“每次响应的平均速度”，无法给出逐 token 的瞬时值。
//   分母必须是“提示就绪 → 响应结束”的时间窗：
//     锚点 = max(本轮开始, 用户消息, 上一次响应结束, 最近一次工具输出)
//   这样既包含首 token 前的排队/预填充延迟，又不会把工具执行时间算进生成时间。
//   早期版本用“上一条任意事件的时间戳”当锚点，导致分母趋近 0、算出 10^6 tok/s 的荒谬值。

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_SAMPLES = 600;
// 凭经验，单次响应超过 400 tok/s 基本意味着分母塌缩（计时锚点错误），
// 宁可不产出样本，也不把 10^6 量级读数写进曲线。
const MAX_PLAUSIBLE_TOKENS_PER_SEC = 400;

// 这些条目是模型生成的内容，其耗时可用于估算纯生成速度
const GEN_ITEM_TYPES = new Set(["Reasoning", "AgentMessage"]);

// 模型在等结果的工具类条目
const TOOL_ITEM_TYPES = new Set([
  "CommandExecution",
  "FunctionCall",
  "CustomToolCall",
  "McpToolCall",
  "FileChange",
  "WebSearch",
  "LocalShellCall",
]);

export function createState() {
  return {
    file: null,
    session: {
      id: null,
      cwd: null,
      model: null,
      cliVersion: null,
      originator: null,
      startedAtMs: null,
    },
    contextWindow: null,
    rateLimits: null,
    totals: { output: 0, reasoning: 0, input: 0, cached: 0 },
    turn: {
      id: null,
      active: false,
      startedAtMs: null,
      endedAtMs: null,
      outputStart: 0,
      reasoningStart: 0,
      lastResponseEndMs: null,
    },
    // 逐响应的速度样本（滚动保留最近 MAX_SAMPLES 条）
    samples: [],
    // 当前轮从 samples 的哪个下标开始（samples 跨轮保留，用于 live/60s 窗口）
    turnSampleStart: 0,
    // 已完成轮次的摘要（按结束时间顺序，供侧面板显示最近几轮）
    turnHistory: [],
    // 会话级累计（逐样本累加，不受 samples 截断影响）
    agg: { out: 0, reason: 0, secs: 0, genMs: 0, responses: 0 },
    // 会话内已完成轮次的累计墙钟时间（毫秒）与其对应的输出 token，用于会话体感吞吐
    turnMs: 0,
    turnOut: 0,
    lastResponse: null,
    previousResponse: null,
    // 当前响应“提示已就绪”的时刻；下一次样本的分母从这里开始
    anchorMs: null,
    // 已发出请求、尚未拿到 token 用量
    generating: false,
    // 模型已发出工具调用、正在等工具结果
    waitingTool: false,
    // 上一次样本的累计输出 token，用于剔除同一响应的重复上报
    lastCumOut: 0,
    // 自上次样本以来，已完成生成的条目累计耗时（毫秒），仅用于估算纯生成速度
    pendingGenMs: 0,
    items: {
      reasoning: { count: 0, chars: 0, ms: 0, rawChars: 0, last: null },
      agentMessage: { count: 0, chars: 0, ms: 0 },
    },
    lastEventTs: 0,
    turnCount: 0,
    parsedBytes: 0,
    truncatedStart: false,
  };
}

export class RolloutReader {
  /**
   * @param {string} file rollout 文件路径
   * @param {{ fromStartBytes?: number }} [opts] 最多回读的字节数（长会话只读尾部）
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.maxBytes = opts.fromStartBytes ?? 12 * 1024 * 1024;
    this.offset = 0;
    this.tail = "";
    this.decoder = new StringDecoder("utf8");
    this.state = createState();
    this.state.file = file;
  }

  /** 首次载入：从文件尾部（或开头）读一次。 */
  prime() {
    this.decoder = new StringDecoder("utf8");
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return this.state;
    }
    const start = Math.max(0, size - this.maxBytes);
    this.state.truncatedStart = start > 0;
    // session_meta 永远在文件第一行。只读尾部时如果不补读头部，长会话会
    // 丢掉 session.id / cwd / startedAt，list_recent_sessions 甚至会把整个
    // 会话当成“坏文件”跳过。
    if (start > 0) this._readHead();
    const fd = fs.openSync(this.file, "r");
    try {
      const len = Math.max(0, size - start);
      const buf = Buffer.allocUnsafe(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      this.offset = start + off;
      const text = this.decoder.write(buf.subarray(0, off));
      // 若从中间截断，丢掉第一行残片
      const firstBreak = start > 0 ? text.indexOf("\n") : -1;
      const usable = firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
      this._consume(usable);
    } finally {
      fs.closeSync(fd);
    }
    return this.state;
  }

  /**
   * 从文件头部单独补读 session_meta。长会话只回读尾部时，第一行通常不在
   * 读取窗口里；不补这一行会丢失 session.id / cwd / startedAt。
   */
  _readHead() {
    let fd = null;
    try {
      fd = fs.openSync(this.file, "r");
      const buf = Buffer.allocUnsafe(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n <= 0) return;
      const first = buf
        .subarray(0, n)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .split("\n", 1)[0]
        .trim();
      if (!first) return;
      const entry = JSON.parse(first);
      // 只认 session_meta；其他事件可能很旧，重放会污染当前状态机
      if (entry?.type === "session_meta") this._apply(entry);
    } catch {
      /* 头部不可读/格式异常时保持尾部行为 */
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 读取自上次以来的新增内容；返回是否有变化。 */
  poll() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) {
      // 文件被截断或重写：重新来过
      Object.assign(this.state, createState());
      this.state.file = this.file;
      this.offset = 0;
      this.tail = "";
      this.decoder = new StringDecoder("utf8");
      this.prime();
      return true;
    }
    if (size === this.offset) return false;

    const fd = fs.openSync(this.file, "r");
    try {
      const len = size - this.offset;
      const buf = Buffer.allocUnsafe(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, this.offset + off);
        if (n <= 0) break;
        off += n;
      }
      this.offset += off;
      if (off === 0) return false;
      this._consume(this.decoder.write(buf.subarray(0, off)));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  _consume(text) {
    const data = this.tail + text;
    const lines = data.split("\n");
    // 末尾没有换行时，最后一段可能是半行，留到下次补齐；以换行结尾时
    // split 的最后一项是空串，前面每一行都是完整的——不能把最后一条真实事件
    // 也留在 tail 里，否则会话结束时最后一条 task_complete 可能永远读不到。
    this.tail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this._apply(entry);
    }
  }

  _apply(entry) {
    const tsMs = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const st = this.state;
    if (!Number.isFinite(tsMs)) return;
    st.lastEventTs = Math.max(st.lastEventTs, tsMs);

    switch (entry.type) {
      case "session_meta": {
        const p = entry.payload ?? {};
        st.session.id = p.session_id ?? p.id ?? st.session.id;
        st.session.cwd = p.cwd ?? st.session.cwd;
        st.session.cliVersion = p.cli_version ?? st.session.cliVersion;
        st.session.originator = p.originator ?? st.session.originator;
        st.session.model = p.model ?? st.session.model;
        if (!st.session.startedAtMs) {
          st.session.startedAtMs = p.timestamp ? Date.parse(p.timestamp) : tsMs;
        }
        return;
      }
      case "turn_context": {
        const p = entry.payload ?? {};
        st.session.model = p.model ?? st.session.model;
        if (p.effort) st.effort = p.effort;
        if (p.model_reasoning_effort) st.effort = p.model_reasoning_effort;
        return;
      }
      case "event_msg": {
        this._applyEvent(entry.payload ?? {}, tsMs);
        return;
      }
      case "token_usage_record": {
        this._applyUsageRecord(entry.payload ?? {}, tsMs);
        return;
      }
      case "response_item": {
        this._applyResponseItem(entry.payload ?? {}, tsMs);
        return;
      }
      default:
        return;
    }
  }

  _applyEvent(p, tsMs) {
    const st = this.state;
    switch (p.type) {
      case "task_started": {
        st.turnCount += 1;
        st.turn = {
          id: p.turn_id ?? p.root_turn_id ?? st.turn.id,
          active: true,
          startedAtMs: p.started_at ? p.started_at * 1000 : tsMs,
          endedAtMs: null,
          outputStart: st.totals.output,
          reasoningStart: st.totals.reasoning,
          lastResponseEndMs: null,
        };
        st.turnSampleStart = st.samples.length;
        // 不在这里清空 samples/lastResponse：新轮次第一段生成期间还没有新样本，
        // live 应展示上一次测得的速度，而不是掉成 0。本轮指标用 turnSampleStart 切分。
        st.previousResponse = null;
        st.anchorMs = st.turn.startedAtMs;
        st.generating = true;
        st.waitingTool = false;
        st.lastCumOut = st.totals.output;
        st.pendingGenMs = 0;
        if (p.model_context_window) st.contextWindow = p.model_context_window;
        return;
      }
      case "task_complete": {
        const startedAtMs = st.turn.startedAtMs;
        const endedAtMs = p.completed_at ? p.completed_at * 1000 : tsMs;
        st.turn.active = false;
        st.turn.endedAtMs = endedAtMs;
        st.turn.durationMs = p.duration_ms ?? (startedAtMs ? endedAtMs - startedAtMs : null);
        st.turn.timeToFirstTokenMs = p.time_to_first_token_ms ?? null;
        const outDelta = Math.max(0, st.totals.output - (st.turn.outputStart ?? 0));
        if (st.turn.durationMs > 0 && st.turn.startedAtMs) {
          st.turnMs += st.turn.durationMs;
          st.turnOut += outDelta;
        }
        // 记录本轮摘要，供侧面板显示“最近几轮”。真实日志里 token_usage_record
        // 先于 task_complete，因此样本和累计都已经就绪。
        const turnSamples = st.samples.slice(st.turnSampleStart ?? 0);
        const sampleOut = turnSamples.reduce((sum, s) => sum + (Number(s.out) || 0), 0);
        const sampleSecs = turnSamples.reduce((sum, s) => sum + (Number(s.secs) || 0), 0);
        const avgRate = sampleSecs > 0 ? sampleOut / sampleSecs : null;
        const wallSecs = st.turn.durationMs > 0 ? st.turn.durationMs / 1000 : null;
        const wallRate = wallSecs && outDelta > 0 ? outDelta / wallSecs : null;
        const reasonDelta = Math.max(
          0,
          st.totals.reasoning - (st.turn.reasoningStart ?? 0)
        );
        const previous = st.turnHistory[st.turnHistory.length - 1];
        if (!previous || previous.endedAtMs !== endedAtMs || previous.id !== st.turn.id) {
          st.turnHistory.push({
            id: st.turn.id ?? null,
            endedAtMs,
            outputTokens: outDelta,
            reasoningTokens: reasonDelta,
            responses: turnSamples.length,
            avgTokensPerSec: avgRate != null ? round1(avgRate) : null,
            wallTokensPerSec: wallRate != null ? round1(wallRate) : null,
            wallSeconds: wallSecs != null ? round3(wallSecs) : null,
            timeToFirstTokenMs: st.turn.timeToFirstTokenMs ?? null,
            avgMsPerToken: avgRate != null ? round1(1000 / avgRate) : null,
          });
          if (st.turnHistory.length > 50) {
            st.turnHistory.splice(0, st.turnHistory.length - 50);
          }
        }
        st.generating = false;
        st.waitingTool = false;
        // completed_at 是整秒精度，可能比最后一条样本时间还早；不要因此把锚点
        // 往回调，否则紧跟着的迟到用量记录可能被算出异常高的速度。
        st.anchorMs = Math.max(endedAtMs, st.lastResponse?.atMs ?? 0);
        return;
      }
      case "turn_aborted": {
        st.turn.active = false;
        st.turn.endedAtMs = tsMs;
        st.generating = false;
        st.waitingTool = false;
        st.pendingGenMs = 0;
        st.anchorMs = tsMs;
        return;
      }
      case "token_count": {
        const total = p.info?.total_token_usage ?? {};
        if (typeof total.output_tokens === "number") {
          st.totals.output = total.output_tokens;
          st.totals.reasoning = total.reasoning_output_tokens ?? st.totals.reasoning;
          st.totals.input = total.input_tokens ?? st.totals.input;
          st.totals.cached = total.cached_input_tokens ?? st.totals.cached;
        }
        // token_usage_record 已覆盖的情况在这里会被去重
        this._recordSample(
          {
            cumOut: (p.info?.total_token_usage ?? {}).output_tokens,
            out: (p.info?.last_token_usage ?? {}).output_tokens,
            reason: (p.info?.last_token_usage ?? {}).reasoning_output_tokens,
            responseId: null,
            input: (p.info?.last_token_usage ?? {}).input_tokens,
            cached: (p.info?.last_token_usage ?? {}).cached_input_tokens,
          },
          tsMs
        );
        if (p.info?.model_context_window) st.contextWindow = p.info.model_context_window;
        if (p.rate_limits) st.rateLimits = p.rate_limits;
        return;
      }
      case "item_completed": {
        this._applyItem(p.item ?? {}, p, tsMs);
        return;
      }
      case "agent_reasoning":
      case "agent_reasoning_raw_content": {
        const text = typeof p.text === "string" ? p.text : "";
        if (text) {
          st.items.reasoning.count += 1;
          st.items.reasoning.rawChars += text.length;
        }
        return;
      }
      case "agent_message": {
        const text = typeof p.message === "string" ? p.message : "";
        if (text) {
          st.items.agentMessage.count += 1;
          st.items.agentMessage.chars += text.length;
        }
        return;
      }
      default:
        return;
    }
  }

  _applyUsageRecord(p, tsMs) {
    const st = this.state;
    const usage = p.usage ?? p.last_token_usage ?? null;
    if (!usage) return;
    const cumOut = (p.thread_token_usage ?? {}).output_tokens;
    if (typeof usage.output_tokens !== "number") return;
    // 会话累计口径（token_usage_record 的 thread_token_usage 与 token_count 的
    // total_token_usage 数值一致，可共用去重逻辑）
    if (typeof cumOut === "number") {
      st.totals.output = cumOut;
      const cumReason = (p.thread_token_usage ?? {}).reasoning_output_tokens;
      if (typeof cumReason === "number") st.totals.reasoning = cumReason;
      const cumInput = (p.thread_token_usage ?? {}).input_tokens;
      if (typeof cumInput === "number") st.totals.input = cumInput;
      const cumCached = (p.thread_token_usage ?? {}).cached_input_tokens;
      if (typeof cumCached === "number") st.totals.cached = cumCached;
    }
    this._recordSample(
      {
        cumOut,
        out: usage.output_tokens,
        reason: usage.reasoning_output_tokens ?? 0,
        responseId: p.response_id ?? null,
        input: usage.input_tokens,
        cached: usage.cached_input_tokens,
      },
      tsMs
    );
  }

  /**
   * 记录一次“响应完成”样本。
   * 分母 = 锚点 → 本次响应结束的时间；锚点在用户消息 / 工具输出 / 上一次响应结束时前移。
   */
  _recordSample(raw, tsMs) {
    const st = this.state;
    const out = typeof raw.out === "number" ? raw.out : null;
    if (!out || out <= 0) {
      // 没有输出 token 的用量事件不是“提示就绪”信号。生成过程中周期性写入的
      // 零用量事件如果推进锚点，会把下一次响应的分母压小、速度算高。
      return;
    }

    const cumOut =
      typeof raw.cumOut === "number" ? raw.cumOut : st.lastCumOut + out;
    // 同一响应的重复上报（token_usage_record 先写、token_count 后写）只算一次
    if (cumOut <= st.lastCumOut) return;

    const anchor = st.anchorMs ?? st.turn.startedAtMs ?? tsMs;
    const wallSecs = Math.max(0, (tsMs - anchor) / 1000);
    const genSecs = st.pendingGenMs / 1000;
    // 分母取“墙钟区间”和“已完成条目的生成耗时”的较大者：
    //   - 墙钟区间包含首 token 前的排队/预填充延迟（用户真实体感）；
    //   - 但工具/子任务的 item_completed 可能落在本次响应之内，把锚点推晚，
    //     导致墙钟区间趋近 0。用生成耗时兜底，避免出现 10^6 tok/s 这类荒谬值。
    const secs = Math.max(wallSecs, genSecs);
    // 两者都过小说明日志缺少锚点信息，宁可不给速度也不要给荒谬值
    if (secs < 0.05) {
      st.anchorMs = tsMs;
      st.lastCumOut = cumOut;
      st.pendingGenMs = 0;
      return;
    }
    // 分母塌缩的最后一道保险：真实响应极少超过 400 tok/s；超过就丢弃样本，
    // 但仍推进累计与锚点，避免同一条记录被反复重试。
    if (out / secs > MAX_PLAUSIBLE_TOKENS_PER_SEC) {
      st.anchorMs = tsMs;
      st.lastCumOut = cumOut;
      st.pendingGenMs = 0;
      return;
    }

    const reason = typeof raw.reason === "number" ? raw.reason : 0;
    const genMs = st.pendingGenMs;
    const sample = {
      tsMs,
      out,
      reason,
      secs: round3(secs),
      wallSecs: round3(wallSecs),
      genMs,
      genSecs: round3(genSecs),
      tokensPerSec: round1(out / secs),
      wallTokensPerSec: round1(wallSecs > 0.05 ? out / wallSecs : null),
      genTokensPerSec: round1(genSecs > 0.05 ? out / genSecs : null),
      reasonPerSec: genMs > 100 ? round1(Math.min(reason, out) / genSecs) : null,
      cumOut,
      responseId: raw.responseId ?? null,
      turnId: st.turn?.id ?? null,
      input: raw.input ?? null,
      cached: raw.cached ?? null,
    };

    st.samples.push(sample);
    if (st.samples.length > MAX_SAMPLES) {
      const remove = st.samples.length - MAX_SAMPLES;
      st.samples.splice(0, remove);
      st.turnSampleStart = Math.max(0, (st.turnSampleStart ?? 0) - remove);
    }

    st.agg.out += out;
    st.agg.reason += reason;
    st.agg.secs += secs;
    st.agg.genMs += genMs;
    st.agg.responses += 1;

    st.previousResponse = st.lastResponse;
    st.lastResponse = {
      outputTokens: out,
      reasoningTokens: reason,
      inputTokens: raw.input ?? null,
      cachedInputTokens: raw.cached ?? null,
      seconds: sample.secs,
      genSeconds: sample.genSecs,
      tokensPerSec: sample.tokensPerSec,
      reasonPerSec: sample.reasonPerSec,
      atMs: tsMs,
      responseId: sample.responseId,
    };

    st.lastCumOut = cumOut;
    st.anchorMs = tsMs;
    st.pendingGenMs = 0;
    st.generating = false;
    st.waitingTool = false;
  }

  _applyItem(item, event, tsMs) {
    const st = this.state;
    const type = item.type;
    const startedAt = event.started_at_ms ?? 0;
    const completedAt = event.completed_at_ms ?? 0;
    const durMs = startedAt && completedAt ? Math.max(0, completedAt - startedAt) : 0;
    const endedAtMs = completedAt || tsMs;

    if (type === "Reasoning") {
      const chars = collectText(item.raw_content).length;
      const summaryChars = collectText(item.summary_text).length;
      st.items.reasoning.count += 1;
      st.items.reasoning.rawChars += chars;
      st.items.reasoning.chars += chars || summaryChars;
      st.items.reasoning.ms += durMs;
      st.items.reasoning.last = { chars, summaryChars, durMs, atMs: tsMs };
    } else if (type === "AgentMessage") {
      const chars = collectAgentText(item.content).length;
      st.items.agentMessage.count += 1;
      st.items.agentMessage.chars += chars;
      st.items.agentMessage.ms += durMs;
    }

    if (GEN_ITEM_TYPES.has(type)) {
      st.pendingGenMs += durMs;
      st.generating = true;
      st.waitingTool = false;
      // 生成条目结束 ≠ 响应结束（后面还会有工具调用/正文），不移动锚点
      st.anchorMs = st.anchorMs ?? endedAtMs;
      return;
    }

    // 用户消息：本轮真正的起点（task_started 早于它几毫秒）
    // 工具条目：属于“本次响应发起之后”的动作，不能用来推进锚点，
    //   否则会把同一次响应的分母压缩到接近 0。真正的锚点由 function_call_output
    //   （工具结果回到模型手里）来推进。
    if (type === "UserMessage") {
      st.anchorMs = Math.max(st.anchorMs ?? 0, endedAtMs);
      st.generating = true;
      st.waitingTool = false;
      st.pendingGenMs = 0;
      return;
    }

    if (TOOL_ITEM_TYPES.has(type)) {
      st.waitingTool = true;
      st.generating = false;
    }
  }

  _applyResponseItem(p, tsMs) {
    const st = this.state;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      // 模型已经出完这次响应的 token，正在等工具执行
      st.waitingTool = true;
      st.generating = false;
      return;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      // 工具结果回来，模型马上开始下一次生成。
      // Codex 桌面版用 custom_tool_call(_output) 表示 shell/freeform 工具，
      // 只处理 function_call 会把工具执行时间算进下一次响应的分母。
      st.anchorMs = Math.max(st.anchorMs ?? 0, tsMs);
      st.generating = true;
      st.waitingTool = false;
      st.pendingGenMs = 0;
      return;
    }
    // 没有 item_completed 的旧会话：用 response_item 兜底统计字符
    if (p.type === "reasoning") {
      const chars = collectText(p.content ?? []).length;
      if (chars > 0 && !st.items.reasoning.count) st.items.reasoning.rawChars += chars;
    }
  }
}

function collectText(parts) {
  if (!parts) return "";
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const part of parts) {
    if (typeof part === "string") out += part;
    else if (part && typeof part.text === "string") out += part.text;
  }
  return out;
}

function collectAgentText(parts) {
  if (!Array.isArray(parts)) return collectText(parts);
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") out += part;
    else if (typeof part.text === "string") out += part.text;
    else if (typeof part.content === "string") out += part.content;
    else if (Array.isArray(part.content)) out += collectText(part.content);
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}