/* 客户营销 · 前端逻辑（原生 JS，无依赖） */
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = n => { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万' : String(Math.round(n)); };
const md = s => String(s || '').slice(5, 10);

/* 和 analyze.js 的 DEFAULTS 一致：没保存过规则时用它回填表单 */
const DEFAULTS = { keyMoney12m: 50000, keyOrders12m: 10, keyCountMinMoney: 20000, dueRatio: 0.8, sleepRatio: 3, sleepMinDays: 90,
  lostDays: 365, minGap: 7, maxGap: 365, voidFlags: [1] };
const NUM_KEYS = ['keyMoney12m', 'keyOrders12m', 'keyCountMinMoney', 'sleepRatio', 'sleepMinDays', 'lostDays', 'minGap', 'maxGap'];
const ORDER_ST = { 0: '初始化', 15: '设计分配', 20: '定稿', 25: '审核', 30: '组版', 40: '外发', 50: '印刷', 53: '上光', 54: '液压', 60: '覆膜',
  70: 'UV', 90: '烫金', 100: '压纹', 150: '模切', 200: '清废', 250: '上架', 600: '成型', 800: '入库', 900: '发货', 1000: '完成' };
const STATUS = {
  overdue: { txt: '已逾期', cls: 'overdue' }, due: { txt: '快到期', cls: 'due' }, sleep: { txt: '沉睡', cls: 'sleep' },
  once: { txt: '只下过一单', cls: 'once' }, normal: { txt: '正常', cls: 'normal' }, lost: { txt: '流失', cls: 'lost' },
  none: { txt: '没下过单', cls: 'none' }
};
const HINTS = {
  daily: '今天要跟的：已过了复购周期的、快到的，以及重点客户里沉睡的。按优先级排，重点客户在前。',
  sleep: '沉睡客户：超过往常周期好几倍没下单的。人很多，建议从上往下联系，或按业务员分下去慢慢唤醒。',
  all: '全部客户（含流失和没下过单的）。点任意一行看详情、写备注、排除不该做营销的客户。'
};
const LIST_PAGES = ['daily', 'sleep', 'all'];

async function api(method, url, body) {
  const r = await fetch(url, method === 'POST'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }
    : { cache: 'no-store' });
  return r.json();
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400);
}
const fmtTs = ts => new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(5, 16);
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(5, 10).replace('-', '.');

let settings = {};
let overview = null;                       // 最近一次概览（业务员列表、重点客户数）
let page = 'overview';
const state = {};                          // 每个名单页的分页
LIST_PAGES.forEach(v => { state[v] = { page: 1, size: 100, total: 0 }; });

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
const effSettings = () => Object.assign({}, DEFAULTS, settings);
const isVoid = f => effSettings().voidFlags.includes(Number(f));

/* ---------------- 页面切换 ---------------- */
function go(name) {
  page = name;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + name));
  if (name === 'overview') loadOverview();
  else if (LIST_PAGES.includes(name)) loadList(name, 1);
  else if (name === 'settings') loadSettings();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.page); });

/* ---------------- 概览 ---------------- */
async function loadOverview() {
  const r = await api('GET', '/api/overview');
  if (!r.ok) return toast(r.error || '读取失败');
  overview = r;
  const k = r.kpi;
  $('#kpis').innerHTML = [
    ['客户总数', k.total, ''], ['下过单', k.bought, ''], ['重点客户', k.key, 'acc'],
    ['已逾期', k.overdue, 'red'], ['快到期', k.due, 'amber'], ['沉睡待唤醒', k.sleep, ''],
    ['近12个月金额', yuan(k.money12), 'green']
  ].map(x => '<div class="kpi ' + x[2] + '"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>').join('');
  const cell = (n, color) => '<td class="num" style="' + (n && color ? 'color:var(' + color + ');font-weight:600' : '') + '">' + (n || '') + '</td>';
  $('#tblSales tbody').innerHTML = r.sales.map(s =>
    '<tr data-sale="' + esc(s.saleMan) + '"><td>' + esc(s.saleMan) + '</td><td class="num">' + s.total + '</td>' +
    cell(s.key) + cell(s.overdue, '--red') + cell(s.due, '--amber') + cell(s.sleep) + '<td class="num">' + yuan(s.money12) + '</td></tr>').join('');
  const badge = $('#badgeDaily');
  badge.textContent = k.overdue + k.due; badge.style.display = 'inline';
  fillSalesSelects();
}
$('#tblSales').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-sale]');
  if (!tr) return;
  const name = tr.dataset.sale;
  $('.filters[data-view=daily] [data-f=sale]').value = name === '（未分配）' ? '' : name;
  go('daily');
});

