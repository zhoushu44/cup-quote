/* 客户营销 · 前端逻辑（原生 JS，无依赖） */
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = n => { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万' : String(Math.round(n)); };
const md = s => String(s || '').slice(5, 10);

/* 和 analyze.js 的 DEFAULTS 一致：没保存过规则时用它回填表单 */
const DEFAULTS = { keyMoney12m: 50000, keyOrders12m: 10, keyCountMinMoney: 20000, dueRatio: 0.8, sleepRatio: 3, sleepMinDays: 90,
  lostDays: 365, minGap: 7, maxGap: 365, followReplyDays: 7, followLaterDays: 30, voidFlags: [1] };
const NUM_KEYS = ['keyMoney12m', 'keyOrders12m', 'keyCountMinMoney', 'sleepRatio', 'sleepMinDays', 'lostDays', 'minGap', 'maxGap',
  'followReplyDays', 'followLaterDays'];
const ORDER_ST = { 0: '初始化', 15: '设计分配', 20: '定稿', 25: '审核', 30: '组版', 40: '外发', 50: '印刷', 53: '上光', 54: '液压', 60: '覆膜',
  70: 'UV', 90: '烫金', 100: '压纹', 150: '模切', 200: '清废', 250: '上架', 600: '成型', 800: '入库', 900: '发货', 1000: '完成' };
const STATUS = {
  overdue: { txt: '已逾期', cls: 'overdue' }, due: { txt: '快到期', cls: 'due' }, sleep: { txt: '沉睡', cls: 'sleep' },
  once: { txt: '只下过一单', cls: 'once' }, normal: { txt: '正常', cls: 'normal' }, lost: { txt: '流失', cls: 'lost' },
  none: { txt: '没下过单', cls: 'none' }
};
/* 跟进结果的四种；days 指向规则里对应的天数 */
const RESULT = {
  reply: { name: '有意向，等回复', short: '等回复', days: 'followReplyDays' },
  later: { name: '最近不需要', short: '不需要', days: 'followLaterDays' },
  ordered: { name: '已经下单', short: '已下单', days: 'followLaterDays' },
  lost: { name: '联系不上 / 不做了', short: '联系不上', days: 'followLaterDays' }
};
const HINTS = {
  daily: '今天要跟的：已过了复购周期的、快到的，以及重点客户里沉睡的。按优先级排，重点客户在前。点一行选跟进结果，客户就会从名单里消失一段时间。',
  sleep: '沉睡客户：超过往常周期好几倍没下单的。人很多，建议从上往下联系，或按业务员分下去慢慢唤醒。',
  all: '全部客户（含流失和没下过单的）。点任意一行看详情、写备注、排除不该做营销的客户。'
};
const LIST_PAGES = ['daily', 'sleep', 'all'];

async function api(method, url, body) {
  const r = await fetch(url, method === 'POST'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }
    : { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/me') { me = null; showLogin('登录已过期，请重新登录'); }
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400);
}
const fmtTs = ts => ts ? new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(5, 16) : '—';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(5, 10).replace('-', '.');

let me = null;                             // 当前登录的人 {id,name,role,saleMan}
let needSetup = false;
let settings = {};
let overview = null;                       // 最近一次概览（业务员列表、重点客户数）
let page = 'overview';
const state = {};                          // 每个名单页的分页
LIST_PAGES.forEach(v => { state[v] = { page: 1, size: 100, total: 0, seq: 0 }; });

const isAdmin = () => !!me && me.role === 'admin';
const effSettings = () => Object.assign({}, DEFAULTS, settings);
const isVoid = f => effSettings().voidFlags.includes(Number(f));

/* 状态的完整说法，表格和复制文本共用 */
function statusText(r) {
  if (r.status === 'overdue') return '已逾期 ' + r.overdueDays + ' 天';
  if (r.status === 'due') return (-r.overdueDays) + ' 天后到期';
  if (r.status === 'sleep') return '沉睡 ' + r.since + ' 天';
  return STATUS[r.status].txt;
}
function cycleText(r) {
  if (!r.cycle) return '';
  if (r.status === 'sleep') return '往常约 ' + r.cycle + ' 天/单';
  return (r.status === 'overdue' || r.status === 'due' ? '往常约 ' : '约 ') + r.cycle + ' 天/单';
}

/* ---------------- 登录 ---------------- */
function showLogin(tip) {
  $('#login').style.display = 'flex';
  $('#barRight').style.display = 'none';
  $('#loginTip').textContent = tip || '请登录';
  $('#loginBtn').textContent = needSetup ? '创建主管账号' : '登录';
  $('#loginErr').textContent = '';
  $('#loginPass').value = '';
  setTimeout(() => $('#loginName').focus(), 50);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#loginErr'); err.textContent = '';
  const r = await api('POST', needSetup ? '/api/setup' : '/api/login', { name: $('#loginName').value.trim(), pass: $('#loginPass').value });
  if (!r.ok) { err.textContent = r.error || '没成功，再试一次'; $('#loginPass').select(); return; }
  needSetup = false;                       // 主管账号建好后，以后都是正常登录
  enter(r.user);
});
$('#btnLogout').addEventListener('click', async () => { await api('POST', '/api/logout'); me = null; showLogin('已退出'); });

