// 路径解析：定位 Codex 主目录与会话日志目录。
// 独立应用不依赖 Codex 插件，允许用户在设置里覆盖数据目录（例如指向 WSL 里的 ~/.codex）。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** 解析 Codex 主目录：设置 > CODEX_HOME > ~/.codex。 */
export function resolveCodexHome(override = null) {
  const fromSetting = typeof override === "string" ? override.trim() : "";
  if (fromSetting) return expandHome(fromSetting);
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".codex");
}

function expandHome(value) {
  const text = String(value).trim().replace(/^"|"$/g, "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return path.resolve(text);
}

export function sessionsDir(home) {
  return path.join(home, "sessions");
}

export function archivedSessionsDir(home) {
  return path.join(home, "archived_sessions");
}

/**
 * 列出当前存在的 rollout 文件，按文件名（内含本地时间戳）从新到旧。
 * 文件名形如 rollout-2026-11-09T19-35-50-<uuid>.jsonl，可直接按字典序排序。
 */
export function listRolloutFiles(home, limit = 40) {
  const roots = [sessionsDir(home), archivedSessionsDir(home)];
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, out, 0);
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out.slice(0, limit);
}

function walk(dir, out, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      out.push({ name: entry.name, path: full });
    }
  }
}

/**
 * 按 Codex 的会话 / 线程 id 找对应的 rollout 文件。
 * 独立应用没有插件注入的 threadId，这里用于“按 id 钉住会话”和用户在仪表盘里选择。
 */
export function findRolloutBySessionId(home, sessionId, limit = 200) {
  const needle = typeof sessionId === "string" ? sessionId.trim().toLowerCase() : "";
  if (!needle) return null;
  const files = listRolloutFiles(home, limit);

  const suffix = `-${needle}.jsonl`;
  const exact = files.find((file) => file.name.toLowerCase().endsWith(suffix));
  if (exact) return exact;

  if (needle.length >= 8) {
    const loose = files.find((file) => file.name.toLowerCase().includes(needle));
    if (loose) return loose;
  }

  for (const file of files.slice(0, 60)) {
    const id = readSessionIdFromHead(file.path);
    if (id && id.toLowerCase() === needle) return file;
  }
  return null;
}

function readSessionIdFromHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const first = buf
      .subarray(0, n)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split("\n", 1)[0]
      .trim();
    if (!first) return null;
    const entry = JSON.parse(first);
    if (entry?.type !== "session_meta") return null;
    const payload = entry.payload ?? {};
    const id = payload.session_id ?? payload.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
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

/** 取最近被修改的 rollout（即“当前正在使用的会话”）。 */
export function latestRollout(home, maxProbe = 8) {
  const files = listRolloutFiles(home, maxProbe);
  let best = null;
  for (const file of files) {
    try {
      const st = fs.statSync(file.path);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { ...file, mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch {
      /* 文件可能正被删除 */
    }
  }
  return best;
}