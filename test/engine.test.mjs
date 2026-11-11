import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RolloutReader } from "../src/main/engine/rollout.mjs";
import { computeMetrics } from "../src/main/engine/metrics.mjs";
import { Monitor } from "../src/main/engine/monitor.mjs";
import {
  DEFAULTS,
  HUD_FIELDS,
  SettingsStore,
  normalizeHudFields,
} from "../src/main/settings.mjs";
import { makeHome, writeRollout, entry, responseLines } from "./helpers.mjs";

const BASE = Date.parse("2026-11-01T00:00:01Z");

test("单次响应：速度、首 token、本轮与会话汇总", () => {
  const home = makeHome();
  const file = writeRollout(home, {
    name: "rollout-2026-11-01T00-00-00-sess-1.jsonl",
    lines: responseLines({ id: "sess-1", start: BASE }),
  });

  const reader = new RolloutReader(file);
  reader.prime();
  const metrics = computeMetrics(reader.state, BASE + 20_000);

  assert.equal(metrics.session.id, "sess-1");
  assert.equal(metrics.session.model, "gpt-5-codex");
  assert.equal(metrics.live.tokensPerSec, 10);
  assert.equal(metrics.turn.outputTokens, 100);
  assert.equal(metrics.turn.avgTokensPerSec, 10);
  assert.equal(metrics.turn.timeToFirstTokenMs, 800);
  assert.equal(metrics.session.avgTokensPerSec, 10);
  assert.equal(metrics.live.spark.length, 1);
  assert.equal(reader.state.samples.length, 1);
  // task_complete 必须被解析：prime 时最后一行以换行结尾，不能被当成半行丢掉
  assert.equal(metrics.turn.active, false);
});

test("同一次响应被 token_usage_record 与 token_count 重复上报时只算一个样本", () => {
  const home = makeHome();
  const start = BASE;
  const end = start + 10_000;
  const lines = [
    entry(start - 1000, "session_meta", { session_id: "sess-2", cwd: "/tmp/p", model: "gpt-5" }),
    entry(start, "event_msg", { type: "task_started", turn_id: "t1", started_at: Math.floor(start / 1000) }),
    entry(end, "token_usage_record", {
      usage: { output_tokens: 100, reasoning_output_tokens: 10, input_tokens: 20 },
      thread_token_usage: { output_tokens: 100, reasoning_output_tokens: 10, input_tokens: 20 },
      response_id: "r1",
    }),
    entry(end + 200, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { output_tokens: 100, reasoning_output_tokens: 10, input_tokens: 20 },
        last_token_usage: { output_tokens: 100, reasoning_output_tokens: 10, input_tokens: 20 },
      },
    }),
  ];
  const file = writeRollout(home, { name: "rollout-2026-11-01T00-00-00-sess-2.jsonl", lines });

  const reader = new RolloutReader(file);
  reader.prime();
  const metrics = computeMetrics(reader.state, end + 5000);
  assert.equal(reader.state.samples.length, 1);
  assert.equal(metrics.session.responses, 1);
});

test("工具执行时间不计入下一次响应的分母", () => {
  const home = makeHome();
  const start = BASE;
  const end = start + 10_000;
  const lines = responseLines({ id: "sess-3", start });
  lines.push(
    entry(end + 2000, "response_item", { type: "function_call", name: "shell" }),
    entry(end + 6000, "response_item", { type: "function_call_output", call_id: "c1" }),
    entry(end + 11_000, "token_usage_record", {
      usage: { output_tokens: 50, reasoning_output_tokens: 5, input_tokens: 10 },
      thread_token_usage: { output_tokens: 150, reasoning_output_tokens: 25, input_tokens: 50 },
      response_id: "r2",
    })
  );
  const file = writeRollout(home, { name: "rollout-2026-11-01T00-00-00-sess-3.jsonl", lines });

  const reader = new RolloutReader(file);
  reader.prime();
  const state = reader.state;
  assert.equal(state.samples.length, 2);
  const last = state.samples[state.samples.length - 1];
  // 锚点 = 工具结果返回时刻，5 秒生成 50 token
  assert.equal(last.tokensPerSec, 10);
  assert.equal(state.lastResponse.outputTokens, 50);
});

test("增量 poll：文件追加后能继续产出样本", () => {
  const home = makeHome();
  const start = BASE;
  const file = writeRollout(home, {
    name: "rollout-2026-11-01T00-00-00-sess-4.jsonl",
    lines: responseLines({ id: "sess-4", start }),
  });

  const reader = new RolloutReader(file);
  reader.prime();
  assert.equal(reader.state.samples.length, 1);

  const second = [
    entry(start + 12_000, "event_msg", { type: "task_started", turn_id: "t2", started_at: Math.floor((start + 12_000) / 1000) }),
    entry(start + 22_000, "token_usage_record", {
      usage: { output_tokens: 200, reasoning_output_tokens: 40, input_tokens: 60 },
      thread_token_usage: { output_tokens: 300, reasoning_output_tokens: 60, input_tokens: 100 },
      response_id: "r2",
    }),
  ];
  fs.appendFileSync(file, second.join("\n") + "\n", "utf8");
  assert.equal(reader.poll(), true);
  assert.equal(reader.state.samples.length, 2);
  assert.equal(reader.state.lastResponse.outputTokens, 200);
});

