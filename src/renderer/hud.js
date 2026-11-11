// HUD 渲染：只消费主进程推来的快照，不做任何文件读取。
//
// 显示哪些指标由 settings.hudFields 决定（主进程右键菜单 / 仪表盘里可改）。
// 窗口高度不写死：每次渲染后量一次内容高度，回报给主进程调整窗口。

const api = window.codexSpeed;
const $ = (id) => document.getElementById(id);

// 主进程首次推设置之前用的兜底字段，避免第一帧空白
const DEFAULT_FIELDS = ["tps", "ttft", "mspt", "latency", "turn", "spark"];

// 小字统计格：两列，标签在左、值在右。值的含义见 title（悬停可看）。
const STAT_FIELDS = [
  {
    key: "ttft",
    label: "首 token",
    title: "本轮从提示就绪到首个 token 的耗时",
  },
  {
    key: "mspt",
    label: "每 token",
    title: "每个输出 token 平摊的端到端时间（含排队与预填充）",
  },
  {
    key: "latency",
    label: "响应耗时",
    title: "上一次完整响应的端到端耗时",
  },
  {
    key: "session",
    label: "会话均速",
    title: "本次会话全部响应的 token 加权平均速度",
  },
];

let snapshot = null;
let settings = null;
let lastSpark = null;
let lastStatKey = null;
let lastHeight = 0;
let resizeFrame = 0;

const statValues = new Map(); // key -> value element

const els = {
  hud: $("hud"),
  rateRow: $("rateRow"),
  rate: $("tps"),
  stats: $("stats"),
  turn: $("turn"),
  status: $("status"),
  pin: $("pin"),
  hint: $("hint"),
  spark: $("spark"),
};

function fields() {
  if (!settings) return DEFAULT_FIELDS;
  return Array.isArray(settings.hudFields) ? settings.hudFields : DEFAULT_FIELDS;
}

function shows(key) {
  return fields().includes(key);
}

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

/** 毫秒 → “820 ms” / “1.24 s”；没有有效值时给 “—” */
function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/** 秒 → “6.42 s” */
function fmtSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${n.toFixed(2)} s`;
}

/** 每 token 毫秒数：小于 10 ms 时保留一位小数，否则取整 */
function fmtPerToken(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ms`;
}

function describeStatus(snap) {
  if (!snap) return { text: "连接中", tone: "dim" };
  if (!snap.ok) {
    return { text: snap.reason === "no-session" ? "等待会话" : "未连接", tone: "dim" };
  }
  const live = snap.live ?? {};
  if (live.active) {
    const waited = Math.floor((live.generatingMs ?? 0) / 1000);
    return { text: waited >= 1 ? `生成中 ${waited}s` : "生成中", tone: "accent" };
  }
  if (live.stalled) return { text: "长时间无样本", tone: "warn" };
  if (live.waitingTool) return { text: "工具中", tone: "warn" };
  if (live.generating) return { text: "等待首字", tone: "warn" };
  return { text: "空闲", tone: "dim" };
}

/* ---------------------------------------------------------------- *
 * 统计格
 * ---------------------------------------------------------------- */
function syncStatCells() {
  const wanted = STAT_FIELDS.filter((field) => shows(field.key));
  const key = wanted.map((field) => field.key).join(",");
  if (key === lastStatKey) return;
  lastStatKey = key;

  statValues.clear();
  els.stats.replaceChildren();
  for (const field of wanted) {
    const cell = document.createElement("div");
    cell.className = "stat";
    cell.title = field.title;
    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = field.label;
    const value = document.createElement("span");
    value.className = "stat-value";
    value.textContent = "—";
    cell.append(label, value);
    els.stats.append(cell);
    statValues.set(field.key, value);
  }
  els.stats.hidden = wanted.length === 0;
}

function setStat(key, text) {
  const element = statValues.get(key);
  if (element && element.textContent !== text) element.textContent = text;
}

