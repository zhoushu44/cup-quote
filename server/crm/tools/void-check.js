/* 看作废标记和订单状态、金额的交叉分布，确定哪些订单算有效 */
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', '..', '..', 'data', 'crm');
const orders = JSON.parse(fs.readFileSync(path.join(DATA, 'orders.json'), 'utf8'));

const key = (r, ks) => ks.map(k => r[k]).join(' | ');
const cross = (ks) => orders.reduce((m, r) => (m[key(r, ks)] = (m[key(r, ks)] || 0) + 1, m), {});
const sum = (ks) => orders.reduce((m, r) => (m[key(r, ks)] = (m[key(r, ks)] || 0) + r.money, m), {});

console.log('作废标记 × 订单状态（条数）：');
Object.entries(cross(['voidFlag', 'orderStatus'])).sort().forEach(([k, v]) => console.log('  ' + k + '  →  ' + v));
console.log('\n作废标记 × 订单状态（金额）：');
Object.entries(sum(['voidFlag', 'orderStatus'])).sort().forEach(([k, v]) => console.log('  ' + k + '  →  ' + Math.round(v)));

console.log('\n每种作废标记各看 3 条样例：');
[0, 1, 2, 3].forEach(f => {
  const rows = orders.filter(o => o.voidFlag === f);
  console.log('voidFlag=' + f + '：' + rows.slice(-3).map(o => JSON.stringify({
    code: o.code, customer: o.customer, product: o.product, qty: o.qty, money: o.money,
    status: o.orderStatus, time: o.createTime, createMan: o.createMan
  })).join('\n            '));
});