/* 登录成功：按角色调整界面，然后加载首页 */
function enter(user) {
  me = user;
  $('#login').style.display = 'none';
  $('#barRight').style.display = 'flex';
  $('#meInfo').textContent = me.name + (isAdmin() ? ' · 主管' : ' · 业务员（只看自己名下）');
  /* 业务员：没有设置页、不能同步 ERP、不能换业务员 */
  $('#tabs [data-page=settings]').style.display = isAdmin() ? '' : 'none';
  $('#btnSync').style.display = isAdmin() ? '' : 'none';
  $$('.filters [data-f=sale], #logSale, #scSale').forEach(s => {
    s.value = isAdmin() ? '' : me.saleMan; s.disabled = !isAdmin(); s.style.display = isAdmin() ? '' : 'none';
  });
  $$('.only-mine').forEach(x => x.remove());
  if (!isAdmin()) $$('.filters[data-view]').forEach(f => f.insertAdjacentHTML('afterbegin', '<span class="dim only-mine">我的客户</span>'));
  LIST_PAGES.forEach(v => { state[v].page = 1; });
  pollSync().then(() => loadOverview()).then(keyPreview);
  go('overview');
}

/* ---------------- 页面切换 ---------------- */
function go(name) {
  if (!me) return;
  if (name === 'settings' && !isAdmin()) name = 'overview';
  page = name;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + name));
  if (name === 'overview') loadOverview();
  else if (LIST_PAGES.includes(name)) loadList(name, 1);
  else if (name === 'log') loadLog();
  else if (name === 'screen') loadScreen();
  else if (name === 'settings') loadSettings();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.style.display === 'none') return;
  go(b.dataset.page);
});

/* ---------------- 概览 ---------------- */
async function loadOverview() {
  const r = await api('GET', '/api/overview');
  if (!r.ok) return;
  overview = r;
  const k = r.kpi;
  $('#kpis').innerHTML = [
    [isAdmin() ? '客户总数' : '我的客户', k.total, ''], ['重点客户', k.key, 'acc'], ['待跟进', k.pending, 'red'], ['今日已跟进', k.followedToday, 'green'],
    ['其中已逾期', k.overdue, ''], ['其中快到期', k.due, 'amber'], ['沉睡待唤醒', k.sleep, ''], ['近12个月金额', yuan(k.money12), 'green']
  ].map(x => '<div class="kpi ' + x[2] + '"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>').join('');
  /* 业务员只有自己一行，没必要看这张表 */
  $('#page-overview .card').style.display = isAdmin() ? '' : 'none';
  if (isAdmin()) {
    const cell = (n, color) => '<td class="num" style="' + (n && color ? 'color:var(' + color + ');font-weight:600' : '') + '">' + (n || '') + '</td>';
    $('#tblSales thead').innerHTML = '<tr><th>业务员</th><th class="num">客户</th><th class="num">重点</th><th class="num">待跟进</th><th class="num">今日已跟进</th>' +
      '<th class="num">已逾期</th><th class="num">快到期</th><th class="num">沉睡</th><th class="num">近12个月金额</th></tr>';
    $('#tblSales tbody').innerHTML = r.sales.map(s =>
      '<tr data-sale="' + esc(s.saleMan) + '"><td>' + esc(s.saleMan) + '</td><td class="num">' + s.total + '</td>' + cell(s.key) +
      cell(s.pending, '--red') + cell(s.followedToday, '--green') + cell(s.overdue) + cell(s.due, '--amber') + cell(s.sleep) +
      '<td class="num">' + yuan(s.money12) + '</td></tr>').join('');
  }
  const badge = $('#badgeDaily');
  badge.textContent = k.pending; badge.style.display = 'inline';
  fillSalesSelects();
}

$('#tblSales').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-sale]');
  if (!tr) return;
  $('.filters[data-view=daily] [data-f=sale]').value = tr.dataset.sale === '（未分配）' ? '' : tr.dataset.sale;
  go('daily');
});

function fillSalesSelects() {
  if (!overview || !isAdmin()) return;
  const opts = overview.sales.filter(s => s.saleMan !== '（未分配）').map(s => '<option value="' + esc(s.saleMan) + '">' + esc(s.saleMan) + '（' + s.total + '）</option>').join('');
  const fill = (sel, first) => { const cur = sel.value; sel.innerHTML = first + opts; sel.value = cur; };
  $$('.filters [data-f=sale]').forEach(sel => fill(sel, '<option value="">全部业务员</option>'));
  fill($('#logSale'), '<option value="">全部业务员名下</option>');
  fill($('#scSale'), '<option value="">全部业务员名下</option>');
  fill($('#uSale'), '<option value="">选 ERP 里的业务员</option>');
}

