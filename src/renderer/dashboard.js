// 仪表盘：会话列表、最近几轮、设置。数据仍由主进程推送。

const api = window.codexSpeed;
const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  settings: null,
  codexHome: "",
  version: "",
  platform: "",
  sessions: [],
  active: [],
  sessionsLoaded: false,
};

const el = {
  sub: $("sub"),
  tps: $("tps"),
  status: $("status"),
  turnRate: $("turnRate"),
  turnMeta: $("turnMeta"),
  sessionRate: $("sessionRate"),
  sessionMeta: $("sessionMeta"),
  ttft: $("ttft"),
  ttftUnit: $("ttftUnit"),
  ttftMeta: $("ttftMeta"),
  sessions: $("sessions"),
  sessionsEmpty: $("sessionsEmpty"),
  turns: $("turns"),
  turnsEmpty: $("turnsEmpty"),
  followHint: $("followHint"),
  unpin: $("unpin"),
  opacity: $("opacity"),
  opacityOut: $("opacityOut"),
  scale: $("scale"),
  theme: $("theme"),
  alwaysOnTop: $("alwaysOnTop"),
  clickThrough: $("clickThrough"),
  edgeSnap: $("edgeSnap"),
  startAtLogin: $("startAtLogin"),
  hideDock: $("hideDock"),
  codexHome: $("codexHome"),
  saveHome: $("saveHome"),
  hudFields: $("hudFields"),
  foot: $("foot"),
};

// 悬浮窗可显示的指标，顺序与主进程 settings.mjs 的 HUD_FIELDS 一致
const HUD_FIELD_OPTIONS = [
  ["tps", "当前速度"],
  ["ttft", "首 token 时延"],
  ["mspt", "每 token 时延"],
  ["latency", "响应耗时"],
  ["turn", "本轮摘要"],
  ["session", "会话均速"],
  ["spark", "迷你曲线"],
];

const hudFieldInputs = new Map();

/* ---------------------------------------------------------------- *
 * 格式化
 * ---------------------------------------------------------------- */
function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n).toString() : "—";
}

function fmtSeconds(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(id) {
  const text = String(id ?? "");
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text || "—";
}

function baseName(file) {
  const text = String(file ?? "");
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || text;
}

function statusInfo(snap) {
  if (!snap) return { text: "连接中", tone: "" };
  if (!snap.ok) {
    return { text: snap.reason === "no-session" ? "等待会话" : "未连接", tone: "" };
  }
  const live = snap.live ?? {};
  if (live.active) return { text: "生成中", tone: "accent" };
  if (live.stalled) return { text: "长时间无样本", tone: "warn" };
  if (live.waitingTool) return { text: "工具中", tone: "warn" };
  if (live.generating) return { text: "等待首字", tone: "warn" };
  return { text: "空闲", tone: "" };
}

/* ---------------------------------------------------------------- *
 * 渲染
 * ---------------------------------------------------------------- */
function renderStats() {
  const snap = state.snapshot;
  const info = statusInfo(snap);
  el.status.textContent = info.text;
  el.status.className = `pill ${info.tone}`.trim();

  if (!snap?.ok) {
    el.tps.textContent = "—";
    el.turnRate.textContent = "—";
    el.turnMeta.textContent = "—";
    el.sessionRate.textContent = "—";
    el.sessionMeta.textContent = "—";
    el.ttft.textContent = "—";
    el.ttftUnit.textContent = "";
    el.ttftMeta.textContent = "—";
    return;
  }

  const live = snap.live ?? {};
  const turn = snap.turn ?? {};
  const session = snap.session ?? {};

  el.tps.textContent = live.lastResponse ? Number(live.tokensPerSec || 0).toFixed(1) : "—";
  el.turnRate.textContent = fmtRate(turn.avgTokensPerSec);
  el.turnMeta.textContent = `输出 ${fmtCompact(turn.outputTokens)} tok · ${turn.responses ?? 0} 次响应`;

  el.sessionRate.textContent = fmtRate(session.avgTokensPerSec);
  el.sessionMeta.textContent = `输出 ${fmtCompact(session.outputTokens)} tok · 推理 ${Math.round(
    (session.reasoningShare ?? 0) * 100
  )}%`;

  const ttft = turn.timeToFirstTokenMs;
  if (Number.isFinite(ttft) && ttft > 0) {
    el.ttft.textContent = (ttft / 1000).toFixed(2);
    el.ttftUnit.textContent = "s";
  } else {
    el.ttft.textContent = "—";
    el.ttftUnit.textContent = "";
  }
  el.ttftMeta.textContent =
    turn.avgMsPerToken != null ? `平均 ${turn.avgMsPerToken} ms/token` : "日志里还没有本轮耗时";
}

function renderTurns() {
  const snap = state.snapshot;
  const history = snap?.ok ? [...(snap.turnHistory ?? [])].reverse().slice(0, 12) : [];
  el.turns.replaceChildren();
  el.turnsEmpty.hidden = history.length > 0;
  for (const turn of history) {
    const tr = document.createElement("tr");
    const cells = [
      fmtTime(turn.endedAtMs),
      fmtCompact(turn.outputTokens),
      fmtRate(turn.avgTokensPerSec),
      fmtRate(turn.wallTokensPerSec),
      fmtSeconds(turn.timeToFirstTokenMs),
    ];
    cells.forEach((text, index) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (index > 0) td.className = "num";
      tr.append(td);
    });
    el.turns.append(tr);
  }
}

