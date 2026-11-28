/* ============================================================
 *  客户分析（纯计算，不联网）
 *  输入：客户档案 + 订单（按 customId 关联）
 *  输出：每个客户一条 stats —— 单数、金额、复购周期、当前状态、是否重点、排序分
 *
 *  状态：
 *    none      从没下过单
 *    once      只下过一单，还在观察期内
 *    normal    复购中，离下次下单还早
 *    due       快到复购周期了（已过周期的 dueRatio）
 *    overdue   已经过了复购周期
 *    sleep     沉睡：超过周期的 sleepRatio 倍且不少于 sleepMinDays 天
 *    lost      流失：超过 lostDays 天没下单
 * ============================================================ */
'use strict';

const DAY = 86400000;
const DEFAULTS = {
  keyMoney12m: 50000,      // 近 12 个月金额 ≥ 此值 → 重点客户
  keyOrders12m: 10,        // 或 近 12 个月单数 ≥ 此值 且 金额 ≥ keyCountMinMoney → 重点客户
  keyCountMinMoney: 20000, // 按单数算重点时，近 12 个月金额至少要有这么多（挡掉单多但量很小的）
  dueRatio: 0.8,           // 已过周期的 80% → 快到期
  sleepRatio: 3,           // 超过周期的 3 倍 → 沉睡
  sleepMinDays: 90,        // 沉睡至少要间隔这么多天（周期很短的客户不会几周就算沉睡）
  lostDays: 365,           // 这么多天没下单 → 流失
  voidFlags: [1],          // 这些作废标记的订单不算
  minGap: 7,               // 两次下单间隔小于这个天数视为同一批，不算一个周期
  maxGap: 365,             // 间隔超过这个天数不参与算周期（中间断档了）
  followReplyDays: 7,      // 跟进结果是「有意向，等回复」→ 这么多天后再提醒
  followLaterDays: 30      // 其他结果（最近不需要 / 已下单 / 联系不上）→ 这么多天后再提醒
};

const STATUS_ORDER = ['overdue', 'due', 'sleep', 'once', 'normal', 'lost', 'none'];

/* ERP 的时间是北京时间，字符串没有时区，显式按 +08:00 解析 */
function parseTime(s) {
  if (!s) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 8 * 3600000;
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const dayFloor = t => Math.floor(t / DAY);

/* 排序分：重点客户优先；其次逾期越久越靠前；再次金额大者优先 */
function scoreOf(r, S) {
  const c = Math.max(r.cycle, 1);
  const urgency = r.status === 'overdue' ? 30 + Math.min(r.overdueDays / c, 3) * 10
    : r.status === 'due' ? 20 + (r.since / c - S.dueRatio) * 10
    : r.status === 'sleep' ? 10 : 0;
  return (r.key ? 100 : 0) + urgency + Math.min(Math.log10(r.money + 10), 5);
}

/* 一个客户 + 它的全部有效订单 → 一条 stats */
function statOne(c, list, S, NOW) {
  const YEAR_AGO = NOW - 365 * DAY;
  const ts = list.map(o => parseTime(o.createTime) || parseTime(o.deliverTime));
  const n = list.length;
  const last = n ? ts[n - 1] : 0;
  const since = last ? dayFloor(NOW) - dayFloor(last) : -1;        // 距上次下单多少天

  let money = 0, money12 = 0, n12 = 0, qty = 0;
  const prods = {};
  for (let i = 0; i < n; i++) {
    money += list[i].money; qty += list[i].qty;
    if (ts[i] >= YEAR_AGO) { money12 += list[i].money; n12++; }
    if (list[i].product) prods[list[i].product] = (prods[list[i].product] || 0) + 1;
  }
  const topProds = Object.keys(prods).sort((a, b) => prods[b] - prods[a]).slice(0, 3);

  /* 复购周期 = 相邻两次下单间隔（天）的中位数 */
  const gaps = [];
  for (let i = 1; i < n; i++) {
    const g = dayFloor(ts[i]) - dayFloor(ts[i - 1]);
    if (g >= S.minGap && g <= S.maxGap) gaps.push(g);
  }
  const cycle = gaps.length ? Math.round(median(gaps)) : 0;

  let status = 'none';
  let overdueDays = 0;                                             // 正数 = 已逾期天数；负数 = 离预计下次下单还有几天
  if (!n) status = 'none';
  else if (since > S.lostDays) status = 'lost';
  else if (n === 1 || !cycle) {
    status = since >= S.sleepMinDays ? 'sleep' : (n === 1 ? 'once' : 'normal');
  } else {
    overdueDays = since - cycle;
    if (since >= cycle * S.sleepRatio && since >= S.sleepMinDays) status = 'sleep';
    else if (since > cycle) status = 'overdue';
    else if (since >= cycle * S.dueRatio) status = 'due';
    else status = 'normal';
  }

  const key = money12 >= S.keyMoney12m || (n12 >= S.keyOrders12m && money12 >= S.keyCountMinMoney);
  const lastO = list[n - 1] || {};
  return Object.assign({}, c, {
    n, money: Math.round(money), money12: Math.round(money12), n12, qty,
    since, cycle, gaps: gaps.length, status, overdueDays, key,
    lastCode: lastO.code || '', lastProduct: lastO.product || '',
    lastQty: lastO.qty || 0, lastMoney: lastO.money || 0,
    lastTime: lastO.createTime || '', topProds
  });
}

function analyze(customers, orders, settings, now) {
  const S = Object.assign({}, DEFAULTS, settings || {});
  const NOW = now || Date.now();
  const voids = {};
  (S.voidFlags || []).forEach(f => { voids[f] = 1; });

  /* 有效订单按客户归拢，时间正序 */
  const byCust = new Map();
  for (const o of orders) {
    if (voids[o.voidFlag] || !o.customId) continue;
    if (!byCust.has(o.customId)) byCust.set(o.customId, []);
    byCust.get(o.customId).push(o);
  }
  for (const a of byCust.values()) {
    a.sort((x, y) => (parseTime(x.createTime) || parseTime(x.deliverTime)) - (parseTime(y.createTime) || parseTime(y.deliverTime)));
  }

  const out = [];
  const seen = new Set();
  for (const c of customers) {
    seen.add(c.id);
    const r = statOne(c, byCust.get(c.id) || [], S, NOW);
    r.score = scoreOf(r, S);
    out.push(r);
  }
  /* 订单里有、档案里没有的客户（极少），补一条占位档案，免得订单凭空消失 */
  for (const [id, list] of byCust) {
    if (seen.has(id)) continue;
    const named = [...list].reverse().find(o => o.customer);
    const blank = { id, name: (named && named.customer) || ('客户#' + id), linkman: '', mobile: '', wx: '', qq: '',
      level: '', saleMan: '', addr: '', area: '', createTime: '', lastOrderTime: '', status: '' };
    const r = statOne(blank, list, S, NOW);
    r.score = scoreOf(r, S);
    r.orphan = true;
    out.push(r);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { analyze, parseTime, DEFAULTS, STATUS_ORDER };