/* ---------------- 名单（今日跟进 / 沉睡唤醒 / 全部客户 共用） ---------------- */
LIST_PAGES.forEach(v => {
  const f = $('.filters[data-view=' + v + ']');
  f.querySelector('[data-f=status]').innerHTML = '<option value="">全部状态</option>' + (v === 'daily' ? ['overdue', 'due', 'sleep']
    : v === 'sleep' ? ['sleep'] : Object.keys(STATUS)).map(k => '<option value="' + k + '">' + STATUS[k].txt + '</option>').join('');
  $('#hint-' + v).textContent = HINTS[v];
  f.addEventListener('change', () => loadList(v, 1));
  f.addEventListener('input', e => { if (e.target.matches('[data-f=q]')) loadList(v, 1); });
  /* 翻页按钮在筛选条外面，所以点击监听挂在整个页面上 */
  $('#page-' + v).addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'prev') loadList(v, state[v].page - 1);
    else if (b.dataset.act === 'next') loadList(v, state[v].page + 1);
    else if (b.dataset.act === 'copy') copyList(v);
  });
  const tbl = $('#page-' + v).querySelector('[data-t=list]');
  tbl.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    /* 点在下拉上不算点开客户 */
    if (tr && !e.target.closest('.follow-pick')) openCustomer(tr.dataset.id);
  });
  /* 名单上的下拉：选结果 → 直接记一笔跟进（保留原来的备注）；选「写备注」→ 打开详情 */
  tbl.addEventListener('change', e => {
    const s = e.target.closest('.follow-pick');
    if (!s) return;
    const v = s.value;
    s.value = '';
    if (v === 'note') return openCustomer(s.dataset.id);
    if (RESULT[v]) doFollow(s.dataset.id, v, s.dataset.note || '');
  });
});

function query(v, pageNum, size) {
  const f = $('.filters[data-view=' + v + ']');
  const val = k => f.querySelector('[data-f=' + k + ']').value.trim();
  const qs = new URLSearchParams({ view: v, page: pageNum, size: size || state[v].size, sort: val('sort') || 'score' });
  ['sale', 'status', 'q'].forEach(k => { if (val(k)) qs.set(k, val(k)); });
  if (f.querySelector('[data-f=key]').checked) qs.set('key', '1');
  if (f.querySelector('[data-f=cool]').checked) qs.set('cool', '1');
  return qs.toString();
}

/* 名单里的「跟进 / 备注」一格：有跟进就显示谁、什么时候、什么结果；下面是一个下拉，选完直接记一笔 */
function followCell(x) {
  const f = x.follow, S = effSettings();
  const head = f && f.last ? '<div class="follow-line"><span class="tag foll">' + esc(RESULT[f.result] ? RESULT[f.result].short : f.result) + '</span> ' +
    '<b>' + esc(f.by) + '</b> ' + esc(fmtTs(f.last)) + (f.count > 1 ? ' · 第 ' + f.count + ' 次' : '') + '</div>' : '';
  const pick = '<select class="follow-pick" data-id="' + x.id + '" data-note="' + esc(x.note || '') + '" title="选一个结果，直接记为一次跟进">' +
    '<option value="">＋ 记录跟进…</option>' + Object.keys(RESULT).map(k =>
      '<option value="' + k + '">' + RESULT[k].name + '（' + S[RESULT[k].days] + ' 天后再提醒）</option>').join('') +
    '<option value="note">写备注 / 看详情…</option></select>';
  return head + pick + (x.note ? '<div class="dim">' + esc(x.note) + '</div>' : '');
}

async function loadList(v, pageNum) {
  const box = $('#page-' + v);
  pageNum = Math.max(1, pageNum || 1);
  /* 带上序号：连点几下时，慢回来的旧结果不覆盖新的 */
  const seq = (state[v].seq = (state[v].seq || 0) + 1);
  const r = await api('GET', '/api/list?' + query(v, pageNum));
  if (seq !== state[v].seq || !r.ok) return;
  state[v].page = pageNum; state[v].total = r.total;
  box.querySelector('[data-t=list] tbody').innerHTML = r.rows.length ? r.rows.map(x =>
    '<tr data-id="' + x.id + '"><td>' + (x.key ? '<span class="star" title="重点客户">★</span>' : '') + esc(x.name) + '</td>' +
    '<td>' + esc(x.saleMan || '—') + '</td>' +
    '<td><span class="tag ' + STATUS[x.status].cls + '">' + statusText(x) + '</span></td>' +
    '<td class="dim">' + cycleText(x) + '</td>' +
    '<td class="num">' + x.n12 + ' 单 · ' + yuan(x.money12) + '</td>' +
    '<td class="dim">' + (x.lastTime ? md(x.lastTime) + ' ' + esc(x.lastProduct) + ' ×' + x.lastQty : '—') + '</td>' +
    '<td class="dim">' + esc((x.topProds || []).join('、')) + '</td>' +
    '<td class="wrap" style="max-width:220px">' + followCell(x) + '</td></tr>').join('')
    : '<tr><td colspan="8" class="dim">没有符合条件的客户</td></tr>';
  const last = Math.max(1, Math.ceil(r.total / state[v].size));
  box.querySelector('[data-t=count]').textContent = '共 ' + r.total + ' 个';
  box.querySelector('[data-t=pg]').textContent = pageNum + ' / ' + last;
  box.querySelector('[data-act=prev]').disabled = pageNum <= 1;
  box.querySelector('[data-act=next]').disabled = pageNum >= last;
}

