// content.js — 选区上方即时显示「复制 / 翻译」菜单（豆包风格）
(() => {
  if (window.__SELECTION_TRANSLATOR_INJECTED__) return;
  window.__SELECTION_TRANSLATOR_INJECTED__ = true;

  const ROOT_ID = 'selection-translator-root';
  const BAR_ID = 'selection-translator-bar';
  const PANEL_ID = 'selection-translator-panel';
  const MIN_LEN = 1;
  const MAX_LEN = 5000;

  let lastSelectedText = '';
  let lastRange = null;               // 仅在 contenteditable 替换时短暂使用
  let lastSelectionRect = null;       // {top,left,bottom,right,width,height} 普通对象，避免 GC 持有 Range
  let bar = null;
  let panel = null;
  let pendingTimer = null;
  let ttsEnabled = false;
  let translateInFlight = false;
  let ttsInFlight = false;
  let editableState = null;        // { kind:'input'|'ce', el, start?, end?, range?, text, rect }
  let replaceInFlight = false;
  let showTimer = null;            // mouseup → 展示菜单的延迟
  let cleanupTimer = null;         // selectionchange → 清空后撤回菜单的延迟

  // 从 background 取配置以决定是否显示「朗读」按钮
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (cfg) => {
        if (cfg && cfg.ttsEnabled) ttsEnabled = true;
      });
    }
  } catch (e) { /* ignore */ }

  // Shadow DOM 隔离：host 在 light DOM、内容在 shadow DOM；page CSS 无法渗透
  let _shadow = null;
  const HOST_INLINE_STYLE = [
    'all: initial !important',
    'position: absolute !important',
    'top: 0 !important',
    'left: 0 !important',
    'width: 0 !important',
    'height: 0 !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'z-index: 2147483647 !important',
    'pointer-events: none !important',
    'display: block !important',
    'visibility: visible !important',
    'opacity: 1 !important',
    'transform: none !important',
    'clip: auto !important',
    'clip-path: none !important'
  ].join('; ');

  function ensureRoot() {
    if (_shadow && _shadow.host && _shadow.host.isConnected) return _shadow;
    // 重连：上次 host 被 SPA 移除了，需要重建（清掉旧引用让下面流程走完整）
    _shadow = null;
    let host = document.getElementById(ROOT_ID);
    if (host && host.shadowRoot) {
      _shadow = host.shadowRoot;
      return _shadow;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = ROOT_ID;
    }
    // 用 setAttribute 设 style，确保是 inline 优先级
    host.setAttribute('style', HOST_INLINE_STYLE);
    if (!host.parentNode) {
      (document.body || document.documentElement).appendChild(host);
    }
    try {
      _shadow = host.attachShadow({ mode: 'open' });
    } catch (e) {
      // host 已有 shadow 或不支持时回退
      _shadow = host.shadowRoot || host;
    }
    // 注入样式：用 <link> 引用 web_accessible_resource，避免页面 CSP 干扰
    if (_shadow !== host) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      try { link.href = chrome.runtime.getURL('content.css'); }
      catch (e) { /* extension context invalidated */ }
      _shadow.appendChild(link);
    }
    return _shadow;
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    // 只在 contenteditable 替换时保留 Range；普通选区只存 rect
    lastSelectionRect = { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height };
    return rect;
  }

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) { return false; }
  }

  // ---------- 可编辑元素选区检测 ----------
  const EDITABLE_INPUT_TYPES = /^(text|search|email|url|tel|password)$/i;

  function isEditableEl(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'INPUT' && EDITABLE_INPUT_TYPES.test(el.type || 'text')) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function getActiveEditable() {
    // 1) 直接的 activeElement
    let ae = document.activeElement;
    // 2) 穿透开放 shadow root
    while (ae && ae.shadowRoot && ae.shadowRoot.activeElement && ae.shadowRoot.activeElement !== ae) {
      ae = ae.shadowRoot.activeElement;
    }
    if (isEditableEl(ae)) return ae;
    // 3) 从 selection 的 composedPath 中找可编辑（兼容闭合 shadow / web component）
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const startNode = range.startContainer;
        const path = (typeof startNode.getRootNode === 'function') ? [] : [];
        let n = startNode;
        while (n) {
          if (isEditableEl(n)) return n;
          n = n.parentNode || (n.host || null);
        }
      }
    } catch (e) {}
    return null;
  }

  function captureEditableSelection() {
    const ae = getActiveEditable();
    if (!ae) return null;
    if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') {
      const start = ae.selectionStart;
      const end = ae.selectionEnd;
      if (start == null || end == null || start === end) return null;
      const slice = ae.value.substring(start, end);
      const trimmed = slice.trim();
      if (!trimmed || trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return null;
      return { kind: 'input', el: ae, start, end, text: trimmed, rect: ae.getBoundingClientRect() };
    }
    if (ae.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return null;
      const text = sel.toString();
      const trimmed = text.trim();
      if (!trimmed || trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return null;
      return { kind: 'ce', el: ae, range: range.cloneRange(), text: trimmed, rect: range.getBoundingClientRect() };
    }
    return null;
  }

  // 原位写回 —— 处理 React/Vue 受控组件
  function replaceInEditable(state, newText) {
    if (!state) return false;
    if (state.kind === 'input') {
      const el = state.el;
      const v = el.value;
      const next = v.substring(0, state.start) + newText + v.substring(state.end);
      try {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement && window.HTMLInputElement.prototype;
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, next);
        else el.value = next;
      } catch (e) {
        el.value = next;
      }
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
      try {
        el.focus();
        el.setSelectionRange(state.start, state.start + newText.length);
      } catch (e) {}
      return true;
    }
    if (state.kind === 'ce') {
      try {
        state.el.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(state.range);
        const ok = document.execCommand('insertText', false, newText);
        if (!ok) {
          state.range.deleteContents();
          state.range.insertNode(document.createTextNode(newText));
        }
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  // ---------- 即时菜单条 ----------
  function showBar(rect) {
    ensureRoot();
    removeBar();
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'st-bar';
    bar.innerHTML = `
      <button class="st-bar-btn" data-action="copy" title="复制">
        <svg class="st-bar-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="8" width="13" height="13" rx="2.5"/>
          <path d="M16 4h-9a2.5 2.5 0 0 0-2.5 2.5V16"/>
        </svg>
        <span>复制</span>
      </button>
      <div class="st-bar-sep"></div>
      <button class="st-bar-btn" data-action="translate" title="翻译">
        <svg class="st-bar-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5h10"/>
          <path d="M8 3v2"/>
          <path d="M11 5c-.5 4-3 7-7 9"/>
          <path d="M5 9c0 3 4 6 9 6"/>
          <path d="m13 20 4-9 4 9"/>
          <path d="M14.5 17h5"/>
        </svg>
        <span>翻译</span>
      </button>
      ${ttsEnabled ? `<div class="st-bar-sep"></div>
      <button class="st-bar-btn" data-action="speak" title="朗读">
        <svg class="st-bar-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>
        <span>朗读</span>
      </button>` : ''}
      ${editableState ? `<div class="st-bar-sep st-bar-sep-strong"></div>
      <button class="st-bar-btn" data-action="replace" title="翻译并替换原文（中↔英）">
        <svg class="st-bar-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="7 4 3 8 7 12"/>
          <path d="M3 8h13a4 4 0 0 1 4 4"/>
          <polyline points="17 20 21 16 17 12"/>
          <path d="M21 16H8a4 4 0 0 1-4-4"/>
        </svg>
        <span>替换</span>
      </button>
      <button class="st-bar-btn" data-action="polish" title="润色（保持原语言）">
        <svg class="st-bar-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v3"/><path d="M12 18v3"/>
          <path d="M3 12h3"/><path d="M18 12h3"/>
          <path d="m5.6 5.6 2.1 2.1"/><path d="m16.3 16.3 2.1 2.1"/>
          <path d="m5.6 18.4 2.1-2.1"/><path d="m16.3 7.7 2.1-2.1"/>
        </svg>
        <span>润色</span>
      </button>` : ''}
    `;

    ensureRoot().appendChild(bar);
    requestAnimationFrame(() => {
      if (!bar) return;
      const barRect = bar.getBoundingClientRect();
      const barW = barRect.width || 140;
      const barH = barRect.height || 32;

      const spaceAbove = rect.top;
      const placeAbove = spaceAbove > barH + 12;

      let top = placeAbove
        ? window.scrollY + rect.top - barH - 8
        : window.scrollY + rect.bottom + 8;

      const centerX = window.scrollX + rect.left + rect.width / 2;
      let left = centerX - barW / 2;
      left = clamp(left, window.scrollX + 6, window.scrollX + document.documentElement.clientWidth - barW - 6);
      top = clamp(top, window.scrollY + 4, window.scrollY + document.documentElement.scrollHeight - barH - 4);

      bar.style.top = `${top}px`;
      bar.style.left = `${left}px`;
      bar.dataset.placement = placeAbove ? 'top' : 'bottom';
    });

    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', onBarClick);
  }

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
    replaceInFlight = false;     // bar 已没，旧的 in-flight 响应回来时按钮也不存在，复位放行下一次
  }

  function onBarClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'translate') {
      doTranslate(lastSelectedText);
    } else if (action === 'copy') {
      doCopy(lastSelectedText);
    } else if (action === 'speak') {
      doSpeak(lastSelectedText);
    } else if (action === 'replace') {
      doReplace('auto');
    } else if (action === 'polish') {
      doReplace('__polish__');
    }
  }

  // ---------- 复制 ----------
  async function doCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch (e2) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
    removeBar();
  }

  function toast(msg) {
    ensureRoot();
    const t = document.createElement('div');
    t.className = 'st-toast';
    t.textContent = msg;
    ensureRoot().appendChild(t);
    setTimeout(() => t.classList.add('st-toast-show'), 10);
    setTimeout(() => {
      t.classList.remove('st-toast-show');
      setTimeout(() => t.remove(), 200);
    }, 1400);
  }

  // ---------- 翻译面板 ----------
  function showPanel(originalText) {
    ensureRoot();
    removePanel();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'st-panel';
    panel.innerHTML = `
      <div class="st-panel-header">
        <span class="st-panel-title">划词翻译</span>
        <div class="st-panel-actions">
          <button class="st-icon-btn" data-action="copy-result" title="复制译文">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="8" width="13" height="13" rx="2.5"/>
              <path d="M16 4h-9a2.5 2.5 0 0 0-2.5 2.5V16"/>
            </svg>
          </button>
          <button class="st-icon-btn" data-action="close" title="关闭">✕</button>
        </div>
      </div>
      <div class="st-panel-body">
        <div class="st-original">${escapeHTML(originalText)}</div>
        <div class="st-divider"></div>
        <div class="st-result"><span class="st-spinner"></span><span class="st-status">翻译中…</span></div>
      </div>
      <div class="st-panel-footer">
        <select class="st-target-lang">
          <option value="">默认目标语言</option>
          <option value="中文">中文</option>
          <option value="英文">English</option>
          <option value="日文">日本語</option>
          <option value="韩文">한국어</option>
          <option value="法文">Français</option>
          <option value="德文">Deutsch</option>
          <option value="西班牙文">Español</option>
        </select>
        <button class="st-retry" data-action="retry">重试</button>
      </div>
    `;

    const rect = lastSelectionRect
      || (editableState && editableState.rect)
      || { top: 100, left: 100, bottom: 100, right: 300 };
    const top = clamp(window.scrollY + rect.bottom + 12, window.scrollY + 8, window.scrollY + window.innerHeight - 280);
    const left = clamp(window.scrollX + rect.left, window.scrollX + 8, window.scrollX + window.innerWidth - 380);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;

    ensureRoot().appendChild(panel);

    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click', onPanelClick);
    panel.__cleanup = makeDraggable(panel, panel.querySelector('.st-panel-header'));
  }

  function removePanel() {
    if (panel) {
      try { if (typeof panel.__cleanup === 'function') panel.__cleanup(); } catch (e) {}
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
    panel = null;
    translateInFlight = false;
    // 关闭面板时同时停止正在朗读的音频
    try { stopSpeak(); } catch (e) {}
  }

  function onPanelClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close') {
      removePanel();
    } else if (action === 'copy-result') {
      const resultEl = panel.querySelector('.st-result');
      if (resultEl.dataset.state !== 'ok') {
        toast('暂无可复制的译文');
        return;
      }
      const result = resultEl.innerText;
      if (!result || !result.trim()) {
        toast('暂无可复制的译文');
        return;
      }
      navigator.clipboard.writeText(result).then(
        () => toast('已复制译文'),
        () => toast('复制失败')
      );
    } else if (action === 'retry') {
      const lang = panel.querySelector('.st-target-lang').value || undefined;
      runTranslation(lastSelectedText, lang);
    }
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const ac = new AbortController();
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left + window.scrollX;
      oy = r.top + window.scrollY;
      e.preventDefault();
    }, { signal: ac.signal });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = el.getBoundingClientRect();
      const minLeft = window.scrollX + 8;
      const maxLeft = window.scrollX + window.innerWidth - rect.width - 8;
      const minTop = window.scrollY + 8;
      const maxTop = window.scrollY + window.innerHeight - 40;     // header 至少保留 40px
      const nl = clamp(ox + (e.clientX - sx), minLeft, Math.max(minLeft, maxLeft));
      const nt = clamp(oy + (e.clientY - sy), minTop, Math.max(minTop, maxTop));
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
    }, { signal: ac.signal });
    document.addEventListener('mouseup', () => { dragging = false; }, { signal: ac.signal });
    return () => ac.abort();
  }

  // ---------- 翻译流程 ----------
  function doTranslate(text) {
    removeBar();
    showPanel(text);
    runTranslation(text);
  }

  function runTranslation(text, overrideLang) {
    if (translateInFlight) return;                  // 并发保护
    const resultEl = panel && panel.querySelector('.st-result');
    if (resultEl) {
      resultEl.innerHTML = '<span class="st-spinner"></span><span class="st-status">翻译中…</span>';
      resultEl.dataset.state = 'loading';
    }
    if (!isExtensionContextValid()) {
      if (resultEl) {
        resultEl.innerHTML = '<span class="st-error">扩展已更新或被禁用。请刷新当前页面（F5）后重试。</span>';
        resultEl.dataset.state = 'error';
      }
      return;
    }
    translateInFlight = true;
    const finish = () => { translateInFlight = false; };
    try {
      chrome.runtime.sendMessage(
        { type: 'TRANSLATE', text, targetLanguage: overrideLang },
        (response) => {
          finish();
          if (!panel) return;
          const el = panel.querySelector('.st-result');
          if (chrome.runtime.lastError) {
            el.innerHTML = `<span class="st-error">扩展通信失败：${escapeHTML(chrome.runtime.lastError.message)}</span>`;
            el.dataset.state = 'error';
            return;
          }
          if (!response) {
            el.innerHTML = `<span class="st-error">未收到响应</span>`;
            el.dataset.state = 'error';
            return;
          }
          if (response.ok) {
            el.textContent = response.text || '(空响应)';
            el.dataset.state = 'ok';
          } else {
            el.innerHTML = `<span class="st-error">${escapeHTML(response.error || '翻译失败')}</span>`;
            el.dataset.state = 'error';
          }
        }
      );
    } catch (err) {
      finish();
      const el = panel && panel.querySelector('.st-result');
      if (el) {
        el.innerHTML = `<span class="st-error">扩展通信中断：${escapeHTML(err && err.message || String(err))}<br>请刷新页面（F5）后重试。</span>`;
        el.dataset.state = 'error';
      }
    }
  }

  // ---------- 选区监听 ----------
  function isInsideOurUI(target, event) {
    if (target && target.closest && target.closest(`#${ROOT_ID}`)) return true;
    if (event && typeof event.composedPath === 'function') {
      const path = event.composedPath();
      for (const n of path) {
        if (n && n.id === ROOT_ID) return true;
      }
    }
    return false;
  }

  // 选区的锚点是否落在我们自己的 UI 内 —— 防止在 panel 中选译文又弹出菜单
  function selectionAnchoredInOurUI() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const anchor = sel.anchorNode;
    if (!anchor) return false;
    const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    return !!(el && el.closest && el.closest(`#${ROOT_ID}`));
  }

  function evaluateSelection() {
    if (selectionAnchoredInOurUI()) return;
    // 优先：可编辑元素（input/textarea/contenteditable）内的选区
    const es = captureEditableSelection();
    if (es) {
      editableState = es;
      lastSelectedText = es.text;
      showBar(es.rect);
      return;
    }
    editableState = null;
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    const trimmed = text.trim();
    if (trimmed.length >= MIN_LEN) {
      if (trimmed.length > MAX_LEN) {
        if (!window.__ST_LEN_WARNED__) {
          toast(`选中文本过长（${trimmed.length} 字符，上限 ${MAX_LEN}）`);
          window.__ST_LEN_WARNED__ = true;
          setTimeout(() => { window.__ST_LEN_WARNED__ = false; }, 3000);
        }
        removeBar();
        return;
      }
      lastSelectedText = trimmed;
      const rect = getSelectionRect();
      if (rect) {
        showBar(rect);
        return;
      }
    }
    removeBar();
  }

  function onMouseUp(e) {
    if (isInsideOurUI(e.target, e)) return;
    clearTimeout(showTimer);
    clearTimeout(cleanupTimer);
    showTimer = setTimeout(evaluateSelection, 10);
  }

  function onMouseDown(e) {
    if (isInsideOurUI(e.target, e)) return;
    removeBar();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      removeBar();
      removePanel();
      stopSpeak();
    }
  }

  // ---------- 朗读 ----------
  let currentAudio = null;
  let currentAudioUrl = null;

  function stopSpeak() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch (e) {}
      currentAudioUrl = null;
    }
    const btn = bar && bar.querySelector('[data-action="speak"]');
    if (btn) btn.classList.remove('is-loading', 'is-playing');
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string') throw new Error('hex 不是字符串');
    const clean = hex.replace(/\s+/g, '');
    if (clean.length === 0) throw new Error('hex 为空');
    if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('hex 包含非法字符');
    if (clean.length % 2 !== 0) throw new Error('hex 长度不是偶数');
    const len = clean.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function playHexAudio(hex, format) {
    stopSpeak();
    const bytes = hexToBytes(hex);
    const mime = format === 'wav' ? 'audio/wav'
              : format === 'pcm' ? 'audio/pcm'
              : 'audio/mpeg';
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    currentAudioUrl = url;
    const audio = new Audio(url);
    currentAudio = audio;
    const speakBtn = bar && bar.querySelector('[data-action="speak"]');
    if (speakBtn) speakBtn.classList.add('is-playing');
    audio.addEventListener('ended', () => stopSpeak());
    audio.addEventListener('error', () => {
      stopSpeak();
      toast('音频播放失败');
    });
    audio.play().catch((e) => {
      stopSpeak();
      toast('播放失败：' + (e.message || e));
    });
  }

  function doSpeak(text) {
    // 再次点击 = 停止当前播放
    if (currentAudio) { stopSpeak(); return; }
    if (ttsInFlight) return;                        // 并发保护
    if (!isExtensionContextValid()) {
      toast('扩展已更新，请刷新页面');
      return;
    }
    const speakBtn = bar && bar.querySelector('[data-action="speak"]');
    if (speakBtn) speakBtn.classList.add('is-loading');
    ttsInFlight = true;
    toast('正在合成…');
    const finish = () => { ttsInFlight = false; if (speakBtn) speakBtn.classList.remove('is-loading'); };
    try {
      chrome.runtime.sendMessage({ type: 'TTS', text }, (response) => {
        finish();
        if (chrome.runtime.lastError) {
          toast('合成失败：' + chrome.runtime.lastError.message);
          return;
        }
        if (!response || !response.ok) {
          toast((response && response.error) || 'TTS 失败');
          return;
        }
        try {
          playHexAudio(response.audioHex, response.format || 'mp3');
        } catch (e) {
          toast('音频解码失败：' + (e && e.message || String(e)));
        }
      });
    } catch (err) {
      finish();
      toast('合成中断：' + (err && err.message || String(err)));
    }
  }

  // ---------- 翻译并替换 / 润色 ----------
  function doReplace(targetLanguage) {
    if (!editableState) return;
    if (replaceInFlight) return;
    if (!isExtensionContextValid()) { toast('扩展已更新，请刷新页面'); return; }
    const action = targetLanguage === '__polish__' ? 'polish' : 'replace';
    const btn = bar && bar.querySelector(`[data-action="${action}"]`);
    if (btn) btn.classList.add('is-loading');
    replaceInFlight = true;
    const state = editableState;
    const text = state.text;
    const finish = () => {
      replaceInFlight = false;
      if (btn) btn.classList.remove('is-loading');
    };
    try {
      chrome.runtime.sendMessage(
        { type: 'TRANSLATE', text, targetLanguage },
        (response) => {
          finish();
          if (chrome.runtime.lastError) { toast('扩展通信失败：' + chrome.runtime.lastError.message); return; }
          if (!response || !response.ok) { toast((response && response.error) || '调用失败'); return; }
          const out = response.text || '';
          if (!out.trim()) { toast('返回结果为空'); return; }
          const ok = replaceInEditable(state, out);
          if (ok) {
            toast(targetLanguage === '__polish__' ? '已润色 ✓' : '已替换 ✓');
            removeBar();
          } else {
            toast('替换失败，无法写回原位');
          }
        }
      );
    } catch (err) {
      finish();
      toast('调用中断：' + (err && err.message || String(err)));
    }
  }

  function onSelectionChange() {
    // 仅负责：若选区为空 → 撤回菜单（菜单不在时不做事）
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (!bar) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      const es = captureEditableSelection();
      if (!text && !es) removeBar();
    }, 250);
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('selectionchange', onSelectionChange);
  // input/textarea 的选区变化需另外监听 select 事件
  document.addEventListener('select', () => {
    clearTimeout(showTimer);
    showTimer = setTimeout(evaluateSelection, 30);
  }, true);

  // 监听来自 background 的消息（右键菜单）
  if (isExtensionContextValid()) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'TRIGGER_TRANSLATE') {
      const text = (msg.text || (window.getSelection() || '').toString()).trim();
      if (!text) {
        toast('未选中文本');
        sendResponse({ ok: false });
        return false;
      }
      lastSelectedText = text;
      // 更新选区 rect 用于面板定位
      getSelectionRect();
      doTranslate(text);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'TRIGGER_COPY') {
      const text = (msg.text || (window.getSelection() || '').toString()).trim();
      if (text) doCopy(text);
      sendResponse({ ok: !!text });
      return false;
    }
    return false;
  });
  }

  // 页面切换时停止音频，释放 Blob URL
  window.addEventListener('pagehide', () => { try { stopSpeak(); } catch (e) {} });
})();
