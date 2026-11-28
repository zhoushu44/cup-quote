/* 无头 Chrome 实际点一遍页面：收集前端报错、检查各页渲染、截图
   用法：node tools/ui-check.js [base]   截图存到 ../docs/ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = process.argv[2] || 'http://127.0.0.1:6656';
const OUT = path.join(__dirname, '..', 'docs');
const PORT = 9497;
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra !== undefined && extra !== '' ? '  → ' + extra : '')); if (!cond) fail++; };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ui-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1500,1000', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });

(async () => {
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    try { const x = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); t = x.find(y => y.type === 'page'); } catch (e) { /* 浏览器还没起来 */ }
    if (!t) await sleep(300);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push('异常：' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push('console.' + m.params.type + '：' + m.params.args.map(a => a.value || a.description).join(' '));
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  /* 在页面里求值：字符串原样返回，其他转 JSON；页面里抛了错返回 'ERR 完整信息' */
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    const d = r.result && r.result.exceptionDetails;
    if (d) return 'ERR ' + ((d.exception || {}).description || d.text);
    const v = r.result && r.result.result ? r.result.result.value : undefined;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const rows = async pg => Number(await ev("document.querySelectorAll('#page-" + pg + " tbody tr[data-id]').length"));
  /* 等到某页名单渲染出行来（最多 10 秒） */
  const waitRows = async pg => { for (let i = 0; i < 25; i++) { if (await rows(pg) > 0) return true; await sleep(400); } return false; };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: B + '/' });
  let shown = false;
  for (let i = 0; i < 25 && !shown; i++) { shown = Number(await ev("document.querySelectorAll('#tblSales tbody tr').length")) > 0; if (!shown) await sleep(400); }
  await sleep(600);

  console.log('概览');
  const kpi = await ev("[...document.querySelectorAll('.kpi')].map(k => k.innerText.split('\\n').join(' ')).join(' ｜ ')");
  ok('KPI 卡片', (await ev("document.querySelectorAll('.kpi').length")) === '7', kpi);
  ok('业务员表格有行', Number(await ev("document.querySelectorAll('#tblSales tbody tr').length")) > 10);
  ok('顶栏显示数据时间', /\d{2}\.\d{2} \d{2}:\d{2}/.test(await ev("document.querySelector('#metaInfo').innerText")), await ev("document.querySelector('#metaInfo').innerText"));
  ok('今日跟进角标', (await ev("document.querySelector('#badgeDaily').style.display")) === 'inline', await ev("document.querySelector('#badgeDaily').innerText"));
  await shot('crm-overview.png');

  console.log('点业务员那一行 → 跳到该业务员的今日跟进');
  await ev("document.querySelector('#tblSales tbody tr').click()"); await sleep(300);
  ok('已跳转', (await ev("document.querySelector('.page.on').id")) === 'page-daily');
  await waitRows('daily');
  ok('名单只含该业务员', (await ev("[...document.querySelectorAll('#page-daily tbody tr td:nth-child(2)')].every(t => t.textContent === document.querySelector('#tblSales tbody tr').innerText.split('\\t')[0])")) === 'true',
    await ev("document.querySelector('.filters[data-view=daily] [data-f=sale]').value"));

  console.log('今日跟进');
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=sale]');s.value='';s.dispatchEvent(new Event('change'));})()");
  await ev("new Promise(r=>setTimeout(r,1200))");
  ok('名单有行', await rows('daily') > 10);
  ok('行数统计', /^共 \d+ 个$/.test(await ev("document.querySelector('#page-daily [data-t=count]').textContent")), await ev("document.querySelector('#page-daily [data-t=count]').textContent + '　' + document.querySelector('#page-daily [data-t=pg]').textContent"));
  ok('状态标签有内容', Number(await ev("document.querySelectorAll('#page-daily .tag').length")) > 10, await ev("document.querySelector('#page-daily tbody tr').innerText.split('\\t').join(' | ')"));
  await shot('crm-daily.png');

  console.log('筛选与复制');
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=sale]');s.value='黄海鸥';s.dispatchEvent(new Event('change'));})()"); await sleep(1000);
  ok('按业务员筛选', (await ev("[...document.querySelectorAll('#page-daily tbody tr td:nth-child(2)')].every(t => t.textContent === '黄海鸥')")) === 'true');
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=status]');s.value='overdue';s.dispatchEvent(new Event('change'));})()"); await sleep(1000);
  ok('叠加状态筛选', (await ev("[...document.querySelectorAll('#page-daily tbody .tag')].length > 0 && [...document.querySelectorAll('#page-daily tbody .tag')].every(t => t.textContent.includes('已逾期'))")) === 'true',
    await ev("document.querySelector('#page-daily [data-t=count]').textContent"));
  await ev("document.querySelector('.filters[data-view=daily] [data-act=copy]').click()"); await sleep(2500);
  ok('复制名单有提示', (await ev("document.querySelector('#toast').textContent")).includes('已复制'), await ev("document.querySelector('#toast').textContent"));
  await ev("(()=>{const s=document.querySelector('.filters[data-view=daily] [data-f=status]');s.value='';s.dispatchEvent(new Event('change'));})()"); await sleep(1000);
  await ev("document.querySelector('#page-daily [data-act=next]').click()"); await sleep(1000);
  ok('下一页', (await ev("document.querySelector('#page-daily [data-t=pg]').textContent")).startsWith('2 / '), await ev("document.querySelector('#page-daily [data-t=pg]').textContent"));

  console.log('沉睡唤醒 / 全部客户');
  await ev("document.querySelector('#tabs [data-page=sleep]').click()");
  ok('沉睡名单', await waitRows('sleep'), await ev("document.querySelector('#page-sleep [data-t=count]').textContent + '　' + document.querySelector('#page-sleep tbody tr').innerText.split('\\t').join(' | ')"));
  await shot('crm-sleep.png');
  await ev("document.querySelector('#tabs [data-page=all]').click()");
  ok('全部客户', await waitRows('all'), await ev("document.querySelector('#page-all [data-t=count]').textContent + '　首行：' + document.querySelector('#page-all tbody tr').innerText.split('\\t').join(' | ')"));
  await shot('crm-all.png');

  console.log('客户详情');
  await ev("document.querySelector('#page-all tbody tr[data-id]').click()"); await sleep(1200);
  ok('抽屉打开', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'true', await ev("document.querySelector('#drawer h2').innerText"));
  ok('有统计块', (await ev("document.querySelectorAll('#drawer .stats div').length")) === '4', await ev("[...document.querySelectorAll('#drawer .stats div')].map(d=>d.innerText.split('\\n').join(' ')).join(' ｜ ')"));
  ok('有历史订单', Number(await ev("document.querySelectorAll('#drawer table tbody tr').length")) >= 1, await ev("'订单 ' + document.querySelectorAll('#drawer table tbody tr').length + ' 行'"));
  await shot('crm-detail.png');
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(300);
  ok('Esc 关闭', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'false');

  console.log('设置');
  await ev("document.querySelector('#tabs [data-page=settings]').click()"); await sleep(1500);
  const vals = JSON.parse(await ev("JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-s]')].map(i => [i.dataset.s, i.value])))"));
  ok('规则回填', vals.keyMoney12m === '50000' && vals.dueRatio === '80', JSON.stringify(vals));
  ok('作废标记勾选', (await ev("[...document.querySelectorAll('#voidForm input:checked')].map(c => c.dataset.v).join(',')")) === '1');
  ok('ERP 账号回填', (await ev("document.querySelector('#erpUser').value")) === '颜益国');
  ok('重点客户预览', (await ev("document.querySelector('#keyPreview').textContent")).includes('个重点客户'), await ev("document.querySelector('#keyPreview').textContent"));
  await shot('crm-settings.png');

  console.log('\n前端报错：' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  if (errors.length) fail++;
  console.log('\n' + (fail ? '有 ' + fail + ' 项失败' : '全部通过'));
  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 临时目录删不掉不影响结果 */ }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本出错：', e.message); chrome.kill(); process.exit(1); });
