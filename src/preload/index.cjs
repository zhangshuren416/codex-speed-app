// 预加载脚本：把最小化的 IPC 能力暴露给渲染进程。
// sandbox: true 的预加载必须是 CommonJS，不能写成 ESM。

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("codexSpeed", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  onSnapshot: (callback) => subscribe("snapshot", callback),
  onState: (callback) => subscribe("state", callback),
  onSettings: (callback) => subscribe("settings", callback),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  pinSession: (file) => ipcRenderer.invoke("session:pin", file),
  listSessions: (limit) => ipcRenderer.invoke("sessions:list", limit),
  showContextMenu: () => ipcRenderer.invoke("hud:context-menu"),
  hideHud: () => ipcRenderer.invoke("hud:hide"),
  toggleClickThrough: () => ipcRenderer.invoke("hud:toggle-click-through"),
  openDashboard: () => ipcRenderer.invoke("window:open-dashboard"),
  openUserData: () => ipcRenderer.invoke("app:open-user-data"),
  quit: () => ipcRenderer.invoke("app:quit"),
});