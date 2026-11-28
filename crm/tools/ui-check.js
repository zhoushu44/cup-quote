/* 无头 Chrome 把页面实际点一遍：初始化账号、登录、名单筛选、跟进、跟进记录、人员管理、业务员视角；
   收集前端报错，截图存到 ../docs/。在临时环境（数据副本）里跑，不会动真实数据。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./env');
const OUT = path.join(__dirname, '..', 'docs');
const CDP = 9497;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra !== undefined && extra !== '' ? '  → ' + extra : '')); if (!cond) fail++; };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ui-'));
const chrome = spawn(CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1500,1000', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + CDP, 'about:blank'], { stdio: 'ignore' });

let e = null;
(async () => {
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    try { const x = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); t = x.find(y => y.type === 'page'); } catch (err) { /* 浏览器还没起来 */ }
    if (!t) await sleep(300);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errors = [];
  ws.addEventListener('message', evt => {
    const m = JSON.parse(evt.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push('异常：' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push('console.' + m.params.type + '：' + m.params.args.map(a => a.value || a.description).join(' '));
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  /* 在页面里求值：字符串原样返回，其他转 JSON；页面里抛了错返回 'ERR 完整信息' */
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    const d = r.result && r.result.exceptionDetails;
    if (d) return 'ERR ' + ((d.exception || {}).description || d.text);
    const v = r.result && r.result.result ? r.result.result.value : undefined;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const wait = async (expr, n) => { for (let i = 0; i < (n || 25); i++) { if ((await ev(expr)) === 'true') return true; await sleep(400); } return false; };
  const rows = async pg => Number(await ev("document.querySelectorAll('#page-" + pg + " tbody tr[data-id]').length"));
  const waitRows = async pg => wait("document.querySelectorAll('#page-" + pg + " tbody tr[data-id]').length > 0");
  const shot = async (name, height) => {
    if (height) await send('Emulation.setDeviceMetricsOverride', { width: 1500, height, deviceScaleFactor: 1, mobile: false });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    if (height) await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  };
  const click = async sel => { await ev("(()=>{const e=document.querySelector(" + JSON.stringify(sel) + ");if(!e)return 'no';e.click();return 'yes';})()"); };
  const setv = async (sel, v) => ev("(()=>{const e=document.querySelector(" + JSON.stringify(sel) + ");e.value=" + JSON.stringify(v) + ";e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  const text = sel => ev("(()=>{const e=document.querySelector(" + JSON.stringify(sel) + ");return e?e.textContent:'(没有这个元素)'})()");
  const count = async view => text('#page-' + view + ' [data-t=count]');
  /* 合成的 change 事件要带 bubbles：页面把监听挂在筛选条上（真实操作会冒泡） */
  const chg = (view, field, value) => setv('.filters[data-view=' + view + '] [data-f=' + field + ']', value);
  const login = async (name, pass) => {
    await ev("document.querySelector('#loginName').value=" + JSON.stringify(name) + ";document.querySelector('#loginPass').value=" + JSON.stringify(pass) + ";document.querySelector('#loginForm').requestSubmit()");
    return wait("getComputedStyle(document.querySelector('#login')).display === 'none'");
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  e = await env.start();
  await send('Page.navigate', { url: e.base + '/' });

  console.log('首次使用：建主管账号');
  ok('没登录时显示登录层', await wait("getComputedStyle(document.querySelector('#login')).display === 'flex'"));
  ok('提示是第一次使用', (await text('#loginTip')).includes('第一次使用'), await text('#loginTip'));
  ok('登录前看不到客户数据', (await ev("document.querySelector('#barRight').style.display")) === 'none');
  await shot('crm-login.png');
  ok('密码太短被拒', !(await login('主管测试', '123')).valueOf() ? ((await text('#loginErr')).includes('6')) : false, await text('#loginErr'));
  ok('创建主管并进入', await login('主管测试', 'test123456'));

  console.log('概览（主管）');
  ok('顶栏显示当前用户', (await text('#meInfo')).includes('主管测试'), await text('#meInfo'));
  ok('KPI 卡片 8 个', (await ev("document.querySelectorAll('.kpi').length")) === '8', await ev("[...document.querySelectorAll('.kpi')].map(k => k.innerText.split('\\n').join(' ')).join(' ｜ ')"));
  ok('业务员表格有行，带今日已跟进列', Number(await ev("document.querySelectorAll('#tblSales tbody tr').length")) > 10 && (await text('#tblSales thead')).includes('今日已跟进'));
  ok('顶栏显示数据时间', (await ev("/^数据：\\d\\d-\\d\\d \\d\\d:\\d\\d/.test(document.querySelector('#metaInfo').innerText)")).toString() === 'true', await text('#metaInfo'));
  ok('今日跟进角标', (await ev("document.querySelector('#badgeDaily').style.display")) === 'inline', await text('#badgeDaily'));
  const pending0 = Number((await text('#badgeDaily')).replace(/\D/g, ''));
  await click('#tblSales tbody tr'); await sleep(400);
  await shot('crm-daily.png');

  console.log('今日跟进');
  ok('点业务员 → 跳到他的名单', (await ev("document.querySelector('.page.on').id")) === 'page-daily' && await waitRows('daily'));
  await chg('daily', 'sale', ''); await sleep(1000);
  ok('全部业务员', (await count('daily')) === '共 ' + pending0 + ' 个', await count('daily'));
  ok('状态标签有内容', Number(await ev("document.querySelectorAll('#page-daily .tag').length")) > 10, await ev("document.querySelector('#page-daily tbody tr').innerText.split('\\t').join(' | ')"));
  await chg('daily', 'status', 'overdue'); await sleep(800);
  ok('按状态筛选', (await ev("[...document.querySelectorAll('#page-daily tbody .tag')].every(t => t.textContent.includes('已逾期'))")) === 'true', await count('daily'));
  await chg('daily', 'status', ''); await sleep(800);
  await click('#page-daily [data-act=next]'); await sleep(800);
  ok('下一页', (await text('#page-daily [data-t=pg]')).startsWith('2 / '), await text('#page-daily [data-t=pg]'));
  await click('#page-daily [data-act=prev]'); await sleep(800);
  ok('上一页，首页时禁用', (await text('#page-daily [data-t=pg]')).startsWith('1 / ') && (await ev("document.querySelector('#page-daily [data-act=prev]').disabled")) === 'true');
  await click('.filters[data-view=daily] [data-act=copy]'); await sleep(2500);
  ok('复制名单有提示', (await text('#toast')).includes('已复制'), await text('#toast'));

  console.log('跟进');
  const firstId = await ev("document.querySelector('#page-daily tbody tr[data-id]').dataset.id");
  await ev("document.querySelector('#page-daily tbody tr[data-id]').click()"); await sleep(1000);
  ok('抽屉打开', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'true', await text('#drawer h2'));
  ok('有统计块', (await ev("document.querySelectorAll('#drawer .stats div').length")) === '4', await ev("[...document.querySelectorAll('#drawer .stats div')].map(d=>d.innerText.split('\\n').join(' ')).join(' ｜ ')"));
  ok('四个跟进结果按钮', (await ev("document.querySelectorAll('#drawer [data-result]').length")) === '4', await ev("[...document.querySelectorAll('#drawer [data-result]')].map(b=>b.innerText.replace('\\n','：')).join(' ｜ ')"));
  ok('有历史订单', Number(await ev("document.querySelectorAll('#drawer table tbody tr').length")) >= 1, await ev("'订单 ' + document.querySelectorAll('#drawer table tbody tr').length + ' 行'"));
  await shot('crm-detail.png');
  await ev("document.querySelector('#cNote').value='采购说下周再联系'");
  await click('#drawer [data-result=reply]'); await sleep(1500);
  ok('点结果后抽屉关闭', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'false');
  ok('提示里写了几天后再提醒', (await text('#toast')).includes('7 天后再提醒'), await text('#toast'));
  ok('名单少一个', (await count('daily')) === '共 ' + (pending0 - 1) + ' 个', await count('daily'));
  ok('概览：今日已跟进 1，角标 -1', (await text('#badgeDaily')) === String(pending0 - 1) && (await ev("document.querySelector('#tblSales td:nth-child(5)') && [...document.querySelectorAll('#tblSales tbody tr')].some(tr => tr.children[4].textContent === '1')")) === 'true', await text('#badgeDaily'));
  await ev("document.querySelector('.filters[data-view=daily] [data-f=cool]').click()"); await sleep(1000);
  ok('「只看已跟进的」里是刚才那个客户', (await ev("document.querySelector('#page-daily tbody tr[data-id]') && document.querySelector('#page-daily tbody tr[data-id]').dataset.id")) === String(firstId) &&
    (await ev("[...document.querySelectorAll('#page-daily .tag.foll')].map(t=>t.textContent).join(',')")).includes('等回复'), await ev("document.querySelector('#page-daily tbody tr').innerText.split('\\t').join(' | ')"));
  await shot('crm-followed.png');
  /* 在「已跟进」列表里直接打开，看的才是刚跟过的那个客户 */
  await ev("document.querySelector('#page-daily tbody tr[data-id]').click()"); await sleep(1000);
  ok('详情里显示上次跟进和记录', (await text('#drawer')).includes('上次跟进') && (await text('#drawer')).includes('主管测试') && (await text('#drawer')).includes('采购说下周再联系'),
    await ev("[...document.querySelectorAll('#drawer > div')].filter(d => d.innerText.includes('跟进')).map(d=>d.innerText).join(' ‖ ').slice(0, 300)"));
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(300);
  ok('Esc 关闭', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'false');
  await ev("document.querySelector('.filters[data-view=daily] [data-f=cool]').click()"); await sleep(600);

  console.log('名单上的下拉');
  ok('每行都有「记录跟进」下拉', Number(await ev("document.querySelectorAll('#page-daily .follow-pick').length")) === Number(await ev("document.querySelectorAll('#page-daily tbody tr[data-id]').length")) &&
    (await ev("document.querySelector('#page-daily .follow-pick').innerText")).includes('最近不需要'), await ev("document.querySelector('#page-daily .follow-pick').innerText.replace(/\\n/g,' ｜ ')"));
  await ev("document.querySelector('#page-daily .follow-pick').click()"); await sleep(500);
  ok('点下拉不会弹出详情', (await ev("document.querySelector('#drawer').classList.contains('on')")) === 'false');
  const secondId = await ev("document.querySelector('#page-daily tbody tr[data-id]').dataset.id");
  await ev("document.querySelector('#page-daily .follow-pick').value='later';document.querySelector('#page-daily .follow-pick').dispatchEvent(new Event('change',{bubbles:true}))"); await sleep(1500);
  ok('选结果直接记录', (await text('#toast')).includes('最近不需要') && (await count('daily')) === '共 ' + (pending0 - 2) + ' 个', await text('#toast') + '　' + await count('daily'));
  ok('概览今日已跟进合计 2', (await ev("[...document.querySelectorAll('#tblSales tbody tr')].reduce((s,tr)=>s+Number(tr.children[4].textContent),0)")) === '2');
  await ev("document.querySelector('.filters[data-view=daily] [data-f=cool]').click()"); await sleep(1000);
  ok('冷却中的两个都带着结果', (await count('daily')) === '共 2 个' && (await ev("[...document.querySelectorAll('#page-daily .follow-line')].map(d=>d.textContent).join(' / ')")).includes('不需要'),
    await ev("[...document.querySelectorAll('#page-daily .follow-line')].map(d=>d.textContent).join(' / ')"));
  ok('下拉记录不会冲掉原备注', (await ev("document.querySelector('#page-daily tr[data-id=\"" + firstId + "\"] .dim:last-child') && document.querySelector('#page-daily tr[data-id=\"" + firstId + "\"]').innerText")).includes('采购说下周再联系'));
  await ev("const s=document.querySelector('#page-daily tr[data-id=\"" + secondId + "\"] .follow-pick');s.value='note';s.dispatchEvent(new Event('change',{bubbles:true}))"); await sleep(1000);
  ok('选「写备注」打开详情', (await ev("document.querySelector('#drawer').classList.contains('on') && document.querySelector('#drawer h2').innerText")) !== 'false', await text('#drawer h2'));
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await ev("document.querySelector('.filters[data-view=daily] [data-f=cool]').click()"); await sleep(600);
  await shot('crm-daily.png');

  console.log('跟进记录');
  await click('#tabs [data-page=log]'); await sleep(1200);
  ok('有两条记录', Number(await ev("document.querySelectorAll('#tblLog tbody tr[data-id]').length")) === 2, await ev("document.querySelector('#tblLog tbody tr').innerText.split('\\t').join(' | ')"));
  ok('底部按人统计', (await text('#logCount')).includes('主管测试 2'), await text('#logCount'));

  console.log('跟进统计');
  await click('#tabs [data-page=screen]'); await sleep(1200);
  ok('六个指标卡', (await ev("document.querySelectorAll('#scKpis .kpi').length")) === '6' && (await text('#scKpis')).includes('跟进次数') && (await text('#scKpis')).includes('覆盖客户'), await ev("[...document.querySelectorAll('#scKpis .kpi')].map(k=>k.innerText.replace(/\\s+/g,' ')).join(' ｜ ')"));
  ok('周期范围写明', (await text('#scRange')).includes('至今'), await text('#scRange'));
  ok('业务员排行（两次跟进分属两个业务员）', (await ev("document.querySelectorAll('#tblRank tbody tr').length")) === '2' && (await text('#tblRank')).includes('等回复') && (await text('#tblRank')).includes('已下单'), await ev("[...document.querySelectorAll('#tblRank tbody tr')].map(r=>r.innerText.replace(/\\s+/g,' ')).join(' ｜ ')"));
  ok('近 7 天：7 根柱子', (await ev("document.querySelectorAll('#scTrend .tcol').length")) === '7' && (await text('#scTrendSum')).includes('日均'), await text('#scTrendSum'));
  ok('明细两行', (await ev("document.querySelectorAll('#tblSc tbody tr[data-id]').length")) === '2');
  await ev("document.querySelector('#scPeriod').value='today';document.querySelector('#scPeriod').dispatchEvent(new Event('change',{bubbles:true}))"); await sleep(1000);
  ok('今天：按小时', (await text('#scTrendTitle')).includes('小时') && (await ev("document.querySelectorAll('#scTrend .tcol').length")) === '14');
  await ev("document.querySelector('#scPeriod').value='month';document.querySelector('#scPeriod').dispatchEvent(new Event('change',{bubbles:true}))"); await sleep(1000);
  ok('本月：按天，从 1 号起', (await ev("document.querySelectorAll('#scTrend .tcol').length")) === String(new Date().getDate()) && (await text('#scRange')).startsWith(new Date().getMonth() + 1 + '-01'), '柱子 ' + await ev("document.querySelectorAll('#scTrend .tcol').length") + ' 根，今天 ' + new Date().getDate() + ' 号　' + await text('#scRange'));
  await shot('crm-screen.png', 1250);
  await shot('crm-log.png');

  console.log('沉睡唤醒 / 全部客户');
  await click('#tabs [data-page=sleep]');
  ok('沉睡名单', await waitRows('sleep'), await ev("document.querySelector('#page-sleep [data-t=count]').textContent + '　' + document.querySelector('#page-sleep tbody tr').innerText.split('\\t').join(' | ')"));
  await click('#tabs [data-page=all]');
  ok('全部客户', await waitRows('all'), await ev("document.querySelector('#page-all [data-t=count]').textContent + '　首行：' + document.querySelector('#page-all tbody tr').innerText.split('\\t').join(' | ')"));

  console.log('设置（主管）');
  await click('#tabs [data-page=settings]'); await sleep(1500);
  const vals = JSON.parse(await ev("JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-s]')].map(i => [i.dataset.s, i.value])))"));
  ok('规则回填（含跟进天数）', vals.keyMoney12m === '50000' && vals.followReplyDays === '7' && vals.followLaterDays === '30', JSON.stringify(vals));
  const usersText = async () => ev("[...document.querySelectorAll('#tblUsers tbody tr')].map(r=>r.innerText.replace(/\\s+/g,' ')).join(' ｜ ')");
  await sleep(1500);
  ok('人员表里只有主管自己', Number(await ev("document.querySelectorAll('#tblUsers tbody tr').length")) === 1 && (await text('#tblUsers')).includes('主管测试'), (await usersText()) || '（人员表是空的）');
  ok('同步记录说明数据来自哪次同步', (await text('#syncLog')).includes('的同步'), await text('#syncLog'));
  await ev("document.querySelector('#uName').value='界面业务员';document.querySelector('#uPass').value='ui123456'");
  await click('#btnAddUser'); await sleep(1200);
  ok('业务员账号没选业务员 → 拒绝', Number(await ev("document.querySelectorAll('#tblUsers tbody tr').length")) === 1 && (await text('#toast')).includes('ERP'), await text('#toast') + '　人员：' + await usersText());
  await ev("document.querySelector('#uName').value='界面业务员';document.querySelector('#uPass').value='ui123456';document.querySelector('#uSale').value='林小敏'");
  await click('#btnAddUser'); await sleep(1200);
  ok('添加业务员账号', (await ev("document.querySelectorAll('#tblUsers tbody tr').length")) === '2', '行数 ' + await ev("document.querySelectorAll('#tblUsers tbody tr').length") + '　' + await usersText());
  await shot('crm-settings.png', 1500);
  await ev("document.querySelector('[data-s=followReplyDays]').value=5"); await click('#btnSaveRules'); await sleep(1500);
  ok('改规则后保存', (await ev("document.querySelector('[data-s=followReplyDays]').value")) === '5' && (await text('#toast')).includes('已保存'));
  await ev("document.querySelector('[data-s=followReplyDays]').value=7"); await click('#btnSaveRules'); await sleep(1200);

  console.log('业务员视角');
  await click('#btnLogout'); await sleep(800);
  ok('退出后回到登录', await wait("getComputedStyle(document.querySelector('#login')).display === 'flex'"));
  ok('密码错进不去', (await ev("(async()=>{document.querySelector('#loginName').value='界面业务员';document.querySelector('#loginPass').value='wrong';document.querySelector('#loginForm').requestSubmit();await new Promise(r=>setTimeout(r,900));return document.querySelector('#loginErr').textContent;})()")).includes('不对'),
    await text('#loginErr'));
  ok('业务员登录', await login('界面业务员', 'ui123456'), '登录层提示：' + await text('#loginErr'));
  ok('顶栏标明只看自己名下', (await text('#meInfo')).includes('只看自己名下'), await text('#meInfo'));
  ok('没有设置页、没有同步按钮', (await ev("document.querySelector('#tabs [data-page=settings]').style.display")) === 'none' && (await ev("document.querySelector('#btnSync').style.display")) === 'none');
  ok('概览只有自己的数，没有业务员表', (await text('#kpis')).includes('我的客户') && (await ev("document.querySelector('#page-overview .card').style.display")) === 'none', await ev("[...document.querySelectorAll('.kpi')].map(k => k.innerText.split('\\n').join(' ')).join(' ｜ ')"));
  await click('#tabs [data-page=daily]'); await sleep(1200);
  ok('名单只有自己名下', await waitRows('daily') && (await ev("[...document.querySelectorAll('#page-daily tbody tr td:nth-child(2)')].every(t => t.textContent === '林小敏')")) === 'true', await count('daily'));
  ok('筛选条标明「我的客户」，不能换业务员', (await ev("document.querySelector('.only-mine') && document.querySelector('.filters[data-view=daily] [data-f=sale]').disabled")) === 'true');
  await shot('crm-sale.png');
  await ev("document.querySelector('#page-daily tbody tr[data-id]').click()"); await sleep(1000);
  await ev("document.querySelector('#cNote').value='自测：已下单'"); await click('#drawer [data-result=ordered]'); await sleep(1500);
  ok('业务员能跟自己的客户', (await text('#toast')).includes('已记录'), await text('#toast'));
  await click('#tabs [data-page=log]'); await sleep(1200);
  ok('业务员的跟进记录只有自己名下', Number(await ev("document.querySelectorAll('#tblLog tbody tr[data-id]').length")) === 1 && (await text('#tblLog')).includes('界面业务员') && !(await text('#tblLog')).includes('主管测试'), await ev("document.querySelector('#tblLog tbody tr').innerText.split('\\t').join(' | ')"));
  await ev("document.querySelector('#loginName').value='';");

  console.log('\n前端报错：' + (errors.length ? '\n' + errors.join('\n') : '无'));
  if (errors.length) fail++;
  console.log('\n' + (fail ? '有 ' + fail + '项失败' : '全部通过'));
  ws.close(); chrome.kill(); await e.stop();
  process.exit(fail ? 1 : 0);
})().catch(async err => {
  console.error('测试脚本出错：', err);
  chrome.kill(); if (e) await e.stop();
  process.exit(1);
});
