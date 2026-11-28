/* 只读：查 ERP 字典和订单详情，找 订单状态 / 作废标记 的文字含义 */
'use strict';
const path = require('path');
const fs = require('fs');
const DATA = path.join(__dirname, '..', 'data');
const sync = require('../erp-sync');

(async () => {
  await sync.login(DATA);
  const get = async p => {
    try { return await sync.get(DATA, p); } catch (e) { return { err: e.message }; }
  };
  sync.get = sync.get; // eslint-disable-line
  const types = await get('/system/dict/type/list?pageNum=1&pageSize=500');
  const rows = (types.rows || []).filter(t => /订单|作废|状态|order|void/i.test(t.dictName + t.dictType));
  console.log('相关字典类型：');
  rows.forEach(t => console.log('  ' + t.dictType + '  ' + t.dictName));
  for (const t of rows) {
    const d = await get('/system/dict/data/type/' + encodeURIComponent(t.dictType));
    if (d.data) console.log('\n[' + t.dictName + '] ' + t.dictType + '：' + d.data.map(x => x.dictValue + '=' + x.dictLabel).join('，'));
  }
  const orders = JSON.parse(fs.readFileSync(path.join(DATA, 'orders.json'), 'utf8'));
  for (const f of [0, 1, 2, 3]) {
    const o = orders.filter(x => x.voidFlag === f && x.orderStatus === 600)[0] || orders.filter(x => x.voidFlag === f)[0];
    if (!o) continue;
    const d = await get('/order/saleorder/' + o.id);
    const x = d.data || {};
    console.log('\n订单详情 voidFlag=' + f + ' ' + o.code + '：' + JSON.stringify({
      voidFlag: x.voidFlag, voidFlagDes: x.voidFlagDes, voidReason: x.voidReason, voidMan: x.voidMan,
      orderStatus: x.orderStatus, orderStatusDes: x.orderStatusDes, status: x.status, memo: x.memo, remark: x.remark
    }));
    console.log('  详情里带 void / status / flag 字样的键：' + Object.keys(x).filter(k => /void|status|flag|cancel|delete/i.test(k)).map(k => k + '=' + JSON.stringify(x[k])).join('，'));
  }
  process.exit(0);
})().catch(e => { console.error('失败：', e.message); process.exit(1); });
