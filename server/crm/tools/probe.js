/* 只读探测：ERP 客户 / 订单列表接口（只发 GET，不写任何数据）
   用法：node probe.js <账号> <密码> */
'use strict';
const ORIGIN = 'http://dhbz.chenhukeji.cn';
const API = ORIGIN + '/prod-api';
const [USER, PASS] = process.argv.slice(2);

(async () => {
  const l = await (await fetch(API + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })).json();
  if (!l.token) { console.log('登录失败', l); process.exit(1); }
  const H = { Authorization: 'Bearer ' + l.token };

  async function get(p) {
    const r = await fetch(API + p, { headers: H });
    const t = await r.text();
    try { return { status: r.status, j: JSON.parse(t) }; } catch (e) { return { status: r.status, raw: t.slice(0, 200) }; }
  }
  const shape = (o, d) => {
    if (o === null) return 'null';
    if (Array.isArray(o)) return '[' + o.length + '] ' + (o.length ? shape(o[0], d) : '');
    if (typeof o === 'object') {
      if (d >= 3) return '{…}';
      return '{' + Object.keys(o).slice(0, 60).map(k => k + ':' + shape(o[k], d + 1)).join(', ') + '}';
    }
    return typeof o;
  };

  const tries = [
    ['客户(现有参数)', '/base/visitors/listType?pageNum=1&pageSize=2&visitorType%5B0%5D=0&ywFlag=0&status=0'],
    ['客户(不带status)', '/base/visitors/listType?pageNum=1&pageSize=2&visitorType%5B0%5D=0&ywFlag=0'],
    ['客户(不带ywFlag)', '/base/visitors/listType?pageNum=1&pageSize=2&visitorType%5B0%5D=0'],
    ['客户(list)', '/base/visitors/list?pageNum=1&pageSize=2'],
    ['订单(saleorder/list)', '/order/saleorder/list?pageNum=1&pageSize=2'],
    ['订单(saleorder/page)', '/order/saleorder/page?pageNum=1&pageSize=2']
  ];
  for (const [name, p] of tries) {
    const r = await get(p);
    console.log('\n== ' + name + '  HTTP ' + r.status + '  code=' + (r.j && r.j.code) + '  total=' + (r.j && r.j.total));
    if (!r.j) { console.log('  非JSON：' + r.raw); continue; }
    if (r.j.msg && r.j.code !== 200) { console.log('  msg：' + r.j.msg); continue; }
    const rows = r.j.rows || (Array.isArray(r.j.data) ? r.j.data : null);
    if (rows) { console.log('  字段：' + shape(rows[0], 0)); console.log('  样例：' + JSON.stringify(rows[0]).slice(0, 1500)); }
    else console.log('  ' + JSON.stringify(r.j).slice(0, 400));
  }
  process.exit(0);
})().catch(e => { console.error('出错', e.message); process.exit(1); });
