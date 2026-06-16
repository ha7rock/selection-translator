# 划词翻译助手 · Selection Translator

[![Release](https://img.shields.io/github/v/release/ha7rock/selection-translator)](https://github.com/ha7rock/selection-translator/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ha7rock/selection-translator?style=social)](https://github.com/ha7rock/selection-translator)

仿豆包 Chrome 扩展的本地浏览器插件 —— 选中网页文本即可**复制 / 翻译 / 朗读 / 替换 / 润色**。

支持自定义 API 节点：

- **Anthropic 兼容**（`/v1/messages`）—— 官方 `api.anthropic.com` 或自建代理
- **OpenAI 兼容**（`/v1/chat/completions`）—— OpenAI、DeepSeek、Together、本地 vLLM/Ollama 等
- **MiniMax T2A v2 协议**（用于 TTS 朗读）

## 功能

### 划词菜单（豆包式即时显示）

| 按钮 | 功能 |
|---|---|
| 📋 复制 | 复制选中文本到剪贴板 |
| 🌐 翻译 | 弹出可拖动浮窗显示译文，可重试、临时切换目标语言、复制译文 |
| 🔊 朗读 | 调用 MiniMax TTS 即时合成播放，再点一次停止 |
| 🔄 替换 | （仅在 `<input>` / `<textarea>` / `contenteditable` 内）翻译并原位写回 |
| ✨ 润色 | （同上）用 AI 改写得更地道流畅，保持原语言 |

### 设置页

- 协议切换（Anthropic / OpenAI 兼容）
- Endpoint 自动规范化：可填全 URL（`.../v1/messages`）或 base URL（`.../anthropic`），系统自动补齐
- 模型自动拉取：填好 Endpoint + API Key 后，模型框点击即显示节点的可用模型列表
- 自定义提示词、Temperature、Max Tokens
- TTS 配置（启用开关、Endpoint、Key、模型、音色、语速、音量、音调）
- 配置导出 / 导入（JSON，可选是否含密钥）

### 技术亮点

- **Shadow DOM 隔离**：菜单 UI 装在 closed shadow root，宿主页面 CSS 完全无法干扰
- **Service Worker MV3**：API 请求由 background 直发，无 CORS 问题
- **React / Vue 控件兼容**：替换原位写回时通过原生 `value` setter + dispatch input event，确保框架状态同步
- **嵌套 Shadow / 闭合 Web Component 兼容**：用 `composedPath()` 和 selection 起点遍历定位
- **隐私**：API Key 仅保存在 `chrome.storage.sync`，不经过任何第三方服务器

## 安装

### 方式 A：开发者模式（推荐用于自定义）

1. 下载源码或克隆本仓库
2. Chrome 访问 `chrome://extensions`
3. 开启「开发者模式」
4. 点「加载已解压的扩展程序」
5. 选择本目录（包含 `manifest.json` 的文件夹）

### 方式 B：从 Release 安装

1. 前往 Releases 页面下载最新 `selection-translator.zip`
2. 解压后按方式 A 加载

## 配置

点工具栏图标 → **打开设置** → 填好：

| 字段 | 示例 |
|---|---|
| 协议 | `Anthropic` 或 `OpenAI 兼容` |
| Endpoint | `https://api.anthropic.com/v1/messages` 或 `https://api.minimaxi.com/anthropic` |
| API Key | 节点对应的 key |
| 模型 | 点击下拉箭头从节点自动加载，或手动输入 |

点「测试 API」验证连通 → 保存。

### 节点示例

| 协议 | Endpoint | 模型 |
|---|---|---|
| Anthropic 官方 | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-5` |
| MiniMax Anthropic 网关 | `https://api.minimaxi.com/anthropic` | `MiniMax-M2.7` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| Ollama 本地 | `http://localhost:11434/v1/chat/completions` | `qwen2.5:7b` |

## 隐私

- 所有配置仅保存在 `chrome.storage.sync`（由 Chrome 加密同步到用户自己的 Google 账号）
- API 请求由 service worker 直接发往用户填写的节点，**不经过任何第三方**
- 选中文本仅在用户主动触发时才发起 API 调用
- 本扩展不使用任何分析、追踪或广告 SDK

## 文件结构

```
selection-translator/
├── manifest.json          # Manifest V3
├── background.js          # Service Worker：API 调用 / 右键菜单
├── content.js             # 注入页面：Shadow DOM UI / 选区检测 / TTS 播放
├── content.css            # Shadow 内样式（:host 选择器）
├── options.html/css/js    # 设置页
├── popup.html / popup.js  # 工具栏弹窗
├── icons/                 # 16/48/128 图标
├── CHANGELOG.md
├── LICENSE                # MIT
└── README.md
```

## License

MIT
