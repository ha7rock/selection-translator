// options.js
const DEFAULTS = {
  provider: 'anthropic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiKey: '',
  model: '',                              // 不再预填
  anthropicVersion: '2023-06-01',
  targetLanguage: 'auto',
  systemPrompt: '',
  temperature: 0.2,
  maxTokens: 1024,
  extraHeaders: '',
  // TTS
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

const PROVIDER_PRESETS = {
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    hint: '可填全 URL（https://api.anthropic.com/v1/messages）或 base URL（如 https://api.minimaxi.com/anthropic）—— 系统会自动补 /v1/messages。'
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    hint: '可填全 URL 或 base URL，例：https://api.openai.com、https://api.deepseek.com/v1、本地 Ollama 等 —— 系统自动补 /v1/chat/completions。'
  }
};

const $ = (id) => document.getElementById(id);

function applyProviderHint(provider) {
  $('endpoint-hint').textContent = PROVIDER_PRESETS[provider]?.hint || '';
  document.querySelectorAll('.anth-only').forEach((el) => {
    el.classList.toggle('hidden', provider !== 'anthropic');
  });
}

async function load() {
  const cfg = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...cfg };
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!merged[key];
    else el.value = merged[key] ?? '';
  }
  applyProviderHint(merged.provider);

  if (merged.endpoint && merged.apiKey) {
    maybeFetchModels();
  }
}

function currentFormValues() {
  const NUM_FIELDS = {
    temperature: 'float', maxTokens: 'int',
    ttsSpeed: 'float', ttsVol: 'float', ttsPitch: 'float',
    ttsSampleRate: 'int', ttsBitrate: 'int', ttsChannel: 'int'
  };
  const data = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') {
      data[key] = !!el.checked;
      continue;
    }
    let val = el.value;
    const t = NUM_FIELDS[key];
    if (t === 'float') val = parseFloat(val) || 0;
    else if (t === 'int') val = parseInt(val, 10) || 0;
    data[key] = val;
  }
  return data;
}

async function save() {
  const data = currentFormValues();
  if (data.extraHeaders && data.extraHeaders.trim()) {
    try { JSON.parse(data.extraHeaders); }
    catch (e) { setStatus('附加请求头不是合法 JSON', true); return; }
  }
  if (data.ttsEnabled) {
    if (!data.ttsApiKey || !data.ttsApiKey.trim()) {
      setStatus('启用朗读需要填写 TTS API Key', true);
      return;
    }
    if (!data.ttsEndpoint || !data.ttsEndpoint.trim()) {
      setStatus('启用朗读需要填写 TTS Endpoint', true);
      return;
    }
  }
  await chrome.storage.sync.set(data);
  setStatus('已保存 ✓', false);
}

async function reset() {
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  setStatus('已恢复默认设置', false);
}

async function test() {
  const out = $('test-output');
  out.hidden = false;
  out.textContent = '正在测试 …';
  setStatus('测试中…', false);
  const override = currentFormValues();
  let settled = false;
  const guard = setTimeout(() => {
    if (settled) return;
    settled = true;
    out.textContent = '✗ 测试超时（service worker 可能已停止）';
    setStatus('测试超时', true);
  }, 35000);
  chrome.runtime.sendMessage({ type: 'TEST_API', override }, (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (chrome.runtime.lastError) {
      out.textContent = '扩展通信失败：' + chrome.runtime.lastError.message;
      setStatus('测试失败', true);
      return;
    }
    if (response?.ok) {
      out.textContent = '✓ 调用成功\n译文：\n' + response.text;
      setStatus('测试成功 ✓', false);
    } else {
      out.textContent = '✗ 失败：\n' + (response?.error || '未知错误');
      setStatus('测试失败', true);
    }
  });
}

// ---------- 模型列表自动拉取 ----------
let lastFetchKey = '';
let lastFetchAt = 0;
let fetchingPromise = null;
let autoFetchTimer = null;
let allModels = [];

function fetchKey(cfg) {
  return `${cfg.provider}|${cfg.endpoint}|${cfg.apiKey}|${cfg.anthropicVersion}|${cfg.extraHeaders}`;
}

function setModelsStatus(text, isErr) {
  const el = $('models-status');
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}

function maybeFetchModels(force) {
  clearTimeout(autoFetchTimer);
  autoFetchTimer = setTimeout(() => fetchModels(force), 350);
}

