// 测试辅助：在临时目录里伪造 ~/.codex/sessions 结构。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-app-"));
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  return home;
}

export function writeRollout(home, { name, lines }) {
  const file = path.join(home, "sessions", name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

export function entry(ms, type, payload) {
  return JSON.stringify({
    timestamp: new Date(ms).toISOString(),
    type,
    payload,
  });
}

/** 构造一条完整响应：task_started → token_usage_record → task_complete。 */
export function responseLines({
  id = "sess-1",
  model = "gpt-5-codex",
  start = Date.parse("2026-11-01T00:00:01Z"),
  durationMs = 10_000,
  outputTokens = 100,
  reasoningTokens = 20,
  inputTokens = 40,
  timeToFirstTokenMs = 800,
  responseId = "resp-1",
} = {}) {
  const end = start + durationMs;
  const cumOut = outputTokens;
  return [
    entry(start - 1000, "session_meta", {
      session_id: id,
      cwd: "/tmp/project",
      model,
      cli_version: "0.50.0",
    }),
    entry(start, "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
      started_at: Math.floor(start / 1000),
    }),
    entry(end, "token_usage_record", {
      usage: {
        output_tokens: outputTokens,
        reasoning_output_tokens: reasoningTokens,
        input_tokens: inputTokens,
      },
      thread_token_usage: {
        output_tokens: cumOut,
        reasoning_output_tokens: reasoningTokens,
        input_tokens: inputTokens,
      },
      response_id: responseId,
    }),
    entry(end + 100, "event_msg", {
      type: "task_complete",
      completed_at: Math.floor((end + 100) / 1000),
      duration_ms: durationMs + 100,
      time_to_first_token_ms: timeToFirstTokenMs,
    }),
  ];
}