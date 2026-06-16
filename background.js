// background.js — Service Worker (classic, 非 module)
// 翻译：Anthropic (/v1/messages) 与 OpenAI 兼容 (/v1/chat/completions) 两种协议
// 模型列表：自动从 endpoint 推导 /v1/models 端点拉取

const DEFAULT_CONFIG = {
  provider: 'anthropic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiKey: '',
  model: 'claude-sonnet-4-5',
  anthropicVersion: '2023-06-01',
  targetLanguage: 'auto',
  systemPrompt: '',
  temperature: 0.2,
  maxTokens: 1024,
  extraHeaders: '',
  // ---- TTS (MiniMax T2A v2 协议) ----
  ttsEnabled: false,
  ttsEndpoint: 'https://api.minimaxi.com/v1/t2a_v2',
  ttsApiKey: '',
  ttsModel: 'speech-2.8-hd',
  ttsVoiceId: 'male-qn-qingse',
  ttsSpeed: 1,
  ttsVol: 1,
  ttsPitch: 0,
  ttsSampleRate: 32000,
  ttsBitrate: 128000,
  ttsFormat: 'mp3',
  ttsChannel: 1
};

const FETCH_TIMEOUT_MS = 25000;

async function getConfig() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG));
  return { ...DEFAULT_CONFIG, ...stored };
}

// 带超时的 fetch
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('timeout', 'AbortError')), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}

function parseExtraHeaders(extra) {
  if (!extra || !extra.trim()) return {};
  let obj;
  try {
    obj = JSON.parse(extra);
  } catch (e) {
    throw new Error('附加请求头不是合法 JSON：' + (e && e.message || ''));
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('附加请求头必须是 JSON 对象');
  }
  // 过滤掉危险或会覆盖鉴权的请求头
  const banned = new Set([
    'host', 'content-length', 'cookie',
    'authorization',                           // 禁止覆盖鉴权
    'x-api-key',                               // Anthropic 鉴权
    'anthropic-version',
    'anthropic-dangerous-direct-browser-access'
  ]);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (banned.has(String(k).toLowerCase())) continue;
    result[k] = typeof v === 'string' ? v : String(v);
  }
  return result;
}

// 把用户填的 endpoint 规范化到具体的 chat 端点
//   anthropic → 必须以 /messages 结尾
//   openai    → 必须以 /chat/completions 结尾
// 若已正确则原样返回；若是 base URL 则自动补齐 /v1/xxx
function normalizeEndpoint(endpoint, provider) {
  let u;
  try {
    u = new URL(endpoint);
  } catch (e) {
    throw new Error(`Endpoint 不是合法 URL：${endpoint}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Endpoint 协议必须是 http(s)：${u.protocol}`);
  }
  let path = u.pathname.replace(/\/+$/, '');
  const suffix = provider === 'anthropic' ? '/messages' : '/chat/completions';
  if (path.endsWith(suffix)) {
    u.search = '';
    return u.toString();
  }
  if (/\/v\d+$/.test(path)) {
    u.pathname = path + suffix;
  } else {
    u.pathname = path + '/v1' + suffix;
  }
  u.search = '';
  return u.toString();
}

// ---------- 右键菜单 ----------
chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    try {
      chrome.contextMenus.create({ id: 'st-translate', title: '翻译选中文本', contexts: ['selection'] });
      chrome.contextMenus.create({ id: 'st-copy', title: '复制选中文本', contexts: ['selection'] });
    } catch (e) { /* ignore */ }
  });
});

chrome.contextMenus && chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  const url = tab.url || '';
  // 限制：chrome:// / about: / edge:// / chrome-extension:// 等无法注入 content script
  if (/^(chrome|about|edge|brave|opera|chrome-extension|view-source):/i.test(url)) {
    return; // 直接忽略，用户在系统页面右键不应该触发
  }
  const type = info.menuItemId === 'st-translate' ? 'TRIGGER_TRANSLATE'
             : info.menuItemId === 'st-copy'      ? 'TRIGGER_COPY'
             : null;
  if (!type) return;
  chrome.tabs.sendMessage(tab.id, { type, text: info.selectionText || '' }, () => {
    // 兜底：忽略 lastError（页面未注入 content script）
    if (chrome.runtime.lastError) { /* swallow */ }
  });
});

