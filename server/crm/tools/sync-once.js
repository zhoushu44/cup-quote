/* 同步一次并打印 作废标记 / 订单状态 的分布，用来确定哪些订单算有效
   用法：node tools/sync-once.js */
'use strict';
const path = require('path');
const DATA = path.join(__dirname, '..', '..', '..', 'data', 'crm');
const sync = require('../erp-sync');

const count = (rows, k) => rows.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});

(async () => {
  // ERP 账号在上一级目录（和报价系统共用 data/erp.json）
const meta = await sync.syncAll(DATA, m => console.log('  ' + m), path.join(DATA, '..'));
  console.log('完成：', JSON.stringify(meta));
  const orders = JSON.parse(require('fs').readFileSync(path.join(DATA, 'orders.json'), 'utf8'));
  const customers = JSON.parse(require('fs').readFileSync(path.join(DATA, 'customers.json'), 'utf8'));
  console.log('voidFlag 分布：', JSON.stringify(count(orders, 'voidFlag')));
  console.log('orderStatus 分布：', JSON.stringify(count(orders, 'orderStatus')));
  console.log('createTime 范围：', orders.map(o => o.createTime).filter(Boolean).sort()[0], '~',
    orders.map(o => o.createTime).filter(Boolean).sort().pop());
  console.log('订单里有、客户档案里没有的 customId：',
    [...new Set(orders.map(o => o.customId))].filter(id => !customers.some(c => c.id === id)).length);
  console.log('客户 status 分布：', JSON.stringify(count(customers, 'status')));
  console.log('业务员人数：', new Set(customers.map(c => c.saleMan).filter(Boolean)).size);
  console.log('金额=0 的订单：', orders.filter(o => !o.money).length);
})().catch(e => { console.error('失败：', e.message); process.exit(1); });