test("监控器跟随最近写入的会话，钉住优先，解除后回到最新", () => {
  const home = makeHome();
  const fileA = writeRollout(home, {
    name: "rollout-2026-11-01T00-00-00-sess-a.jsonl",
    lines: responseLines({ id: "sess-a", start: BASE }),
  });
  const fileB = writeRollout(home, {
    name: "rollout-2026-11-01T00-01-00-sess-b.jsonl",
    lines: responseLines({ id: "sess-b", start: BASE + 60_000 }),
  });
  const now = Date.now();
  fs.utimesSync(fileA, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(fileB, new Date(now), new Date(now));

  const monitor = new Monitor({ codexHome: home });
  const first = monitor.tick();
  assert.equal(first.ok, true);
  assert.equal(first.followedFile, fileB);
  assert.equal(first.pinned, false);

  monitor.setPinned(fileA);
  const pinned = monitor.tick();
  assert.equal(pinned.followedFile, fileA);
  assert.equal(pinned.pinned, true);

  monitor.setPinned(null);
  const back = monitor.tick();
  assert.equal(back.followedFile, fileB);
  assert.equal(back.pinned, false);
});

test("会话列表与活跃会话", () => {
  const home = makeHome();
  const fileA = writeRollout(home, {
    name: "rollout-2026-11-01T00-00-00-sess-a.jsonl",
    lines: responseLines({ id: "sess-a", start: BASE }),
  });
  const fileB = writeRollout(home, {
    name: "rollout-2026-11-01T00-02-00-sess-b.jsonl",
    lines: responseLines({ id: "sess-b", start: BASE + 120_000 }),
  });
  const now = Date.now();
  fs.utimesSync(fileA, new Date(now - 120_000), new Date(now - 120_000));
  fs.utimesSync(fileB, new Date(now), new Date(now));

  const monitor = new Monitor({ codexHome: home });
  monitor.tick();

  const sessions = monitor.listSessions(5);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => s.sessionId).sort(),
    ["sess-a", "sess-b"]
  );
  assert.equal(sessions.find((s) => s.sessionId === "sess-b").active, true);

  const active = monitor.listActive();
  assert.equal(active.length, 2);
  assert.equal(active.find((s) => s.sessionId === "sess-b").followed, true);
  assert.equal(active.find((s) => s.sessionId === "sess-b").pinned, false);
});

test("钉住的文件被删除后自动解除钉住", () => {
  const home = makeHome();
  const fileA = writeRollout(home, {
    name: "rollout-2026-11-01T00-00-00-sess-a.jsonl",
    lines: responseLines({ id: "sess-a", start: BASE }),
  });
  const fileB = writeRollout(home, {
    name: "rollout-2026-11-01T00-01-00-sess-b.jsonl",
    lines: responseLines({ id: "sess-b", start: BASE + 60_000 }),
  });
  const now = Date.now();
  fs.utimesSync(fileA, new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(fileB, new Date(now), new Date(now));

  const monitor = new Monitor({ codexHome: home });
  monitor.setPinned(fileA);
  fs.rmSync(fileA);
  const snap = monitor.tick();
  assert.equal(snap.ok, true);
  assert.equal(snap.followedFile, fileB);
  assert.equal(snap.pinned, false);
  assert.equal(monitor.pinned(), null);
});

test("没有会话日志时返回 no-session", () => {
  const home = makeHome();
  const monitor = new Monitor({ codexHome: home });
  const snap = monitor.tick();
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, "no-session");
});

test("悬浮窗显示字段：未知项被丢弃、去重、按固定顺序排列", () => {
  assert.deepEqual(normalizeHudFields(["spark", "bogus", "tps", "tps"]), ["tps", "spark"]);
  assert.deepEqual(normalizeHudFields(["latency", "ttft"]), ["ttft", "latency"]);
  // 空数组是合法状态（用户把显示内容全关了），不能被补回默认值
  assert.deepEqual(normalizeHudFields([]), []);
  // 旧版设置文件没有这个键、或值被写坏时回落到默认值
  assert.deepEqual(normalizeHudFields(undefined), DEFAULTS.hudFields);
  assert.deepEqual(normalizeHudFields("tps"), DEFAULTS.hudFields);
  assert.equal(HUD_FIELDS.length, 7);
});

test("设置持久化：hudFields 能读回并保持规范顺序", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-settings-"));
  try {
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file);
    store.set({ hudFields: ["latency", "tps", "unknown"] });
    store.save();
    const reloaded = new SettingsStore(file);
    assert.deepEqual(reloaded.get("hudFields"), ["tps", "latency"]);

    // 损坏的设置文件不能把悬浮窗变成空白
    fs.writeFileSync(file, JSON.stringify({ hudFields: "broken" }));
    const fixed = new SettingsStore(file);
    assert.deepEqual(fixed.get("hudFields"), DEFAULTS.hudFields);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});