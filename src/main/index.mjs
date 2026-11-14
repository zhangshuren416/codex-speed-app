// Codex Speed 桌面版主进程
//
// 设计：
//   * 引擎（读取 ~/.codex/sessions）跑在主进程，每秒推一份快照给窗口；
//   * HUD 是无边框透明置顶窗，仪表盘是普通窗口，两者都只是渲染器；
//   * 不依赖 Codex 插件，也不起本地 HTTP 服务。

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  nativeImage,
  nativeTheme,
  globalShortcut,
  shell,
  dialog,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsStore } from "./settings.mjs";
import { Monitor } from "./engine/monitor.mjs";
import { resolveCodexHome } from "./engine/paths.mjs";
import {
  BUBBLE_SIZE_CSS,
  clampAlong,
  bubbleBounds as computeBubbleBounds,
  expandedBounds as computeExpandedBounds,
  snapTargetFor as computeSnapTarget,
} from "./dock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

// 打包后图标从 asarUnpack 目录读：部分平台上 nativeImage/Tray 无法直接读 asar 内的文件
const ASSET_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "assets")
  : path.join(ROOT, "assets");

// 影响 userData 目录与系统里显示的应用名，必须在 ready 之前设置
app.setName("Codex Speed");

// userData 是否真的可写。不可写时 Chromium 建不了 profile 会直接崩（0x80000003），
// 单实例锁也建不起来，进程表现为「静默退出、没有窗口」，所以出错时要能说清是哪一种。
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// 便携模式 / 自动化测试：把 userData 指到指定目录，避免往 %APPDATA% 写东西
if (process.env.CODEX_SPEED_USER_DATA) {
  const userData = path.resolve(process.env.CODEX_SPEED_USER_DATA);
  app.setPath("userData", userData);
  try {
    app.setPath("sessionData", path.join(userData, "session"));
  } catch {
    /* 旧版 Electron 没有 sessionData */
  }
}

const HUD_WIDTH = 300;
// 高度由渲染进程按实际内容量回来（hudFields 决定行数），这里只保留上下限兜底
const HUD_MIN_HEIGHT = 60;
const HUD_MAX_HEIGHT = 460;

// 边缘吸附：拖到工作区边缘附近松手 → 收成一个贴边小气泡；悬停展开，移开收回
// 纯几何（气泡/展开 bounds、选边）在 dock.mjs，可单测；这里只保留时序常量
const COLLAPSE_DELAY_MS = 350; // 鼠标离开后延迟收回，避免掠过边缘时抖动
const MOVE_GUARD_MS = 250; // 程序化移窗后这段时间内的 moved 事件不触发吸附判定
const HOVER_POLL_MS = 80; // 光标轮询间隔：气泡是原生拖动区，不派发 mouseenter，靠主进程判悬停
const EXPAND_ANIM_MS = 240; // 展开滑入动画时长（与 hud.css 一致）
const COLLAPSE_ANIM_MS = 200; // 收回滑出动画时长（略大于 CSS 的 180ms，确保动画演完再缩窗）

// 悬浮窗“显示内容”菜单：key 与 settings.mjs 的 HUD_FIELDS 对应
const HUD_FIELD_LABELS = [
  ["tps", "当前速度"],
  ["ttft", "首 token 时延"],
  ["mspt", "每 token 时延"],
  ["latency", "响应耗时"],
  ["turn", "本轮摘要"],
  ["session", "会话均速"],
  ["spark", "迷你曲线"],
];

let settings = null;
let monitor = null;
let hudWin = null;
let dashboardWin = null;
let tray = null;
let engineTimer = null;
let lastSnapshot = null;
let sessionsCache = { at: 0, value: null };
let quitting = false;
let moveTimer = null;
// 当前 HUD 的内容高度（CSS 像素）。缩放时再乘以 scale 得到窗口 DIP 尺寸。
let hudHeightCss = 196;

// 边缘吸附状态：dock = { edge, anchor, displayId }，anchor 是气泡沿吸附边的坐标
let dock = null;
let dockExpanded = false; // 吸附中但悬停/固定展开成完整 HUD
let dockPinned = false; // 点击气泡固定展开：鼠标移开也不收回
let dragging = false; // 原生拖动进行中（move → moved 之间）
let menuOpen = false; // 右键菜单打开时不收回，避免菜单还在窗口先缩了
let programmaticMoveUntil = 0; // 程序化移窗的保护期，防止 moved 事件回环触发吸附
let dockAnimating = null; // null | "expand" | "collapse"，驱动渲染器滑入/滑出动画
let outsideSince = null; // 展开后鼠标移出窗口的起始时刻，用于延迟收回
let hoverPollTimer = null; // 光标轮询定时器
let expandAnimTimer = null;
let collapseAnimTimer = null;

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "main.log"), line + "\n");
  } catch {
    /* 日志失败不影响主流程 */
  }
  // userData 不可写时上面会静默失败，再往临时目录留一份，保证启动过程总有痕迹
  try {
    fs.appendFileSync(path.join(os.tmpdir(), "codex-speed-startup.log"), line + "\n");
  } catch {
    /* 临时目录也写不了就放弃，不能拖累启动 */
  }
}

/* ------------------------------------------------------------------ *
 * 单实例
 * ------------------------------------------------------------------ */
// requestSingleInstanceLock() 返回 false 有两种完全不同的原因，不能混为一谈：
//   a) 已经有一个实例在跑 —— 正常情况，提示用户去看托盘；
//   b) userData 目录不可写，锁文件根本没建起来 —— 这是环境问题，得让用户知道真实原因。
// 原来两种情况都直接 app.quit()，用户看到的就是「输入命令、什么都没发生」。
function userDataWritable() {
  return isWritableDir(app.getPath("userData"));
}

