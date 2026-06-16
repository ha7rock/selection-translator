document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (cfg) => {
    if (!cfg) {
      statusEl.textContent = '尚未连接到 background。';
      return;
    }
    const provider = cfg.provider === 'openai' ? 'OpenAI 兼容' : 'Anthropic';
    const hasKey = cfg.apiKey ? '已配置' : '未配置';
    // 用 DOM 构建避免 innerHTML 注入风险
    statusEl.textContent = '';
    const lines = [
      ['协议', provider],
      ['Endpoint', cfg.endpoint || '(空)'],
      ['API Key', hasKey],
      ['模型', cfg.model || '(空)']
    ];
    lines.forEach((kv, i) => {
      if (i > 0) statusEl.appendChild(document.createElement('br'));
      const k = document.createElement('span');
      k.textContent = kv[0] + '：';
      statusEl.appendChild(k);
      statusEl.appendChild(document.createTextNode(kv[1]));
    });
  });

  document.getElementById('options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
