# Codex Speed Desktop

独立的 Codex 速度计桌面应用：直接读取本地 Codex 会话日志，用置顶悬浮窗显示实时推理速度。**不依赖 Codex 插件**，不需要 API Key，不联网，只读。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4)
![electron](https://img.shields.io/badge/electron-45-47848F)

## 功能

- **悬浮窗**：透明、无边框、置顶、可拖动，显示当前 tok/s、状态、本轮 token 和最近速度曲线
- **边缘吸附**：拖到屏幕边缘自动收成贴边小气泡，悬停展开、点击固定、拖走恢复，重启后记忆
- **仪表盘**：当前/本轮/会话指标、首 token 延迟、最近会话列表、最近几轮
- **多会话**：自动跟随最近写入的会话，也可以随时钉住任意会话（独立应用没有插件注入的 `threadId`）
- **深色/浅色主题**：在托盘菜单、悬浮窗右键菜单或仪表盘设置「主题」里切换，悬浮窗/气泡/迷你曲线/仪表盘同步换肤，原生菜单跟随，重启记忆。浅色为纯白实色卡片 + 近黑文字（强制不透明，避免半透明白卡发灰）；「不透明度」滑杆作用于深色模式
- **桌面集成**：托盘、点击穿透、不透明度、缩放、位置记忆、开机自启
- **跨平台**：Windows、macOS、Linux（Wayland 有限制，见下）

## 数据与口径

- 只读 `~/.codex/sessions` 和 `~/.codex/archived_sessions`，不改任何文件
- 支持 `CODEX_HOME`，也可以在仪表盘里指定数据目录（例如指向 WSL 里的 `~/.codex`）
- Codex 只在一次模型响应**结束后**才落盘 token 用量，所以速度是**每次响应的平均值**，不是逐 token 实时值；悬浮窗的「生成中 Ns」是墙钟计时
- 计时口径与插件版一致：分母是「提示就绪 → 响应结束」，不含工具执行时间；最近 3 次响应按 token 加权

## 开发

需要 Node.js 18+。

```bash
npm install
npm start        # 启动应用（HUD + 托盘）
npm test         # 引擎单元测试（node:test）
npm run smoke    # 不开窗口，直接读本机日志并打印摘要
```

国内网络下载 Electron 二进制较慢时：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_CACHE  = "$PWD\.cache\electron"
npm install
```

项目自带 `.npmrc`，npm 缓存会落在项目内的 `.cache/npm`。

### 调试

| 环境变量 | 作用 |
| --- | --- |
| `CODEX_SPEED_DEBUG=1` | 启动后打印 HUD / 仪表盘的渲染器自检结果到 `userData/logs/main.log` |
| `CODEX_SPEED_USER_DATA=<dir>` | 便携模式：把设置、日志、缓存写到指定目录 |
| `CODEX_SPEED_HOME=<dir>` | 覆盖 Codex 数据目录（等价于设置里的「Codex 数据目录」） |
| `CODEX_SPEED_SMOKE=1` | 不显示窗口，只跑一次引擎并退出（CI 用） |

日志文件位置：Windows `%APPDATA%\Codex Speed\logs\main.log`，macOS `~/Library/Application Support/Codex Speed/logs/main.log`，Linux `~/.config/Codex Speed/logs/main.log`。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Alt+S` | 切换点击穿透（HUD 不挡鼠标；托盘菜单也能开） |
| `Ctrl+Alt+H` | 显示 / 隐藏悬浮窗 |
| 右键 HUD / `⋯` | 悬浮窗菜单 |

## 边缘吸附

「边缘自动吸附」默认开启，可在托盘菜单、悬浮窗右键菜单或仪表盘设置里关闭：

- 把悬浮窗拖到屏幕工作区边缘约 24px 内松手，自动吸到最近的一条边，收成一个 40px 的圆形气泡；气泡显示紧凑速度和状态点（生成中为绿色）
- **悬停**气泡即从屏幕边缘滑出完整悬浮窗（带弹出动画），鼠标移开约 0.35 秒后滑回收回
- **点击**气泡固定展开（鼠标移开不收回）；右键菜单「收起为气泡」收回、「解除边缘吸附」恢复普通窗口
- **拖动**气泡可沿边缘移动；拖离边缘则恢复完整悬浮窗
- 吸附状态写入 `settings.json`，重启后直接以气泡形态恢复；多显示器按原显示器恢复，显示器拔掉时回落主屏
- 托盘「显示悬浮窗」/ `Ctrl+Alt+H` 唤起时会展开并固定，避免鼠标不在上面又缩回去

## 打包

```bash
npm run dist:win     # NSIS 安装包 + 便携版
npm run dist:mac     # DMG
npm run dist:linux   # AppImage + deb
```

首次打包时 electron-builder 会下载 NSIS 等工具，网络慢可以设置镜像：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

分发前需要处理签名，否则用户会遇到系统拦截：

- **Windows**：无签名会有 SmartScreen 警告；可先用便携版或 Scoop 分发
- **macOS**：需要 Developer ID 证书 + notarize + hardened runtime，否则 Gatekeeper 直接拦截
- **Linux**：AppImage / deb 基本无阻碍

## 目录结构

```
src/main/index.mjs          主进程：窗口、托盘、设置、IPC、快捷键
src/main/settings.mjs       设置持久化（userData/settings.json）
src/main/engine/            数据引擎（来自 codex-speed 插件，已改为独立运行）
  paths.mjs                 定位 ~/.codex 与 rollout 文件
  rollout.mjs               增量读取 JSONL、状态机、速度样本
  metrics.mjs               由样本推导指标
  monitor.mjs               会话跟随 / 钉住 / 多会话列表
src/preload/index.cjs       contextBridge 暴露的最小 IPC API
src/renderer/               HUD 与仪表盘（原生 HTML/CSS/JS，无框架）
test/                       引擎单元测试
scripts/smoke.mjs           冒烟检查
scripts/make-icons.ps1      生成应用与托盘图标
```

## 与插件版的关系

- 引擎逻辑来自 [codex-speed](https://github.com/zhangshuren416/codex-speed)（MIT），但独立应用不加载插件、不跑 MCP、不开本地 HTTP 端口
- 插件继续提供 Codex 会话右侧的速度面板和对模型问答的能力；两者可以共存，但本应用完全不依赖插件
- 当前引擎是复制而非共享包；改动计时口径时需要两边同步（后续可以把 core 抽成独立包）
- 桌面版修正了插件版的一个解析边界问题：日志以换行结尾时，最后一条事件不会被误当成半行留到下一次写入（否则会话结束时最后一轮可能一直显示「生成中」）

## 已知限制

- **Wayland**：协议不提供全局置顶/定位，悬浮窗可能无法置顶或定位，建议在 X11 会话下使用
- **macOS 全屏**：靠 `screen-saver` 窗口层级压在其它 App 之上；个别全屏应用仍可能覆盖
- **实时性**：日志没有逐 token 数据，只有每次响应结束后的用量
- 暂未实现自动更新、代码签名脚本和多语言

## License

MIT