if (!app.requestSingleInstanceLock()) {
  const writable = userDataWritable();
  const dir = app.getPath("userData");

  if (writable) {
    log("单实例锁未获得：已有实例在运行，本次启动退出");
  } else {
    log(`单实例锁建立失败：数据目录不可写 ${dir}`);
  }

  app.whenReady().then(() => {
    try {
      dialog.showErrorBox(
        writable ? "Codex Speed 已在运行" : "Codex Speed 无法启动",
        writable
          ? "已经有一个 Codex Speed 实例在运行。\n\n" +
              "请查看任务栏的托盘图标（Windows 11 默认会收进「显示隐藏的图标」里），" +
              "从它的菜单里打开仪表盘，或先退出旧实例再重新启动。"
          : `应用数据目录不可写：\n${dir}\n\n` +
              "Electron 无法在这个目录创建单实例锁，所以启动会直接退出。\n\n" +
              "解决办法：用一个可写目录启动，例如\n" +
              '  set CODEX_SPEED_USER_DATA=D:\\tmp\\codex-speed   (cmd)\n' +
              '  $env:CODEX_SPEED_USER_DATA="D:\\tmp\\codex-speed"   (pwsh)\n' +
              "然后重新启动。"
      );
    } catch {
      /* 没有图形界面时弹窗会失败，日志里已有记录 */
    }
    app.exit(0);
  });
} else {
  app.on("second-instance", () => {
    showHud();
  });
  app.whenReady().then(boot).catch((err) => {
    log("启动失败", err?.stack ?? err);
    app.exit(1);
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
async function boot() {
  if (IS_WIN) app.setAppUserModelId("com.zhangshuren.codexspeed");

  settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  hudHeightCss = estimateHudHeight(settings.get("hudFields"));
  monitor = new Monitor({
    codexHome: resolveCodexHome(settings.get("codexHome")),
    pinnedFile: settings.get("pinnedFile"),
  });
  // 钉住的会话已经被删除/归档时，清掉过期设置
  if (settings.get("pinnedFile") && !monitor.pinned()) {
    settings.set({ pinnedFile: null });
  }

  if (process.env.CODEX_SPEED_SMOKE === "1") {
    await runSmoke();
    return;
  }

  installAppMenu();
  applyTheme();
  installIpc();
  installSecurityGuards();
  createTray();
  createHud();
  startEngine();
  registerShortcuts();
  applyLoginItem();

  // 分辨率/任务栏变化：吸附中的窗口重新贴边，普通窗口夹回屏幕
  screen.on("display-metrics-changed", () => {
    if (!hudWin || hudWin.isDestroyed()) return;
    if (dock) {
      const area = dockWorkArea();
      setHudBounds(
        dockExpanded
          ? expandedBounds(area, dock.edge, dock.anchor)
          : bubbleBounds(area, dock.edge, dock.anchor)
      );
    } else {
      keepHudOnScreen();
    }
  });

  // 悬停判定轮询：气泡/卡片是原生拖动区，渲染器鼠标事件不可靠，由主进程按光标位置驱动
  hoverPollTimer = setInterval(pollDockHover, HOVER_POLL_MS);
  hoverPollTimer.unref?.();

  if (process.env.CODEX_SPEED_DEBUG === "1") {
    setTimeout(() => showDashboard(), 1200);
  }

  if (IS_MAC && settings.get("hideDock")) {
    app.dock?.hide();
  }

  log("启动完成", `version=${app.getVersion()}`, `codexHome=${resolveCodexHome(settings.get("codexHome"))}`);
}

async function runSmoke() {
  const snap = monitor.tick();
  const payload = {
    ok: snap.ok,
    tps: snap.ok ? snap.live?.tokensPerSec ?? null : null,
    phase: snap.ok ? snap.live?.phase ?? null : null,
    sessionId: snap.ok ? snap.session?.id ?? null : null,
    file: snap.ok ? snap.session?.file ?? null : null,
    pinned: Boolean(snap.pinned),
    codexHome: resolveCodexHome(settings.get("codexHome")),
    userData: app.getPath("userData"),
  };
  const line = `SMOKE ${JSON.stringify(payload)}\n`;
  process.stdout.write(line);
  // Electron 是 GUI 子系统程序，Windows 终端可能收不到 stdout，落一份文件兜底
  try {
    const out = process.env.CODEX_SPEED_SMOKE_OUT || path.join(app.getPath("userData"), "smoke.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  } catch (err) {
    log("写入冒烟结果失败", err?.message ?? err);
  }
  setTimeout(() => app.exit(payload.ok ? 0 : 2), 150);
}

/* ------------------------------------------------------------------ *
 * HUD 窗口
 * ------------------------------------------------------------------ */
function attachWindowDiagnostics(win, name) {
  const contents = win.webContents;
  contents.on("console-message", (_event, ...args) => {
    // Electron 新版把参数收进 details 对象，旧版是 (level, message, line, sourceId)
    const details = args[0];
    if (details && typeof details === "object") {
      if (details.level === "error" || details.level === "warning") {
        log(`[${name}] console.${details.level}`, details.message ?? "");
      }
      return;
    }
    const [level, message] = args;
    if (level >= 2) log(`[${name}] console`, String(message ?? ""));
  });
  contents.on("preload-error", (_event, preloadPath, error) => {
    log(`[${name}] preload 错误`, preloadPath, error?.message ?? String(error));
  });
  contents.on("render-process-gone", (_event, details) => {
    log(`[${name}] 渲染进程退出`, JSON.stringify(details));
  });
  contents.on("did-fail-load", (_event, code, description, url) => {
    log(`[${name}] 页面加载失败`, code, description, url);
  });
}

/**
 * 估算 HUD 内容高度：只在第一帧（渲染进程还没量完）和窗口重建时用。
 * 数值是 CSS 像素，与 hud.css 的间距大致对应，不必精确——渲染进程会回报真实高度。
 */
function estimateHudHeight(fields) {
  const has = (key) => Array.isArray(fields) && fields.includes(key);
  let height = 21; // 上下内边距
  height += 20; // 标题行
  if (has("tps")) height += 46;
  const cells = ["ttft", "mspt", "latency", "session"].filter(has).length;
  if (cells) height += Math.ceil(cells / 2) * 17 + 6;
  if (has("turn")) height += 15;
  if (has("spark")) height += 45;
  return Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, Math.round(height)));
}

function hudPixelSize() {
  const scale = settings.get("scale");
  return {
    width: Math.round(HUD_WIDTH * scale),
    height: Math.round(hudHeightCss * scale),
  };
}

function createHud() {
  if (hudWin) return;
  // 上次退出时吸在边缘的话，启动直接以气泡形态恢复
  dock = restoreDock();
  dockExpanded = false;
  dockPinned = false;
  const position = restorePosition();
  const scale = settings.get("scale");
  const size = hudPixelSize();
  const initial = dock
    ? bubbleBounds(dockWorkArea(), dock.edge, dock.anchor)
    : { x: position.x, y: position.y, width: size.width, height: size.height };

  hudWin = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: "Codex Speed",
    icon: path.join(ASSET_DIR, "app.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  hudWin.setMenuBarVisibility(false);
  attachWindowDiagnostics(hudWin, "hud");
  hudWin.loadFile(path.join(ROOT, "src/renderer/hud.html"));
  hudWin.webContents.setZoomFactor(scale);

  hudWin.once("ready-to-show", () => {
    applyAppearance();
    hudWin.showInactive();
    broadcastState();
    log("HUD 已显示");
    if (process.env.CODEX_SPEED_DEBUG === "1") {
      hudWin.webContents
        .executeJavaScript(`(() => ({
          hasApi: Boolean(window.codexSpeed),
          tps: document.getElementById("tps")?.textContent,
          status: document.getElementById("status")?.textContent,
          turn: document.getElementById("turn")?.textContent,
          canvasWidth: document.getElementById("spark")?.width,
          bodyClass: document.body.className
        }))()`)
        .then((info) => log("HUD 自检", JSON.stringify(info)))
        .catch((err) => log("HUD 自检失败", err?.message ?? String(err)));
      // 吸附自检：模拟 吸附→固定展开→收回→解除，验证状态机、几何与动画类
      setTimeout(async () => {
        if (!hudWin || hudWin.isDestroyed()) return;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const probe = () =>
          hudWin.webContents
            .executeJavaScript(
              `({ body: document.body.className, hud: document.getElementById("hud")?.className, bubbleHidden: document.getElementById("bubble")?.hidden })`
            )
            .catch(() => null);
        try {
          dockToEdge("right", 200);
          await sleep(60);
          const bubble = hudWin.getBounds();
          const sDock = dockStatePayload();
          const pBubble = await probe();
          expandFromBubble({ pin: true });
          await sleep(EXPAND_ANIM_MS + 40);
          const expanded = hudWin.getBounds();
          const sPin = dockStatePayload();
          const pExpanded = await probe();
          collapseToBubble();
          await sleep(COLLAPSE_ANIM_MS + 60);
          const collapsed = hudWin.getBounds();
          const sCollapse = dockStatePayload();
          const pCollapsed = await probe();
          undock();
          await sleep(60);
          const free = hudWin.getBounds();
          const sFree = dockStatePayload();
          log(
            "吸附自检",
            JSON.stringify({ bubble, sDock, pBubble, expanded, sPin, pExpanded, collapsed, sCollapse, pCollapsed, free, sFree })
          );
        } catch (err) {
          log("吸附自检失败", err?.message ?? String(err));
        }
      }, 1500);
      // 主题自检：探测当前配色 → 切到相反主题 → 探测 → 切回，验证实时切换
      setTimeout(async () => {
        if (!hudWin || hudWin.isDestroyed()) return;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const probe = () =>
          hudWin.webContents
            .executeJavaScript(
              `({ theme: document.documentElement.dataset.theme, hudBg: getComputedStyle(document.getElementById("hud")).backgroundImage, text: getComputedStyle(document.getElementById("hud")).color })`
            )
            .catch(() => null);
        try {
          const start = settings.get("theme");
          const other = start === "light" ? "dark" : "light";
          const before = await probe();
          updateSettings({ theme: other });
          await sleep(200);
          const switched = await probe();
          updateSettings({ theme: start });
          await sleep(200);
          const restored = await probe();
          log("主题自检", JSON.stringify({ start, before, switched, restored }));
        } catch (err) {
          log("主题自检失败", err?.message ?? String(err));
        }
      }, 3000);
    }
  });

  // 无边框窗口没有原生关闭按钮，Alt+F4 / 系统关闭一律改为隐藏，避免误退出
  hudWin.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hudWin.hide();
      refreshTrayMenu();
    }
  });
  hudWin.on("closed", () => {
    hudWin = null;
  });
  hudWin.on("show", refreshTrayMenu);
  hudWin.on("hide", refreshTrayMenu);

  // 拖动：move 期间标记 dragging；moved（松手）时做吸附判定并记住位置。
  // 注意：Windows 下程序化 setBounds 只发 move 不发 moved，保护期内的 move 不能置
  // dragging，否则标志会永久卡真，导致悬停轮询被一直跳过。
  hudWin.on("move", () => {
    if (Date.now() >= programmaticMoveUntil) dragging = true;
  });
  hudWin.on("moved", () => {
    if (!hudWin || hudWin.isDestroyed()) return;
    dragging = false;
    // 程序化移窗（收起/展开/恢复）也会触发 moved，保护期内不做吸附判定
    if (Date.now() < programmaticMoveUntil) {
      // 但用户可能刚拖完气泡就松手：只同步 anchor（不移窗，无回环风险），
      // 避免下次展开时跳回旧位置
      if (dock && !dockExpanded) {
        const b = hudWin.getBounds();
        const vertical = dock.edge === "left" || dock.edge === "right";
        const center = vertical ? b.y + b.height / 2 : b.x + b.width / 2;
        const anchor = Math.round(center - bubbleSide() / 2);
        if (anchor !== dock.anchor) {
          dock.anchor = anchor;
          persistDock();
        }
      }
      return;
    }
    const bounds = hudWin.getBounds();
    const area = screen.getDisplayNearestPoint({
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    }).workArea;
    const target = settings.get("edgeSnap") ? snapTargetFor(bounds, area) : null;
    if (target) {
      // 拖到边缘：吸附并收成气泡（沿边拖气泡也走这里，更新 anchor）
      dockToEdge(target.edge, target.anchor);
      return;
    }
    if (dock) {
      // 从边缘拖走：解除吸附，恢复完整窗口
      undock();
      return;
    }
    // 普通拖动：记住位置（多显示器）
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!hudWin || hudWin.isDestroyed()) return;
      const [x, y] = hudWin.getPosition();
      settings.set({ hudPosition: { x, y } });
    }, 300);
    moveTimer.unref?.();
  });

  if (IS_MAC) {
    hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  applyAppearance();
}

