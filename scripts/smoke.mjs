// 冒烟检查：不启动 Electron，直接用引擎读本机 Codex 会话，打印一份摘要。
// 用法：npm run smoke

import { Monitor } from "../src/main/engine/monitor.mjs";
import { resolveCodexHome } from "../src/main/engine/paths.mjs";

const home = resolveCodexHome(process.env.CODEX_SPEED_HOME ?? null);
const monitor = new Monitor({ codexHome: home });

let snap;
try {
  snap = monitor.tick();
} catch (err) {
  console.error("引擎运行失败:", err.message);
  process.exit(1);
}

const summary = {
  codexHome: home,
  ok: snap.ok,
  reason: snap.ok ? null : snap.reason ?? null,
  hint: snap.ok ? undefined : snap.hint ?? null,
  sessionId: snap.ok ? snap.session?.id ?? null : null,
  model: snap.ok ? snap.session?.model ?? null : null,
  phase: snap.ok ? snap.live?.phase ?? null : null,
  tokensPerSec: snap.ok ? snap.live?.tokensPerSec ?? null : null,
  outputTokens: snap.ok ? snap.session?.outputTokens ?? null : null,
  responses: snap.ok ? snap.session?.responses ?? null : null,
  pinned: Boolean(snap.pinned),
  file: snap.ok ? snap.session?.file ?? null : null,
  sessions: monitor.listSessions(5).length,
  active: monitor.listActive().length,
};

console.log(JSON.stringify(summary, null, 2));

if (!snap.ok) {
  console.error("提示：没有找到会话日志。先在 Codex 里发一条消息，或用 CODEX_HOME 指定数据目录。");
}