/* ============================================================
 *  客户营销系统 · 服务端（不依赖任何第三方包）
 *    1) 托管 public/ 下的页面
 *    2) /api/*：概览、名单、客户详情、规则设置、备注/排除、ERP 同步
 *  数据都在 DATA 目录（默认 ./data，可用环境变量 DATA 改）：
 *    customers.json / orders.json / meta.json   ← ERP 同步来的
 *    settings.json  规则        notes.json      ← 本系统自己的（排除、备注）
 *  只读 ERP，不往 ERP 回写任何东西。
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const sync = require('./erp-sync');
const { analyze, DEFAULTS } = require('./analyze');
const NUM_KEYS = ['keyMoney12m', 'keyOrders12m', 'keyCountMinMoney', 'sleepRatio', 'sleepMinDays', 'lostDays', 'minGap', 'maxGap'];

const PORT = parseInt(process.env.PORT || '6656', 10);
const DATA = process.env.DATA || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const AUTO_SYNC_AFTER = 12 * 3600 * 1000;      // 数据超过 12 小时，启动时自动同步一次

/* ---------- 本地文件 ---------- */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
const F = {
  customers: path.join(DATA, 'customers.json'), orders: path.join(DATA, 'orders.json'),
  meta: path.join(DATA, 'meta.json'), settings: path.join(DATA, 'settings.json'),
  notes: path.join(DATA, 'notes.json')
};

/* ---------- 分析缓存（数据或规则变了才重算） ---------- */
let cache = null;
function build() {
  const customers = readJson(F.customers, []);
  const orders = readJson(F.orders, []);
  const settings = readJson(F.settings, {});
  const notes = readJson(F.notes, {});
  const rows = analyze(customers, orders, settings, Date.now()).map(r =>
    Object.assign(r, notes[r.id] || {}));
  const ordersBy = new Map();
  for (const o of orders) {
    if (!ordersBy.has(o.customId)) ordersBy.set(o.customId, []);
    ordersBy.get(o.customId).push(o);
  }
  cache = { rows, ordersBy, meta: readJson(F.meta, { ts: 0, customers: 0, orders: 0 }), settings };
  return cache;
}
const data = () => cache || build();
const invalidate = () => { cache = null; };

/* ---------- 同步（同一时间只跑一个） ---------- */
const job = { running: false, log: '', error: '' };
async function runSync(auto) {
  if (job.running) return job;
  job.running = true; job.error = ''; job.log = (auto ? '数据较旧，自动同步…\n' : '开始同步…\n');
  try {
    await sync.syncAll(DATA, m => { job.log += '  ' + m + '\n'; if (job.log.length > 4000) job.log = job.log.slice(-4000); });
    job.log += '完成\n';
    invalidate();
  } catch (e) {
    job.error = e.message;
    job.log += '失败：' + e.message + '\n';
  }
  job.running = false;
  return job;
}

/* ---------- HTTP 工具 ---------- */
function send(res, code, body, head) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, head || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (file.indexOf(PUB) !== 0 || p.indexOf('/.') >= 0) return send(res, 403, '禁止访问');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '找不到页面');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

/* ---------- 列表筛选 ---------- */
/* view：daily 今日跟进（逾期 + 快到期 + 重点客户里的沉睡）/ sleep 沉睡唤醒 / all 全部 */
const VIEWS = {
  daily: r => ['overdue', 'due'].includes(r.status) || (r.status === 'sleep' && r.key),
  sleep: r => r.status === 'sleep',
  all: () => true
};
const active = r => !r.excl;                // 被排除的（同行、内部账号等）不进任何名单

function pickRows(q) {
  const inView = VIEWS[q.get('view')] || VIEWS.daily;
  const sale = (q.get('sale') || '').trim();
  const status = (q.get('status') || '').trim();
  const key = q.get('key') === '1';
  const k = norm(q.get('q'));
  let rows = data().rows.filter(r => active(r) && inView(r));
  if (sale) rows = rows.filter(r => r.saleMan === sale);
  if (status) rows = rows.filter(r => r.status === status);
  if (key) rows = rows.filter(r => r.key);
  if (k) rows = rows.filter(r => norm(r.name).includes(k) || norm(r.linkman).includes(k) || norm(r.mobile).includes(k) || norm(r.note).includes(k));
  return rows;
}

