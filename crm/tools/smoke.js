/* 本地接口自测：node tools/smoke.js [base]   默认 http://127.0.0.1:6656 */
'use strict';
const B = process.argv[2] || 'http://127.0.0.1:6656';
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra !== undefined ? '  → ' + extra : '')); if (!cond) fail++; };
const j = async (method, p, body, headers) => {
  const r = await fetch(B + p, method === 'POST'
    ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) }
    : { cache: 'no-store' });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const E = encodeURIComponent;

(async () => {
  console.log('静态页面');
  for (const p of ['/', '/app.js', '/style.css', '/healthz']) { const r = await fetch(B + p); ok(p, r.status === 200, r.status); }
  ok('路径穿越被拒', (await fetch(B + '/..%2Fserver.js')).status === 403 || (await fetch(B + '/..%2Fserver.js')).status === 404);

  console.log('\n读取接口');
  const meta = await j('GET', '/api/meta');
  ok('meta', meta.j.ok, JSON.stringify(meta.j.meta));
  const ov = await j('GET', '/api/overview');
  ok('overview', ov.j.ok && ov.j.sales.length > 0, '业务员 ' + ov.j.sales.length + ' 个，重点 ' + ov.j.kpi.key);
  for (const v of ['daily', 'sleep', 'all']) {
    const r = await j('GET', '/api/list?view=' + v + '&size=5');
    ok('list view=' + v, r.j.ok && r.j.total > 0 && r.j.rows.length === 5, 'total=' + r.j.total);
  }
  const f = await j('GET', '/api/list?view=daily&sale=' + E('黄海鸥') + '&status=overdue&key=1&sort=score');
  ok('筛选 业务员+逾期+重点', f.j.ok && f.j.rows.every(x => x.saleMan === '黄海鸥' && x.status === 'overdue' && x.key), 'total=' + f.j.total);
  const pg = await j('GET', '/api/list?view=daily&size=100&page=2');
  ok('分页 第2页', pg.j.ok && pg.j.page === 2 && pg.j.rows.length <= 100);
  const s = await j('GET', '/api/list?view=all&q=' + E('牛蒡'));
  ok('搜索 牛蒡', s.j.ok && s.j.rows.length >= 1, s.j.rows.map(x => x.name).join(' / '));
  const sorted = await j('GET', '/api/list?view=daily&size=100&sort=money');
  const m = sorted.j.rows.map(x => x.money12);
  ok('按金额排序', m.every((v, i) => i === 0 || m[i - 1] >= v), m.slice(0, 3).join(','));
  const sc = (await j('GET', '/api/list?view=daily&size=100')).j.rows;
  ok('默认排序 重点在前', sc.findIndex(x => !x.key) >= sc.reduce((a, x, i) => x.key ? i : a, -1) || sc.every(x => x.key));
  if (s.j.rows[0]) {
    const d = await j('GET', '/api/customer/' + s.j.rows[0].id);
    ok('客户详情', d.j.ok && Array.isArray(d.j.orders) && d.j.orders.length >= 1, '订单 ' + d.j.orders.length + ' 条，周期 ' + d.j.customer.cycle + ' 天');
  }
  ok('不存在的客户 → 404', (await j('GET', '/api/customer/999999999')).status === 404);

  console.log('\n写接口');
  ok('外来请求被拒', (await j('POST', '/api/settings', {}, { Origin: 'http://evil.example' })).status === 403);
  const bad = await j('POST', '/api/settings', { keyMoney12m: -5 });
  ok('负数规则被拒', !bad.j.ok, JSON.stringify(bad.j));
  ok('被拒后已保存的规则没变', JSON.stringify((await j('GET', '/api/meta')).j.settings) === JSON.stringify(meta.j.settings));
  const same = await j('POST', '/api/settings', Object.assign({}, meta.j.settings, { dueRatio: meta.j.settings.dueRatio }));
  ok('保存规则（原样）', same.j.ok, JSON.stringify(same.j.settings));
  const target = (await j('GET', '/api/list?view=all&q=' + E('报价系统业务员客户'))).j.rows.find(x => x.name.indexOf('可删除') >= 0);
  if (target) {
    const n1 = await j('POST', '/api/notes', { id: target.id, note: '自测备注', excl: true });
    ok('写备注并排除', n1.j.ok && n1.j.notes.excl === true);
    const gone = await j('GET', '/api/list?view=all&q=' + E('报价系统业务员客户') + '&size=500');
    ok('排除后从名单消失', !gone.j.rows.some(x => x.id === target.id), '同名利搜索结果里已无该 ID');
    ok('概览计入已排除', (await j('GET', '/api/overview')).j.kpi.excluded === 1);
    await j('POST', '/api/notes', { id: target.id, note: '', excl: false });
    const back = await j('GET', '/api/list?view=all&q=' + E('报价系统业务员客户') + '&size=500');
    ok('取消排除后恢复', back.j.rows.some(x => x.id === target.id) && !back.j.rows.find(x => x.id === target.id).excl);
  } else console.log('  跳过备注测试（找不到测试客户）');

  console.log('\n复制文本样例（今日跟进，黄海鸥，前 3 个）');
  const c = (await j('GET', '/api/list?view=daily&size=3&sale=' + E('黄海鸥'))).j.rows;
  console.log('【今日返单提醒】黄海鸥（' + c.length + ' 个）');
  c.forEach((x, i) => console.log((i + 1) + '. ' + (x.key ? '★' : '') + x.name + '｜' + (x.status === 'overdue' ? '已逾期 ' + x.overdueDays + ' 天' : x.status) +
    (x.cycle ? '（往常约' + x.cycle + '天一单）' : '') + '｜近12月 ' + x.n12 + '单 ' + x.money12 + '元｜常买：' + (x.topProds || []).join('、')));

  console.log('\n' + (fail ? '有 ' + fail + ' 项失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本出错：', e.message); process.exit(1); });