// ---------- 消息分发（保证 sendResponse 一定被调用） ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const safe = (fn) => {
    Promise.resolve()
      .then(fn)
      .then((payload) => { try { sendResponse(payload); } catch (_) {} })
      .catch((err) => { try { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); } catch (_) {} });
  };

  if (!msg || typeof msg !== 'object') return false;

  switch (msg.type) {
    case 'TRANSLATE':
      safe(async () => {
        const text = await handleTranslate(msg.text, msg.targetLanguage);
        return { ok: true, text };
      });
      return true;
    case 'GET_CONFIG':
      safe(async () => await getConfig());
      return true;
    case 'TEST_API':
      safe(async () => {
        const text = await handleTranslate('Hello, world.', '中文', msg.override);
        return { ok: true, text };
      });
      return true;
    case 'LIST_MODELS':
      safe(async () => {
        const models = await listModels(msg.override);
        return { ok: true, models };
      });
      return true;
    case 'TTS':
      safe(async () => {
        const result = await ttsSynthesize(msg.text, msg.override);
        return { ok: true, ...result };
      });
      return true;
    default:
      return false;
  }
});

// ---------- 翻译核心 ----------
async function handleTranslate(text, targetLanguageOverride, configOverride) {
  if (!text || !text.trim()) throw new Error('无文本可翻译');
  const cfg = configOverride
    ? { ...DEFAULT_CONFIG, ...configOverride }
    : await getConfig();
  if (!cfg.apiKey) throw new Error('请先在扩展设置中填写 API Key');
  if (!cfg.endpoint) throw new Error('请先在扩展设置中填写 API Endpoint');

  const targetLang = targetLanguageOverride || cfg.targetLanguage || 'auto';
  const { systemPrompt, userPrompt } = buildPrompt(text, targetLang, cfg.systemPrompt);

  if (cfg.provider === 'anthropic') {
    return await callAnthropic(cfg, systemPrompt, userPrompt);
  }
  return await callOpenAI(cfg, systemPrompt, userPrompt);
}

function buildPrompt(text, targetLang, customSystem) {
  const isAuto = !targetLang || targetLang === 'auto';
  // 特殊模式：__polish__ → 同语言润色改写
  if (targetLang === '__polish__') {
    const sys = '你是一名专业写作助手。请把用户输入改写得更地道、流畅、自然，但保持原意与原语言不变。只输出改写后的文本，不要解释、前后缀、引号或代码块。保持原文的换行与基本格式。';
    return { systemPrompt: sys, userPrompt: text };
  }
  const sys = (customSystem && customSystem.trim()) || (
    isAuto
      ? '你是一名专业翻译。规则：若输入主要是中文则翻译为英文；否则翻译为中文。只输出译文本身，不要任何前后缀、解释、引号或代码块。保持原文的换行与基本格式。'
      : `你是一名专业翻译。请将用户输入翻译为${targetLang}。只输出译文本身，不要任何前后缀、解释、引号或代码块。保持原文的换行与基本格式。`
  );
  return { systemPrompt: sys, userPrompt: text };
}