function restorePosition() {
  const scale = settings.get("scale");
  const w = Math.round(HUD_WIDTH * scale);
  const h = Math.round(hudHeightCss * scale);
  const saved = settings.get("hudPosition");
  if (saved) {
    const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    const area = display.workArea;
    // 允许贴边，但不能整窗跑到屏幕外（换显示器/改分辨率后还能找回来）
    const x = Math.min(Math.max(saved.x, area.x - w + 80), area.x + area.width - 80);
    const y = Math.min(Math.max(saved.y, area.y - 8), area.y + area.height - 48);
    return { x, y };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - w - 24, y: area.y + 24 };
}

/* ------------------------------------------------------------------ *
 * 边缘吸附：拖近边缘收成气泡，悬停展开、点击固定、拖走解除
 * ------------------------------------------------------------------ */
function bubbleSide() {
  return Math.round(BUBBLE_SIZE_CSS * settings.get("scale"));
}

function hudDisplay() {
  const [x, y] = hudWin.getPosition();
  const [w, h] = hudWin.getSize();
  return screen.getDisplayNearestPoint({
    x: x + Math.round(w / 2),
    y: y + Math.round(h / 2),
  });
}

/** 吸附所在显示器的工作区；记录的显示器拔掉后回落到窗口当前所在屏。 */
function dockWorkArea() {
  const found = screen.getAllDisplays().find((d) => d.id === dock?.displayId);
  if (found) return found.workArea;
  if (hudWin && !hudWin.isDestroyed()) return hudDisplay().workArea;
  return screen.getPrimaryDisplay().workArea;
}

