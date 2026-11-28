/* ============================================================
 *  客户营销系统 · 服务端（不依赖任何第三方包）
 *    1) 托管 public/ 下的页面
 *    2) /api/*：登录、概览、名单、客户详情、跟进、跟进记录、规则、人员、ERP 同步
 *  数据都在 DATA 目录（默认 ./data，可用环境变量 DATA 改）：
 *    customers.json / orders.json / meta.json   ← ERP 同步来的
 *    settings.json  规则        notes.json      ← 备注、不做营销
 *    follows.json   跟进记录    users.json      ← 账号（密码只存加盐哈希）
 *    secret.json    会话签名密钥  erp.json       ← ERP 账号
 *  对 ERP 只读，不回写任何东西。
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sync = require('./erp-sync');
const { analyze, parseTime, DEFAULTS } = require('./analyze');

const PORT = parseInt(process.env.PORT || '6656', 10);
const DATA = process.env.DATA || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const AUTO_SYNC_AFTER = 12 * 3600 * 1000;      // 数据超过 12 小时，启动时自动同步一次
const DAY = 86400000;
const SESSION_DAYS = 30;
const COOKIE = 'crm_tok';
const NUM_KEYS = ['keyMoney12m', 'keyOrders12m', 'keyCountMinMoney', 'sleepRatio', 'sleepMinDays', 'lostDays', 'minGap', 'maxGap',
  'followReplyDays', 'followLaterDays'];
const FOLLOW_RESULTS = { reply: '有意向，等回复', later: '最近不需要', ordered: '已经下单', lost: '联系不上 / 不做了' };

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
  notes: path.join(DATA, 'notes.json'), follows: path.join(DATA, 'follows.json'),
  users: path.join(DATA, 'users.json'), secret: path.join(DATA, 'secret.json')
};

/* ---------- 分析缓存（数据、规则、备注或跟进变了才重算） ---------- */
let cache = null;
function build() {
  const customers = readJson(F.customers, []);
  const orders = readJson(F.orders, []);
  const settings = readJson(F.settings, {});
  const notes = readJson(F.notes, {});
  const follows = readJson(F.follows, {});
  const rows = analyze(customers, orders, settings, Date.now())
    .map(r => Object.assign(r, notes[r.id] || {}, { follow: follows[r.id] || null }));
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
const rules = () => Object.assign({}, DEFAULTS, data().settings);

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

/* ---------- 账号与会话 ---------- */
let SECRET = readJson(F.secret, {}).secret;
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); writeJson(F.secret, { secret: SECRET }); }
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const users = () => readJson(F.users, []);
const publicUser = u => ({ id: u.id, name: u.name, role: u.role, saleMan: u.saleMan || '', lastLogin: u.lastLogin || 0 });
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const samePw = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function setSession(res, userId) {
  const p = Buffer.from(JSON.stringify({ u: userId, t: Date.now() })).toString('base64url');
  res.setHeader('Set-Cookie', COOKIE + '=' + p + '.' + sign(p) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (SESSION_DAYS * DAY / 1000));
}
function clearSession(res) { res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function cookieVal(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
/* 从 Cookie 认出当前用户；签名不对或过期都当作没登录 */
function currentUser(req) {
  const v = cookieVal(req, COOKIE);
  const i = v.indexOf('.');
  if (i < 0) return null;
  const p = v.slice(0, i);
  if (!samePw(sign(p), v.slice(i + 1))) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!o || !o.u || Date.now() - o.t > SESSION_DAYS * DAY) return null;
  return users().find(u => u.id === o.u) || null;
}
/* 登录失败次数：同一个账号名 10 分钟内错 5 次就先不让试 */
const fails = new Map();
const tooMany = name => { const f = fails.get(name); return f && Date.now() - f.first < 10 * 60000 && f.n >= 5; };
const noteFail = name => { const f = fails.get(name); if (!f || Date.now() - f.first > 10 * 60000) fails.set(name, { first: Date.now(), n: 1 }); else f.n++; };

/* 业务员只能看自己名下的；主管看全部 */
const owns = (u, r) => u.role !== 'sale' || r.saleMan === u.saleMan;
const scoped = (u, rows) => u.role === 'sale' ? rows.filter(r => r.saleMan === u.saleMan) : rows;

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
const bodyOf = async req => { try { return JSON.parse(await readBody(req)); } catch (e) { return null; } };
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
/* 时间戳 → 北京时间的 20261128 这样的数字，用来判断「是不是今天」 */
const dayNum = ms => { const d = new Date(ms + 8 * 3600000); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
const todayNum = () => dayNum(Date.now());

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

/* ---------- 名单筛选 ---------- */
/* view：daily 今日跟进（逾期 + 快到期 + 重点客户里的沉睡）/ sleep 沉睡唤醒 / all 全部 */
const VIEWS = {
  daily: r => ['overdue', 'due'].includes(r.status) || (r.status === 'sleep' && r.key),
  sleep: r => r.status === 'sleep',
  all: () => true
};
const active = r => !r.excl;                // 被排除的（同行、内部账号等）不进任何名单

/* 冷却中 = 跟进过、还没到下次提醒的日子、而且跟进之后客户没再下单（下单了周期自动重算） */
function cooled(r, S, now) {
  const f = r.follow;
  if (!f || !f.last) return false;
  if (parseTime(r.lastTime) > f.last) return false;
  const days = f.result === 'reply' ? S.followReplyDays : S.followLaterDays;
  return now - f.last < days * DAY;
}

function pickRows(q, user, S, now) {
  const view = VIEWS[q.get('view')] ? q.get('view') : 'daily';
  const onlyCool = q.get('cool') === '1';
  let rows = data().rows.filter(r => active(r) && VIEWS[view](r));
  if (view !== 'all' || onlyCool) rows = rows.filter(r => cooled(r, S, now) === onlyCool);
  const sale = user.role === 'sale' ? user.saleMan : (q.get('sale') || '').trim();
  const status = (q.get('status') || '').trim();
  const k = norm(q.get('q'));
  if (sale) rows = rows.filter(r => r.saleMan === sale);
  if (status) rows = rows.filter(r => r.status === status);
  if (q.get('key') === '1') rows = rows.filter(r => r.key);
  if (k) rows = rows.filter(r => norm(r.name).includes(k) || norm(r.linkman).includes(k) || norm(r.mobile).includes(k) ||
    norm(r.note).includes(k) || norm(r.follow && r.follow.note).includes(k));
  return rows;
}
const slimFollow = f => f && f.last ? { last: f.last, by: f.by, result: f.result, count: f.count, note: f.note || '' } : null;

/* ---------- 接口 ---------- */
const PUBLIC = { '/api/bootstrap': 1, '/api/setup': 1, '/api/login': 1 };
const ADMIN_ONLY = { '/api/sync': 1, '/api/erp': 1, '/api/settings': 1, '/api/users': 1 };

async function serveApi(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;
  const method = req.method;

  /* ---- 不用登录的三个 ---- */
  if (p === '/api/bootstrap' && method === 'GET') return json(res, 200, { ok: true, needSetup: users().length === 0 });

  if (p === '/api/setup' && method === 'POST') {
    if (users().length) return json(res, 400, { ok: false, error: '已经初始化过了' });
    const b = await bodyOf(req);
    const err = checkNewUser(Object.assign({}, b, { role: 'admin' }));     // 第一个账号固定是主管
    if (err) return json(res, 400, { ok: false, error: err });
    const u = newUser(b.name, b.pass, 'admin', '');
    writeJson(F.users, [u]); setSession(res, u.id);
    return json(res, 200, { ok: true, user: publicUser(u) });
  }

  if (p === '/api/login' && method === 'POST') {
    const b = (await bodyOf(req)) || {};
    const name = String(b.name || '').trim();
    if (tooMany(name)) return json(res, 429, { ok: false, error: '密码错了太多次，请 10 分钟后再试' });
    const u = users().find(x => x.name === name);
    if (!u || !samePw(hashPw(b.pass || '', u.salt), u.hash)) {
      noteFail(name);
      return json(res, 200, { ok: false, error: '姓名或密码不对' });
    }
    fails.delete(name);
    const all = users(); const i = all.findIndex(x => x.id === u.id);
    all[i] = Object.assign({}, u, { lastLogin: Date.now() }); writeJson(F.users, all);
    setSession(res, u.id);
    return json(res, 200, { ok: true, user: publicUser(all[i]) });
  }

  /* ---- 以下都要登录 ---- */
  const user = currentUser(req);
  if (!user) return json(res, 401, { ok: false, error: '请先登录' });
  if (ADMIN_ONLY[p] && user.role !== 'admin') return json(res, 403, { ok: false, error: '只有主管能做这个操作' });
  const me = () => json(res, 200, { ok: true, user: publicUser(user) });

  if (p === '/api/logout' && method === 'POST') { clearSession(res); return json(res, 200, { ok: true }); }
  if (p === '/api/me' && method === 'GET') return me();

  if (p === '/api/meta' && method === 'GET') {
    const d = data();
    const stale = !d.meta.ts || Date.now() - d.meta.ts > AUTO_SYNC_AFTER;
    if (stale && !job.running && sync.status(DATA).configured) runSync(true);
    return json(res, 200, { ok: true, user: publicUser(user), meta: d.meta, sync: job, settings: d.settings,
      erp: user.role === 'admin' ? sync.maskCfg(DATA) : null });
  }

  if (p === '/api/sync' && method === 'POST') {
    if (!sync.status(DATA).configured) return json(res, 200, { ok: false, error: 'ERP 账号还没配置' });
    runSync(false);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/erp' && method === 'POST') {
    const b = await bodyOf(req);
    const c = sync.writeCfg(DATA, { url: b.url, user: b.user, pass: b.pass || null });
    return json(res, 200, { ok: true, erp: { url: c.url, user: c.user, configured: !!(c.user && c.pass), pass: '******' } });
  }

  if (p === '/api/overview' && method === 'GET') {
    const S = rules(); const now = Date.now(); const today = todayNum();
    const all = data().rows;
    const rows = scoped(user, all);
    const live = rows.filter(active);
    const st = {};
    live.forEach(r => { st[r.status] = (st[r.status] || 0) + 1; });
    const followedToday = r => !!(r.follow && r.follow.last && dayNum(r.follow.last) === today);
    const by = {};
    live.forEach(r => {
      const k = r.saleMan || '（未分配）';
      by[k] = by[k] || { saleMan: k, total: 0, key: 0, overdue: 0, due: 0, sleep: 0, pending: 0, followedToday: 0, money12: 0 };
      const g = by[k];
      g.total++; g.money12 += r.money12;
      if (r.key) g.key++; if (r.status === 'overdue') g.overdue++; if (r.status === 'due') g.due++; if (r.status === 'sleep') g.sleep++;
      if (VIEWS.daily(r) && !cooled(r, S, now)) g.pending++;
      if (followedToday(r)) g.followedToday++;
    });
    const sales = Object.values(by).sort((a, b) => a.saleMan === '（未分配）' ? 1 : b.saleMan === '（未分配）' ? -1 : b.pending - a.pending);
    return json(res, 200, { ok: true, status: st, sales,
      kpi: {
        total: live.length, bought: live.filter(r => r.n > 0).length, repeat: live.filter(r => r.n >= 2).length,
        key: live.filter(r => r.key).length, overdue: st.overdue || 0, due: st.due || 0, sleep: st.sleep || 0,
        pending: live.filter(r => VIEWS.daily(r) && !cooled(r, S, now)).length,
        followedToday: live.filter(followedToday).length,
        money12: Math.round(live.reduce((s, r) => s + r.money12, 0)),
        excluded: all.length - live.length
      } });
  }

  if (p === '/api/list' && method === 'GET') {
    const rows = pickRows(q, user, rules(), Date.now());
    const sort = q.get('sort') || 'score';
    const by = { score: (a, b) => b.score - a.score, money: (a, b) => b.money12 - a.money12,
      since: (a, b) => b.since - a.since, cycle: (a, b) => (a.overdueDays || 0) - (b.overdueDays || 0) };
    rows.sort(by[sort] || by.score);
    const size = Math.min(parseInt(q.get('size'), 10) || 100, 500);
    const page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
    const slim = r => ({ id: r.id, name: r.name, saleMan: r.saleMan, linkman: r.linkman, mobile: r.mobile,
      status: r.status, key: r.key, since: r.since, cycle: r.cycle, overdueDays: r.overdueDays, n: r.n, n12: r.n12,
      money: r.money, money12: r.money12, lastTime: r.lastTime, lastProduct: r.lastProduct, lastQty: r.lastQty,
      topProds: r.topProds, note: r.note || '', excl: !!r.excl, gaps: r.gaps, follow: slimFollow(r.follow) });
    return json(res, 200, { ok: true, total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size).map(slim) });
  }

  const mc = p.match(/^\/api\/customer\/(\d+)$/);
  if (mc && method === 'GET') {
    const r = data().rows.find(x => x.id === Number(mc[1]));
    if (!r) return json(res, 404, { ok: false, error: '没有这个客户' });
    if (!owns(user, r)) return json(res, 403, { ok: false, error: '这不是你名下的客户' });
    const orders = (data().ordersBy.get(r.id) || []).slice().reverse().map(o => ({
      code: o.code, time: o.createTime, product: o.product, qty: o.qty, money: o.money,
      status: o.orderStatus, voidFlag: o.voidFlag
    }));
    return json(res, 200, { ok: true, customer: r, orders });
  }

  /* 写操作：从请求里找客户，并确认是本人名下的；有问题时已经把回应发出去了，返回 null */
  const findOwn = async () => {
    const b = (await bodyOf(req)) || {};
    const r = data().rows.find(x => x.id === Number(b.id));
    if (!r) { json(res, 404, { ok: false, error: '没有这个客户' }); return null; }
    if (!owns(user, r)) { json(res, 403, { ok: false, error: '这不是你名下的客户' }); return null; }
    return { b, r };
  };

  if (p === '/api/notes' && method === 'POST') {
    const c = await findOwn(); if (!c) return;
    const b = c.b;
    if (b.excl === undefined && b.note === undefined) return json(res, 400, { ok: false, error: '没有要改的内容' });
    const notes = readJson(F.notes, {});
    const cur = notes[c.r.id] || {};
    if (b.excl !== undefined) cur.excl = !!b.excl;
    if (b.note !== undefined) cur.note = String(b.note || '').slice(0, 300);
    if (!cur.excl && !cur.note) delete notes[c.r.id]; else notes[c.r.id] = cur;
    writeJson(F.notes, notes);
    invalidate();
    return json(res, 200, { ok: true, notes: notes[c.r.id] || {} });
  }

  /* 跟进：记一笔结果，客户进入冷却期；备注同步成客户的最新备注 */
  if (p === '/api/follow' && method === 'POST') {
    const c = await findOwn(); if (!c) return;
    const b = c.b;
    if (!FOLLOW_RESULTS[b.result]) return json(res, 400, { ok: false, error: '请选一个跟进结果' });
    const note = String(b.note || '').trim().slice(0, 300);
    const entry = { ts: Date.now(), by: user.name, result: b.result, note };
    const follows = readJson(F.follows, {});
    const f = follows[c.r.id] || { count: 0, history: [] };
    f.count++; f.last = entry.ts; f.by = entry.by; f.result = entry.result; f.note = note;
    f.history = [entry].concat(f.history).slice(0, 30);
    follows[c.r.id] = f;
    writeJson(F.follows, follows);
    if (note) {
      const notes = readJson(F.notes, {});
      notes[c.r.id] = Object.assign({}, notes[c.r.id] || {}, { note });
      writeJson(F.notes, notes);
    }
    invalidate();
    return json(res, 200, { ok: true, follow: slimFollow(f) });
  }

  /* 跟进记录：最近几天所有人（或自己）的跟进流水 */
  if (p === '/api/follows' && method === 'GET') {
    /* days 取 7 / 30 / 90；或者用 from=时间戳 指定从哪天开始（本月、自定义区间用） */
    const from = Number(q.get('from'));
    const since = from > 0 && from <= Date.now() ? from : Date.now() - ([7, 30, 90].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30) * DAY;
    const sale = user.role === 'sale' ? user.saleMan : (q.get('sale') || '').trim();
    const out = [];
    for (const r of data().rows) {
      if (!r.follow || (sale && r.saleMan !== sale) || !owns(user, r)) continue;
      for (const h of r.follow.history) {
        if (h.ts >= since) out.push({ ts: h.ts, id: r.id, name: r.name, saleMan: r.saleMan, by: h.by, result: h.result, note: h.note || '' });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return json(res, 200, { ok: true, since, total: out.length, rows: out.slice(0, 2000), results: FOLLOW_RESULTS });
  }

  /* ---- 人员管理（主管） ---- */
  if (p === '/api/users' && method === 'GET') return json(res, 200, { ok: true, users: users().map(publicUser) });
  if (p === '/api/users' && method === 'POST') {
    const b = (await bodyOf(req)) || {};
    const all = users();
    if (b.del) {
      if (b.id === user.id) return json(res, 400, { ok: false, error: '不能删除自己正在用的账号' });
      const next = all.filter(u => u.id !== b.id);
      if (next.length === all.length) return json(res, 404, { ok: false, error: '没有这个账号' });
      if (!next.some(u => u.role === 'admin')) return json(res, 400, { ok: false, error: '至少要留一个主管账号' });
      writeJson(F.users, next);
      return json(res, 200, { ok: true, users: next.map(publicUser) });
    }
    if (b.id) {                                         // 改密码 / 改对应业务员
      const i = all.findIndex(u => u.id === b.id);
      if (i < 0) return json(res, 404, { ok: false, error: '没有这个账号' });
      if (b.pass !== undefined) {
        if (String(b.pass).length < 6) return json(res, 400, { ok: false, error: '密码至少 6 位' });
        all[i].salt = crypto.randomBytes(12).toString('hex'); all[i].hash = hashPw(b.pass, all[i].salt);
      }
      if (b.saleMan !== undefined && all[i].role === 'sale') {
        if (!String(b.saleMan).trim()) return json(res, 400, { ok: false, error: '业务员账号要对应一个 ERP 里的业务员名字' });
        all[i].saleMan = String(b.saleMan).trim();
      }
      writeJson(F.users, all);
      return json(res, 200, { ok: true, users: all.map(publicUser) });
    }
    const err = checkNewUser(b) || (all.some(u => u.name === String(b.name).trim()) ? '已经有同名账号了' : '');
    if (err) return json(res, 400, { ok: false, error: err });
    all.push(newUser(b.name, b.pass, b.role, b.saleMan));
    writeJson(F.users, all);
    return json(res, 200, { ok: true, users: all.map(publicUser) });
  }

  if (p === '/api/settings' && method === 'POST') {
    const b = (await bodyOf(req)) || {};
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

/* 新建账号前的检查；返回错误文字，没问题返回 '' */
function checkNewUser(b) {
  if (!b || typeof b !== 'object') return '内容不对';
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 20) return '姓名要 2~20 个字';
  if (String(b.pass || '').length < 6) return '密码至少 6 位';
  if (!['admin', 'sale'].includes(b.role)) return '角色要选主管或业务员';
  if (b.role === 'sale' && !String(b.saleMan || '').trim()) return '业务员账号要对应一个 ERP 里的业务员名字';
  return '';
}
function newUser(name, pass, role, saleMan) {
  const salt = crypto.randomBytes(12).toString('hex');
  return { id: crypto.randomBytes(5).toString('hex'), name: String(name).trim(), role, saleMan: role === 'sale' ? String(saleMan).trim() : '',
    salt, hash: hashPw(pass, salt), lastLogin: 0, ts: Date.now() };
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
