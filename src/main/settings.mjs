// 设置持久化：userData/settings.json。独立应用没有插件注入的目录，全部自己管。

import fs from "node:fs";
import path from "node:path";

// 悬浮窗可显示的指标。顺序即显示顺序；hudFields 里只保存用户勾选的子集。
export const HUD_FIELDS = Object.freeze([
  "tps", // 主数字：当前速度
  "ttft", // 首 token 时延
  "mspt", // 每 token 时延
  "latency", // 单次响应端到端耗时
  "turn", // 本轮摘要
  "session", // 会话均速
  "spark", // 迷你曲线
]);

const DEFAULT_HUD_FIELDS = Object.freeze(["tps", "ttft", "mspt", "latency", "turn", "spark"]);

// 边缘吸附可选的四条边
export const DOCK_EDGES = Object.freeze(["left", "right", "top", "bottom"]);

// 外观主题：深色（默认）/ 浅色
export const THEMES = Object.freeze(["dark", "light"]);

export const DEFAULTS = Object.freeze({
  opacity: 0.94,
  scale: 1,
  alwaysOnTop: true,
  clickThrough: false,
  pinnedFile: null,
  codexHome: null,
  hudPosition: null,
  startAtLogin: false,
  hideDock: false,
  refreshMs: 1000,
  hudFields: DEFAULT_HUD_FIELDS,
  edgeSnap: true,
  hudDock: null,
  theme: "dark",
});

/** 规范化主题：只接受 dark/light，写坏或缺失时回落深色。 */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : "dark";
}

/**
 * 规范化边缘吸附状态：{ edge, anchor, displayId }。
 * anchor 是气泡沿吸附边的坐标（左右边为 y，上下边为 x），displayId 用于多显示器恢复。
 * 写坏或缺失时回落到 null（未吸附），不能让悬浮窗卡在找不到的位置。
 */
export function normalizeHudDock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!DOCK_EDGES.includes(value.edge)) return null;
  if (!Number.isFinite(value.anchor)) return null;
  return {
    edge: value.edge,
    anchor: Math.round(value.anchor),
    displayId: Number.isFinite(value.displayId) ? value.displayId : null,
  };
}

/**
 * 规范化显示字段：丢掉未知项、去重、按 HUD_FIELDS 的固定顺序排列。
 * 旧版设置文件里没有这个键（undefined）时回落到默认值；显式传空数组表示
 * “什么都不显示”，这是合法状态，不要把它当成缺失再补回默认值。
 */
export function normalizeHudFields(value) {
  if (!Array.isArray(value)) return [...DEFAULT_HUD_FIELDS];
  const picked = new Set();
  for (const item of value) {
    if (typeof item === "string" && HUD_FIELDS.includes(item)) picked.add(item);
  }
  return HUD_FIELDS.filter((field) => picked.has(field));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.data = { ...DEFAULTS, ...raw };
        this.data.hudFields = normalizeHudFields(this.data.hudFields);
        this.data.edgeSnap = Boolean(this.data.edgeSnap);
        this.data.hudDock = normalizeHudDock(this.data.hudDock);
        this.data.theme = normalizeTheme(this.data.theme);
      }
    } catch {
      /* 首次启动或文件损坏：使用默认值 */
    }
  }

  all() {
    return { ...this.data };
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    if (!patch || typeof patch !== "object") return this.all();
    const next = { ...this.data, ...patch };
    next.opacity = clamp(Number(next.opacity) || DEFAULTS.opacity, 0.2, 1);
    next.scale = clamp(Number(next.scale) || 1, 0.6, 2);
    next.refreshMs = clamp(Number(next.refreshMs) || 1000, 500, 10000);
    next.alwaysOnTop = Boolean(next.alwaysOnTop);
    next.clickThrough = Boolean(next.clickThrough);
    next.startAtLogin = Boolean(next.startAtLogin);
    next.hideDock = Boolean(next.hideDock);
    next.edgeSnap = Boolean(next.edgeSnap);
    next.hudFields = normalizeHudFields(next.hudFields);
    next.hudDock = normalizeHudDock(next.hudDock);
    next.theme = normalizeTheme(next.theme);
    if (next.pinnedFile !== null && typeof next.pinnedFile !== "string") next.pinnedFile = null;
    if (next.codexHome !== null && typeof next.codexHome !== "string") next.codexHome = null;
    if (next.hudPosition !== null) {
      const pos = next.hudPosition;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) next.hudPosition = null;
      else next.hudPosition = { x: Math.round(pos.x), y: Math.round(pos.y) };
    }
    this.data = next;
    this.scheduleSave();
    return this.all();
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
    this.saveTimer.unref?.();
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error("[codex-speed] 保存设置失败:", err.message);
    }
  }
}