// ---------- Anthropic ----------
async function callAnthropic(cfg, systemPrompt, userPrompt) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': cfg.anthropicVersion || '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...parseExtraHeaders(cfg.extraHeaders)
  };
  const body = {
    model: cfg.model,
    max_tokens: Number(cfg.maxTokens) || 1024,
    temperature: Number(cfg.temperature) || 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  const url = normalizeEndpoint(cfg.endpoint, cfg.provider);
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await safeReadText(res);
    throw new Error(`Anthropic 调用失败 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  if (Array.isArray(data && data.content)) {
    const out = data.content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text)
      .join('');
    if (out) return out.trim();
  }
  if (data && typeof data.completion === 'string') return data.completion.trim();
  throw new Error('Anthropic 响应解析失败：' + JSON.stringify(data).slice(0, 300));
}

// ---------- OpenAI 兼容 ----------
async function callOpenAI(cfg, systemPrompt, userPrompt) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
    ...parseExtraHeaders(cfg.extraHeaders)
  };
  const body = {
    model: cfg.model,
    temperature: Number(cfg.temperature) || 0,
    max_tokens: Number(cfg.maxTokens) || 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  const url = normalizeEndpoint(cfg.endpoint, cfg.provider);
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await safeReadText(res);
    throw new Error(`OpenAI 兼容接口调用失败 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
    || (data && data.choices && data.choices[0] && data.choices[0].text)
    || (data && data.output_text);
  if (typeof msg === 'string') return msg.trim();
  throw new Error('OpenAI 响应解析失败：' + JSON.stringify(data).slice(0, 300));
}

// ---------- 模型列表 ----------
function deriveModelsUrl(endpoint) {
  try {
    const u = new URL(endpoint);
    let path = u.pathname.replace(/\/+$/, '');

    // 先剥掉已知 chat 后缀，再统一处理
    if (path.endsWith('/chat/completions')) path = path.replace(/\/chat\/completions$/, '');
    else if (path.endsWith('/messages'))   path = path.replace(/\/messages$/, '');
    else if (path.endsWith('/completions')) path = path.replace(/\/completions$/, '');

    if (path.endsWith('/models')) {
      // 已是 /models 端点
    } else if (/\/v\d+$/.test(path)) {
      path = path + '/models';
    } else {
      path = (path || '') + '/v1/models';
    }
    u.pathname = path;
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function listModels(configOverride) {
  const cfg = configOverride
    ? { ...DEFAULT_CONFIG, ...configOverride }
    : await getConfig();
  if (!cfg.endpoint) throw new Error('请先填写 Endpoint');
  if (!cfg.apiKey) throw new Error('请先填写 API Key');

  const modelsUrl = deriveModelsUrl(cfg.endpoint);
  if (!modelsUrl) throw new Error('无法从 Endpoint 推导模型列表 URL');

  let headers;
  if (cfg.provider === 'anthropic') {
    headers = {
      'x-api-key': cfg.apiKey,
      'anthropic-version': cfg.anthropicVersion || '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      ...parseExtraHeaders(cfg.extraHeaders)
    };
  } else {
    headers = {
      'Authorization': `Bearer ${cfg.apiKey}`,
      ...parseExtraHeaders(cfg.extraHeaders)
    };
  }

  let res;
  try {
    res = await fetchWithTimeout(modelsUrl, { method: 'GET', headers }, 15000);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`拉取模型超时 @ ${modelsUrl}`);
    throw new Error(`网络错误：${(e && e.message) || e} @ ${modelsUrl}`);
  }

  if (!res.ok) {
    const errText = await safeReadText(res);
    if (res.status === 404) {
      throw new Error(`节点不支持模型枚举接口 (404 @ ${modelsUrl})\n请直接在「模型」框中手动输入模型名（输入框可自由输入）。`);
    }
    throw new Error(`拉取模型列表失败 (${res.status}) @ ${modelsUrl}\n${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  let items = data && data.data;
  if (!Array.isArray(items) && data && Array.isArray(data.models)) items = data.models;
  if (!Array.isArray(items)) {
    throw new Error('模型列表响应格式未知：' + JSON.stringify(data).slice(0, 200));
  }
  const ids = items
    .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model))))
    .filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

// ---------- TTS（MiniMax T2A v2） ----------
async function ttsSynthesize(text, configOverride) {
  if (!text || !text.trim()) throw new Error('无文本可合成');
  const cfg = configOverride
    ? { ...DEFAULT_CONFIG, ...configOverride }
    : await getConfig();
  if (!cfg.ttsApiKey) throw new Error('请先在「语音朗读」设置中填写 TTS API Key');
  if (!cfg.ttsEndpoint) throw new Error('请先填写 TTS Endpoint');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.ttsApiKey}`
  };
  const body = {
    model: cfg.ttsModel || 'speech-2.8-hd',
    text: text,
    stream: false,
    voice_setting: {
      voice_id: cfg.ttsVoiceId || 'male-qn-qingse',
      speed: Number(cfg.ttsSpeed) || 1,
      vol: Number(cfg.ttsVol) || 1,
      pitch: Number(cfg.ttsPitch) || 0
    },
    audio_setting: {
      sample_rate: Number(cfg.ttsSampleRate) || 32000,
      bitrate: Number(cfg.ttsBitrate) || 128000,
      format: cfg.ttsFormat || 'mp3',
      channel: Number(cfg.ttsChannel) || 1
    },
    pronunciation_dict: { tone: [] },
    subtitle_enable: false,
    output_format: 'hex'
  };
  const res = await fetchWithTimeout(cfg.ttsEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, 30000);
  if (!res.ok) {
    const errText = await safeReadText(res);
    throw new Error(`TTS 调用失败 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  // MiniMax 响应：{ data: { audio: "hex...", status: 2 }, base_resp: { status_code: 0 } }
  if (data && data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(`TTS 业务错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg || ''}`);
  }
  const audioHex = data && (data.data && data.data.audio) || data && data.audio;
  if (!audioHex || typeof audioHex !== 'string') {
    throw new Error('TTS 响应解析失败：' + JSON.stringify(data).slice(0, 300));
  }
  return { audioHex, format: cfg.ttsFormat || 'mp3' };
}
