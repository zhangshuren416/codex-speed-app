// HUD 渲染：只消费主进程推来的快照，不做任何文件读取。

const api = window.codexSpeed;
const $ = (id) => document.getElementById(id);

let snapshot = null;
let settings = null;
let lastSpark = null;

const els = {
  rate: $("tps"),
  turn: $("turn"),
  status: $("status"),
  pin: $("pin"),
  hint: $("hint"),
  spark: $("spark"),
};

function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
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

function render() {
  const snap = snapshot;
  const status = describeStatus(snap);

  if (els.status) {
    els.status.textContent = status.text;
    els.status.className = `badge status tone-${status.tone}`;
  }
  if (els.pin) els.pin.hidden = !snap?.pinned;

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

  if (els.turn) {
    const turn = snap?.ok ? snap.turn : null;
    if (turn && (turn.responses > 0 || turn.outputTokens > 0)) {
      els.turn.textContent = `本轮 ${fmtCompact(turn.outputTokens)} tok · ${Math.round(
        turn.avgTokensPerSec || 0
      )} t/s`;
    } else {
      els.turn.textContent = "本轮 —";
    }
  }

  if (els.hint) {
    let hint = "";
    if (snap && !snap.ok) hint = snap.hint || "";
    else if (snap?.live?.stalled) hint = "超过 15 分钟没有新样本";
    els.hint.textContent = hint;
  }

  drawSpark(snap?.ok ? snap.live?.spark : null);
}

/* ---------------------------------------------------------------- *
 * 迷你曲线：每个点 = 一次响应结束时的速度
 * ---------------------------------------------------------------- */
function drawSpark(spark) {
  if (spark) lastSpark = spark;
  const canvas = els.spark;
  if (!canvas) return;
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
  settings = next;
  document.body.classList.toggle("through", Boolean(next?.clickThrough));
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

  window.addEventListener("resize", () => drawSpark());
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