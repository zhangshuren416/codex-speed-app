// 设置持久化：userData/settings.json。独立应用没有插件注入的目录，全部自己管。

import fs from "node:fs";
import path from "node:path";

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
});

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