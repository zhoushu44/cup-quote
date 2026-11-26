/* ============================================================
 * 印刷 ERP（晨鹄 dhbz.chenhukeji.cn）对接客户端（不依赖第三方包）
 *   登录 → 客户查询/新建 → 产品/装箱规格 → 下单（POST /order/saleorder）
 *   账号配置存在 DATA/erp.json（不入 git），也可用环境变量 ERP_URL/ERP_USER/ERP_PASS
 * 实测要点：
 *   · 登录无验证码：POST /prod-api/login {username,password} → {token}
 *   · 下单接口返回 {code:200,data:<订单id>}，单号要再查一次详情拿 code
 *   · 新建客户接口不返回 id，建完要按名称搜一遍拿 customId
 *   · 版面/工艺文本放 mainOrderInfo，装箱放 planVoList[{packageType:0,packageId,count,num}]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://dhbz.chenhukeji.cn';
let cfg = null;
let token = null;
let tokenTs = 0;

function loadCfg(DATA) {
  if (cfg) return cfg;
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(DATA, 'erp.json'), 'utf8')); } catch (e) { /* 没有配置文件就算了 */ }
  cfg = {
    url: String(f.url || process.env.ERP_URL || DEFAULT_URL).replace(/\/+$/, ''),
    user: String(f.user || process.env.ERP_USER || ''),
    pass: String(f.pass || process.env.ERP_PASS || '')
  };
  return cfg;
}

/* 保存配置：pass 传 null 表示保持原密码 */
function writeCfg(DATA, patch) {
  const cur = Object.assign({}, loadCfg(DATA));
  ['url', 'user', 'pass'].forEach(function (k) {
    if (patch[k] !== undefined && patch[k] !== null) cur[k] = String(patch[k]).trim();
  });
  cfg = cur;
  token = null;
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = path.join(DATA, 'erp.json.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 1));
  fs.renameSync(tmp, path.join(DATA, 'erp.json'));
  return cur;
}

function status(DATA) {
  const c = loadCfg(DATA);
  return { configured: !!(c.user && c.pass), url: c.url, user: c.user };
}

function maskCfg(DATA) {
  const s = status(DATA);
  return Object.assign(s, { pass: s.configured ? '******' : '' });
}

async function login(DATA) {
  const c = loadCfg(DATA);
  if (!c.user || !c.pass) throw new Error('ERP 账号还没配置');
  const r = await fetch(c.url + '/prod-api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.user, password: c.pass })
  });
  const j = await r.json().catch(function () { return {}; });
  if (!j.token) throw new Error('ERP 登录失败：' + (j.msg || ('HTTP ' + r.status)));
  token = j.token;
  tokenTs = Date.now();
  return token;
}

/* 带 token 的 GET/POST；401（登录过期）时重登一次再试 */
async function api(DATA, p, opt, retried) {
  const c = loadCfg(DATA);
  if (!token) await login(DATA);
  const o = Object.assign({}, opt || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
  const r = await fetch(c.url + '/prod-api' + p, o);
  if (r.status === 401 && !retried) {
    token = null;
    return api(DATA, p, opt, true);
  }
  const j = await r.json().catch(function () { return {}; });
  if (j.code && j.code !== 200) {
    const e = new Error('ERP 接口出错（' + p + '）：' + (j.msg || '') + ' ' + JSON.stringify(j).slice(0, 300));
    e.erp = true;
    throw e;
  }
  return j;
}

/* ---------- 客户（往来单位） ---------- */
async function findCustomers(DATA, name, limit) {
  const j = await api(DATA, '/base/visitors/listType?pageNum=1&pageSize=' + (limit || 10) +
    '&visitorType%5B0%5D=0&ywFlag=0&status=0&name=' + encodeURIComponent(name));
  return (j.rows || []).map(function (x) {
    return { id: x.id, name: x.name, linkman: x.linkman || '', mobile: x.mobile || '', level: x.levelName || '', saleMan: x.saleMan || '' };
  });
}

async function ensureCustomer(DATA, info) {
  const name = String((info && info.name) || '').trim();
  if (!name) throw new Error('客户名称不能为空');
  const found = await findCustomers(DATA, name, 10);
  const exact = found.filter(function (x) { return x.name === name; });
  if (exact.length) return exact[0];
  /* 没有完全同名的 → 新建一个（等级固定普通客户 4），建完再搜拿 id */
  await api(DATA, '/base/visitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      visitorType: 0, name: name, customType: 3, level: 4, category: '1', status: '0',
      linkman: String((info && info.contact) || '').slice(0, 40) || null,
      mobile: String((info && info.mobile) || '').slice(0, 20) || null,
      remark: '由报价系统自动创建'
    })
  });
  const again = await findCustomers(DATA, name, 10);
  const made = again.filter(function (x) { return x.name === name; })[0];
  if (!made) throw new Error('客户已创建但搜不到（' + name + '），请到 ERP 里确认');
  return made;
}

