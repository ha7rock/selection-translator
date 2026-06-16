# Changelog

## [1.0.7] - 2026-05-29

### 修复（全面代码审查）

- 关闭 `all_frames` —— 之前 iframe 多注入导致 Discord/Notion 等页面创建多个 host
- `isInsideOurUI` 使用 `event.composedPath()` 兼容嵌套 Shadow DOM（Twitter Lite 等）
- `getActiveEditable` 加 selection 起点遍历，兼容闭合 Shadow Root 的 web component 输入框
- 拖动 panel 实时 clamp，不再可拖出视口
- `lastRange` → 普通 rect 对象，避免阻止 DOM GC
- 关闭 panel / `pagehide` 时停止音频，释放 Blob URL
- `removeBar` 复位 `replaceInFlight`
- `extraHeaders` 屏蔽 `Authorization` / `x-api-key` / `anthropic-*` 等敏感头
- 「测试 API」加 35s 客户端超时
- 配置导入限制 256 KB
- `popup.js` 用 textContent + DOM 构建，移除 innerHTML 注入面
- 模型自动拉取改用 `change` + IME composition 守卫

## [1.0.6] - 2026-05-21

- 修复定时器竞争：`mouseup`-显示 与 `selectionchange`-清空 拆分为独立 timer
- `ensureRoot` 检测 host 是否仍连接，SPA 移除后自动重建
- 启用 `all_frames` 以支持 iframe（后续 v1.0.7 因引发更多 bug 而回退）

## [1.0.5] - 2026-05-21

- **新增**：在 `<input>` / `<textarea>` / `contenteditable` 内选中文本，菜单显示**替换**和**润色**两个按钮，结果直接写回原位
- React/Vue 受控组件兼容：通过原生 value setter + dispatch input event
- 监听 `select` 事件以支持键盘选择

## [1.0.4] - 2026-05-21

- **新增**：设置页底部加「导出 / 导入」按钮（JSON，可选是否含 API Key）

## [1.0.3] - 2026-05-21

- 用 **Shadow DOM** 隔离样式，彻底解决在 `higgsfield.ai` 等激进 CSS 站点上样式被污染的问题
- CSS 通过 `<link>` 引用 `web_accessible_resources`，host 用 inline `!important` 锁住位置

## [1.0.2] - 2026-05-18

- 全面代码 Review + 修复 12 项问题（内存泄漏、并发保护、URL 校验、可访问性等）

## [1.0.1] - 2026-05-17

- 移除快捷键
- 菜单改为豆包式即时显示（不再需要先点「译」字球）
- 自定义下拉替代 datalist（避免预填值过滤模型列表）
- 设置页重做：现代卡片布局，自定义下拉，sticky 操作栏

## [1.0.0] - 2026-05-17

- 首版：划词复制 / 翻译
- 支持 Anthropic 与 OpenAI 兼容协议
- 模型列表自动拉取
- TTS 朗读（MiniMax T2A v2 协议）
