// 粘贴预览探针:通过 CDP 注入页面,检查 vision-engine 预览链路 + 模拟粘贴路径实测渲染
// 用法: node scripts/probe-paste.mjs <cdpPort>
const port = process.argv[2] || '9222';
const fs = require('fs');
const log = 'D:/Deepseek-Harness/_backups/probe-paste.log';
const line = (s) => fs.appendFileSync(log, s + '\n');

(async () => {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const page = list.find(t => t.type === 'page' && /DeepSeek/.test(t.title || ''));
    if (!page) { line('未找到页面, targets: ' + list.map(t => `${t.type}:${t.title}`).join(' | ')); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let nextId = 1;
    const evaluate = (expr, awaitPromise = false) => new Promise((res, rej) => {
      const id = nextId++;
      const handler = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', handler);
          if (m.result && m.result.exceptionDetails) rej(new Error('页面异常: ' + JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
          else res(m.result && m.result.result ? m.result.result.value : m);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise } }));
    });
    line('=== 探针结果 ===');
    line('armed=' + JSON.stringify(await evaluate('!!window.__VE_POLLERS__')));
    line('activeTag=' + JSON.stringify(await evaluate('document.activeElement ? document.activeElement.tagName : null')));
    line('composerTextarea=' + JSON.stringify(await evaluate('document.querySelectorAll("textarea,input").length')));
    // 模拟粘贴路径 → 触发 input → 等待卡片
    const sim = await evaluate(`(async () => {
      const out = {};
      const ta = document.createElement('textarea');
      ta.id = '__ve_probe_ta__';
      ta.value = 'C:\\\\Temp\\\\modlens-dsh-paste\\\\p-probe-test\\\\paste.png';
      document.body.appendChild(ta);
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2000));
      out.cards = document.querySelectorAll('.ve-preview').length;
      out.imgSrc = (document.querySelector('.ve-preview img') || {}).src || '';
      ta.remove();
      return JSON.stringify(out);
    })()`, true);
    line('sim=' + sim);
    ws.close();
    process.exit(0);
  } catch (e) {
    line('探针失败: ' + String(e && e.stack || e));
    process.exit(1);
  }
})();