// 以下两个是 dock.mjs 纯函数的薄封装：只补充当前缩放下的像素尺寸
function bubbleBounds(area, edge, anchor) {
  return computeBubbleBounds(area, edge, anchor, bubbleSide());
}

function expandedBounds(area, edge, anchor) {
  const { width, height } = hudPixelSize();
  return computeExpandedBounds(area, edge, anchor, width, height, bubbleSide());
}

/** 程序化移窗：带保护期，避免 setBounds 触发的 moved 又被当成用户拖拽。 */
function setHudBounds(bounds) {
  if (!hudWin || hudWin.isDestroyed()) return;
  programmaticMoveUntil = Date.now() + MOVE_GUARD_MS;
  dragging = false; // 程序化移窗不是用户拖动，确保拖动标志不会卡住
  hudWin.setBounds(bounds);
}

function dockStatePayload() {
  return {
    docked: Boolean(dock),
    expanded: dockExpanded,
    pinned: dockPinned,
    edge: dock?.edge ?? null,
    animating: dockAnimating,
  };
}

function sendDockState() {
  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.webContents.send("hud:dock-state", dockStatePayload());
  }
}

function persistDock() {
  settings.set({
    hudDock: dock ? { edge: dock.edge, anchor: dock.anchor, displayId: dock.displayId } : null,
  });
}

function clearAnimTimers() {
  if (expandAnimTimer) clearTimeout(expandAnimTimer);
  if (collapseAnimTimer) clearTimeout(collapseAnimTimer);
  expandAnimTimer = null;
  collapseAnimTimer = null;
}

/** 展开：窗口立即放到完整尺寸，渲染器播放从边缘滑入的弹出动画。 */
function expandFromBubble({ pin = false } = {}) {
  if (!dock || !hudWin || hudWin.isDestroyed()) return;
  clearAnimTimers();
  dockExpanded = true;
  if (pin) dockPinned = true;
  dockAnimating = "expand";
  outsideSince = null;
  setHudBounds(expandedBounds(dockWorkArea(), dock.edge, dock.anchor));
  sendDockState();
  // 动画演完清掉标记，避免后续状态推送（如打开仪表盘）误触发再次滑入
  expandAnimTimer = setTimeout(() => {
    dockAnimating = null;
    expandAnimTimer = null;
  }, EXPAND_ANIM_MS);
  expandAnimTimer.unref?.();
}

/** 收回：先让渲染器把卡片滑向边缘淡出，动画演完再真正缩成气泡（两阶段）。 */
function collapseToBubble() {
  if (!dock || !hudWin || hudWin.isDestroyed()) return;
  if (!dockExpanded) {
    finishCollapse();
    return;
  }
  if (dockAnimating === "collapse") return; // 已在收回动画中
  clearAnimTimers();
  dockAnimating = "collapse";
  outsideSince = null;
  sendDockState(); // expanded 仍为 true，窗口保持完整尺寸供滑出动画
  collapseAnimTimer = setTimeout(finishCollapse, COLLAPSE_ANIM_MS);
  collapseAnimTimer.unref?.();
}

function finishCollapse() {
  clearAnimTimers();
  dockExpanded = false;
  dockPinned = false;
  dockAnimating = null;
  if (!dock || !hudWin || hudWin.isDestroyed()) return;
  setHudBounds(bubbleBounds(dockWorkArea(), dock.edge, dock.anchor));
  sendDockState();
}

/**
 * 光标轮询判定悬停：气泡与卡片都是原生拖动区，渲染器收不到可靠的 mouseenter/mouseleave，
 * 因此由主进程按「光标 vs 窗口 bounds」驱动展开/收回，彻底绕开拖动区事件问题。
 */