function sessionRow(session, options = {}) {
  const tr = document.createElement("tr");

  const tdSession = document.createElement("td");
  const idDiv = document.createElement("div");
  idDiv.className = "session-id";
  idDiv.textContent = shortId(session.sessionId);
  const cwdDiv = document.createElement("span");
  cwdDiv.className = "session-cwd";
  cwdDiv.textContent = session.cwd || baseName(session.file);
  tdSession.append(idDiv, cwdDiv);
  tr.append(tdSession);

  const tdModel = document.createElement("td");
  tdModel.textContent = session.model || "—";
  tr.append(tdModel);

  const tdRate = document.createElement("td");
  tdRate.className = "num";
  tdRate.textContent = `${fmtRate(session.avgTokensPerSec)} t/s`;
  tr.append(tdRate);

  const tdOut = document.createElement("td");
  tdOut.className = "num";
  tdOut.textContent = fmtCompact(session.outputTokens);
  tr.append(tdOut);

  const tdStatus = document.createElement("td");
  const tag = document.createElement("span");
  tag.className = "tag";
  if (options.pinned) {
    tag.textContent = "已钉住";
    tdStatus.append(tag);
  } else if (options.followed) {
    tag.textContent = "跟随中";
    tdStatus.append(tag);
  } else if (session.active) {
    tag.textContent = "活跃";
    tdStatus.append(tag);
  } else {
    tag.className = "tag dim";
    tag.textContent = "已结束";
    tdStatus.append(tag);
  }
  tr.append(tdStatus);

  const tdAction = document.createElement("td");
  const button = document.createElement("button");
  button.className = "btn ghost";
  button.textContent = options.pinned ? "已钉住" : "钉住";
  button.disabled = Boolean(options.pinned) || !session.file;
  button.addEventListener("click", () => pin(session.file));
  tdAction.append(button);
  tr.append(tdAction);

  return tr;
}

function renderSessions() {
  const pinned = state.settings?.pinnedFile ?? null;
  const followedFile = state.snapshot?.ok ? state.snapshot.followedFile : null;
  const seen = new Set();
  const rows = [];

  for (const session of state.active) {
    if (seen.has(session.file)) continue;
    seen.add(session.file);
    rows.push({ session, active: true, pinned: pinned === session.file, followed: followedFile === session.file });
  }
  for (const session of state.sessions) {
    if (seen.has(session.file)) continue;
    seen.add(session.file);
    rows.push({
      session,
      active: Boolean(session.active),
      pinned: pinned === session.file,
      followed: followedFile === session.file,
    });
  }

  el.sessions.replaceChildren();
  if (rows.length === 0) {
    el.sessionsEmpty.hidden = false;
    el.sessionsEmpty.textContent = state.sessionsLoaded
      ? "没有找到会话日志。先在 Codex 里发一条消息。"
      : "正在读取会话日志…";
  } else {
    el.sessionsEmpty.hidden = true;
  }
  for (const row of rows) {
    el.sessions.append(
      sessionRow(row.session, { pinned: row.pinned, followed: row.followed, active: row.active })
    );
  }

  if (pinned) {
    const shownId = state.snapshot?.ok && followedFile === pinned ? state.snapshot.session?.id : "";
    el.followHint.textContent = `已钉住：${shortId(shownId) || baseName(pinned)}`;
  } else {
    el.followHint.textContent = "自动跟随最近写入的会话";
  }
  el.unpin.disabled = !pinned;
}

function setValue(element, value) {
  if (!element || document.activeElement === element) return;
  const text = String(value ?? "");
  if (element.value !== text) element.value = text;
}

function setChecked(element, value) {
  if (!element || document.activeElement === element) return;
  element.checked = Boolean(value);
}

/* 悬浮窗显示内容：勾选立即生效，悬浮窗自己会按内容调整高度 */
function buildHudFieldInputs() {
  if (!el.hudFields) return;
  el.hudFields.replaceChildren();
  for (const [key, label] of HUD_FIELD_OPTIONS) {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      const picked = HUD_FIELD_OPTIONS.filter(([k]) => hudFieldInputs.get(k)?.checked).map(
        ([k]) => k
      );
      api?.updateSettings({ hudFields: picked });
    });
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(input, text);
    el.hudFields.append(wrap);
    hudFieldInputs.set(key, input);
  }
}

