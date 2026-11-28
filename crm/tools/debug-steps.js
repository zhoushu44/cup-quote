/* 临时排查：单步验证筛选、翻页，并捕获未处理的 Promise 拒绝 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-dbg-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1500,1000', '--user-data-dir=' + profile, '--remote-debugging-port=9498', 'about:blank'], { stdio: 'ignore' });
(async () => {
  let t = null;
  for (let i = 0; i < 40 && !t; i++) { try { t = (await (await fetch('http://127.0.0.1:9498/json/list')).json()).find(y => y.type === 'page'); } catch (e) { /* 等 */ } if (!t) await sleep(300); }
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map(); const errors = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map(a => a.value || a.description).join(' ')); });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) return 'ERR ' + ((r.result.exceptionDetails.exception || {}).description || '').split('\n')[0];
    const v = r.result.result.value; return typeof v === 'string' ? v : JSON.stringify(v); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:6656/' }); await sleep(3500);
  await ev("window.__rej=[]; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)))");
  const show = async label => console.log(label.padEnd(34), await ev("document.querySelector('#page-daily [data-t=count]').textContent + '　' + document.querySelector('#page-daily [data-t=pg]').textContent + '　status=' + document.querySelector('.filters[data-view=daily] [data-f=status]').value + '　next.disabled=' + document.querySelector('#page-daily [data-act=next]').disabled"));
  await ev("document.querySelector('#tabs [data-page=daily]').click()"); await sleep(1200);
  await show('打开今日跟进');
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=status]');s.value='overdue';s.dispatchEvent(new Event('change',{bubbles:true}));})()"); await sleep(800);
  await show('状态=逾期（冒泡事件）');
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=status]');s.value='';s.dispatchEvent(new Event('change'));})()"); await sleep(800);
  await show('状态=空（不冒泡事件）');
  await ev("document.querySelector('#page-daily [data-act=next]').click()"); await sleep(800);
  await show('点下一页');
  await ev("document.querySelector('#page-daily [data-act=next]').click()"); await sleep(800);
  await show('再点下一页');
  console.log('未处理的拒绝：', await ev("JSON.stringify(window.__rej)"));
  console.log('报错：', errors.join(' | ') || '无');
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
