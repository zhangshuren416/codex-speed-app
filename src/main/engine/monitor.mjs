// 会话监控器（独立应用版）：
//   - 跟随最近被写入的 rollout 文件，或跟随用户手动钉住的会话；
//   - 多会话：仪表盘列出最近活跃会话，HUD 只显示跟随/钉住的那一个；
//   - 不再有插件注入的 threadId，也不再读写 hook 产生的 active-session。

import fs from "node:fs";
import { RolloutReader } from "./rollout.mjs";
import { computeMetrics } from "./metrics.mjs";
import {
  latestRollout,
  listRolloutFiles,
  findRolloutBySessionId,
} from "./paths.mjs";

// 超过这个时间没有写入的会话不再算“活跃”（仍可在最近会话列表里看到）
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export class Monitor {
  constructor({ codexHome, pinnedFile = null } = {}) {
    this.codexHome = codexHome;
    this.pinnedFile = null;
    this.file = null;
    this.readers = new Map();
    /** 仪表盘会话列表的按文件缓存：mtime/size 没变就不重复解析 4MB 日志 */
    this.summaryCache = new Map();
    this.lastSwitchCheck = 0;
    if (pinnedFile) {
      try {
        this.setPinned(pinnedFile);
      } catch {
        this.pinnedFile = null;
      }
    }
  }

  /** 切换数据目录（用户在设置里改了 Codex 目录）。 */
  setCodexHome(home) {
    if (!home || home === this.codexHome) return;
    this.codexHome = home;
    this.readers.clear();
    this.summaryCache.clear();
    this.file = null;
    this.lastSwitchCheck = 0;
    if (this.pinnedFile && !fs.existsSync(this.pinnedFile)) this.pinnedFile = null;
  }

  /** 钉住某个会话（文件路径、文件名片段或 session id）；传 null 恢复自动跟随。 */
  setPinned(fileOrId = null) {
    if (!fileOrId) {
      this.pinnedFile = null;
      this.lastSwitchCheck = 0;
      return this.describe();
    }
    let target = String(fileOrId).trim();
    if (!target) return this.setPinned(null);
    if (!fs.existsSync(target)) {
      const hit = findRolloutBySessionId(this.codexHome, target, 500);
      if (!hit) throw new Error(`找不到匹配的会话：${target}`);
      target = hit.path;
    }
    this.pinnedFile = target;
    this._open(target);
    return this.describe();
  }

  pinned() {
    return this.pinnedFile;
  }

  /** 一轮采样：切文件（如需）→ 读增量 → 生成快照。 */
  tick() {
    // 跟随的文件被删除/归档：立即重新选，不要等到下一次切换窗口
    if (this.file && !fs.existsSync(this.file)) {
      this.file = null;
      this.lastSwitchCheck = 0;
    }
    this._selectFile();
    if (this.file) {
      const reader = this._readerFor(this.file);
      try {
        reader.poll();
      } catch {
        /* 忽略瞬时 IO 错误 */
      }
    }
    return this.describe();
  }

  _selectFile() {
    const now = Date.now();
    if (now - this.lastSwitchCheck < 1500) return;
    this.lastSwitchCheck = now;

    if (this.pinnedFile) {
      if (fs.existsSync(this.pinnedFile)) {
        if (this.file !== this.pinnedFile) this._open(this.pinnedFile);
        return;
      }
      // 被钉住的文件被删除/归档：自动解除钉住，回到跟随
      this.pinnedFile = null;
    }

    const latest = latestRollout(this.codexHome);
    if (latest && latest.path !== this.file) this._open(latest.path);
  }

  _readerFor(file) {
    let entry = this.readers.get(file);
    if (!entry) {
      const reader = new RolloutReader(file);
      try {
        reader.prime();
      } catch {
        /* 读取失败时保留空状态 */
      }
      entry = { reader, usedAt: Date.now() };
      this.readers.set(file, entry);
    }
    entry.usedAt = Date.now();
    this._trimReaders();
    return entry.reader;
  }

  _trimReaders(max = 8) {
    if (this.readers.size <= max) return;
    const removable = [...this.readers.entries()]
      .filter(([file]) => file !== this.file)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.readers.size > max && removable.length) {
      const [file] = removable.shift();
      this.readers.delete(file);
    }
  }

  _open(file) {
    this.file = file;
    this._readerFor(file);
  }

  /** 当前跟随会话的完整指标快照，直接推给渲染进程。 */
  describe() {
    if (!this.file || !fs.existsSync(this.file)) {
      return {
        ok: false,
        reason: "no-session",
        hint: "还没有找到 Codex 会话日志。先在 Codex 里发一条消息。",
        pinned: Boolean(this.pinnedFile),
        generatedAt: Date.now(),
      };
    }
    const reader = this._readerFor(this.file);
    let metrics;
    try {
      metrics = computeMetrics(reader.state);
    } catch (err) {
      return {
        ok: false,
        reason: "read-error",
        hint: `读取会话日志失败：${err.message}`,
        pinned: Boolean(this.pinnedFile),
        generatedAt: Date.now(),
      };
    }
    return {
      ok: true,
      ...metrics,
      pinned: Boolean(this.pinnedFile),
      followedFile: this.file,
    };
  }

  /** 最近若干个会话及其平均速度（供仪表盘列表）。 */
  listSessions(limit = 10) {
    const files = listRolloutFiles(this.codexHome, limit * 3);
    const out = [];
    const now = Date.now();
    for (const f of files) {
      if (out.length >= limit) break;
      let st;
      try {
        st = fs.statSync(f.path);
      } catch {
        continue;
      }
      let cached = this.summaryCache.get(f.path);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        const summary = this._summarize(f);
        if (!summary) {
          this.summaryCache.delete(f.path);
          continue;
        }
        cached = { ...summary, mtimeMs: st.mtimeMs, size: st.size };
        this.summaryCache.set(f.path, cached);
      }
      out.push({ ...cached, active: now - st.mtimeMs < ACTIVE_WINDOW_MS });
    }
    // 缓存只保留最近用到的文件，避免长期运行时无限增长
    while (this.summaryCache.size > 64) {
      const oldest = this.summaryCache.keys().next().value;
      this.summaryCache.delete(oldest);
    }
    return out;
  }

  /**
   * 生成单个会话的摘要。正在被跟随的文件已经有 reader（增量 poll 很便宜），
   * 不要为它重新读 4MB；其它文件只在 mtime/size 变化时才解析一次。
   */
  _summarize(f) {
    try {
      const existing = this.readers.get(f.path);
      let reader;
      if (existing) {
        existing.reader.poll();
        reader = existing.reader;
      } else {
        reader = new RolloutReader(f.path, { fromStartBytes: 4 * 1024 * 1024 });
        reader.prime();
      }
      const m = computeMetrics(reader.state);
      const fallbackId = f.name.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
      if (!m.session.id && !m.session.responses && !m.session.outputTokens) return null;
      return {
        file: f.path,
        name: f.name,
        sessionId: m.session.id ?? fallbackId,
        cwd: m.session.cwd,
        model: m.session.model,
        startedAtMs: m.session.startedAtMs,
        outputTokens: m.session.outputTokens,
        reasoningTokens: m.session.reasoningTokens,
        responses: m.session.responses,
        avgTokensPerSec: m.session.avgTokensPerSec,
        turns: m.session.turns,
      };
    } catch {
      return null;
    }
  }

  /** 最近仍在写入的会话，按 mtime 从新到旧。 */
  listActive(withinMs = ACTIVE_WINDOW_MS, limit = 6) {
    const files = listRolloutFiles(this.codexHome, 60);
    const cutoff = Date.now() - withinMs;
    const active = [];
    for (const f of files) {
      if (active.length >= limit) break;
      let st;
      try {
        st = fs.statSync(f.path);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      let m = null;
      try {
        const reader = this._readerFor(f.path);
        reader.poll();
        m = computeMetrics(reader.state);
      } catch {
        /* 单个文件坏掉不影响列表 */
      }
      active.push({
        file: f.path,
        name: f.name,
        sessionId: m?.session?.id ?? f.name.replace(/^rollout-/, "").replace(/\.jsonl$/, ""),
        cwd: m?.session?.cwd ?? null,
        model: m?.session?.model ?? null,
        mtimeMs: st.mtimeMs,
        outputTokens: m?.session?.outputTokens ?? 0,
        avgTokensPerSec: m?.session?.avgTokensPerSec ?? 0,
        phase: m?.live?.phase ?? "idle",
        active: true,
        pinned: this.pinnedFile === f.path,
        followed: this.file === f.path,
      });
    }
    return active;
  }
}