/** 首 token 时延：本轮还没测到时回退到最近完成的一轮。 */
function ttftMs(snap) {
  const direct = Number(snap?.turn?.timeToFirstTokenMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const history = snap?.turnHistory ?? [];
  const last = history[history.length - 1];
  return Number(last?.timeToFirstTokenMs) || null;
}

function updateStats(snap) {
  const live = snap?.ok ? snap.live ?? {} : {};
  const turn = snap?.ok ? snap.turn ?? {} : {};
  const session = snap?.ok ? snap.session ?? {} : {};

  const tps = Number(live.tokensPerSec) || 0;
  const perToken = tps > 0 ? 1000 / tps : Number(turn.avgMsPerToken) || 0;
  const lastSeconds = live.lastResponse?.seconds;

  setStat("ttft", fmtMs(ttftMs(snap)));
  setStat("mspt", fmtPerToken(perToken));
  setStat("latency", fmtSeconds(lastSeconds));
  setStat(
    "session",
    Number(session.avgTokensPerSec) > 0
      ? `${Math.round(session.avgTokensPerSec)} t/s`
      : "—"
  );
}

/* ---------------------------------------------------------------- *
 * 渲染
 * ---------------------------------------------------------------- */
function render() {
  const snap = snapshot;
  const status = describeStatus(snap);

  if (els.status) {
    els.status.textContent = status.text;
    els.status.className = `badge status tone-${status.tone}`;
  }
  if (els.pin) els.pin.hidden = !snap?.pinned;

  // 主数字：当前速度
  const showRate = shows("tps");
  if (els.rateRow) els.rateRow.hidden = !showRate;
  let tpsText = "—";
  let stale = false;
  let empty = true;
  if (snap?.ok) {
    const live = snap.live ?? {};
    if (live.lastResponse) {
      tpsText = Number(live.tokensPerSec || 0).toFixed(1);
      stale = Boolean(live.stale);
      empty = false;
    } else if (Number(live.tokensPerSec) > 0) {
      tpsText = Number(live.tokensPerSec).toFixed(1);
      empty = false;
    }
  }
  if (els.rate) {
    els.rate.textContent = tpsText;
    els.rate.classList.toggle("stale", stale);
    els.rate.classList.toggle("empty", empty);
  }

  syncStatCells();
  updateStats(snap);

  // 本轮摘要
  const showTurn = shows("turn");
  if (els.turn) {
    els.turn.hidden = !showTurn;
    if (showTurn) {
      const turn = snap?.ok ? snap.turn : null;
      if (turn && (turn.responses > 0 || turn.outputTokens > 0)) {
        els.turn.textContent = `本轮 ${fmtCompact(turn.outputTokens)} tok · ${Math.round(
          turn.avgTokensPerSec || 0
        )} t/s`;
      } else {
        els.turn.textContent = "本轮 —";
      }
    }
  }

  // 迷你曲线
  const showSpark = shows("spark");
  if (els.spark) els.spark.hidden = !showSpark;
  if (showSpark) drawSpark(snap?.ok ? snap.live?.spark : null);

  // 提示行：字段全关掉时也用它告诉用户怎么恢复
  let hint = "";
  if (fields().length === 0) hint = "未选择显示内容：右键菜单「显示内容」可恢复";
  else if (snap && !snap.ok) hint = snap.hint || "";
  else if (snap?.live?.stalled) hint = "超过 15 分钟没有新样本";
  if (els.hint) {
    els.hint.textContent = hint;
    els.hint.hidden = !hint;
  }

  scheduleResize();
}

/* ---------------------------------------------------------------- *
 * 窗口高度：量内容 → 回报主进程
 * ---------------------------------------------------------------- */
function scheduleResize() {
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (!els.hud) return;
    // 设置还没到时先用主进程按 hudFields 估的高度，避免先按默认布局撑大再缩回
    if (!settings) return;
    // hud 的高度是 auto，量出来的就是内容高度；窗口比内容小也不会影响布局
    const height = Math.ceil(els.hud.getBoundingClientRect().height);
    if (Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    api?.setHudSize?.(height);
  });
}

/* ---------------------------------------------------------------- *
 * 迷你曲线：每个点 = 一次响应结束时的速度
 * ---------------------------------------------------------------- */
function drawSpark(spark) {
  if (spark) lastSpark = spark;
  const canvas = els.spark;
  if (!canvas || canvas.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();

  const points = Array.isArray(lastSpark) ? lastSpark.filter((p) => Number.isFinite(p?.v)) : [];
  if (points.length < 2) return;

  const max = Math.max(10, ...points.map((p) => p.v)) * 1.15;
  const stepX = width / (points.length - 1);
  const yOf = (value) => height - 1 - (value / max) * (height - 3);

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(16,163,127,0.30)");
  gradient.addColorStop(1, "rgba(16,163,127,0)");

  ctx.beginPath();
  ctx.moveTo(0, height);
  points.forEach((point, index) => ctx.lineTo(index * stepX, yOf(point.v)));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = index * stepX;
    const y = yOf(point.v);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#10a37f";
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/* ---------------------------------------------------------------- *
 * 事件与订阅
 * ---------------------------------------------------------------- */
function applySettings(next) {
  const fieldsChanged =
    JSON.stringify(next?.hudFields ?? null) !== JSON.stringify(settings?.hudFields ?? null);
  settings = next;
  document.body.classList.toggle("through", Boolean(next?.clickThrough));
  if (fieldsChanged) lastStatKey = null; // 字段变了要重建统计格
}

function applyState(payload) {
  if (!payload) return;
  snapshot = payload.snapshot ?? snapshot;
  if (payload.settings) applySettings(payload.settings);
  render();
}

function bindUi() {
  $("menu")?.addEventListener("click", (event) => {
    event.stopPropagation();
    api?.showContextMenu();
  });

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    api?.showContextMenu();
  });

  window.addEventListener("dblclick", () => api?.openDashboard());

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") api?.hideHud();
  });

  window.addEventListener("resize", () => decodeSparkAfterResize());
}

function decodeSparkAfterResize() {
  // 尺寸变化后 canvas 的位图尺寸要跟着重算
  if (els.spark && !els.spark.hidden) drawSpark();
  scheduleResize();
}

async function init() {
  bindUi();
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:16px;color:#e8b34b;font:12px sans-serif">预加载脚本未加载，请通过 Electron 启动。</div>';
    return;
  }
  try {
    const state = await api.getState();
    applyState(state);
  } catch {
    /* 首次启动时可能还没有快照 */
  }
  api.onSnapshot(applyState);
  api.onState(applyState);
  api.onSettings(({ settings: next }) => {
    applySettings(next);
    render();
  });
}

init();