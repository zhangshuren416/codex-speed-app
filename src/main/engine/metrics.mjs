// 由 rollout 状态推导速度指标。
//
// 口径说明（务必与 rollout.mjs 的计时口径保持一致）：
//   - 每个样本 = 一次完整模型响应的平均值：
//       tokensPerSec = 该响应输出 token / (提示就绪 → 响应结束 的秒数)
//     分母包含首 token 前的排队/预填充延迟，不含工具执行时间。
//   - “当前速度”用最近若干个样本按 token 加权合并：
//       sum(output) / sum(seconds)
//     即真正的加权平均，而不是对平均值再取平均。
//   - “纯生成速度”用 item_completed 里 Reasoning/AgentMessage 的生成耗时做分母，
//     会略高于端到端速度（少了排队与预填充时间），作为参考值展示。
//   - 会话均值累计在 state.agg 里，不受滚动样本窗口截断影响；但如果只读了文件尾部
//     （truncatedStart = true），会话均值/响应数只覆盖窗口内样本，此时不应把它当成完整会话统计。

const SAMPLE_WINDOW_MS = 60_000;
// 最近几次响应合并成“当前速度”。取 3 而不是 5：一次长响应就能占满 1–2 分钟，
// 窗口太大时数字会长时间纹丝不动，看起来像卡死。
const LIVE_SAMPLES = 3;
// samples 跨轮保留（最近 MAX_SAMPLES 条），state.turnSampleStart 标记当前轮起点；
// 这样 live/60s 窗口能跨轮工作，本轮指标仍然只统计当前轮。
// 一次响应最长可能的生成时间；超过它标记 stalled，而不是继续显示“生成中”
const MAX_GENERATION_MS = 15 * 60_000;

