# Codex Speed Desktop

独立的 Codex 速度计桌面应用：读取本地 Codex 会话日志，用置顶悬浮窗显示实时推理速度。不需要 API Key，不联网，只读。目前仅支持 Windows。

![platform](https://img.shields.io/badge/platform-Windows-0078D4)

## 功能

- **悬浮窗**：透明、无边框、置顶、可拖动，显示当前 tok/s、状态、本轮 token 和最近速度曲线；拖到屏幕边缘自动吸附成小气泡，悬停展开、点击固定
- **仪表盘**：当前/本轮/会话指标、首 token 延迟、最近会话列表、最近几轮
- **多会话**：自动跟随最近写入的会话，也可以钉住任意会话
- **深色/浅色主题**：托盘菜单、悬浮窗右键菜单或仪表盘设置里切换，重启记忆
- **桌面集成**：托盘、点击穿透、不透明度、缩放、位置记忆、开机自启

## 数据

- 只读 `~/.codex/sessions` 和 `~/.codex/archived_sessions`，不修改任何文件
- 支持 `CODEX_HOME` 环境变量，也可以在仪表盘里指定数据目录
- Codex 在每次响应结束后才写入 token 用量，因此速度是每次响应的平均值，不是逐 token 实时值

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Alt+S` | 切换点击穿透 |
| `Ctrl+Alt+H` | 显示 / 隐藏悬浮窗 |

## 开发

需要 Node.js 18+。

```bash
npm install
npm start      # 启动应用
npm test       # 单元测试
npm run smoke  # 不开窗口，读本机日志并打印摘要
```

打包：

```bash
npm run dist:win   # 安装包 + 便携版
```

## 已知限制

- 暂未实现自动更新和多语言

## License

MIT
