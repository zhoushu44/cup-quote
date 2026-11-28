/* 看一眼分析结果的整体分布，用来定重点客户规则的默认值
   用法：node tools/distribution.js */
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', '..', '..', 'data', 'crm');
const { analyze } = require('../analyze');
const customers = JSON.parse(fs.readFileSync(path.join(DATA, 'customers.json'), 'utf8'));
const orders = JSON.parse(fs.readFileSync(path.join(DATA, 'orders.json'), 'utf8'));

const all = analyze(customers, orders, {}, Date.now());
const count = (rows, k) => rows.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const bought = all.filter(r => r.n > 0);
console.log('客户总数', all.length, '｜下过单', bought.length, '｜两单及以上', bought.filter(r => r.n >= 2).length,
  '｜算得出周期', bought.filter(r => r.cycle > 0).length);
console.log('状态分布：', JSON.stringify(count(all, 'status')));
const c = bought.filter(r => r.cycle > 0).map(r => r.cycle);
console.log('复购周期（天）分位 25/50/75/90：', pct(c, .25), pct(c, .5), pct(c, .75), pct(c, .9));
for (const k of ['money', 'money12', 'n12', 'n']) {
  const a = bought.map(r => r[k]);
  console.log(k + ' 分位 50/75/90/95/99：', pct(a, .5), pct(a, .75), pct(a, .9), pct(a, .95), pct(a, .99));
}
for (const th of [30000, 50000, 100000, 200000]) console.log('近12个月金额 ≥ ' + th + '：', bought.filter(r => r.money12 >= th).length);
for (const th of [4, 6, 10, 20]) console.log('近12个月单数 ≥ ' + th + '：', bought.filter(r => r.n12 >= th).length);

console.log('\n今日跟进名单前 12 个：');
all.filter(r => ['overdue', 'due', 'sleep'].includes(r.status)).slice(0, 12).forEach(r => console.log('  ' + JSON.stringify({
  name: r.name, sale: r.saleMan, status: r.status, since: r.since, cycle: r.cycle, od: r.overdueDays,
  n: r.n, money: r.money, money12: r.money12, n12: r.n12, key: r.key, top: r.topProds
})));
console.log('\n按业务员（有逾期/到期/沉睡的）：');
const g = {};
all.filter(r => ['overdue', 'due', 'sleep'].includes(r.status)).forEach(r => {
  g[r.saleMan || '（未分配）'] = g[r.saleMan || '（未分配）'] || { overdue: 0, due: 0, sleep: 0 };
  g[r.saleMan || '（未分配）'][r.status]++;
});
Object.entries(g).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y) - Object.values(a[1]).reduce((x, y) => x + y))
  .forEach(([k, v]) => console.log('  ' + k + '：逾期 ' + v.overdue + '，到期 ' + v.due + '，沉睡 ' + v.sleep));