function fillSalesSelects() {
  if (!overview) return;
  const opts = overview.sales.map(s => '<option value="' + esc(s.saleMan) + '">' + esc(s.saleMan) + '（' + s.total + '）</option>').join('');
  $$('.filters [data-f=sale]').forEach(sel => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部业务员</option>' + opts;
    sel.value = cur;
  });
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
  $('#page-' + v).querySelector('[data-t=list]').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openCustomer(tr.dataset.id);
  });
});

function query(v, pageNum, size) {
  const f = $('.filters[data-view=' + v + ']');
  const val = k => f.querySelector('[data-f=' + k + ']').value.trim();
  const qs = new URLSearchParams({ view: v, page: pageNum, size: size || state[v].size, sort: val('sort') || 'score' });
  ['sale', 'status', 'q'].forEach(k => { if (val(k)) qs.set(k, val(k)); });
  if (f.querySelector('[data-f=key]').checked) qs.set('key', '1');
  return qs.toString();
}

async function loadList(v, pageNum) {
  const box = $('#page-' + v);
  pageNum = Math.max(1, pageNum || 1);
  /* 带上序号：连点几下时，慢回来的旧结果不覆盖新的 */
  const seq = (state[v].seq = (state[v].seq || 0) + 1);
  const r = await api('GET', '/api/list?' + query(v, pageNum));
  if (seq !== state[v].seq) return;
  if (!r.ok) return toast(r.error || '读取失败');
  state[v].page = pageNum; state[v].total = r.total;
  box.querySelector('[data-t=list] tbody').innerHTML = r.rows.length ? r.rows.map(x =>
    '<tr data-id="' + x.id + '"><td>' + (x.key ? '<span class="star" title="重点客户">★</span>' : '') + esc(x.name) + '</td>' +
    '<td>' + esc(x.saleMan || '—') + '</td>' +
    '<td><span class="tag ' + STATUS[x.status].cls + '">' + statusText(x) + '</span></td>' +
    '<td class="dim">' + cycleText(x) + '</td>' +
    '<td class="num">' + x.n12 + ' 单 · ' + yuan(x.money12) + '</td>' +
    '<td class="dim">' + (x.lastTime ? md(x.lastTime) + ' ' + esc(x.lastProduct) + ' ×' + x.lastQty : '—') + '</td>' +
    '<td class="dim">' + esc((x.topProds || []).join('、')) + '</td>' +
    '<td class="wrap dim" style="max-width:160px">' + esc(x.note || '') + '</td></tr>').join('')
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
  if (!r.ok) return toast(r.error || '读取失败');
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
      out += (i + 1) + '. ' + (x.key ? '★' : '') + x.name + '｜' + statusText(x) + (x.cycle ? '（往常约' + x.cycle + '天一单）' : '') +
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

/* ---------------- 客户详情 ---------------- */
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
  $('#drawer').innerHTML =
    '<button class="close" id="btnClose">×</button>' +
    '<h2>' + (c.key ? '<span class="star">★</span>' : '') + esc(c.name) + '</h2>' +
    '<div class="dim">' + esc(info) + '</div>' + (c.addr ? '<div class="dim">地址：' + esc(c.addr) + '</div>' : '') +
    '<div class="stats">' + stat(statusText(c), '当前状态', 'color:' + color) + stat(c.cycle ? c.cycle + ' 天' : '—', '复购周期（按 ' + c.gaps + ' 次间隔算）') +
      stat(c.n, '历史订单') + stat(yuan(c.money), '历史金额') + '</div>' +
    '<div class="dim" style="margin-top:6px">近 12 个月 ' + c.n12 + ' 单 · ' + yuan(c.money12) + ' 元｜常买：' + esc((c.topProds || []).join('、') || '—') +
    '｜距上次下单 ' + (c.since >= 0 ? c.since + ' 天' : '—') + '</div>' +
    '<div class="card"><h3>备注 <span class="dim">跟进情况写这里，大家都能看到</span></h3>' +
      '<textarea id="cNote" placeholder="例：10.28 已微信联系，说 11 月有新品活动；对方采购换人了…">' + esc(c.note || '') + '</textarea>' +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:8px">' +
        '<label class="dim"><input type="checkbox" id="cExcl"' + (c.excl ? ' checked' : '') + '> 不做营销（同行 / 内部账号 / 已关门），从所有名单里隐藏</label>' +
        '<button class="btn pri sm" id="btnSaveNote" style="margin-left:auto">保存</button></div></div>' +
    '<div class="card"><h3>历史订单 <span class="dim">划掉的是不算数的单（作废等）</span></h3>' +
      (rows ? '<table><thead><tr><th>单号</th><th>下单时间</th><th>产品</th><th class="num">数量</th><th class="num">金额</th><th>进度</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="dim">没有订单</div>') + '</div>';
  $('#drawer').classList.add('on'); $('#mask').classList.add('on');
  $('#btnClose').onclick = closeDrawer;
  $('#btnSaveNote').onclick = () => saveNote(c.id);
}
async function saveNote(id) {
  const r = await api('POST', '/api/notes', { id: Number(id), note: $('#cNote').value, excl: $('#cExcl').checked });
  if (!r.ok) return toast(r.error || '保存失败');
  toast('已保存'); closeDrawer();
  if (LIST_PAGES.includes(page)) loadList(page, state[page].page);
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#mask').classList.remove('on'); }
$('#mask').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* ---------------- 设置 ---------------- */
function fillSettings() {
  const S = effSettings();
  $$('[data-s]').forEach(i => { i.value = i.dataset.s === 'dueRatio' ? Math.round(S.dueRatio * 100) : S[i.dataset.s]; });
  $$('#voidForm input').forEach(c => { c.checked = S.voidFlags.includes(Number(c.dataset.v)); });
}
async function loadSettings() {
  const r = await api('GET', '/api/meta');
  if (!r.ok) return toast(r.error || '读取失败');
  settings = r.settings || {};
  fillSettings();
  const e = r.erp || {};
  $('#erpUrl').value = e.url || ''; $('#erpUser').value = e.user || ''; $('#erpPass').value = '';
  showSync(r.sync); showMeta(r.meta);
}
function keyPreview() {
  $('#keyPreview').textContent = (overview ? '按当前已保存的规则，现在有 ' + overview.kpi.key + ' 个重点客户。' : '') +
    '改了数字点「保存规则」，这里和所有名单会一起更新。';
}$('#btnSaveRules').addEventListener('click', async () => {
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

/* ---------------- 同步 ---------------- */
let needReload = false, polling = false;
function showSync(j) {
  $('#syncLog').textContent = j && j.log ? j.log : '（还没同步过）';
  $('#btnSync').disabled = !!(j && j.running); $('#btnSync2').disabled = !!(j && j.running);
}
function showMeta(m) {
  $('#metaInfo').textContent = m && m.ts ? '数据：' + fmtTs(m.ts) + '　' + m.customers + ' 客户 / ' + m.orders + ' 订单' : '还没有数据';
}
async function pollSync() {
  if (polling) return; polling = true;
  let again = false;
  try {
    const r = await api('GET', '/api/meta');
    showSync(r.sync); showMeta(r.meta);
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
  await pollSync();
  await loadOverview();
  keyPreview();
})();