function pollDockHover() {
  if (!dock || !hudWin || hudWin.isDestroyed() || !hudWin.isVisible()) return;
  if (dragging || menuOpen) return;
  const cursor = screen.getCursorScreenPoint();
  const b = hudWin.getBounds();
  const inside =
    cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;

  if (!dockExpanded) {
    if (inside) {
      // 气泡：光标进入即弹出
      if (process.env.CODEX_SPEED_DEBUG === "1") log("悬停展开", JSON.stringify(hudWin.getBounds()));
      expandFromBubble();
    }
    return;
  }
  if (dockPinned) {
    outsideSince = null;
    return;
  }
  if (inside) {
    outsideSince = null;
    if (dockAnimating === "collapse") expandFromBubble(); // 收回动画中鼠标回来 → 反向滑入
    return;
  }
  if (dockAnimating === "collapse") return; // 正在滑出，让它演完
  if (outsideSince === null) outsideSince = Date.now();
  else if (Date.now() - outsideSince >= COLLAPSE_DELAY_MS) {
    if (process.env.CODEX_SPEED_DEBUG === "1") log("悬停收回", JSON.stringify(hudWin.getBounds()));
    collapseToBubble();
  }
}

function snapTargetFor(bounds, area) {
  return computeSnapTarget(bounds, area, bubbleSide());
}

function dockToEdge(edge, anchor) {
  clearAnimTimers();
  dock = { edge, anchor, displayId: hudDisplay().id };
  dockExpanded = false;
  dockPinned = false;
  dockAnimating = null;
  outsideSince = null;
  persistDock();
  setHudBounds(bubbleBounds(dockWorkArea(), edge, anchor));
  sendDockState();
}

/** 解除吸附：展开状态原地恢复；气泡状态以气泡为中心展开成完整窗口并夹回屏幕。 */
function undock() {
  if (!dock) return;
  const wasExpanded = dockExpanded;
  const prev = dock;
  dock = null;
  dockExpanded = false;
  dockPinned = false;
  dockAnimating = null;
  outsideSince = null;
  clearAnimTimers();
  persistDock();
  if (!hudWin || hudWin.isDestroyed()) return;
  const area = hudDisplay().workArea;
  const { width: w, height: h } = hudPixelSize();
  let x;
  let y;
  if (wasExpanded) {
    [x, y] = hudWin.getPosition();
  } else {
    const b = bubbleBounds(area, prev.edge, prev.anchor);
    const side = bubbleSide();
    x = clampAlong(b.x + side / 2 - w / 2, area.x, area.x + area.width - w);
    y = clampAlong(b.y + side / 2 - h / 2, area.y, area.y + area.height - h);
  }
  setHudBounds({ x, y, width: w, height: h });
  settings.set({ hudPosition: { x, y } });
  sendDockState();
}

/** 启动时恢复吸附：显示器可能变了，anchor 夹回当前工作区。 */
function restoreDock() {
  const saved = settings.get("hudDock");
  if (!saved) return null;
  const display =
    screen.getAllDisplays().find((d) => d.id === saved.displayId) ?? screen.getPrimaryDisplay();
  const area = display.workArea;
  const side = Math.round(BUBBLE_SIZE_CSS * settings.get("scale"));
  const vertical = saved.edge === "left" || saved.edge === "right";
  const min = vertical ? area.y : area.x;
  const max = (vertical ? area.y + area.height : area.x + area.width) - side;
  return {
    edge: saved.edge,
    anchor: clampAlong(saved.anchor, min, max),
    displayId: display.id,
  };
}

function applyAppearance() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const scale = settings.get("scale");
  hudWin.webContents.setZoomFactor(scale);
  if (dock) {
    // 吸附中：按气泡/展开几何重排（缩放变化时气泡与窗口同步缩放）
    const area = dockWorkArea();
    const bounds = dockExpanded
      ? expandedBounds(area, dock.edge, dock.anchor)
      : bubbleBounds(area, dock.edge, dock.anchor);
    setHudBounds(bounds);
  } else {
    const size = hudPixelSize();
    hudWin.setContentSize(size.width, size.height);
  }
  applyHudOpacity();
  applyAlwaysOnTop();
  applyClickThrough();
}

/** HUD 不透明度：浅色强制 1——半透明白卡叠在任何非白背景上都会混成灰（灰蒙根源）；深色按用户设置。
 * Windows 上不能用原生 setOpacity：它会给窗口加 WS_EX_LAYERED 并走 LWA_ALPHA 常量 alpha
 * （见 Electron native_window_views.cc SetOpacity），与透明窗口的逐像素 alpha
 * （WS_EX_NOREDIRECTIONBITMAP）互斥，窗口缩放（气泡收起/展开）后会在圆形气泡/卡片
 * 背后露出一块灰色正方形底（electron/electron#32555）。改由渲染进程把不透明度应用到
 * body 的 CSS opacity（见 hud.js applySettings），窗口本身保持完全透明。
 * 设置里的 opacity/theme 会随 broadcastState/broadcastSettings 推到渲染进程，无需单独 IPC。
 * macOS 的原生实现没有这个冲突，保持原样。 */
function applyHudOpacity() {
  if (!hudWin || hudWin.isDestroyed()) return;
  if (IS_MAC) {
    hudWin.setOpacity(settings.get("theme") === "light" ? 1 : settings.get("opacity"));
  }
}

/** 变高/变矮后别让窗口滑出屏幕（至少留 80px 宽、40px 高可见）。 */
function keepHudOnScreen() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const [x, y] = hudWin.getPosition();
  const [w, h] = hudWin.getSize();
  const display = screen.getDisplayNearestPoint({
    x: x + Math.round(w / 2),
    y: y + Math.round(h / 2),
  });
  const area = display.workArea;
  const nextX = Math.min(Math.max(x, area.x - w + 80), area.x + area.width - 80);
  const nextY = Math.min(Math.max(y, area.y), area.y + area.height - 40);
  if (nextX !== x || nextY !== y) hudWin.setPosition(nextX, nextY, false);
}