/* 复制名单：当前筛选条件下的客户（最多 500 个），按业务员分组生成一段文字，直接粘微信 */
async function copyList(v) {
  const btn = $('.filters[data-view=' + v + '] [data-act=copy]');
  btn.disabled = true;
  const r = await api('GET', '/api/list?' + query(v, 1, 500));
  btn.disabled = false;
  if (!r.ok) return;
  if (!r.rows.length) return toast('没有可复制的客户');
  const groups = {};
  r.rows.forEach(x => { const k = x.saleMan || '（未分配）'; (groups[k] = groups[k] || []).push(x); });
  const title = v === 'daily' ? '今日返单提醒' : v === 'sleep' ? '沉睡客户唤醒' : '客户名单';
  const order = overview ? overview.sales.map(s => s.saleMan) : Object.keys(groups);
  let out = '';
  order.concat(Object.keys(groups).filter(k => !order.includes(k))).forEach(name => {
    const g = groups[name];
    if (!g) return;
    out += (out ? '\n\n' : '') + '【' + title + ' ' + today() + '】' + name + '（' + g.length + ' 个）\n';
    g.forEach((x, i) => {
      const f = x.follow && x.follow.last ? '（上次跟进 ' + fmtTs(x.follow.last) + '：' + (RESULT[x.follow.result] ? RESULT[x.follow.result].short : x.follow.result) + '）' : '';
      out += (i + 1) + '. ' + (x.key ? '★' : '') + x.name + '｜' + statusText(x) + (x.cycle ? '（往常约' + x.cycle + '天一单）' : '') + f +
        '｜近12月 ' + x.n12 + '单 ' + yuan(x.money12) + '元｜常买：' + ((x.topProds || []).join('、') || '—') + '\n';
    });
  });
  if (r.total > r.rows.length) out += '\n（共 ' + r.total + ' 个，只列了前 ' + r.rows.length + ' 个；可按业务员筛选后分别复制）';
  try { await navigator.clipboard.writeText(out); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = out; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('已复制 ' + r.rows.length + ' 个客户，可以粘到微信了');
}

/* ---------------- 客户详情与跟进 ---------------- */
async function openCustomer(id) {
  const r = await api('GET', '/api/customer/' + id);
  if (!r.ok) return toast(r.error || '读取失败');
  const c = r.customer;
  const color = c.status === 'overdue' ? 'var(--red)' : c.status === 'due' ? 'var(--amber)' : 'var(--green)';
  const info = [c.level, c.linkman && ('联系人 ' + c.linkman), c.mobile, c.wx && ('微信 ' + c.wx), c.qq && ('QQ ' + c.qq),
    c.saleMan && ('业务员 ' + c.saleMan), c.area].filter(Boolean).join(' ｜ ');
  const stat = (b, s, style) => '<div><b' + (style ? ' style="' + style + '"' : '') + '>' + b + '</b><span>' + s + '</span></div>';
  const rows = r.orders.map(x => '<tr class="' + (isVoid(x.voidFlag) ? 'void-row' : '') + '"><td>' + esc(x.code) + '</td><td>' +
    esc(String(x.time || '').slice(0, 16)) + '</td><td>' + esc(x.product) + '</td><td class="num">' + x.qty + '</td>' +
    '<td class="num">' + yuan(x.money) + '</td><td class="dim">' + esc(ORDER_ST[x.status] || ('状态' + x.status)) + '</td></tr>').join('');
  const S = effSettings();
  const f = c.follow;
  const history = f && f.history.length ? '<div class="dim" style="margin-top:6px">跟进记录：<br>' +
    f.history.slice(0, 6).map(h => esc(fmtTs(h.ts) + '　' + h.by + ' · ' + (RESULT[h.result] ? RESULT[h.result].name : h.result) + (h.note ? '：' + h.note : ''))).join('<br>') + '</div>' : '';
  $('#drawer').innerHTML =
    '<button class="close" id="btnClose">×</button>' +
    '<h2>' + (c.key ? '<span class="star">★</span>' : '') + esc(c.name) + '</h2>' +
    '<div class="dim">' + esc(info) + '</div>' + (c.addr ? '<div class="dim">地址：' + esc(c.addr) + '</div>' : '') +
    '<div class="stats">' + stat(statusText(c), '当前状态', 'color:' + color) + stat(c.cycle ? c.cycle + ' 天' : '—', '复购周期（按 ' + c.gaps + ' 次间隔算）') +
      stat(c.n, '历史订单') + stat(yuan(c.money), '历史金额') + '</div>' +
    '<div class="dim" style="margin-top:6px">近 12 个月 ' + c.n12 + ' 单 · ' + yuan(c.money12) + ' 元｜常买：' + esc((c.topProds || []).join('、') || '—') +
    '｜距上次下单 ' + (c.since >= 0 ? c.since + ' 天' : '—') + '</div>' +
    (f && f.last ? '<div style="margin-top:6px">上次跟进：<span class="tag foll">' + esc(RESULT[f.result] ? RESULT[f.result].short : f.result) + '</span> ' +
      esc(f.by + ' ' + fmtTs(f.last)) + (f.count > 1 ? ' · 已跟 ' + f.count + ' 次' : '') + (f.note ? '｜' + esc(f.note) : '') + '</div>' : '') + history +
    '<div class="card"><h3>这次跟进 <span class="dim">先写情况，再点结果；点了之后这个客户会从名单里消失一段时间</span></h3>' +
      '<textarea id="cNote" placeholder="例：采购说这个月库存还够，12 月初再联系；对方换了采购，新的是王经理…">' + esc(c.note || '') + '</textarea>' +
      '<div class="follow-btns">' + Object.keys(RESULT).map(k =>
        '<button class="r-' + k + '" data-result="' + k + '">' + RESULT[k].name + '<small>' + S[RESULT[k].days] + ' 天后再提醒</small></button>').join('') + '</div>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line2)">' +
        '<label class="dim"><input type="checkbox" id="cExcl"' + (c.excl ? ' checked' : '') + '> 不做营销（同行 / 内部账号 / 已关门），从所有名单里隐藏</label>' +
        '<button class="btn sm" id="btnSaveNote" style="margin-left:auto">只保存备注</button></div></div>' +
    '<div class="card"><h3>历史订单 <span class="dim">划掉的是不算数的单（作废等）</span></h3>' +
      (rows ? '<table><thead><tr><th>单号</th><th>下单时间</th><th>产品</th><th class="num">数量</th><th class="num">金额</th><th>进度</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="dim">没有订单</div>') + '</div>';
  $('#drawer').classList.add('on'); $('#mask').classList.add('on');
  $('#btnClose').onclick = closeDrawer;
  $('#btnSaveNote').onclick = () => saveNote(c.id);
  $$('#drawer [data-result]').forEach(b => { b.onclick = () => doFollow(c.id, b.dataset.result, $('#cNote').value); });
}

/* 记一笔跟进。note：详情里填的情况，或名单下拉时客户原有的备注（保留不动） */
async function doFollow(id, result, note) {
  const r = await api('POST', '/api/follow', { id: Number(id), result, note: note || '' });
  if (!r.ok) return toast(r.error || '没保存上，再试一次');
  toast('已记录：' + RESULT[result].name + '，' + effSettings()[RESULT[result].days] + ' 天后再提醒');
  closeDrawer();
  refreshLists();
}
async function saveNote(id) {
  const r = await api('POST', '/api/notes', { id: Number(id), note: $('#cNote').value, excl: $('#cExcl').checked });
  if (!r.ok) return toast(r.error || '保存失败');
  toast('备注已保存'); closeDrawer();
  refreshLists();
}
function refreshLists() {
  if (LIST_PAGES.includes(page)) loadList(page, state[page].page);
  if (page === 'log') loadLog();
  loadOverview().then(keyPreview);
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#mask').classList.remove('on'); }
$('#mask').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* ---------------- 跟进记录 ---------------- */
$('#logDays').addEventListener('change', loadLog);
$('#logSale').addEventListener('change', loadLog);
$('#tblLog').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openCustomer(tr.dataset.id); });
let logSeq = 0;
async function loadLog() {
  const seq = ++logSeq;
  const sale = $('#logSale').value;
  const r = await api('GET', '/api/follows?days=' + $('#logDays').value + (sale ? '&sale=' + encodeURIComponent(sale) : ''));
  if (seq !== logSeq || !r.ok) return;
  $('#tblLog tbody').innerHTML = r.rows.length ? r.rows.map(h =>
    '<tr data-id="' + h.id + '"><td>' + esc(fmtTs(h.ts)) + '</td><td>' + esc(h.name) + '</td><td>' + esc(h.saleMan || '—') + '</td><td>' + esc(h.by) + '</td>' +
    '<td><span class="tag foll">' + esc(RESULT[h.result] ? RESULT[h.result].name : h.result) + '</span></td><td class="wrap dim">' + esc(h.note) + '</td></tr>').join('')
    : '<tr><td colspan="6" class="dim">这段时间还没有跟进记录</td></tr>';
  const by = {};
  r.rows.forEach(h => { by[h.by] = (by[h.by] || 0) + 1; });
  $('#logCount').textContent = '共 ' + r.total + ' 条' + (r.total > r.rows.length ? '（只显示前 ' + r.rows.length + ' 条）' : '') +
    (Object.keys(by).length ? '　按跟进人：' + Object.entries(by).sort((a, b) => b[1] - a[1]).map(x => x[0] + ' ' + x[1]).join('，') : '');
}

