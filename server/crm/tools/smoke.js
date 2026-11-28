/* 接口自测：node tools/smoke.js
   在临时环境（数据副本 + 独立服务）里把接口过一遍：登录与权限、名单筛选、跟进与冷却期、人员管理、规则、备注。 */
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./env');
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra !== undefined && extra !== '' ? '  → ' + extra : '')); if (!cond) fail++; };
const E = encodeURIComponent;
/* 带会话 Cookie 的请求；每个 jar 是一个登录的人。连不上时把服务的退出码和日志一起报出来 */
const jar = () => {
  let cookie = '';
  const j = async (method, p, body, headers) => {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    let r;
    try {
      r = await fetch(B + p, method === 'POST'
        ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify(body) }
        : { headers: h });
    } catch (err) {
      throw new Error('请求 ' + method + ' ' + p + ' 失败（' + (err.cause && err.cause.code || err.message) + '）\n' + (await ENV.report()));
    }
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map(s => s.split(';')[0]).join('; ');
    let parsed = {};
    const text = await r.text();
    try { parsed = JSON.parse(text); } catch (e) { /* 不是 JSON，下面原样带出 */ }
    return { status: r.status, text, j: parsed };
  };
  return { j, get cookie() { return cookie; } };
};
let B, ENV;

(async () => {
  const e = ENV = await env.start(); B = e.base;
  try {
    console.log('静态页面');
    for (const p of ['/', '/crm/app.js', '/crm/style.css', '/healthz']) { const r = await fetch(B + p); ok(p, r.status === 200 && (await r.text()).length > 0, r.status); }   // 内容要读完，不然连接回收会带掉后面的请求
    const x = await fetch(B + '/..%2Fserver.js'); await x.text(); ok('路径穿越被拒', [403, 404].includes(x.status));

    console.log('\n登录');
    const anon = jar(), admin = jar();
    ok('没登录 → 401', (await anon.j('GET', '/api/crm/list?view=daily')).status === 401);
    ok('bootstrap 显示需要初始化', (await anon.j('GET', '/api/crm/bootstrap')).j.needSetup === true);
    ok('初始化时密码太短被拒', !(await anon.j('POST', '/api/crm/setup', { name: '主管测试', pass: '123' })).j.ok);
    const su = await anon.j('POST', '/api/crm/setup', { name: '主管测试', pass: 'test123456' });
    ok('创建主管账号', su.j.ok && su.j.user.role === 'admin');
    ok('初始化只能做一次', (await anon.j('POST', '/api/crm/setup', { name: '别人', pass: 'test123456' })).status === 400);
    ok('密码错 → 拒绝', !(await admin.j('POST', '/api/crm/login', { name: '主管测试', pass: 'wrong-pass' })).j.ok);
    const li = await admin.j('POST', '/api/crm/login', { name: '主管测试', pass: 'test123456' });
    ok('密码对 → 登录', li.j.ok && li.j.user.name === '主管测试');
    ok('伪造的 Cookie → 401', (await jar().j('GET', '/api/crm/list', null, { Cookie: 'crm_tok=eyJ1IjoiMSJ9.xxxx' })).status === 401);
    const me = await admin.j('GET', '/api/crm/me');
    ok('me 认出当前用户', me.j.ok && me.j.user.role === 'admin');

    console.log('\n读取接口（主管）');
    const meta = await admin.j('GET', '/api/crm/meta');
    ok('meta（主管能看到 ERP 配置项）', meta.j.ok && meta.j.erp && typeof meta.j.erp === 'object', JSON.stringify(meta.j.meta));
    const ov = await admin.j('GET', '/api/crm/overview');
    ok('overview', ov.j.ok && ov.j.sales.length > 0 && typeof ov.j.kpi.pending === 'number' && typeof ov.j.kpi.followedToday === 'number',
      '业务员 ' + ov.j.sales.length + ' 个，重点 ' + ov.j.kpi.key + '，待跟进 ' + ov.j.kpi.pending + '，今日已跟进 ' + ov.j.kpi.followedToday);
    for (const v of ['daily', 'sleep', 'all']) {
      const r = await admin.j('GET', '/api/crm/list?view=' + v + '&size=5');
      ok('list view=' + v, r.j.ok && r.j.total > 0 && r.j.rows.length === 5, 'total=' + r.j.total);
    }
    const f = await admin.j('GET', '/api/crm/list?view=daily&sale=' + E('黄海鸥') + '&status=overdue&key=1&sort=score');
    ok('筛选 业务员+逾期+重点', f.j.ok && f.j.rows.every(x => x.saleMan === '黄海鸥' && x.status === 'overdue' && x.key), 'total=' + f.j.total);
    const pg = await admin.j('GET', '/api/crm/list?view=daily&size=100&page=2');
    ok('分页 第2页', pg.j.ok && pg.j.page === 2 && pg.j.rows.length <= 100);
    const s = await admin.j('GET', '/api/crm/list?view=all&q=' + E('牛蒡'));
    ok('搜索 牛蒡', s.j.ok && s.j.rows.length >= 1, s.j.rows.map(x => x.name).join(' / '));
    const sortedR = await admin.j('GET', '/api/crm/list?view=daily&size=100&sort=money');
    ok('按金额排序（接口正常）', sortedR.j.ok, sortedR.j.ok ? '' : sortedR.status + ' ' + sortedR.text.slice(0, 300));
    const sorted = sortedR.j.rows || [];
    const m = sorted.map(x => x.money12);
    ok('按金额排序', m.every((v, i) => i === 0 || m[i - 1] >= v), m.slice(0, 3).join(','));
    const sc = (await admin.j('GET', '/api/crm/list?view=daily&size=100')).j.rows;
    ok('默认排序 重点在前', sc.every(x => x.key) || sc.findIndex(x => !x.key) > sc.reduce((a, x, i) => x.key ? i : a, -1));
    if (s.j.rows[0]) {
      const d = await admin.j('GET', '/api/crm/customer/' + s.j.rows[0].id);
      ok('客户详情', d.j.ok && d.j.orders.length >= 1 && 'follow' in d.j.customer, '订单 ' + d.j.orders.length + ' 条，周期 ' + d.j.customer.cycle + ' 天');
    }
    ok('不存在的客户 → 404', (await admin.j('GET', '/api/crm/customer/999999999')).status === 404);

    console.log('\n跟进与冷却期');
    const T = sc[0];
    const before = (await admin.j('GET', '/api/crm/list?view=daily')).j.total;
    const pendBefore = ov.j.kpi.pending;
    ok('跟进结果不合法 → 400', (await admin.j('POST', '/api/crm/follow', { id: T.id, result: 'nope' })).status === 400);
    const fw = await admin.j('POST', '/api/crm/follow', { id: T.id, result: 'reply', note: '自测：采购说下周再联系' });
    ok('记录跟进', fw.j.ok && fw.j.follow.result === 'reply' && fw.j.follow.by === '主管测试' && fw.j.follow.count === 1);
    const after = (await admin.j('GET', '/api/crm/list?view=daily')).j;
    ok('跟进后从今日名单消失', after.total === before - 1 && !after.rows.concat((await admin.j('GET', '/api/crm/list?view=daily&size=500')).j.rows).some(x => x.id === T.id), before + ' → ' + after.total);
    const cool = (await admin.j('GET', '/api/crm/list?view=daily&cool=1')).j;
    ok('「只看已跟进的」里能找到，带结果和次数', cool.rows.some(x => x.id === T.id && x.follow.result === 'reply' && x.follow.count === 1), '冷却中 ' + cool.total + ' 个');
    const dc = (await admin.j('GET', '/api/crm/customer/' + T.id)).j.customer;
    ok('客户详情里有跟进历史和备注', dc.follow.history.length === 1 && dc.note === '自测：采购说下周再联系');
    const log = await admin.j('GET', '/api/crm/follows?days=7');
    ok('跟进记录页有这一条', log.j.ok && log.j.rows.some(h => h.id === T.id && h.by === '主管测试' && h.result === 'reply'), '共 ' + log.j.total + ' 条');
    const odd = (await admin.j('GET', '/api/crm/follows?days=3650')).j;
  ok('最近 7 天以外的天数按 30 天算', Math.abs(odd.since - (Date.now() - 30 * 864e5)) < 60000, new Date(odd.since).toISOString());
  const fromTs = new Date(); fromTs.setHours(0, 0, 0, 0); fromTs.setDate(1);
  const mon = (await admin.j('GET', '/api/crm/follows?from=' + fromTs.getTime())).j;
  ok('指定起始时间（本月）', mon.rows.length >= log.j.rows.length && mon.since === fromTs.getTime(), mon.rows.length + ' 条');
  ok('起始时间不合法（在未来）→ 按默认', (await admin.j('GET', '/api/crm/follows?from=99999999999999')).j.since < Date.now());
    const ov2 = (await admin.j('GET', '/api/crm/overview')).j;
    ok('概览：今日已跟进 +1，待跟进 -1', ov2.kpi.followedToday === ov.j.kpi.followedToday + 1 && ov2.kpi.pending === pendBefore - 1,
      '已跟进 ' + ov2.kpi.followedToday + '，待跟进 ' + ov2.kpi.pending);
    ok('概览：业务员那行计入今日已跟进', ov2.sales.find(x => x.saleMan === T.saleMan).followedToday === 1);
    /* 冷却天数改成 0 → 立刻重新出现；改回去 → 又消失 */
    await admin.j('POST', '/api/crm/settings', { followReplyDays: 0 });
    ok('冷却天数改为 0 后重新出现', (await admin.j('GET', '/api/crm/list?view=daily')).j.total === before);
    await admin.j('POST', '/api/crm/settings', { followReplyDays: 7 });
    ok('改回 7 天后又进入冷却', (await admin.j('GET', '/api/crm/list?view=daily')).j.total === before - 1);
    /* 跟进之后客户下了单 → 不再冷却。把跟进时间改到很久以前来模拟 */
    const ff = path.join(e.data, 'crm', 'follows.json');
    const all = JSON.parse(fs.readFileSync(ff, 'utf8'));
    const h = all[T.id].history[0];
    all[T.id] = { count: 1, last: 1000, by: h.by, result: 'reply', note: h.note, history: [h] };
    fs.writeFileSync(ff, JSON.stringify(all));
    await admin.j('POST', '/api/crm/settings', {});                       // 触发重新读取
    ok('跟进后客户下过单 → 不算冷却', (await admin.j('GET', '/api/crm/list?view=daily')).j.total === before);
    ok('但跟进历史还留着', (await admin.j('GET', '/api/crm/follows?days=30')).j.rows.some(x => x.id === T.id));
    await admin.j('POST', '/api/crm/follow', { id: T.id, result: 'later', note: '自测：最近不需要' });
    const dc2 = (await admin.j('GET', '/api/crm/customer/' + T.id)).j.customer;
    ok('再跟一次：次数 +1，历史两条', dc2.follow.count === 2 && dc2.follow.history.length === 2);

    console.log('\n备注 / 排除');
    ok('外来请求被拒', (await admin.j('POST', '/api/crm/settings', {}, { Origin: 'http://evil.example' })).status === 403);
    const bad = await admin.j('POST', '/api/crm/settings', { keyMoney12m: -5 });
    ok('负数规则被拒', !bad.j.ok && JSON.stringify(bad.j).length < 200, JSON.stringify(bad.j));
    ok('被拒后已保存的规则没变', (await admin.j('GET', '/api/crm/meta')).j.settings.keyMoney12m === meta.j.settings.keyMoney12m);
    const saved = await admin.j('POST', '/api/crm/settings', Object.assign({}, meta.j.settings, { followReplyDays: 7 }));
    ok('保存规则', saved.j.ok && saved.j.settings.followLaterDays === 30, JSON.stringify(saved.j.settings));
    const n1 = await admin.j('POST', '/api/crm/notes', { id: T.id, note: '自测备注', excl: true });
    ok('写备注并排除', n1.j.ok && n1.j.notes.excl === true);
    ok('排除后从名单消失', !(await admin.j('GET', '/api/crm/list?view=all&size=500&q=' + E(T.name.slice(0, 4)))).j.rows.some(x => x.id === T.id));
    ok('概览计入已排除', (await admin.j('GET', '/api/crm/overview')).j.kpi.excluded >= 1);
    await admin.j('POST', '/api/crm/notes', { id: T.id, note: '', excl: false });
    ok('取消排除后恢复', !(await admin.j('GET', '/api/crm/customer/' + T.id)).j.customer.excl);

    console.log('\n人员管理');
    ok('重名被拒', !(await admin.j('POST', '/api/crm/users', { name: '主管测试', pass: 'test123456', role: 'admin' })).j.ok);
    ok('密码太短被拒', !(await admin.j('POST', '/api/crm/users', { name: '甲', pass: '12345', role: 'admin' })).j.ok);
    ok('业务员账号没选业务员 → 拒绝', !(await admin.j('POST', '/api/crm/users', { name: '测试业务员', pass: 'test123456', role: 'sale', saleMan: '' })).j.ok);
    const au = await admin.j('POST', '/api/crm/users', { name: '测试业务员', pass: 'test123456', role: 'sale', saleMan: '黄海鸥' });
    ok('添加业务员账号', au.j.ok && au.j.users.length === 2);
    const saleId = au.j.users.find(u => u.name === '测试业务员').id;
    ok('账号列表不带密码', !JSON.stringify(au.j).match(/hash|salt/));

    const sale = jar();
    ok('业务员登录', (await sale.j('POST', '/api/crm/login', { name: '测试业务员', pass: 'test123456' })).j.ok);
    const sd = (await sale.j('GET', '/api/crm/list?view=daily')).j;
    ok('业务员名单只有自己名下', sd.ok && sd.rows.length > 0 && sd.rows.every(x => x.saleMan === '黄海鸥'), '今日 ' + sd.total + ' 个');
    const other = (await sale.j('GET', '/api/crm/list?view=daily&sale=' + E('郑程鹏'))).j;
    ok('业务员改不了筛选条件', other.rows.every(x => x.saleMan === '黄海鸥') && other.total === sd.total);
    const so = (await sale.j('GET', '/api/crm/overview')).j;
    ok('业务员概览只有自己的数', so.sales.length === 1 && so.sales[0].saleMan === '黄海鸥' && so.kpi.total === ov.j.sales.find(x => x.saleMan === '黄海鸥').total, '客户 ' + so.kpi.total);
    const notMine = sc.find(x => x.saleMan !== '黄海鸥');
    ok('看别人的客户 → 403', (await sale.j('GET', '/api/crm/customer/' + notMine.id)).status === 403);
    ok('跟别人的客户 → 403', (await sale.j('POST', '/api/crm/follow', { id: notMine.id, result: 'later' })).status === 403);
    ok('业务员不能改规则', (await sale.j('POST', '/api/crm/settings', {})).status === 403);
    ok('业务员不能管账号', (await sale.j('GET', '/api/crm/users')).status === 403);
    ok('业务员不能同步 ERP', (await sale.j('POST', '/api/crm/sync')).status === 403);
    ok('业务员看不到 ERP 配置', (await sale.j('GET', '/api/crm/meta')).j.erp === null);
    const mine = sd.rows.find(x => x.id !== T.id);
    ok('业务员跟自己的客户', (await sale.j('POST', '/api/crm/follow', { id: mine.id, result: 'ordered', note: '自测：已下单' })).j.ok);
    const slog = (await sale.j('GET', '/api/crm/follows?days=30')).j;
    ok('业务员的跟进记录只有自己名下', slog.rows.length >= 1 && slog.rows.every(h => h.saleMan === '黄海鸥') && slog.rows.some(h => h.by === '测试业务员'));
    ok('主管能看到所有人的跟进', (await admin.j('GET', '/api/crm/follows?days=30')).j.rows.some(h => h.by === '测试业务员'));

    ok('改密码', (await admin.j('POST', '/api/crm/users', { id: saleId, pass: 'newpass123' })).j.ok);
    ok('新密码能登录', (await jar().j('POST', '/api/crm/login', { name: '测试业务员', pass: 'newpass123' })).j.ok);
    ok('不能删自己', !(await admin.j('POST', '/api/crm/users', { id: me.j.user.id, del: 1 })).j.ok);
    ok('删除业务员账号', (await admin.j('POST', '/api/crm/users', { id: saleId, del: 1 })).j.ok);
    ok('被删的人会话立刻失效', (await sale.j('GET', '/api/crm/list?view=daily')).status === 401);

    ok('退出登录后 → 401', (await admin.j('POST', '/api/crm/logout')).j.ok && (await admin.j('GET', '/api/crm/overview')).status === 401);

    console.log('\n复制文本样例（今日跟进，黄海鸥，前 3 个）');
    const a2 = jar(); await a2.j('POST', '/api/crm/login', { name: '主管测试', pass: 'test123456' });
    const c = (await a2.j('GET', '/api/crm/list?view=daily&size=3&sale=' + E('黄海鸥'))).j.rows;
    console.log('【今日返单提醒】黄海鸥（' + c.length + ' 个）');
    c.forEach((x, i) => console.log((i + 1) + '. ' + (x.key ? '★' : '') + x.name + '｜' + (x.status === 'overdue' ? '已逾期 ' + x.overdueDays + ' 天' : x.status) +
      (x.cycle ? '（往常约' + x.cycle + '天一单）' : '') + '｜近12月 ' + x.n12 + '单 ' + x.money12 + '元｜常买：' + (x.topProds || []).join('、')));
  } finally {
    await e.stop();
  }
  console.log('\n' + (fail ? '有 ' + fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('测试脚本出错：', err); process.exit(1); });