async function fetchModels(force) {
  const cfg = currentFormValues();
  if (!cfg.endpoint || !cfg.apiKey) {
    setModelsStatus('', false);
    return;
  }
  const key = fetchKey(cfg);
  if (!force && key === lastFetchKey && (Date.now() - lastFetchAt) < 5 * 60 * 1000) {
    return;
  }
  if (fetchingPromise) return fetchingPromise;

  setModelsStatus('正在拉取模型…', false);
  fetchingPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (status, err) => {
      if (settled) return;
      settled = true;
      fetchingPromise = null;
      if (err) setModelsStatus(err, true);
      else setModelsStatus(status, false);
      resolve();
    };
    const guard = setTimeout(() => {
      finish(null, '拉取超时');
    }, 35000);

    chrome.runtime.sendMessage({ type: 'LIST_MODELS', override: cfg }, (response) => {
      clearTimeout(guard);
      if (chrome.runtime.lastError) {
        finish(null, '拉取失败：' + chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok && Array.isArray(response.models)) {
        allModels = response.models;
        lastFetchKey = key;
        lastFetchAt = Date.now();
        finish(`已加载 ${response.models.length} 个模型`);
        // 若下拉是打开状态则刷新
        if (combobox.isOpen) combobox.render();
      } else {
        allModels = [];
        finish(null, (response && response.error) || '拉取失败');
      }
    });
  });
  return fetchingPromise;
}

// ---------- 自定义 Combobox ----------
const combobox = {
  isOpen: false,
  filtering: false,           // true: 用户在键入；false: 显示全部
  activeIndex: -1,
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.filtering = false;
    this.activeIndex = -1;
    $('model-combobox').classList.add('is-open');
    $('model').setAttribute('aria-expanded', 'true');
    $('model-list').hidden = false;
    this.render();
  },
  close() {
    this.isOpen = false;
    $('model-combobox').classList.remove('is-open');
    $('model').setAttribute('aria-expanded', 'false');
    $('model-list').hidden = true;
  },
  toggle() {
    if (this.isOpen) this.close();
    else { $('model').focus(); this.open(); }
  },
  render() {
    const list = $('model-list');
    const inputVal = $('model').value;
    const filter = (this.filtering && inputVal) ? inputVal.toLowerCase() : '';
    const items = filter
      ? allModels.filter((m) => m.toLowerCase().includes(filter))
      : allModels.slice();

    list.innerHTML = '';
    if (!allModels.length) {
      const li = document.createElement('li');
      li.className = 'combobox-empty';
      li.textContent = '尚无模型列表（请填 Endpoint + API Key，或直接输入模型名）';
      list.appendChild(li);
      return;
    }
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'combobox-empty';
      li.textContent = `没有匹配 "${inputVal}" 的模型（可直接使用当前输入值）`;
      list.appendChild(li);
      return;
    }
    items.forEach((m, idx) => {
      const li = document.createElement('li');
      li.textContent = m;
      li.dataset.value = m;
      if (m === inputVal) li.classList.add('is-selected');
      if (idx === this.activeIndex) li.classList.add('is-active');
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(m);
      });
      list.appendChild(li);
    });
  },
  select(value) {
    $('model').value = value;
    this.close();
  },
  moveActive(delta) {
    if (!this.isOpen) { this.open(); return; }
    const items = $('model-list').querySelectorAll('li:not(.combobox-empty)');
    if (!items.length) return;
    this.activeIndex = (this.activeIndex + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('is-active', i === this.activeIndex));
    const el = items[this.activeIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  },
  acceptActive() {
    const items = $('model-list').querySelectorAll('li:not(.combobox-empty)');
    if (this.activeIndex >= 0 && items[this.activeIndex]) {
      this.select(items[this.activeIndex].dataset.value);
    } else {
      this.close();
    }
  }
};

function bindCombobox() {
  const input = $('model');
  const toggleBtn = $('combobox-toggle');
  const wrap = $('model-combobox');

  input.addEventListener('focus', () => combobox.open());
  input.addEventListener('click', () => combobox.open());
  input.addEventListener('input', () => {
    combobox.filtering = true;
    combobox.activeIndex = -1;
    combobox.open();
    combobox.render();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!wrap.contains(document.activeElement)) combobox.close();
    }, 100);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); combobox.moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); combobox.moveActive(-1); }
    else if (e.key === 'Enter') {
      if (combobox.isOpen && combobox.activeIndex >= 0) {
        e.preventDefault();
        combobox.acceptActive();
      } else if (combobox.isOpen) {
        combobox.close();
      }
    }
    else if (e.key === 'Escape') { combobox.close(); }
  });
  toggleBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    combobox.toggle();
    if (combobox.isOpen) input.focus();
  });
}