/* ---------------- 跟进统计（按周期） ---------------- */
$('#scPeriod').addEventListener('change', loadScreen);
$('#scSale').addEventListener('change', loadScreen);
$('#tblSc').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openCustomer(tr.dataset.id); });
let scSeq = 0;
/* 周期 → 起始时间：今天 / 近 N 天 / 本月（从 1 号 0 点起） */
function periodStart(v) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (v === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (v === 'today') return d.getTime();
  return d.getTime() - (Number(v) - 1) * 864e5;          // 近 7 天含今天，共 7 个自然日
}
const mdd = ts => { const d = new Date(ts); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
async function loadScreen() {
  const seq = ++scSeq;
  const from = periodStart($('#scPeriod').value);
  const sale = $('#scSale').value;
  const r = await api('GET', '/api/follows?from=' + from + (sale ? '&sale=' + encodeURIComponent(sale) : ''));
  if (seq !== scSeq || !r.ok) return;
  const rows = r.rows;
  $('#scRange').textContent = mdd(from) + ' 至今 · ' + (r.total > rows.length ? '共 ' + r.total + ' 条，只统计前 ' + rows.length + ' 条' : '共 ' + r.total + ' 条');
  const cnt = k => rows.filter(h => h.result === k).length;
  const ids = new Set(rows.map(h => h.id));
  const mix = { reply: cnt('reply'), ordered: cnt('ordered'), later: cnt('later'), lost: cnt('lost') };
  /* 需要跟进 = 现在还在待跟进名单上的 + 这段时间已经跟进过的（去重）；完成 = 这段时间已跟进的客户 */
  const pendBy = {}; let pending = 0;
  (overview ? overview.sales : []).forEach(g => { pendBy[g.saleMan] = g.pending; if (!sale || g.saleMan === sale) pending += g.pending; });
  const need = pending + ids.size, done = ids.size;
  const rate = need ? Math.round(100 * done / need) : 0;
  const kpi = (v, l, c) => '<div class="kpi"><b' + (c ? ' style="color:' + c + '"' : '') + '>' + v + '</b><span class="dim">' + l + '</span></div>';
  $('#scKpis').innerHTML = kpi(need, '需要跟进', 'var(--ac)') + kpi(done, '跟进完成', 'var(--green)') + kpi(rate + '%', '完成率') +
    kpi(pending, '仍待跟进') + kpi(mix.reply, RESULT.reply.name, 'var(--amber)') + kpi(mix.ordered, RESULT.ordered.name, 'var(--green)');

  /* 业务员排行：按客户归属 */
  const by = {};
  rows.forEach(h => { const k = h.saleMan || '（未分配）'; by[k] = by[k] || { n: 0, reply: 0, ordered: 0, later: 0, lost: 0, ids: new Set() }; const g = by[k]; g.n++; g[h.result]++; g.ids.add(h.id); });
  /* 业务员排行：按客户归属；没有跟进记录但手上有名单的业务员也要列出来 */
  const sales2 = overview ? overview.sales.filter(g => g.saleMan !== '（未分配）' && (!sale || g.saleMan === sale)) : [];
  const rank = sales2.map(g => { const x = by[g.saleMan]; return { saleMan: g.saleMan, pending: g.pending, n: x ? x.n : 0, ids: x ? x.ids.size : 0, reply: x ? x.reply : 0, ordered: x ? x.ordered : 0, later: x ? x.later : 0, lost: x ? x.lost : 0 }; })
    .concat(Object.keys(by).filter(k => !pendBy.hasOwnProperty(k) && (!sale || k === sale)).map(k => Object.assign({}, by[k], { saleMan: k, pending: 0, ids: by[k].ids.size })))
    .filter(g => g.pending + g.n > 0)
    .sort((a, b) => b.n - a.n || b.pending - a.pending);
  const max = Math.max(1, ...rank.map(g => g.n + g.pending));
  const cell = v => v ? String(v) : '—';
  $('#tblRank tbody').innerHTML = rank.length ? rank.map((g, i) => { const need2 = g.pending + g.ids, r2 = need2 ? Math.round(100 * g.ids / need2) : 0;
    return '<tr><td><b>' + (i + 1) + '</b>　' + esc(g.saleMan) + '</td>' +
    '<td>' + need2 + '</td><td><b>' + g.ids + '</b></td><td>' + r2 + '%</td>' +
    '<td><div class="rankline"><div class="rankbar"><i style="width:' + Math.round(100 * g.n / max) + '%"></i><i class="pend" style="width:' + Math.round(100 * g.pending / max) + '%"></i></div><b>' + g.n + '</b></div></td>' +
    '<td>' + cell(g.reply) + '</td><td>' + cell(g.ordered) + '</td><td>' + cell(g.later) + '</td><td>' + cell(g.lost) + '</td></tr>'; }).join('')
    : '<tr><td colspan="9" class="dim">这段时间没有要跟进的客户</td></tr>';

  /* 趋势：今天看按小时，其余按天 */
  const today = $('#scPeriod').value === 'today';
  const buckets = [];
  if (today) { for (let h = 8; h <= 21; h++) buckets.push({ key: h, label: (h < 10 ? '0' : '') + h + '点', n: 0 }); }
  else { const end = new Date(); end.setHours(0, 0, 0, 0); for (let t = end.getTime(); t >= from; t -= 864e5) buckets.unshift({ key: t, label: mdd(t), n: 0 }); }
  rows.forEach(h => { const d = new Date(h.ts); const key = today ? d.getHours() : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const b = buckets.find(x => x.key === key); if (b) b.n++; });
  const bmax = Math.max(1, ...buckets.map(b => b.n));
  /* 标签最多显示约 10 个：多了隔几个显示一个，最后一个（今天）总是显示；按天时只写几号，1 号写成「月-日」提示换月 */
  const step = Math.max(1, Math.ceil(buckets.length / 10));
  const lbl = b => { if (today) return b.label; const d = new Date(b.key); return d.getDate() === 1 ? mdd(b.key) : String(d.getDate()); };
  $('#scTrendTitle').textContent = today ? '按小时跟进次数' : '每天跟进次数';
  $('#scTrend').innerHTML = buckets.map((b, i) => '<div class="tcol' + (b.n ? '' : ' empty') + '" title="' + b.label + '：' + b.n + ' 次"><span class="v">' + (b.n || '') + '</span><i style="height:' + Math.round(100 * b.n / bmax) + '%"></i><span class="l">' + (((i % step === 0) || i === buckets.length - 1) ? lbl(b) : '') + '</span></div>').join('');
  const avg = buckets.length ? (rows.length / buckets.filter(b => b.key <= Date.now()).length) : 0;
  $('#scTrendSum').textContent = today ? '' : '日均 ' + avg.toFixed(1) + ' 次　最多一天 ' + bmax + ' 次';

  /* 明细（最多 300 条） */
  $('#tblSc tbody').innerHTML = rows.length ? rows.slice(0, 300).map(h =>
    '<tr data-id="' + h.id + '"><td>' + esc(fmtTs(h.ts)) + '</td><td>' + esc(h.name) + '</td><td>' + esc(h.saleMan || '—') + '</td><td>' + esc(h.by) + '</td>' +
    '<td><span class="tag foll">' + esc(RESULT[h.result] ? RESULT[h.result].name : h.result) + '</span></td><td class="wrap dim">' + esc(h.note) + '</td></tr>').join('')
    : '<tr><td colspan="6" class="dim">这段时间还没有跟进记录</td></tr>';
  const byWho = {};
  rows.forEach(h => { byWho[h.by] = (byWho[h.by] || 0) + 1; });
  $('#scCount').textContent = (r.total > 300 ? '共 ' + r.total + ' 条，只显示前 300 条　' : '') +
    (Object.keys(byWho).length ? '按跟进人：' + Object.entries(byWho).sort((a, b) => b[1] - a[1]).map(x => x[0] + ' ' + x[1]).join('，') : '');
}

/* ---------------- 设置（主管） ---------------- */
function fillSettings() {
  const S = effSettings();
  $$('[data-s]').forEach(i => { i.value = i.dataset.s === 'dueRatio' ? Math.round(S.dueRatio * 100) : S[i.dataset.s]; });
  $$('#voidForm input').forEach(c => { c.checked = S.voidFlags.includes(Number(c.dataset.v)); });
}
async function loadSettings() {
  const r = await api('GET', '/api/meta');
  if (!r.ok) return;
  settings = r.settings || {};
  fillSettings();
  const e = r.erp || {};
  $('#erpUrl').value = e.url || ''; $('#erpUser').value = e.user || ''; $('#erpPass').value = '';
  showSync(r.sync); showMeta(r.meta);
  loadUsers();
  keyPreview();
}
function keyPreview() {
  $('#keyPreview').textContent = (overview ? '按当前已保存的规则，现在有 ' + overview.kpi.key + ' 个重点客户。' : '') +
    '改了数字点「保存规则」，这里和所有名单会一起更新。';
}
$('#btnSaveRules').addEventListener('click', async () => {
  const body = { voidFlags: $$('#voidForm input:checked').map(c => Number(c.dataset.v)) };
  $$('[data-s]').forEach(i => { body[i.dataset.s] = Number(i.value); });
  for (const k of NUM_KEYS) {
    if (!(body[k] >= 0)) return toast('规则里要填 0 或正数');
  }
  body.dueRatio = body.dueRatio / 100;
  const r = await api('POST', '/api/settings', body);
  if (!r.ok) return toast(r.error || '保存失败');
  settings = r.settings; fillSettings();
  await loadOverview(); keyPreview();
  toast('规则已保存，名单已按新规则重算');
});
$('#btnSaveErp').addEventListener('click', async () => {
  const r = await api('POST', '/api/erp', { url: $('#erpUrl').value, user: $('#erpUser').value, pass: $('#erpPass').value || null });
  if (!r.ok) return toast(r.error || '保存失败');
  $('#erpPass').value = ''; toast('ERP 账号已保存');
});

/* ---- 人员 ---- */
$('#uRole').addEventListener('change', () => { $('#uSale').disabled = $('#uRole').value !== 'sale'; });
$('#btnAddUser').addEventListener('click', async () => {
  const r = await api('POST', '/api/users', { name: $('#uName').value.trim(), pass: $('#uPass').value, role: $('#uRole').value,
    saleMan: $('#uRole').value === 'sale' ? $('#uSale').value : '' });
  if (!r.ok) return toast(r.error || '没添加上');
  $('#uName').value = ''; $('#uPass').value = '';
  renderUsers(r.users); toast('账号已添加');
});
$('#tblUsers').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, name = b.dataset.name;
  if (b.dataset.act === 'pass') {
    const pw = prompt('给「' + name + '」设新密码（至少 6 位）：');
    if (pw === null) return;
    if (pw.length < 6) return toast('密码至少 6 位');
    const r = await api('POST', '/api/users', { id, pass: pw });
    toast(r.ok ? '密码已改' : (r.error || '没改成'));
    if (r.ok) renderUsers(r.users);
  } else if (b.dataset.act === 'del') {
    if (!confirm('删除账号「' + name + '」？客户和跟进记录不受影响。')) return;
    const r = await api('POST', '/api/users', { id, del: 1 });
    toast(r.ok ? '账号已删除' : (r.error || '没删成'));
    if (r.ok) renderUsers(r.users);
  }
});
function renderUsers(list) {
  $('#tblUsers tbody').innerHTML = list.map(u =>
    '<tr style="cursor:default"><td><b>' + esc(u.name) + '</b>' + (me && u.id === me.id ? ' <span class="dim">（我）</span>' : '') + '</td><td>' +
    (u.role === 'admin' ? '主管' : '业务员') + '</td><td>' + esc(u.saleMan || '—') + '</td><td class="dim">' + fmtTs(u.lastLogin) + '</td>' +
    '<td class="num"><button class="btn sm" data-act="pass" data-id="' + u.id + '" data-name="' + esc(u.name) + '">改密码</button> ' +
    '<button class="btn sm" data-act="del" data-id="' + u.id + '" data-name="' + esc(u.name) + '">删除</button></td></tr>').join('');
}
async function loadUsers() {
  const r = await api('GET', '/api/users');
  if (r.ok) renderUsers(r.users);
}

