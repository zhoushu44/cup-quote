/* ============================================================
 * 纸杯报价系统 · 服务端（不依赖任何第三方包）
 *   1) 提供网页（index.html + assets/）
 *   2) 提供已保存报价单的存取接口（/api/*），数据落在 DATA 目录：
 *        DATA/q/<id>.json   每张报价单一个文件（含版面图）
 *   用环境变量 PORT / DATA 配置，默认 3000 / /data
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const erp = require('./erp');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA = process.env.DATA || '/data';
const ROOT = process.env.ROOT || path.join(__dirname, '..', 'public');
const QDIR = path.join(DATA, 'q');
const MAX_BODY = 20 * 1024 * 1024;      // 版面图压缩后约 0.2~1MB，留足余量
const LIST_MAX = 30;

fs.mkdirSync(QDIR, { recursive: true });

/* ---------- 存储 ---------- */
const index = [];                       // 内存里的摘要列表（倒序：新的在前）

function indexAdd(rec) {
  const i = index.findIndex(function (r) { return r.id === rec.id; });
  const row = {
    id: rec.id, no: rec.no, ts: rec.ts, cust: rec.cust, contact: rec.contact,
    mode: rec.mode, spec: rec.spec, qty: rec.qty, total: rec.total
  };
  if (i >= 0) index[i] = row; else index.push(row);
  index.sort(function (a, b) { return b.ts - a.ts; });
  return row;
}

function rebuildIndex() {
  index.length = 0;
  let n = 0;
  for (const f of fs.readdirSync(QDIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(QDIR, f), 'utf8'));
      if (rec && rec.id) { indexAdd(rec); n++; }
    } catch (e) { console.error('读不了的记录文件：' + f, e.message); }
  }
  return n;
}

function recPath(id) {
  if (!/^[a-z0-9]{6,40}$/i.test(id)) return null;
  return path.join(QDIR, id + '.json');
}

