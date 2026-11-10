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
const HUD_HEIGHT = 168;

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
  installIpc();
  installSecurityGuards();
  createTray();
  createHud();
  startEngine();
  registerShortcuts();
  applyLoginItem();

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

function createHud() {
  if (hudWin) return;
  const position = restorePosition();
  const scale = settings.get("scale");

  hudWin = new BrowserWindow({
    width: Math.round(HUD_WIDTH * scale),
    height: Math.round(HUD_HEIGHT * scale),
    x: position.x,
    y: position.y,
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

  // 记住位置（多显示器）
  hudWin.on("moved", () => {
    if (!hudWin) return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!hudWin) return;
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
  const h = Math.round(HUD_HEIGHT * scale);
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

function applyAppearance() {
  if (!hudWin || hudWin.isDestroyed()) return;
  const scale = settings.get("scale");
  hudWin.setContentSize(Math.round(HUD_WIDTH * scale), Math.round(HUD_HEIGHT * scale));
  hudWin.webContents.setZoomFactor(scale);
  hudWin.setOpacity(settings.get("opacity"));
  applyAlwaysOnTop();
  applyClickThrough();
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

function showHud() {
  if (!settings || !monitor) return;
  if (!hudWin) createHud();
  if (!hudWin) return;
  if (hudWin.isMinimized()) hudWin.restore();
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
    backgroundColor: "#0f1115",
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
  if (next.opacity !== before.opacity) hudWin?.setOpacity(next.opacity);
  if (next.scale !== before.scale) applyAppearance();
  if (next.alwaysOnTop !== before.alwaysOnTop) applyAlwaysOnTop();
  if (next.clickThrough !== before.clickThrough) applyClickThrough();
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
    { label: "隐藏悬浮窗", click: () => hudWin?.hide() },
    { label: "退出", click: () => quitApp() },
  ]);
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
  settings?.save();
});
app.on("window-all-closed", () => {
  // 托盘常驻：关掉窗口不退出
});
app.on("activate", () => {
  showHud();
});