/** 渲染进程量完内容后回报 CSS 高度；只有变化超过 1px 才真正改窗口。 */
function applyHudContentHeight(cssHeight) {
  const value = Number(cssHeight);
  if (!Number.isFinite(value)) return hudHeightCss;
  const next = Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, Math.round(value)));
  if (Math.abs(next - hudHeightCss) < 1) return hudHeightCss;
  hudHeightCss = next;
  if (hudWin && !hudWin.isDestroyed()) {
    if (dock) {
      // 收起状态窗口保持气泡尺寸，只记录内容高度；展开状态按新高度重新贴边
      if (dockExpanded) setHudBounds(expandedBounds(dockWorkArea(), dock.edge, dock.anchor));
    } else {
      const size = hudPixelSize();
      hudWin.setContentSize(size.width, size.height);
      keepHudOnScreen();
    }
  }
  return hudHeightCss;
}

function applyAlwaysOnTop() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const on = settings.get("alwaysOnTop");
  // macOS 用 screen-saver 层级才能压住全屏应用
  hudWin.setAlwaysOnTop(on, on ? "screen-saver" : "normal");
}

function applyClickThrough() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const on = settings.get("clickThrough");
  // forward: true 让鼠标移动仍然透传给页面（悬停效果），点击则直接穿透到下面的窗口
  hudWin.setIgnoreMouseEvents(on, { forward: true });
}

/** 主题：原生菜单/对话框跟随深浅色；仪表盘窗口底色同步，避免浅色下黑底闪烁。 */
function applyTheme() {
  const light = settings.get("theme") === "light";
  nativeTheme.themeSource = light ? "light" : "dark";
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.setBackgroundColor(light ? "#f5f7fa" : "#0f1115");
  }
  applyHudOpacity(); // 切到浅色立即变不透明，切回深色恢复用户不透明度
}

/** 「主题」子菜单：托盘与悬浮窗右键菜单共用。 */
function themeSubmenu() {
  const light = settings.get("theme") === "light";
  return [
    { label: "深色", type: "radio", checked: !light, click: () => updateSettings({ theme: "dark" }) },
    { label: "浅色", type: "radio", checked: light, click: () => updateSettings({ theme: "light" }) },
  ];
}

function showHud() {
  if (!settings || !monitor) return;
  if (!hudWin) createHud();
  if (!hudWin) return;
  if (hudWin.isMinimized()) hudWin.restore();
  // 吸附中被托盘/快捷键唤起：展开并固定，免得鼠标不在上面又缩回去
  if (dock && !dockExpanded) expandFromBubble({ pin: true });
  hudWin.showInactive();
  hudWin.moveTop();
  refreshTrayMenu();
}

function toggleHud() {
  if (!hudWin) {
    createHud();
    return;
  }
  if (hudWin.isVisible()) hudWin.hide();
  else showHud();
  refreshTrayMenu();
}

/* ------------------------------------------------------------------ *
 * 仪表盘
 * ------------------------------------------------------------------ */
function showDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    if (dashboardWin.isMinimized()) dashboardWin.restore();
    dashboardWin.show();
    dashboardWin.focus();
    return;
  }
  dashboardWin = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 660,
    minHeight: 480,
    title: "Codex Speed",
    backgroundColor: settings.get("theme") === "light" ? "#f5f7fa" : "#0f1115",
    autoHideMenuBar: true,
    icon: path.join(ASSET_DIR, "app.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  dashboardWin.loadFile(path.join(ROOT, "src/renderer/dashboard.html"));
  attachWindowDiagnostics(dashboardWin, "dashboard");
  dashboardWin.once("ready-to-show", () => {
    dashboardWin.show();
    broadcastState();
    if (process.env.CODEX_SPEED_DEBUG === "1") {
      dashboardWin.webContents
        .executeJavaScript(`(() => ({
          hasApi: Boolean(window.codexSpeed),
          tps: document.getElementById("tps")?.textContent,
          status: document.getElementById("status")?.textContent,
          sessionRows: document.querySelectorAll("#sessions tr").length,
          turnRows: document.querySelectorAll("#turns tr").length,
          opacity: document.getElementById("opacity")?.value,
          sub: document.getElementById("sub")?.textContent
        }))()`)
        .then((info) => log("仪表盘自检", JSON.stringify(info)))
        .catch((err) => log("仪表盘自检失败", err?.message ?? String(err)));
      // 会话列表是异步加载的，4 秒后再看一次，确认不是一直空表
      setTimeout(() => {
        if (!dashboardWin || dashboardWin.isDestroyed()) return;
        const list = getSessionList(12);
        dashboardWin.webContents
          .executeJavaScript(
            `document.querySelectorAll("#sessions tr").length`
          )
          .then((rows) => log("仪表盘延迟自检", JSON.stringify({ rows, sessions: list.sessions.length, active: list.active.length })))
          .catch(() => {});
      }, 4000);
    }
  });
  dashboardWin.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      dashboardWin.hide();
    }
  });
  dashboardWin.on("closed", () => {
    dashboardWin = null;
  });
}

/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */
function startEngine() {
  stopEngine();
  const tick = () => {
    try {
      pushSnapshot(monitor.tick());
    } catch (err) {
      log("采样失败", err?.message ?? err);
    }
  };
  tick();
  engineTimer = setInterval(tick, settings.get("refreshMs"));
}

function stopEngine() {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
}

function pushSnapshot(snap) {
  lastSnapshot = snap;
  const payload = {
    snapshot: snap,
    settings: settings.all(),
    platform: process.platform,
    version: app.getVersion(),
    codexHome: resolveCodexHome(settings.get("codexHome")),
  };
  for (const win of [hudWin, dashboardWin]) {
    if (win && !win.isDestroyed()) win.webContents.send("snapshot", payload);
  }
}

function broadcastState() {
  const payload = {
    snapshot: lastSnapshot,
    settings: settings.all(),
    platform: process.platform,
    version: app.getVersion(),
    codexHome: resolveCodexHome(settings.get("codexHome")),
    dock: dockStatePayload(),
  };
  for (const win of [hudWin, dashboardWin]) {
    if (win && !win.isDestroyed()) win.webContents.send("state", payload);
  }
}

function broadcastSettings() {
  const payload = { settings: settings.all() };
  for (const win of [hudWin, dashboardWin]) {
    if (win && !win.isDestroyed()) win.webContents.send("settings", payload);
  }
}