function renderHudFields(s) {
  const picked = new Set(Array.isArray(s.hudFields) ? s.hudFields : []);
  for (const [key, input] of hudFieldInputs) {
    if (document.activeElement !== input) input.checked = picked.has(key);
  }
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const pct = Math.round(s.opacity * 100);
  setValue(el.opacity, pct);
  el.opacityOut.textContent = `${pct}%`;
  setValue(el.scale, String(s.scale));
  setValue(el.theme, s.theme ?? "dark");
  document.documentElement.dataset.theme = s.theme === "light" ? "light" : "dark";
  setChecked(el.alwaysOnTop, s.alwaysOnTop);
  setChecked(el.clickThrough, s.clickThrough);
  setChecked(el.edgeSnap, s.edgeSnap);
  setChecked(el.startAtLogin, s.startAtLogin);
  setChecked(el.hideDock, s.hideDock);
  el.hideDock.disabled = state.platform !== "darwin";
  renderHudFields(s);
  setValue(el.codexHome, s.codexHome ?? "");

  el.sub.textContent = `数据源：${state.codexHome} · v${state.version}`;
  el.foot.textContent =
    "只读取本地会话日志，不上传任何数据。速度按“每次响应”统计，不是逐 token 实时值。" +
    " 悬浮窗显示哪些指标可在上方勾选，或右键悬浮窗用「显示内容」随时切换。" +
    " 悬浮窗拖到屏幕边缘会自动收成小气泡：悬停展开、点击固定、拖走恢复。" +
    " 快捷键：Ctrl+Alt+S 切换点击穿透，Ctrl+Alt+H 显示/隐藏悬浮窗。";
}

function renderAll() {
  renderStats();
  renderTurns();
  renderSettings();
  renderSessions();
}

/* ---------------------------------------------------------------- *
 * 数据
 * ---------------------------------------------------------------- */
async function refreshSessions() {
  if (!api) return;
  try {
    const data = await api.listSessions(12);
    state.sessions = data?.sessions ?? [];
    state.active = data?.active ?? [];
    state.sessionsLoaded = true;
    renderSessions();
  } catch {
    /* 忽略瞬时错误 */
  }
}

async function pin(file) {
  if (!api) return;
  const result = await api.pinSession(file ?? null);
  if (!result?.ok) {
    el.foot.textContent = `钉住失败：${result?.error ?? "未知原因"}`;
    return;
  }
  if (result.snapshot) {
    state.snapshot = result.snapshot;
    renderStats();
    renderTurns();
  }
  await refreshSessions();
}

/* ---------------------------------------------------------------- *
 * 事件
 * ---------------------------------------------------------------- */
function bindEvents() {
  el.unpin.addEventListener("click", () => pin(null));

  el.opacity.addEventListener("input", () => {
    const pct = Number(el.opacity.value);
    el.opacityOut.textContent = `${pct}%`;
    api?.updateSettings({ opacity: pct / 100 });
  });

  el.scale.addEventListener("change", () => {
    api?.updateSettings({ scale: Number(el.scale.value) });
  });

  el.theme.addEventListener("change", () => {
    api?.updateSettings({ theme: el.theme.value });
  });

  for (const [element, key] of [
    [el.alwaysOnTop, "alwaysOnTop"],
    [el.clickThrough, "clickThrough"],
    [el.edgeSnap, "edgeSnap"],
    [el.startAtLogin, "startAtLogin"],
    [el.hideDock, "hideDock"],
  ]) {
    element.addEventListener("change", () => {
      api?.updateSettings({ [key]: element.checked });
    });
  }

  el.saveHome.addEventListener("click", async () => {
    const value = el.codexHome.value.trim();
    await api?.updateSettings({ codexHome: value || null });
    el.foot.textContent = "数据目录已更新，正在重新读取会话…";
    state.sessions = [];
    state.active = [];
    state.sessionsLoaded = false;
    renderSessions();
    await refreshSessions();
  });

  $("openData").addEventListener("click", () => api?.openUserData());
  $("quit").addEventListener("click", () => api?.quit());

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshSessions();
  });
}

async function init() {
  buildHudFieldInputs();
  bindEvents();
  if (!api) {
    el.sub.textContent = "预加载脚本未加载，请通过 Electron 启动。";
    return;
  }
  try {
    const data = await api.getState();
    state.snapshot = data.snapshot;
    state.settings = data.settings;
    state.codexHome = data.codexHome;
    state.version = data.version;
    state.platform = data.platform;
    renderAll();
  } catch {
    /* ignore */
  }

  api.onSnapshot((payload) => {
    state.snapshot = payload.snapshot;
    if (payload.settings) state.settings = payload.settings;
    if (payload.codexHome) state.codexHome = payload.codexHome;
    // 每秒只更新数值卡片和轮次表；会话表格由 refreshSessions / 钉住变化驱动，
    // 否则每秒重建 DOM 会打断用户点击「钉住」。
    renderStats();
    renderTurns();
    renderSettings();
  });
  api.onState((payload) => {
    state.snapshot = payload.snapshot ?? state.snapshot;
    if (payload.settings) state.settings = payload.settings;
    if (payload.codexHome) state.codexHome = payload.codexHome;
    renderAll();
  });
  api.onSettings(({ settings }) => {
    const pinnedChanged = settings.pinnedFile !== state.settings?.pinnedFile;
    state.settings = settings;
    renderSettings();
    if (pinnedChanged) refreshSessions();
  });

  await refreshSessions();
  setInterval(() => {
    if (!document.hidden) refreshSessions();
  }, 4000);
}

init();