/* 先写临时文件再改名：写到一半断电也不会留下坏文件 */
function writeJson(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* 单号：PC + 日期 + 三位流水。已有的最大流水 + 1，没有就从 100 开始 */
function nextSeq(date) {
  const pre = 'PC' + date + '-';
  let max = 99;
  for (const r of index) {
    if (r.no && r.no.indexOf(pre) === 0) {
      const n = parseInt(r.no.slice(pre.length), 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/* 搜索：单号（去掉横线等符号后包含即可）或 客户名称 / 联系人（包含即可） */
function search(q) {
  const k = norm(q);
  if (!k) return index.slice(0, 8);                       // 没输入 → 最近保存的 8 张
  const out = [];
  for (const r of index) {
    if (norm(r.no).indexOf(k) >= 0 || norm(r.cust).indexOf(k) >= 0 || norm(r.contact).indexOf(k) >= 0) out.push(r);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

/* ---------- 工具 ---------- */
function send(res, code, body, head) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, head || {});
  res.writeHead(code, h);
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj)); }

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (file.indexOf(ROOT) !== 0 || p.indexOf('/.') >= 0) { send(res, 403, '禁止访问'); return; }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { send(res, 404, '找不到页面'); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const versioned = /[?&]v=[^&]+/.test(url.search);        // 地址带版本号 → 内容不会变
    const etag = 'W/"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }

    const head = {
      'Content-Type': type, 'ETag': etag,
      'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate'
        : versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    if (req.method === 'HEAD') { res.writeHead(200, Object.assign(head, { 'Content-Length': st.size })); res.end(); return; }
    fs.readFile(file, function (e2, buf) {
      if (e2) { send(res, 500, '读取失败'); return; }
      const gz = /\.(html|js|css|json|svg|txt)$/.test(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (gz) {
        head['Content-Encoding'] = 'gzip';
        head['Vary'] = 'Accept-Encoding';
        zlib.gzip(buf, function (e3, z) { if (e3) { send(res, 500, '压缩失败'); return; } res.writeHead(200, head); res.end(z); });
      } else {
        head['Content-Length'] = buf.length;
        res.writeHead(200, head);
        res.end(buf);
      }
    });
  });
}

/* ---------- 接口 ---------- */
async function serveApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/(search|quote|seq|erp)(?:\/([a-z0-9]+))?$/i);
  const route = m && m[1].toLowerCase();
  const arg = m && m[2];
  const jsonHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

  if (route === 'search' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: search(url.searchParams.get('q') || '') });
  }

  if (route === 'seq' && req.method === 'GET') {
    const d = /^\d{8}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : ymd();
    return json(res, 200, { ok: true, next: nextSeq(d) });
  }

  /* 以下都是写操作或读单张：只接受本站页面发来的请求（别的网站不能借着用户的浏览器来读/删） */
  const origin = req.headers.origin;
  if (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) {
    return json(res, 403, { ok: false, error: '不接受其他网站的请求' });
  }

  if (route === 'quote' && req.method === 'GET' && arg) {
    const f = recPath(arg);
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, error: '这张报价单不存在（可能已被删除）' });
    return fs.readFile(f, 'utf8', function (e, t) {
      if (e) return json(res, 500, { ok: false, error: '读取失败' });
      try { json(res, 200, { ok: true, record: JSON.parse(t) }); } catch (e2) { json(res, 500, { ok: false, error: '记录文件损坏' }); }
    });
  }

  if (route === 'quote' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: '内容不是有效的数据' }); }

    /* 只记 ERP 生产单号：{id, erp:{code,id,ts}} */
    if (body && body.id && body.erp && !body.data) {
      const f = recPath(String(body.id));
      if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, error: '这张报价单不存在' });
      try {
        const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
        rec.data = rec.data || {};
        rec.data.erp = {
          code: String(body.erp.code || '').slice(0, 40),
          id: Number(body.erp.id) || 0,
          ts: Number(body.erp.ts) || Date.now()
        };
        writeJson(f, rec);
        return json(res, 200, { ok: true, erp: rec.data.erp });
      } catch (e) { return json(res, 500, { ok: false, error: '保存失败' }); }
    }

    const d = body && body.data;
    const inputs = d && d.inputs;
    if (!inputs || typeof inputs !== 'object') return json(res, 400, { ok: false, error: '缺少报价内容' });

    const date = ymd();
    let no = String(body.no || '').trim();
    const taken = function (n) { return index.some(function (r) { return r.no === n; }); };
    const okNo = /^PC\d{8}-\d{3,6}$/.test(no);
    /* 没给单号、单号格式不对、或已被占用 → 重新分配一个 */
    if (!okNo || taken(no)) no = 'PC' + date + '-' + nextSeq(date);
    while (taken(no)) no = 'PC' + date + '-' + nextSeq(date);

    const ts = Date.now();
    const id = ts.toString(36) + crypto.randomBytes(3).toString('hex');
    const q = inputs.quote || {};
    const rec = {
      id: id, no: no, ts: ts,
      cust: String(q.customer || '').slice(0, 80),
      contact: String(q.contact || '').slice(0, 40),
      mode: inputs.mode === 'tea' ? 'tea' : 'cup',
      spec: String(body.spec || '').slice(0, 60),
      qty: Number(inputs.qty) || 0,
      total: Number(body.total) || 0,
      data: { inputs: inputs, cost: (d.cost && typeof d.cost === 'object') ? d.cost : {} }
    };
    writeJson(path.join(QDIR, id + '.json'), rec);
    indexAdd(rec);
    return json(res, 200, { ok: true, id: id, no: no, ts: ts });
  }

  if (route === 'quote' && req.method === 'DELETE' && arg) {
    const f = recPath(arg);
    if (!f || !fs.existsSync(f)) return json(res, 404, { ok: false, error: '这张报价单不存在（可能已被删除）' });
    fs.unlinkSync(f);
    const i = index.findIndex(function (r) { return r.id === arg; });
    if (i >= 0) index.splice(i, 1);
    return json(res, 200, { ok: true });
  }

  /* ---------- ERP（印刷生产系统）对接 ---------- */
  if (route === 'erp' && req.method === 'GET' && !arg) {
    const w = url.searchParams.get('w');
    if (w === 'config') return json(res, 200, { ok: true, config: erp.maskCfg(DATA) });
    if (w === 'customers') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 200, { ok: true, list: [] });
      try { return json(res, 200, { ok: true, list: await erp.findCustomers(DATA, q, 10) }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (w === 'pk') {
      try { return json(res, 200, { ok: true, list: await erp.packages(DATA, Number(arg) || Number(url.searchParams.get('pid')) || 0) }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    /* 该产品可选纸种（ERP 纸种库） */
    if (w === 'papers') {
      try { return json(res, 200, { ok: true, list: await erp.productPapers(DATA, Number(arg) || Number(url.searchParams.get('pid')) || 0) }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (w === 'meta') {
      try { return json(res, 200, { ok: true, products: await erp.products(DATA), config: erp.maskCfg(DATA) }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message, config: erp.maskCfg(DATA) }); }
    }
    return json(res, 404, { ok: false, error: '没有这个接口' });
  }

  if (route === 'erp' && req.method === 'POST' && !arg) {
    let body3;
    try { body3 = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: '内容不是有效的数据' }); }
    /* 保存账号配置 */
    if (body3 && body3.config) {
      const c = erp.writeCfg(DATA, { url: body3.config.url, user: body3.config.user, pass: body3.config.pass || null });
      return json(res, 200, { ok: true, config: { url: c.url, user: c.user, configured: !!(c.user && c.pass) } });
    }
    /* 下单：body = { customer:{name,contact,mobile}|customId, order:{…ERP 字段…}, design:{name,b64,w,h}? } */
    if (body3 && body3.order) {
      try {
        const custIn = body3.customer || {};
        const custId = Number(body3.customId) || Number(custIn.customId) || 0;
        const cust = custId ? { id: custId, name: custIn.name || order.customer } :
          await erp.ensureCustomer(DATA, custIn);
        const order = body3.order;
        if (!order.productId) throw new Error('没有选产品');
        if (!order.orderQty) throw new Error('没有数量');
        if (!order.productMoney) throw new Error('没有金额');
        /* 正式下单（operate=1 是暂存，车间列表里看不到） */
        order.operate = 2;
        /* 工艺行：ERP 里别人下的单都带工序清单（印刷/模切/清废/上架/成型…），
           这行是 UI 前端拼的、不发就为空，这里按产品模板补齐 */
        if (!order.processList || !order.processList.length) {
          const tpl = await erp.processTemplate(DATA, order.productId);
          const skip = { '正印': 1, '反印': 1, '印刷要求': 1 };
          const rows = [];
          const push = function (r) {
            if (!r || rows.some(function (x) { return x.processId === r.processId; })) return;
            rows.push({ processName: r.processName, processId: r.processId, processValue: '',
              totalNum: order.orderQty, processType: 2, busiType: 0, processInfo: r.processName,
              stockFlag: 0, outFlag: 0, outNum: 0, lineNum: 50 });
          };
          tpl.forEach(function (r) { if (r.defaultFlag === 1 && !skip[r.processName]) push(r); });
          /* 工艺名已在 data.js 里与 ERP 工序名统一；这里只处理 ERP 没有的变体：
             烫银→ERP烫金工序、镭射膜→光膜；丝网/数码印刷是印刷方式，只进版面说明 */
          const craftMap = { '烫银': '烫金', '镭射膜': '光膜' };
          (body3.crafts || []).forEach(function (c) {
            const cn = craftMap[String(c || '').trim()] || String(c || '').trim();
            if (!cn) return;
            const free = tpl.filter(function (r) { return !skip[r.processName] && !rows.some(function (x) { return x.processId === r.processId; }); });
            /* 优先：工艺名打头（压纹（液压）→压纹），其次任意包含 */
            const hit = free.filter(function (r) { return cn === r.processName || cn.indexOf(r.processName) === 0; })[0] ||
              free.filter(function (r) { return r.processName.indexOf(cn) >= 0 || cn.indexOf(r.processName) >= 0; })[0];
            push(hit);
          });
          order.processList = rows;
        }
        /* 纸种：确认框里选了就直接用；没选就按报价的克重（+纸名关键词）在 ERP 产品纸种库里匹配 */
        if (body3.paper && body3.paper.suttleId) {
          order.paperSuttle = body3.paper.name || '';
          order.suttleId = body3.paper.suttleId;
          order.paper = body3.paper.paperName || String(body3.paper.name || '').replace(/\d+g$/, '');
        }
        if (!order.suttleId) {
          const ps = (await erp.productPapers(DATA, order.productId)).filter(function (p) { return p && p.name && p.suttleId; });
          const gsm = Number(body3.paperGsm) || 0;
          const kw = String(body3.paperKw || '');
          const has = (n, s) => String(n || '').indexOf(s) >= 0;
          const pick =
            ps.filter(function (p) { return kw && has(p.name, kw) && has(p.name, gsm + 'g'); })[0] ||
            ps.filter(function (p) { return kw && has(p.name, kw) && has(p.paper, kw); })[0] ||
            ps.filter(function (p) { return has(p.name, gsm + 'g'); })[0] ||
            ps.filter(function (p) { return p.def === 1; })[0] || ps[0];
          if (pick) { order.paperSuttle = pick.name; order.suttleId = pick.suttleId; order.paper = pick.paper || String(pick.name).replace(/\d+g$/, ''); }
        }
        /* 装箱名 + 默认物流/模房 */
        if (order.planVoList && order.planVoList.length) {
          const pk = await erp.packages(DATA, order.productId);
          order.planVoList.forEach(function (p) {
            if (!p.packageName) {
              const hit = pk.filter(function (x) { return x.goodId === p.packageId; })[0];
              if (hit) p.packageName = hit.name;
            }
          });
        }
        if (!order.logistics) order.logistics = body3.logistics || '创新物流';
        if (!order.mouldFactory) order.mouldFactory = '车间';
        /* 版面图：先传到 ERP 的设计稿库，再把地址挂到订单上 */
        if (body3.design && body3.design.b64) {
          const up = await erp.uploadDesign(DATA, body3.design.name || 'layout.jpg', body3.design.b64);
          order.filePath = up.url;
          order.thumb = up.url;
          order.fileName = up.fileName;
          if (Number(body3.design.w) > 0) order.width = Number(body3.design.w);
          if (Number(body3.design.h) > 0) order.height = Number(body3.design.h);
        }
        order.customId = cust.id;
        order.customer = cust.name;
        const made = await erp.createOrder(DATA, order);
        return json(res, 200, { ok: true, code: made.code, id: made.id, customer: cust.name, customId: cust.id });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    return json(res, 400, { ok: false, error: '缺少下单内容' });
  }

  json(res, 404, { ok: false, error: '没有这个接口' });
}

function ymd() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);          // 按北京时间出日期
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

/* ---------- 入口 ---------- */
const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
  if (url.pathname.indexOf('/api/') === 0) {
    serveApi(req, res, url).catch(function (e) {
      if (e.message !== 'too large') console.error(e);
      if (!res.headersSent) json(res, e.message === 'too large' ? 413 : 500, { ok: false, error: e.message === 'too large' ? '内容太大' : '服务器出错了' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, '不支持的方法'); return; }
  serveStatic(req, res, url);
});

const n = rebuildIndex();
server.listen(PORT, '0.0.0.0', function () {
  console.log('纸杯报价系统已启动：端口 ' + PORT + '，数据目录 ' + DATA + '，已有报价单 ' + n + ' 张');
});