/* ------------------------------------------------------------------ *
 * 设置更新（IPC 与菜单共用）
 * ------------------------------------------------------------------ */
const SETTING_KEYS = new Set([
  "opacity",
  "scale",
  "alwaysOnTop",
  "clickThrough",
  "codexHome",
  "hudPosition",
  "startAtLogin",
  "hideDock",
  "refreshMs",
  "hudFields",
  "edgeSnap",
  "theme",
]);

function sanitizeSettingsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  return out;
}

function updateSettings(patch) {
  const before = settings.all();
  const next = settings.set(patch);
  if (next.opacity !== before.opacity) applyHudOpacity();
  if (next.scale !== before.scale) applyAppearance();
  if (next.alwaysOnTop !== before.alwaysOnTop) applyAlwaysOnTop();
  if (next.clickThrough !== before.clickThrough) applyClickThrough();
  if (next.theme !== before.theme) applyTheme();
  // 关掉自动吸附时把已经吸在边缘的窗口放回来
  if (next.edgeSnap !== before.edgeSnap && !next.edgeSnap && dock) undock();
  if (next.startAtLogin !== before.startAtLogin) applyLoginItem();
  if (next.codexHome !== before.codexHome) {
    // 换数据目录时旧的钉住路径可能属于另一个 Codex 主目录，直接解除
    monitor.setPinned(null);
    settings.set({ pinnedFile: null });
    monitor.setCodexHome(resolveCodexHome(next.codexHome));
    sessionsCache = { at: 0, value: null };
    startEngine();
  } else if (next.refreshMs !== before.refreshMs) {
    startEngine();
  }
  refreshTrayMenu();
  broadcastSettings();
  return settings.all();
}

function applyLoginItem() {
  if (IS_LINUX) return; // Linux 需要写 .desktop，留到打包阶段
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.get("startAtLogin")) });
  } catch (err) {
    log("设置开机自启失败", err?.message ?? err);
  }
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */
function trayImage() {
  const file = IS_MAC ? "trayTemplate.png" : "tray.png";
  const image = nativeImage.createFromPath(path.join(ASSET_DIR, file));
  if (IS_MAC && !image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function createTray() {
  try {
    const image = trayImage();
    if (image.isEmpty()) log("托盘图标缺失，托盘将不可见");
    tray = new Tray(image);
    tray.setToolTip("Codex Speed");
    if (IS_WIN) {
      tray.on("click", toggleHud);
    }
    refreshTrayMenu();
  } catch (err) {
    // Linux 没有 StatusNotifier/appindicator 时创建托盘会失败；HUD 仍可用
    tray = null;
    log("托盘不可用", err?.message ?? err);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function opacityLabel(value) {
  return `${Math.round(value * 100)}%`;
}

/** 悬浮窗“显示内容”子菜单。每次点击都从当前设置重新读，避免菜单项状态过期。 */
function hudFieldsSubmenu() {
  return HUD_FIELD_LABELS.map(([key, label]) => ({
    label,
    type: "checkbox",
    checked: (settings.get("hudFields") ?? []).includes(key),
    click: (item) => {
      const next = new Set(settings.get("hudFields") ?? []);
      if (item.checked) next.add(key);
      else next.delete(key);
      updateSettings({ hudFields: [...next] });
    },
  }));
}

function trayTemplate() {
  const s = settings.all();
  const hudVisible = Boolean(hudWin && !hudWin.isDestroyed() && hudWin.isVisible());
  const followed = lastSnapshot?.ok ? lastSnapshot.followedFile : null;

  return [
    {
      label: hudVisible ? "隐藏悬浮窗" : "显示悬浮窗",
      click: () => (hudVisible ? hudWin?.hide() : showHud()),
    },
    { label: "打开仪表盘", click: showDashboard },
    { type: "separator" },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: s.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked }),
    },
    {
      label: "点击穿透",
      type: "checkbox",
      checked: s.clickThrough,
      accelerator: "CommandOrControl+Alt+S",
      click: (item) => updateSettings({ clickThrough: item.checked }),
    },
    {
      label: "边缘自动吸附",
      type: "checkbox",
      checked: s.edgeSnap,
      click: (item) => updateSettings({ edgeSnap: item.checked }),
    },
    {
      label: "不透明度",
      submenu: [1, 0.9, 0.8, 0.6, 0.4].map((value) => ({
        label: opacityLabel(value),
        type: "radio",
        checked: Math.abs(s.opacity - value) < 0.01,
        click: () => updateSettings({ opacity: value }),
      })),
    },
    {
      label: "缩放",
      submenu: [0.8, 1, 1.25, 1.5].map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: "radio",
        checked: Math.abs(s.scale - value) < 0.01,
        click: () => updateSettings({ scale: value }),
      })),
    },
    { label: "主题", submenu: themeSubmenu() },
    {
      label: "显示内容",
      submenu: hudFieldsSubmenu(),
    },
    { type: "separator" },
    {
      label: "钉住当前会话",
      enabled: Boolean(followed) && s.pinnedFile !== followed,
      click: () => pinSession(followed),
    },
    {
      label: "恢复自动跟随",
      enabled: Boolean(s.pinnedFile),
      click: () => pinSession(null),
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: s.startAtLogin,
      enabled: !IS_LINUX,
      click: (item) => updateSettings({ startAtLogin: item.checked }),
    },
    {
      label: "打开数据目录",
      click: () => shell.openPath(app.getPath("userData")),
    },
    { type: "separator" },
    {
      label: "退出 Codex Speed",
      click: () => quitApp(),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * HUD 右键菜单
 * ------------------------------------------------------------------ */
function hudContextMenu() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const s = settings.all();
  const followed = lastSnapshot?.ok ? lastSnapshot.followedFile : null;
  const menu = Menu.buildFromTemplate([
    { label: "打开仪表盘", click: showDashboard },
    { type: "separator" },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: s.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked }),
    },
    {
      label: "点击穿透（Ctrl+Alt+S）",
      type: "checkbox",
      checked: s.clickThrough,
      click: (item) => updateSettings({ clickThrough: item.checked }),
    },
    {
      label: "边缘自动吸附",
      type: "checkbox",
      checked: s.edgeSnap,
      click: (item) => updateSettings({ edgeSnap: item.checked }),
    },
    {
      label: "不透明度",
      submenu: [1, 0.9, 0.8, 0.6, 0.4].map((value) => ({
        label: opacityLabel(value),
        type: "radio",
        checked: Math.abs(s.opacity - value) < 0.01,
        click: () => updateSettings({ opacity: value }),
      })),
    },
    {
      label: "缩放",
      submenu: [0.8, 1, 1.25, 1.5].map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: "radio",
        checked: Math.abs(s.scale - value) < 0.01,
        click: () => updateSettings({ scale: value }),
      })),
    },
    { label: "主题", submenu: themeSubmenu() },
    {
      label: "显示内容",
      submenu: hudFieldsSubmenu(),
    },
    { type: "separator" },
    {
      label: "钉住当前会话",
      enabled: Boolean(followed) && s.pinnedFile !== followed,
      click: () => pinSession(followed),
    },
    {
      label: "恢复自动跟随",
      enabled: Boolean(s.pinnedFile),
      click: () => pinSession(null),
    },
    ...(dock
      ? [
          ...(dockExpanded ? [{ label: "收起为气泡", click: () => collapseToBubble() }] : []),
          { label: "解除边缘吸附", click: () => undock() },
        ]
      : []),
    { type: "separator" },
    { label: "隐藏悬浮窗", click: () => hudWin?.hide() },
    { label: "退出", click: () => quitApp() },
  ]);
  // 菜单打开期间不收回窗口；关闭后按鼠标位置决定是否补一次收回
  menuOpen = true;
  menu.once("menu-will-close", () => {
    menuOpen = false;
    if (!dock || !dockExpanded || dockPinned) return;
    if (!hudWin || hudWin.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const b = hudWin.getBounds();
    const inside =
      cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    // 菜单关闭后重置收回计时，交给光标轮询按延迟判定
    outsideSince = inside ? null : Date.now();
  });
  menu.popup({ window: hudWin });
}