/* ---------------- 同步（主管） ---------------- */
let lastMeta = null, needReload = false, polling = false;
function showSync(j) {
  /* 服务重启后内存里的同步过程就没了，这时至少告诉用户手上的数据是哪次同步的 */
  $('#syncLog').textContent = j && j.log ? j.log
    : lastMeta && lastMeta.ts ? '当前数据来自 ' + fmtTs(lastMeta.ts) + ' 的同步（服务重启后不保留过程记录）' : '（还没同步过）';
  $('#btnSync').disabled = !!(j && j.running); $('#btnSync2').disabled = !!(j && j.running);
}
function showMeta(m) {
  lastMeta = m || {};
  $('#metaInfo').textContent = m && m.ts ? '数据：' + fmtTs(m.ts) + '　' + m.customers + ' 客户 / ' + m.orders + ' 订单' : '还没有数据';
}
async function pollSync() {
  if (polling) return; polling = true;
  let again = false;
  try {
    const r = await api('GET', '/api/meta');
    if (!r.ok) { polling = false; return; }
    lastMeta = r.meta; showMeta(r.meta);
    if (isAdmin()) showSync(r.sync);
    if (r.sync.running) again = true;
    else if (r.sync.error && needReload) toast('同步失败：' + r.sync.error);
    else if (needReload) { toast('同步完成'); loadOverview(); }
    needReload = r.sync.running;
  } catch (e) { /* 网络抖动，下次再看 */ }
  polling = false;
  if (again) setTimeout(pollSync, 1500);
}
async function startSync() {
  const r = await api('POST', '/api/sync');
  if (!r.ok) return toast(r.error || '启动失败');
  needReload = true; showSync({ running: true, log: '正在连接 ERP…' }); pollSync();
}
$('#btnSync').addEventListener('click', startSync);
$('#btnSync2').addEventListener('click', startSync);

/* ---------------- 启动 ---------------- */
(async () => {
  fillSettings();
  const b = await api('GET', '/api/bootstrap');
  needSetup = !!(b && b.needSetup);
  const m = await api('GET', '/api/me');
  if (m && m.ok) enter(m.user);
  else showLogin(needSetup ? '第一次使用：先给主管（你自己）建一个账号' : '请登录');
})();