/* ---------- 接口 ---------- */
async function serveApi(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/meta' && method === 'GET') {
    const d = data();
    const stale = !d.meta.ts || Date.now() - d.meta.ts > AUTO_SYNC_AFTER;
    if (stale && !job.running && sync.status(DATA).configured) runSync(true);
    return json(res, 200, { ok: true, meta: d.meta, sync: job, erp: sync.maskCfg(DATA), settings: d.settings });
  }

  if (p === '/api/sync' && method === 'POST') {
    if (!sync.status(DATA).configured) return json(res, 200, { ok: false, error: 'ERP 账号还没配置' });
    runSync(false);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/erp' && method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: '内容不是有效的数据' }); }
    const c = sync.writeCfg(DATA, { url: b.url, user: b.user, pass: b.pass || null });
    return json(res, 200, { ok: true, erp: { url: c.url, user: c.user, configured: !!(c.user && c.pass), pass: '******' } });
  }

  if (p === '/api/overview' && method === 'GET') {
    const rows = data().rows;
    const live = rows.filter(active);
    const cnt = (list, f) => list.filter(f).length;
    const st = {};
    live.forEach(r => { st[r.status] = (st[r.status] || 0) + 1; });
    const by = {};
    live.forEach(r => {
      const k = r.saleMan || '（未分配）';
      by[k] = by[k] || { saleMan: k, total: 0, key: 0, overdue: 0, due: 0, sleep: 0, money12: 0 };
      const g = by[k];
      g.total++; g.money12 += r.money12;
      if (r.key) g.key++; if (r.status === 'overdue') g.overdue++; if (r.status === 'due') g.due++; if (r.status === 'sleep') g.sleep++;
    });
    const sales = Object.values(by).sort((a, b) => (b.overdue + b.due) - (a.overdue + a.due));
    return json(res, 200, { ok: true, status: st, sales,
      kpi: {
        total: live.length, bought: cnt(live, r => r.n > 0), repeat: cnt(live, r => r.n >= 2),
        key: cnt(live, r => r.key), overdue: st.overdue || 0, due: st.due || 0, sleep: st.sleep || 0,
        money12: Math.round(live.reduce((s, r) => s + r.money12, 0)),
        excluded: rows.length - live.length
      } });
  }

  if (p === '/api/list' && method === 'GET') {
    const rows = pickRows(q);
    const sort = q.get('sort') || 'score';
    const by = { score: (a, b) => b.score - a.score, money: (a, b) => b.money12 - a.money12,
      since: (a, b) => b.since - a.since, cycle: (a, b) => (a.overdueDays || 0) - (b.overdueDays || 0) };
    rows.sort(by[sort] || by.score);
    const size = Math.min(parseInt(q.get('size'), 10) || 100, 500);
    const page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
    const slim = r => ({ id: r.id, name: r.name, saleMan: r.saleMan, linkman: r.linkman, mobile: r.mobile,
      status: r.status, key: r.key, since: r.since, cycle: r.cycle, overdueDays: r.overdueDays, n: r.n, n12: r.n12,
      money: r.money, money12: r.money12, lastTime: r.lastTime, lastProduct: r.lastProduct, lastQty: r.lastQty,
      topProds: r.topProds, note: r.note || '', excl: !!r.excl, gaps: r.gaps });
    return json(res, 200, { ok: true, total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size).map(slim) });
  }

  const mc = p.match(/^\/api\/customer\/(\d+)$/);
  if (mc && method === 'GET') {
    const id = Number(mc[1]);
    const r = data().rows.find(x => x.id === id);
    if (!r) return json(res, 404, { ok: false, error: '没有这个客户' });
    const orders = (data().ordersBy.get(id) || []).slice().reverse().map(o => ({
      code: o.code, time: o.createTime, product: o.product, qty: o.qty, money: o.money,
      status: o.orderStatus, voidFlag: o.voidFlag, salMan: o.salMan
    }));
    return json(res, 200, { ok: true, customer: r, orders });
  }

  if (p === '/api/notes' && method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: '内容不是有效的数据' }); }
    const id = Number(b.id);
    if (!data().rows.some(r => r.id === id)) return json(res, 404, { ok: false, error: '没有这个客户' });
    const notes = readJson(F.notes, {});
    if (b.excl === undefined && b.note === undefined) return json(res, 400, { ok: false, error: '没有要改的内容' });
    const cur = notes[id] || {};
    if (b.excl !== undefined) cur.excl = !!b.excl;
    if (b.note !== undefined) cur.note = String(b.note || '').slice(0, 300);
    if (!cur.excl && !cur.note) delete notes[id]; else notes[id] = cur;
    writeJson(F.notes, notes);
    invalidate();
    return json(res, 200, { ok: true, notes: notes[id] || {} });
  }

  if (p === '/api/settings' && method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: '内容不是有效的数据' }); }
    /* 以默认值为底，只覆盖传了且合法的字段；有一个不合法就整次拒绝，不动已保存的规则 */
    const cur = Object.assign({}, DEFAULTS, readJson(F.settings, {}));
    let bad = false;
    NUM_KEYS.forEach(k => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!isFinite(v) || v < 0) { bad = true; return; }
      cur[k] = Math.round(v);
    });
    if (b.dueRatio !== undefined) {
      const v = Number(b.dueRatio);
      if (!isFinite(v) || v < 0 || v > 1) bad = true; else cur.dueRatio = v;
    }
    if (Array.isArray(b.voidFlags)) cur.voidFlags = b.voidFlags.map(Number).filter(v => isFinite(v));
    if (bad) return json(res, 400, { ok: false, error: '规则里要填 0 或正数' });
    writeJson(F.settings, cur);
    invalidate();
    return json(res, 200, { ok: true, settings: cur });
  }

  json(res, 404, { ok: false, error: '没有这个接口' });
}

/* ---------- 入口 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
  if (url.pathname.indexOf('/api/') === 0) {
    if (req.method === 'POST') {
      const o = req.headers.origin;
      if (o && o !== 'http://' + req.headers.host && o !== 'https://' + req.headers.host) return json(res, 403, { ok: false, error: '不接受其他网站的请求' });
    }
    return serveApi(req, res, url).catch(e => {
      if (e.message !== 'too large') console.error(e);
      if (!res.headersSent) json(res, e.message === 'too large' ? 413 : 500, { ok: false, error: e.message === 'too large' ? '内容太大' : '服务器出错了' });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '不支持的方法');
  serveStatic(req, res, url);
});

const n = build();
server.listen(PORT, '0.0.0.0', () => {
  console.log('客户营销系统已启动：http://localhost:' + PORT + '　客户 ' + n.rows.length + ' 个，订单 ' + (n.meta.orders || 0) + ' 条，数据目录 ' + DATA);
});
