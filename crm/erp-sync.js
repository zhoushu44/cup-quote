/* ============================================================
 *  客户营销系统 · ERP 同步（只读，不依赖第三方包）
 *  从印刷 ERP（晨鹄）全量拉取客户档案和销售订单，落在 DATA 目录：
 *    DATA/erp.json        ERP 账号（不入 git）
 *    DATA/customers.json  客户档案（只留营销用得上的字段）
 *    DATA/orders.json     销售订单（只留营销用得上的字段）
 *    DATA/meta.json       上次同步时间、条数
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://dhbz.chenhukeji.cn';
const PAGE = 2000;
const GAP = 150;                       // 每页之间歇一下，别把 ERP 拖慢
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cfg = null;
let token = null;

function loadCfg(DATA) {
  if (cfg) return cfg;
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(DATA, 'erp.json'), 'utf8')); } catch (e) { /* 没配过 */ }
  cfg = {
    url: String(f.url || process.env.ERP_URL || DEFAULT_URL).replace(/\/+$/, ''),
    user: String(f.user || process.env.ERP_USER || ''),
    pass: String(f.pass || process.env.ERP_PASS || '')
  };
  return cfg;
}

function status(DATA) {
  const c = loadCfg(DATA);
  return { configured: !!(c.user && c.pass), url: c.url, user: c.user };
}

async function login(DATA) {
  const c = loadCfg(DATA);
  if (!c.user || !c.pass) throw new Error('ERP 账号还没配置');
  const r = await fetch(c.url + '/prod-api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.user, password: c.pass })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('ERP 登录失败：' + (j.msg || ('HTTP ' + r.status)));
  token = j.token;
  return token;
}

/* 带 token 的 GET；401 重登一次 */
async function get(DATA, p, retried) {
  const c = loadCfg(DATA);
  if (!token) await login(DATA);
  const r = await fetch(c.url + '/prod-api' + p, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 && !retried) { token = null; return get(DATA, p, true); }
  const j = await r.json().catch(() => ({}));
  if (j.code && j.code !== 200) throw new Error('ERP 接口出错（' + p + '）：' + (j.msg || ''));
  return j;
}

/* 逐页拉完一个 list 接口；onPage 每页回调一次（用来显示进度） */
async function fetchAll(DATA, p, onPage) {
  const out = [];
  let total = Infinity;
  for (let n = 1; out.length < total; n++) {
    const j = await get(DATA, p + (p.indexOf('?') < 0 ? '?' : '&') + 'pageNum=' + n + '&pageSize=' + PAGE);
    const rows = j.rows || [];
    total = Number(j.total) || rows.length;
    out.push.apply(out, rows);
    if (onPage) onPage(out.length, total);
    if (!rows.length) break;
    if (out.length < total) await sleep(GAP);
  }
  return out;
}

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const str = v => (v == null ? '' : String(v)).trim();

function slimCustomer(x) {
  return {
    id: num(x.id), name: str(x.name), linkman: str(x.linkman), mobile: str(x.mobile),
    wx: str(x.wx), qq: str(x.qq), level: str(x.levelName), saleMan: str(x.saleMan),
    addr: str(x.receiveAddress), area: str(x.receiveArea), createMan: str(x.createMan),
    createTime: str(x.time), lastOrderTime: str(x.lastOrderTime), status: str(x.status)
  };
}

function slimOrder(x) {
  return {
    id: num(x.id), code: str(x.code), customId: num(x.customId), customer: str(x.customer),
    product: str(x.product), qty: num(x.orderQty), money: num(x.orderMoney),
    createTime: str(x.createTime), orderStatus: num(x.orderStatus), voidFlag: num(x.voidFlag),
    salMan: str(x.salMan), createMan: str(x.createMan), deliverTime: str(x.deliverTime)
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* 全量同步。旧文件先留着，全部拉完才覆盖，中途失败不会把本地数据弄坏 */
async function syncAll(DATA, onProgress) {
  const say = m => { if (onProgress) onProgress(m); };

  say('拉取客户档案…');
  const cs = await fetchAll(DATA, '/base/visitors/list', (a, b) => say('客户 ' + a + ' / ' + b));
  const customers = cs.map(slimCustomer);
  say('客户 ' + customers.length + ' 个，开始拉订单…');

  const os = await fetchAll(DATA, '/order/saleorder/list', (a, b) => say('订单 ' + a + ' / ' + b));
  const orders = os.map(slimOrder);
  say('订单 ' + orders.length + ' 条');

  writeJson(path.join(DATA, 'customers.json'), customers);
  writeJson(path.join(DATA, 'orders.json'), orders);
  const meta = { ts: Date.now(), customers: customers.length, orders: orders.length };
  writeJson(path.join(DATA, 'meta.json'), meta);
  return meta;
}

module.exports = { status, loadCfg, login, get, syncAll };