/* ------------------------------------------------------------------ *
 * 会话钉住
 * ------------------------------------------------------------------ */
function pinSession(file) {
  try {
    monitor.setPinned(file || null);
    settings.set({ pinnedFile: monitor.pinned() });
    sessionsCache = { at: 0, value: null };
    const snap = monitor.tick();
    pushSnapshot(snap);
    refreshTrayMenu();
    return { ok: true, snapshot: snap };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function getSessionList(limit = 12) {
  const now = Date.now();
  if (sessionsCache.value && now - sessionsCache.at < 4000) return sessionsCache.value;
  const sessions = monitor.listSessions(limit);
  const active = monitor.listActive();
  sessionsCache = { at: now, value: { sessions, active } };
  return sessionsCache.value;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function installIpc() {
  ipcMain.handle("app:get-state", () => ({
    snapshot: lastSnapshot,
    settings: settings.all(),
    platform: process.platform,
    version: app.getVersion(),
    codexHome: resolveCodexHome(settings.get("codexHome")),
    userData: app.getPath("userData"),
    dock: dockStatePayload(),
  }));

  ipcMain.handle("settings:update", (_event, patch) => updateSettings(sanitizeSettingsPatch(patch)));

  ipcMain.handle("session:pin", (_event, file) => pinSession(file));

  ipcMain.handle("sessions:list", (_event, limit) => getSessionList(Number(limit) || 12));

  ipcMain.handle("hud:context-menu", () => {
    hudContextMenu();
    return true;
  });

  ipcMain.handle("hud:hide", () => {
    hudWin?.hide();
    return true;
  });

  ipcMain.handle("hud:toggle-click-through", () => {
    updateSettings({ clickThrough: !settings.get("clickThrough") });
    return settings.get("clickThrough");
  });

  // HUD 内容高度随“显示内容”变化；由渲染进程测量后回报，主进程只负责改窗口尺寸
  ipcMain.handle("hud:resize", (_event, cssHeight) => applyHudContentHeight(cssHeight));

  // 悬停展开/收回由主进程光标轮询驱动（pollDockHover），不再依赖渲染器鼠标事件。
  // 点击气泡：固定展开，鼠标移开也不收回；已固定时再点则收起
  ipcMain.handle("hud:bubble-pin", () => {
    if (dock && hudWin && !hudWin.isDestroyed()) {
      if (dockExpanded && dockPinned) collapseToBubble();
      else expandFromBubble({ pin: true });
    }
    return dockStatePayload();
  });

  ipcMain.handle("window:open-dashboard", () => {
    showDashboard();
    return true;
  });

  ipcMain.handle("app:quit", () => {
    quitApp();
    return true;
  });

  ipcMain.handle("app:open-user-data", () => {
    shell.openPath(app.getPath("userData"));
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * 快捷键
 * ------------------------------------------------------------------ */
function registerShortcuts() {
  const combos = [
    ["CommandOrControl+Alt+S", () => updateSettings({ clickThrough: !settings.get("clickThrough") })],
    ["CommandOrControl+Alt+H", toggleHud],
  ];
  for (const [accelerator, handler] of combos) {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) log("快捷键被占用", accelerator);
    } catch (err) {
      log("注册快捷键失败", accelerator, err?.message ?? err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 菜单与安全
 * ------------------------------------------------------------------ */
function installAppMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ])
  );
}

function installSecurityGuards() {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 退出
 * ------------------------------------------------------------------ */
function quitApp() {
  quitting = true;
  try {
    tray?.destroy();
    tray = null;
  } catch {
    /* ignore */
  }
  settings?.save();
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopEngine();
  if (hoverPollTimer) clearInterval(hoverPollTimer);
  clearAnimTimers();
  settings?.save();
});
app.on("window-all-closed", () => {
  // 托盘常驻：关掉窗口不退出
});
app.on("activate", () => {
  showHud();
});