/* ---------- 产品 / 装箱规格 ---------- */
async function products(DATA) {
  const j = await api(DATA, '/base/product/list?pageNum=1&pageSize=300&status=1');
  return (j.rows || []).map(function (x) { return { id: x.id, name: x.name, type: x.type }; });
}

async function packages(DATA, productId) {
  const j = await api(DATA, '/base/productpackage/list?productId=' + productId + '&pageSize=2000');
  return (j.rows || []).filter(function (x) { return x.category === 1; }).map(function (x) {
    return { goodId: x.goodId, name: x.name, per: x.defautCount, bagType: x.bagType || 0 };
  });
}

/* ---------- 下单 ---------- */
/* ERP 后端对缺字段很敏感（null 直接 500），所以先垫上「普通下单」表单的完整默认模型，
   调用方只覆盖要改的字段。默认模型来自 ERP 页面表单导出（不含任何客户/订单数据）。 */
let ORDER_DEFAULTS = null;
function orderDefaults(DATA) {
  if (ORDER_DEFAULTS) return ORDER_DEFAULTS;
  try { ORDER_DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'erp-order-defaults.json'), 'utf8')); }
  catch (e) { ORDER_DEFAULTS = {}; }
  return ORDER_DEFAULTS;
}

async function createOrder(DATA, body) {
  const payload = Object.assign({}, orderDefaults(DATA), body);
  const j = await api(DATA, '/order/saleorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(payload)
  });
  const id = j.data;
  if (!id) throw new Error('ERP 没有返回订单 id：' + JSON.stringify(j).slice(0, 200));
  let code = '';
  try {
    const d = (await api(DATA, '/order/saleorder/' + id)).data || {};
    code = d.code || '';
  } catch (e) { /* 单号拿不到不挡成功 */ }
  return { id: id, code: code };
}

/* ---------- 设计稿（版面图）上传 ---------- */
/* 单文件，multipart 字段名必须是 file；返回 {url, originalFilename} */
async function uploadDesign(DATA, name, b64) {
  const c = loadCfg(DATA);
  if (!token) await login(DATA);
  const buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
  const boundary = '----qs' + Date.now().toString(36);
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + String(name || 'layout.jpg').replace(/"/g, '') + '"\r\n' +
    'Content-Type: image/jpeg\r\n\r\n', 'utf8');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(c.url + '/prod-api/design/design/uploadFile', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: body
  });
  if (r.status === 401 && !arguments[3]) {
    token = null;
    return uploadDesign(DATA, name, b64, true);
  }
  const j = await r.json().catch(function () { return {}; });
  if (!j.url) throw new Error('版面图上传失败：' + JSON.stringify(j).slice(0, 200));
  return { url: j.url, originalFilename: j.originalFilename || name, fileName: Buffer.from(String(name || 'layout.jpg'), 'utf8').toString('base64') };
}

/* ---------- 工序模板 / 纸种库 ---------- */
/* 产品的默认工序模板（defaultFlag=1 的项就是 UI 新建订单时预选中的工艺行） */
async function processTemplate(DATA, productId) {
  const j = await api(DATA, '/base/process/getProcessList?productId=' + productId);
  return j.data || [];
}

/* 产品可选纸种：[{suttleId, name 如「白卡268g」, paper 如「白卡纸」}，defaultFlag=1 是默认] */
async function productPapers(DATA, productId) {
  const j = await api(DATA, '/base/productpaper/list?productId=' + productId + '&pageSize=200');
  return (j.rows || []).map(function (r) {
    return { suttleId: r.suttleId, name: r.suttleName || r.name, paper: r.paperName || '', def: r.defaultFlag };
  });
}

module.exports = {
  status: status, maskCfg: maskCfg, writeCfg: writeCfg,
  login: login, findCustomers: findCustomers, ensureCustomer: ensureCustomer,
  products: products, packages: packages, createOrder: createOrder, uploadDesign: uploadDesign,
  processTemplate: processTemplate, productPapers: productPapers
};