// ---------- 通用 ----------
function setStatus(text, isErr) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('err', !!isErr);
  if (text && !isErr) {
    setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2200);
  }
}

// ---------- 配置导入 / 导出 ----------
async function exportConfig() {
  const cfg = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const data = { ...DEFAULTS, ...cfg };

  // 询问是否包含敏感字段
  const includeKeys = window.confirm(
    '导出文件将包含以下敏感字段：\n  · API Key\n  · TTS API Key\n\n点「确定」=> 导出含密钥的完整配置（妥善保管文件！）\n点「取消」=> 导出不含密钥的配置（迁移到新设备后需重填）'
  );
  if (!includeKeys) {
    data.apiKey = '';
    data.ttsApiKey = '';
  }

  const payload = {
    __version: 1,
    __exportedAt: new Date().toISOString(),
    config: data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `selection-translator-config-${ts}${includeKeys ? '-with-keys' : ''}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
  setStatus(includeKeys ? '已导出（含密钥）✓' : '已导出（不含密钥）✓', false);
}

function triggerImport() {
  $('import-file').click();
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';                  // 允许选同一文件再次导入
  if (!file) return;
  if (file.size > 256 * 1024) {
    setStatus('文件过大（>256KB），疑似非配置文件', true);
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const cfg = parsed && parsed.config ? parsed.config : parsed;
    if (!cfg || typeof cfg !== 'object') throw new Error('JSON 结构不合法');
    // 只接受已知字段（防止注入未知键）
    const filtered = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(cfg, key)) {
        filtered[key] = cfg[key];
      }
    }
    if (Object.keys(filtered).length === 0) {
      setStatus('文件中没有可识别的配置字段', true);
      return;
    }
    if (!window.confirm(
      `将导入 ${Object.keys(filtered).length} 项配置，并覆盖当前设置。继续？`
    )) return;
    await chrome.storage.sync.set(filtered);
    await load();
    setStatus(`已导入 ${Object.keys(filtered).length} 项配置 ✓`, false);
  } catch (err) {
    setStatus('导入失败：' + (err && err.message || String(err)), true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('reset').addEventListener('click', reset);
  $('export').addEventListener('click', exportConfig);
  $('import').addEventListener('click', triggerImport);
  $('import-file').addEventListener('change', handleImportFile);
  $('refresh-models').addEventListener('click', () => fetchModels(true));
  bindCombobox();

  // 切换 API key 显示/隐藏
  $('toggle-key').addEventListener('click', () => {
    const inp = $('apiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  const ttsKeyToggle = $('toggle-tts-key');
  if (ttsKeyToggle) {
    ttsKeyToggle.addEventListener('click', () => {
      const inp = $('ttsApiKey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  }

  // endpoint / apiKey / version / extraHeaders 变化自动重拉
  // 用 change 触发（焦点离开/Enter 时），避免：
  //   1) 边输入 sk-... 边发请求（中间态 Key 必失败）
  //   2) IME composition 期间错误触发
  // 同时保留 input 事件但带 IME 守卫，输入很久（800ms）后才尝试
  ['endpoint', 'apiKey', 'anthropicVersion', 'extraHeaders'].forEach((id) => {
    const el = $(id);
    let composing = false;
    let inputTimer = null;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => {
      composing = false;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => maybeFetchModels(false), 800);
    });
    el.addEventListener('input', () => {
      if (composing) return;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => maybeFetchModels(false), 800);
    });
    el.addEventListener('change', () => {
      clearTimeout(inputTimer);
      maybeFetchModels(false);
    });
  });

  $('provider').addEventListener('change', (e) => {
    const v = e.target.value;
    applyProviderHint(v);
    const preset = PROVIDER_PRESETS[v];
    if (preset) {
      const currentEndpoint = $('endpoint').value;
      if (!currentEndpoint || Object.values(PROVIDER_PRESETS).some((p) => p.endpoint === currentEndpoint)) {
        $('endpoint').value = preset.endpoint;
      }
    }
    lastFetchKey = '';
    allModels = [];
    setModelsStatus('', false);
    maybeFetchModels(false);
  });
});