export function computeMetrics(state, nowMs = Date.now()) {
  const lastTs = state.lastEventTs || 0;
  const idleMs = lastTs ? Math.max(0, nowMs - lastTs) : null;
  const samples = state.samples ?? [];
  const lastResponse = state.lastResponse;

  // 正在生成：已发出请求但 token 用量还没落盘。日志里没有“进行中”的 token 计数，
  // 所以此时只能展示上一次响应测得的速度，并标注为“生成中（数值为上次测得）”。
  const generating = Boolean(state.generating);
  const waitingTool = Boolean(state.waitingTool) && !generating;
  const generatingSinceMs = generating ? state.anchorMs ?? lastTs : null;
  const generatingMs = generatingSinceMs ? Math.max(0, nowMs - generatingSinceMs) : null;
  const turnActive = Boolean(state.turn?.active);
  // 长思考期间日志里没有新行，不能只用“最后事件距今”判断活跃。
  // 超过上限不直接当空闲，而是标成 stalled：既不会让 HUD 一直显示“生成中”，
  // 也不会误显示成“等待首字”。
  const stalled =
    generating && generatingMs != null && generatingMs >= MAX_GENERATION_MS;
  const active = generating && !stalled && generatingMs != null;

  const sinceLastSampleMs = lastResponse ? Math.max(0, nowMs - lastResponse.atMs) : null;
  // 数字的“新鲜度”：样本本身产生于一次响应结束时，超过 2 分钟就只是历史参考值
  const stale = sinceLastSampleMs != null && sinceLastSampleMs > 120_000;

  // 1) 最近 N 个样本的 token 加权平均（当前速度的最佳估计）
  const tail = samples.slice(-LIVE_SAMPLES);
  const liveAgg = aggregate(tail);

  // 2) 最近 60 秒窗口
  const cutoff = nowMs - SAMPLE_WINDOW_MS;
  const windowAgg = aggregate(samples.filter((s) => s.tsMs >= cutoff));

  // 3) 本轮（samples 跨轮保留，用 turnSampleStart 切分）
  const turnAgg = aggregate(samples.slice(state.turnSampleStart ?? 0));

  // 4) 会话累计
  const agg = state.agg ?? { out: 0, reason: 0, secs: 0, genMs: 0, responses: 0 };
  const sessionAvg = agg.secs > 0 ? agg.out / agg.secs : null;
  // 注意：不提供“会话级纯生成速度”。session 的输出 token 里有大量 function_call token，
  // 而 genMs 只统计 Reasoning/AgentMessage 的耗时，两者分子分母不一致，算出来必然虚高。

  const totalOut = state.totals.output;
  const totalReason = state.totals.reasoning;
  const reasoningShare = totalOut > 0 ? totalReason / totalOut : 0;
  const turnOutput = Math.max(0, totalOut - (state.turn?.outputStart ?? 0));
  const turnReasoning = Math.max(0, totalReason - (state.turn?.reasoningStart ?? 0));
  const turnReasoningShare = turnOutput > 0 ? turnReasoning / turnOutput : 0;

  // 端到端吞吐：把工具执行、等待用户的时间也算进去，代表“用户体感的产出速度”
  let turnWallRate = null;
  let turnSeconds = null;
  if (state.turn?.startedAtMs) {
    const endMs = state.turn.endedAtMs ?? (turnActive ? nowMs : state.turn.startedAtMs);
    turnSeconds = Math.max(0, (endMs - state.turn.startedAtMs) / 1000);
    if (turnOutput > 0 && turnSeconds > 0.5) turnWallRate = turnOutput / turnSeconds;
  }
  const sessionWallRate =
    state.turnMs > 0 && state.turnOut > 0 ? state.turnOut / (state.turnMs / 1000) : null;

  const reasoningTokens = agg.reason;
  const answerTokens = Math.max(0, agg.out - agg.reason);
  const reasoningSecs = (state.items?.reasoning?.ms ?? 0) / 1000;
  const answerSecs = (state.items?.agentMessage?.ms ?? 0) / 1000;

  return {
    live: {
      active,
      stalled,
      generating,
      waitingTool,
      generatingMs,
      idleMs,
      phase: waitingTool ? "tool" : stalled ? "stalled" : generating ? "generating" : "idle",
      sinceLastSampleMs,
      stale,
      tokensPerSec: round(liveAgg.rate ?? lastResponse?.tokensPerSec ?? 0),
      recentAvg60s: round(windowAgg.rate ?? 0),
      samplesInWindow: windowAgg.count,
      // 悬浮窗迷你曲线：每个点 = 一次响应结束时的速度
      spark: samples.slice(-48).map((s) => ({ t: s.tsMs, v: s.tokensPerSec })),
      approximate: true,
      lastResponse: lastResponse
        ? {
            tokensPerSec: round(lastResponse.tokensPerSec),
            genTokensPerSec:
              lastResponse.genSeconds > 0.05
                ? round(lastResponse.outputTokens / lastResponse.genSeconds)
                : null,
            outputTokens: lastResponse.outputTokens,
            reasoningTokens: lastResponse.reasoningTokens,
            seconds: round(lastResponse.seconds, 2),
            genSeconds: round(lastResponse.genSeconds, 2),
            atMs: lastResponse.atMs,
            ageMs: Math.max(0, nowMs - lastResponse.atMs),
          }
        : null,
    },
    turn: {
      id: state.turn?.id ?? null,
      active: turnActive,
      outputTokens: turnOutput,
      reasoningTokens: turnReasoning,
      reasoningShare: round(turnReasoningShare, 3),
      wallSeconds: round(turnSeconds ?? 0, 1),
      responseSeconds: round(turnAgg.secs, 1),
      responses: turnAgg.count,
      avgTokensPerSec: round(turnAgg.rate ?? 0),
      wallTokensPerSec: round(turnWallRate ?? 0),
      avgMsPerToken: turnAgg.rate > 0 ? round(1000 / turnAgg.rate, 1) : null,
      startedAtMs: state.turn?.startedAtMs ?? null,
      endedAtMs: state.turn?.endedAtMs ?? null,
      timeToFirstTokenMs: state.turn?.timeToFirstTokenMs ?? null,
    },
    turnHistory: (state.turnHistory ?? []).slice(-20),
    session: {
      id: state.session.id,
      cwd: state.session.cwd,
      model: state.session.model,
      effort: state.effort ?? null,
      cliVersion: state.session.cliVersion,
      originator: state.session.originator,
      startedAtMs: state.session.startedAtMs,
      outputTokens: totalOut,
      reasoningTokens: totalReason,
      inputTokens: state.totals.input,
      cachedInputTokens: state.totals.cached,
      reasoningShare: round(reasoningShare, 3),
      avgTokensPerSec: round(sessionAvg ?? 0),
      wallTokensPerSec: round(sessionWallRate ?? 0),
      responseSeconds: round(agg.secs, 1),
      itemSeconds: round(agg.genMs / 1000, 1),
      responses: agg.responses,
      turns: state.turnCount,
      contextWindow: state.contextWindow,
      rateLimits: state.rateLimits,
      file: state.file,
      truncatedStart: Boolean(state.truncatedStart),
    },
    reasoning: {
      items: state.items.reasoning.count,
      chars: state.items.reasoning.chars,
      rawChars: state.items.reasoning.rawChars,
      totalMs: state.items.reasoning.ms,
      tokens: reasoningTokens,
      seconds: round(reasoningSecs, 1),
      tokensPerSec: round(reasoningSecs > 0.5 ? reasoningTokens / reasoningSecs : 0),
      last: state.items.reasoning.last ?? null,
    },
    answer: {
      items: state.items.agentMessage.count,
      chars: state.items.agentMessage.chars,
      totalMs: state.items.agentMessage.ms,
      tokens: answerTokens,
      seconds: round(answerSecs, 1),
      // 注意：answerTokens 是非推理输出 token（含工具调用的 function_call token），
      // 而 answerSecs 只统计 AgentMessage 的耗时，两者的分子分母口径并不一致，
      // 所以这里不给出 tok/s，避免出现虚高的“正文速度”。
    },
    generatedAt: nowMs,
  };
}

/** 把若干样本按 token 加权合并成真实的平均速度。 */
function aggregate(samples) {
  let out = 0;
  let reason = 0;
  let secs = 0;
  for (const s of samples) {
    if (!s || !(s.secs > 0)) continue;
    out += s.out;
    reason += s.reason ?? 0;
    secs += s.secs;
  }
  return {
    count: samples.length,
    out,
    reason,
    secs: round(secs, 3),
    rate: secs > 0.05 ? out / secs : null,
  };
}

function round(n, digits = 1) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export { SAMPLE_WINDOW_MS, MAX_GENERATION_MS };