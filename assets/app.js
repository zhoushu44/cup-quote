/* ============================================================
   纸杯报价 · 纸价核算版
   单只成本 = 纸（吨价 × 纸张规格 ÷ (拼版 × 损耗)，按层累计，单层/双层由纸杯表决定）
            + 加工费（成型 + 印刷，按数量梯度插值）
            + 工艺费（按数量梯度）
   注：买来的纸本身就是淋膜纸，PE 涂膜含在纸价里，不再单独计淋膜
   报价 = 成本 ÷ (1 − 毛利率) × (1 + 税率)
   对客户只展示一个价（默认「公司」档）
   ============================================================ */
(function () {
  'use strict';

  var D = window.PC_DATA;
  var KEY = 'pc_simple_v3';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function el(t, c, h) { var n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fp(x) {
    if (!isFinite(x)) return '—';
    if (x === 0) return '0';
    if (x < 0.01) return x.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
    if (x < 1) return x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return x.toFixed(2);
  }
  function fm(x) { return isFinite(x) ? x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
  function fq(x) { return isFinite(x) ? Math.round(x).toLocaleString('zh-CN') : '—'; }
  /* 正在查看的已保存报价单（见文末「已保存报价单」一节） */
  var VIEW = { rec: null, dirty: false, stash: null, applying: false, swap: false, fp: '', pendingId: null, pendingDirty: false };

  /* 版面图 / 单号 / 已保存报价单 / 搜索栏 —— 见文末「版面图」「已保存报价单」两节 */
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 1800); }
  var state = {
    specId: 'ad-9-268',
    lining: 'single',
    qty: 10000,
    crafts: [],
    plateAmort: false,
    urgent: false,
    quoteTier: 1,            // 对客户展示哪一档：0 经销商 / 1 公司 / 2 个人
    quote: { customer: '', contact: '', date: today(), freight: 0, other: 0, buyerTaxNo: '', buyerAddr: '' },
    invoice: 'none',
    shipping: 'none',
    freightPay: 'prepaid',
    shipGrid: {},
    wt: {},                 // 每个杯型的实测单杯克重（空=自动估算）
    customSpecs: [],        // 自定义杯型
    specOrder: null,        // 杯型显示顺序（id 数组）
    specHidden: [],         // 已删除的内置杯型（id 数组，可恢复）
    specDims: {},           // 内置杯型改过的尺寸 { id: { top, bottom, height } }
    quoteImg: null,         // 版面图 { src: dataURL, w, h, name }
    viewId: null,           // 正在查看的已保存报价单 id（刷新后接着显示）
    viewDirty: false,       // 那张单打开后有没有改过
    craftOrder: null,       // 工艺显示顺序
    customCrafts: [],       // 自定义工艺（id,name,prices,plate,desc）
    shipZones: {},          // 每家快递的分区价表 { sf: [{zones:[zoneId], first, next}, ...] }
    boxCfg: {},             // 每个杯型的结构化箱规 { per, l, w, h }
    mode: 'cup',             // cup = 空纸杯 / tea = 茶叶杯
    tea: {
      leaf: 0,
      qtyIdx: 3,
      grade: 'normal',
      pack: 'bag',
      source: 'ours',
      size: 'eu8'
    },
    shipMode: 'auto',        // auto = 按梯度表取；manual = 手工填
    gradients: D.anchors.slice(),
    paper: JSON.parse(JSON.stringify(D.paper || {})),   // 工艺参数：默认损耗 / 卷边 / 杯底余量 / PE
    paperStock: JSON.parse(JSON.stringify(D.paperStock || [])),  // 纸库（长宽 / 克重 / 吨价，可增删改）
    cupPaper: {},           // specId -> { structure, layers:[{paperId, pack, loss}] }
    proc: { make: [], print: [] },  // 加工费梯度（元/只，与 gradients 一一对应）
    craftGrid: {},           // craftId -> [每档加价]
    addon: {},               // 历史字段，已不用（结构工费随选纸自动计）
    params: JSON.parse(JSON.stringify(D.params)),
    lead: JSON.parse(JSON.stringify(D.leadTime)),
    ocrText: '',
    custOcrText: ''
  };

  /* 单杯克重：手填实测优先，没填就用纸杯表自动算 */
  function gramOf(sp) {
    return num((state.wt || {})[sp.id]) || 0;
  }
  /* 自动克重（按纸杯表算） */
  function autoGram(sp) {
    var g = cupPaperCalc(sp).gram;
    return Math.round(g * 10) / 10;
  }

  /* 当前杯型的单杯克重 */
  function curGram() {
    var sp = spec();
    var manual = gramOf(sp);
    return manual > 0 ? manual : autoGram(sp);
  }

  /* 单个箱规 → 文本 */
  function boxText(b) {
    if (!b || !(num(b.per) > 0)) return '';
    return fq(num(b.per)) + '只装 ' + (num(b.l) || '?') + '×' + (num(b.w) || '?') + '×' + (num(b.h) || '?') + 'cm';
  }

  /* 杯型全部箱规（数组）：boxCfg[id] = [ {per,l,w,h}, ... ]；空则从旧文本解析 */
  function boxesOf(sp) {
    var arr = (state.boxCfg || {})[sp.id];
    if (arr && arr.length) {
      return arr.map(function (b) {
        return { per: num(b.per), l: num(b.l), w: num(b.w), h: num(b.h) };
      });
    }
    // 去掉括号里的「建议/备注」内容，避免被误当成额外箱规
    var raw = String(sp.box || '').replace(/[（(][^）)]*[）)]/g, '');
    var out = [];
    // 写法一：1千装 38×31×36cm —— 尺寸在前带"装"
    // 写法零：46.5×37.5×39.5cm，500只 —— 必须优先，否则开头数字会被当成只数
    var m0 = raw.match(/(\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)\s*cm[^\d]{0,8}(\d+)\s*只/);
    if (m0) {
      out.push({ per: +m0[4], l: +m0[1], w: +m0[2], h: +m0[3] });
    }
    var re = /(\d+(?:\.\d+)?)\s*(千|万|只)?装?\s*(\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)/g;
    var m;
    while (out.length === 0 && (m = re.exec(raw)) !== null) {
      out.push({
        per: parseFloat(m[1]) * (m[2] === '万' ? 10000 : m[2] === '千' ? 1000 : 1),
        l: +m[3], w: +m[4], h: +m[5]
      });
    }
    // 写法二：46.5×37.5×39.5cm，500只 —— 三维尺寸 + 末尾只数
    if (!out.length) {
      var m2 = raw.match(/(\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)\s*cm[^\d]{0,8}(\d+)\s*只/);
      if (m2) out.push({ per: +m2[4], l: +m2[1], w: +m2[2], h: +m2[3] });
    }
    // 写法三：25×20=500只/箱 —— 两维 + 等号 + 只数（缺高度）
    if (!out.length) {
      var m3 = raw.match(/(\d+(?:\.\d+)?)[×x*](\d+(?:\.\d+)?)\s*[=＝]\s*(\d+)\s*只/);
      if (m3) out.push({ per: +m3[3], l: +m3[1], w: +m3[2], h: 0 });
    }
    if (!out.length) out = [{ per: 0, l: 0, w: 0, h: 0 }];
    return out;
  }

  /* 主箱规（第一行） */
  function boxOf(sp) {
    var rows = boxesOf(sp);
    return rows[0] || { per: 0, l: 0, w: 0, h: 0 };
  }

  /* ============================================================
     纸成本引擎：吨价 × 纸张规格 ÷ (拼版 × 损耗)
     ============================================================ */

  /* 纸张参数（带默认值兜底，避免用户清空输入框后除零） */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function paperCfg() {
    var p = state.paper || {};
    return {
      lossDefault: p.lossDefault == null ? 8 : clamp(num(p.lossDefault), 0, 90),
      // 调机损耗：每单开机调机固定浪费几张纸（张/单），按这一单的数量摊到每只杯；0 = 不算
      lossStart: p.lossStart == null ? 0 : clamp(num(p.lossStart), 0, 100000),
      // 卷边系数与杯底余量固定（不再做成可调参数）
      flange: 1.06,   // 扇片宽 = 上口周长 × 1.06
      botMargin: 4    // 杯底圆片直径 = 下口 + 4mm
    };
  }

  /* 杯身扇片展开尺寸 mm：宽 = 上口周长 × 卷边；高 = 斜高 */
  function fanBlank(sp, cfg) {
    cfg = cfg || paperCfg();
    var r1 = sp.top / 2, r2 = sp.bottom / 2, h = sp.height;
    var slant = Math.sqrt(h * h + (r1 - r2) * (r1 - r2));
    return { w: Math.PI * sp.top * cfg.flange, h: slant };
  }

  /* 扇片净面积 m²（真实扇形面积 + 卷边，不含损耗） */
  function fanArea(sp, cfg) {
    cfg = cfg || paperCfg();
    var r1 = sp.top / 2000, r2 = sp.bottom / 2000, h = sp.height / 1000;
    var slant = Math.sqrt(h * h + (r1 - r2) * (r1 - r2));
    return Math.PI * (r1 + r2) * slant * cfg.flange;
  }

  /* 一张纸能排多少片：相邻两片一正一倒相扣（错缝），按真实生产拼数反推的规律
       横向节距 =（上口周长 + 下口周长）÷ 2，第一片占整个上口周长
       每行高度：内层（带杯底的扇片）= 斜高 + 卷边余量（默认 14mm）；外层（中空外筒 / 外贴面纸）= 斜高
     li = 第几层（0 = 内层）。两个方向都排一遍取大 */
  function autoPack(sp, paper, cfg, li) {
    cfg = cfg || paperCfg();
    var L = num(paper && paper.len) || 787, W = num(paper && paper.wid) || 1092;
    var tw = Math.PI * num(sp.top), bw = Math.PI * num(sp.bottom);
    if (!(tw > 0) || !(bw > 0)) return 0;
    var avg = (tw + bw) / 2;
    var rowH = Math.hypot(num(sp.height), (num(sp.top) - num(sp.bottom)) / 2) +
      (li > 0 ? 0 : (num(state.paper.fanRowExtra) || 14));
    if (!(rowH > 0)) return 0;
    function one(A, B) {
      var cols = A >= tw ? 1 + Math.floor((A - tw) / avg) : 0;
      return cols * Math.floor(B / rowH);
    }
    return Math.max(one(L, W), one(W, L));
  }

  /* 杯底圆片直径 mm */
  function discDia(sp, cfg) { return sp.bottom + (cfg || paperCfg()).botMargin; }

  /* 纸库里的某张纸 */
  function paperById(id) {
    var list = state.paperStock || [];
    return list.filter(function (p) { return p.id === id; })[0] || list[0] ||
      { id: 'cupstock', name: '杯纸', len: 787, wid: 1092, gsm: 268, price: 6800 };
  }

  /* 结构 */
  function structOf(id) {
    return (D.structures || []).filter(function (s) { return s.id === id; })[0] || D.structures[0];
  }

  /* 某个杯型默认用哪种结构 */
  function defaultStructId(sp) {
    var g = sp.group || '';
    if (g.indexOf('中空') >= 0) return 'double';
    if (g.indexOf('金箔') >= 0) return 'double';   // 金箔铝箔组全是「中空铝箔杯」
    if (g.indexOf('外贴') >= 0) return 'outer';
    return 'single';
  }
  /* 在某材质族里挑克重最接近的「通用」纸（开料纸只给开料表里对应的杯型用，不参与自动匹配） */
  function paperInBase(base, wantGsm) {
    var pool = (state.paperStock || []).filter(function (p) { return (p.base || p.id) === base && p.gen; });
    if (!pool.length) return null;
    var best = null;
    pool.forEach(function (p) {
      if (!best) best = p;
      else if (Math.abs(num(p.gsm) - wantGsm) < Math.abs(num(best.gsm) - wantGsm)) best = p;
    });
    return best;
  }
  /* 纸的显示名：名字里没写克重时补在后面（名字已带 268g 就不重复） */
  function paperLabel(p) {
    p = p || {};
    var g = num(p.gsm);
    return (p.name || '未命名') + (g && String(p.name || '').indexOf(String(g)) < 0 ? ' ' + g + 'g' : '');
  }

  /* 开料表里该杯型该层用的纸：{ id, pack } 或纸 id；没有返回 null */
  function sheetOf(sp, layerIdx) {
    var e = ((D.specSheets || {})[sp.id] || [])[layerIdx || 0];
    if (!e) return null;
    return typeof e === 'string' ? { id: e } : e;
  }

  /* 某个杯型默认用哪种纸：开料表 → 材质族 + 该杯型常用克重（分层：内杯 / 外杯不同族） */
  function defaultPaperId(sp, layerIdx, structId) {
    var g = sp.group || '';
    var base = 'cupstock';
    if (g.indexOf('金箔') >= 0) base = 'gold';
    else if (g.indexOf('银箔') >= 0) base = 'silver';
    else if (g.indexOf('瓦楞') >= 0) base = 'corr';
    var want = num(sp.defW) || 268;
    var st = structId || defaultStructId(sp);
    var idx = layerIdx || 0;
    // 外层：外贴=银箔贴纸、瓦楞=瓦楞纸、金箔杯外层=白卡
    if (idx > 0) {
      if (st === 'outer') base = 'silver';
      else if (st === 'corrugated') base = 'corr';
      else if (base === 'gold') base = 'white';
    } else if (base === 'silver') {
      base = 'cupstock';   // 外贴/银箔杯的内层是普通杯纸
    }
    var pre = sheetOf(sp, idx);
    var p0 = pre ? paperById(pre.id) : null;
    if (pre && p0 && state.paperStock.some(function (x) { return x.id === p0.id; })) return p0.id;
    var gens = (state.paperStock || []).filter(function (x) { return x.gen; });
    var p = paperInBase(base, want) || paperInBase('cupstock', want) || gens[0] || (state.paperStock || [])[0];
    return p ? p.id : 'cupstock-268';
  }

  /* 某杯型的纸杯配置：结构 + 每层（纸 / 拼版 / 损耗） */
  function cupCfg(sp) {
    var c = (state.cupPaper || {})[sp.id];
    if (!c) { c = defaultCupCfg(sp); (state.cupPaper || {})[sp.id] = c; }
    if (!c.layers) c.layers = [];
    if (!c.stash) c.stash = [];
    var st = structOf(c.structure);
    var n = st.layers || 1;
    var cfg = paperCfg();
    while (c.layers.length < n) {
      // 切回双层时优先用之前那层的拼版/损耗
      var src = c.stash[c.layers.length] || {};
      c.layers.push({
        paperId: src.paperId || defaultPaperId(sp, c.layers.length, c.structure),
        pack: src.pack != null ? src.pack : 0,
        loss: src.loss != null ? src.loss : cfg.lossDefault
      });
    }
    if (c.layers.length > n) {
      // 收起的层先存起来，切回去还能用
      for (var k = n; k < c.layers.length; k++) c.stash[k] = c.layers[k];
      c.layers.length = n;
    }
    return c;
  }
  /* 给某一层换纸。手填的拼版数是跟着「这张纸」走的：换纸后先恢复自动，
     旧纸的手填数记在 packMemo 里，换回那张纸时自动恢复 */
  function setLayerPaper(c, L, newId) {
    if (!L) return;
    var memo = c.packMemo || (c.packMemo = {});
    var old = num(L.pack) > 0 ? Math.round(num(L.pack)) : 0;
    if (old > 0 && L.paperId && L.paperId !== newId) memo[L.paperId] = old;
    L.paperId = newId;
    var back = num(memo[newId]) > 0 ? Math.round(num(memo[newId])) : 0;
    L.pack = back;
    return { cleared: old > 0 && !back, restored: back > 0 };
  }
  /* 默认配置：拼版留 0 = 按纸长宽自动算 */
  function defaultCupCfg(sp) {
    var cfg = paperCfg();
    var sid = defaultStructId(sp);
    var st = structOf(sid);
    var layers = [];
    for (var i = 0; i < (st.layers || 1); i++) {
      var pre = sheetOf(sp, i);
      layers.push({ paperId: defaultPaperId(sp, i, sid), pack: pre && num(pre.pack) > 0 ? num(pre.pack) : 0, loss: cfg.lossDefault });
    }
    return { structure: sid, layers: layers, stash: [] };
  }

  /* 一只杯的纸成本与重量
     杯身扇片：整张纸钱 ÷ (拼版数 × (1 − 损耗%)) + 调机损耗（每单固定浪费几张纸 ÷ 这一单的只数）
     杯底圆片：卷筒纸切圆片，不排版 → 净面积 × 克重 × 吨价 ÷ (1 − 损耗%)（切圆片的损耗）
     cfg.qty = 这一单的只数（不传就用当前订单数量），调机损耗按它摊 */
  function cupPaperCalc(sp, cfg) {
    cfg = cfg || paperCfg();
    if (cfg.qty == null) cfg.qty = state.qty;
    var qty = Math.max(0, num(cfg.qty));
    var startN = clamp(num(cfg.lossStart), 0, 100000);
    var cc = cupCfg(sp);
    var layers = [], cost = 0, gram = 0, noFit = false;
    for (var i = 0; i < cc.layers.length; i++) {
      var L = cc.layers[i] || {};
      var p = effPaper(sp, L, i);
      var gsm = num(p.gsm) || 268;
      var loss = clamp(num(L.loss), 0, 90) / 100;
      var pack = num(L.pack) > 0 ? Math.round(num(L.pack)) : autoPack(sp, p, cfg, i);
      var eff = pack > 0 ? Math.max(0.05, pack * (1 - loss)) : 0;
      if (pack <= 0) noFit = true;
      var sheetArea = (num(p.len) || 787) / 1000 * (num(p.wid) || 1092) / 1000;
      var sheetGram = sheetArea * gsm;                                  // 一张纸多少克
      var sheetCost = sheetArea * gsm / 1000 * (num(p.price) || 0) / 1000;  // 一张纸多少钱
      // 调机损耗：startN 张纸全部报废，折成「相当于多损耗百分之几」= 报废只数 ÷(订单只数 ×(1−损耗))
      var startCost = (startN > 0 && qty > 0) ? startN * sheetCost / qty : 0;
      var startLoss = (startN > 0 && qty > 0 && loss < 1) ? startN * pack / qty / (1 - loss) * 100 : 0;
      var row = {
        i: i, name: i === 0 ? '内杯' : '外杯', paper: p, gsm: gsm, price: num(p.price) || 0,
        loss: loss * 100, pack: pack, eff: eff,
        bodyGram: fanArea(sp, cfg) * gsm,      // 杯身净重（进到杯子里的纸）
        bodyCost: eff > 0 ? sheetCost / eff : 0,   // 杯身纸成本（按整张纸摊，含损耗与排版浪费）；放不下时不算
        startCost: startCost, startLoss: startLoss,
        sheetGram: sheetGram, sheetCost: sheetCost
      };
      if (i === 0) {
        // 杯底：卷筒纸切圆片，按净面积计
        var d = discDia(sp, cfg);
        var area = Math.PI * Math.pow(d / 2000, 2);
        row.bottomDia = d;
        row.bottomArea = area;
        row.bottomGram = area * gsm;
        row.bottomCost = area * gsm / 1000 * (num(p.price) || 0) / 1000 / Math.max(0.05, 1 - loss);
      }
      layers.push(row);
      cost += row.bodyCost + row.startCost + (row.bottomCost || 0);
      gram += row.bodyGram + (row.bottomGram || 0);
    }
    return { cfg: cfg, structure: cc.structure, layers: layers, cost: cost, gram: gram, noFit: noFit };
  }

  /* 加工费：成型 / 印刷 各自按数量梯度对数插值 */
  function procCost(item, qty) { return interp((state.proc || {})[item] || [], qty); }
  function procCostAll(qty) { return procCost('make', qty) + procCost('print', qty); }

  /* 加工费默认值（元/只）：固定工费 + 开机损耗摊销 */
  function suggestProc(item, qty) {
    var q = Math.max(1, num(qty));
    var v = item === 'print' ? 0.006 + 25 / q : 0.010 + 8 / q;
    return Math.round(v * 100000) / 100000;
  }

  function initData() {
    if (!state.craftGrid) state.craftGrid = {};
    if (!state.shipGrid) state.shipGrid = {};
    (D.shipping || []).forEach(function (s) {
      if (s.id === 'none') return;
      if (!state.shipGrid[s.id] || !state.shipGrid[s.id].length) {
        var base = (D.shipGrid || {})[s.id] || [30, 80, 130, 500, 900];
        state.shipGrid[s.id] = state.gradients.map(function (g, i) {
          return (base[i] != null ? base[i] : base[base.length - 1]);
        });
      }
      while (state.shipGrid[s.id].length < state.gradients.length) {
        state.shipGrid[s.id].push(state.shipGrid[s.id][state.shipGrid[s.id].length - 1]);
      }
    });
    D.crafts.forEach(function (c) {
      if (!state.craftGrid[c.id] || !state.craftGrid[c.id].length) {
        // 按数量递减生成工艺梯度：量大单价低
        state.craftGrid[c.id] = state.gradients.map(function (g, i) {
          var factor = [1.15, 1.06, 1, 0.92, 0.86, 0.82][Math.min(i, 5)] || 0.8;
          return Math.round(c.prices[1] * factor * 100000) / 100000;
        });
      }
      while (state.craftGrid[c.id].length < state.gradients.length) {
        var lastV = state.craftGrid[c.id][state.craftGrid[c.id].length - 1];
        state.craftGrid[c.id].push(Math.round(lastV * 0.95 * 100000) / 100000);
      }
    });
    // 工艺参数：旧存档没有该字段时补默认值
    state.paper = Object.assign(JSON.parse(JSON.stringify(D.paper || {})), state.paper || {});
    state.paper.pe = Object.assign({ price: 9800, gsm: 18 }, state.paper.pe || {});
    if (state.paper.lossDefault == null) state.paper.lossDefault = 8;
    if (state.paper.lossStart == null) state.paper.lossStart = 0;
    // 纸库：没有就用 data.js 模板
    if (!state.paperStock || !state.paperStock.length) {
      state.paperStock = JSON.parse(JSON.stringify(D.paperStock || []));
    }
    state.paperStock = state.paperStock.map(function (p) {
      return {
        id: p.id || ('p' + Math.random().toString(36).slice(2, 8)),
        base: p.base != null ? p.base : (p.id || ''),
        name: p.name || '未命名',
        len: num(p.len) || 787, wid: num(p.wid) || 1092,
        gsm: num(p.gsm) || 268, price: num(p.price) || 0, desc: p.desc || '',
        gen: !!p.gen
      };
    });
    // 纸杯配置（每个杯型一套）
    if (!state.cupPaper) state.cupPaper = {};
    if (!state.addon) state.addon = {};
    if (!state.sizesExtra) state.sizesExtra = [];   // 「纸」页手动加的、还没被任何纸用上的开料

    // 加工费梯度：首次填充默认值，之后以用户填写为准
    ['make', 'print'].forEach(function (k) {
      if (!state.proc[k]) state.proc[k] = [];
      while (state.proc[k].length < state.gradients.length) {
        state.proc[k].push(suggestProc(k, state.gradients[state.proc[k].length]));
      }
    });

    // 旧版「结构附加工费」已废弃（单层/双层由纸杯表选纸决定），加载后清掉
    if (state.addon.struct) delete state.addon.struct;
  }

  /* ---------------- 存取 ---------------- */
  function save() {
    // 正在用旧单的成本重画报价单：这时成本表是临时换进去的，绝不能写进本机存档
    if (VIEW.swap) return;
    // 查看已保存的报价单时，只要报价内容改了就记一笔（成本页的改动不算）
    if (VIEW.rec && !VIEW.applying && quoteFp() !== VIEW.fp) {
      // 旧单改了内容：单号马上换成一个新号（原单号留给原单），点「保存」后生效
      VIEW.dirty = true;
      state._no = ''; state._noDate = '';
      ensureNo();
      renderDoc();
      renderBanner();
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({
        specId: state.specId, cupPaper: state.cupPaper, stockV: 2,
        paperSel: state.paperSel,
        lining: state.lining, qty: state.qty, crafts: state.crafts,
        plateAmort: state.plateAmort, urgent: state.urgent, quoteTier: state.quoteTier,
        quote: state.quote, gradients: state.gradients,
        paper: state.paper, paperStock: state.paperStock, sizesExtra: state.sizesExtra, proc: state.proc,
        craftGrid: state.craftGrid, addon: state.addon, lead: state.lead,
        shipGrid: state.shipGrid, wt: state.wt, boxCfg: state.boxCfg, shipZones: state.shipZones, customSpecs: state.customSpecs, customCrafts: state.customCrafts, specOrder: state.specOrder, craftOrder: state.craftOrder,
        specHidden: state.specHidden, specDims: state.specDims,
        invoice: state.invoice, shipping: state.shipping, freightPay: state.freightPay,
        mode: state.mode, tea: state.tea,
        params: state.params, ocrText: state.ocrText, custOcrText: state.custOcrText,
        quoteImg: state.quoteImg,
        viewId: VIEW.rec ? VIEW.rec.id : null, viewDirty: !!(VIEW.rec && VIEW.dirty)
      }));
      $('#saveState').textContent = '已保存';
    } catch (e) {}
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      ['specId', 'lining', 'qty', 'crafts', 'ocrText', 'custOcrText'].forEach(function (k) {
        if (o[k] != null) state[k] = o[k];
      });
      ['plateAmort', 'urgent'].forEach(function (k) { if (typeof o[k] === 'boolean') state[k] = o[k]; });
      ['invoice', 'shipping', 'freightPay'].forEach(function (k) { if (o[k]) state[k] = o[k]; });
      if (o.mode) state.mode = o.mode;
      if (o.tea) state.tea = Object.assign(state.tea, o.tea);
      if (typeof o.quoteTier === 'number') state.quoteTier = o.quoteTier;
      if (o.quote) Object.assign(state.quote, o.quote);
      if (o.gradients && o.gradients.length) state.gradients = o.gradients;
      if (o.paper) state.paper = o.paper;
      if (o.paperStock && o.paperStock.length) state.paperStock = o.paperStock;
      if (o.sizesExtra) state.sizesExtra = o.sizesExtra;
      if (o.cupPaper) state.cupPaper = o.cupPaper;
      if (o.proc) state.proc = o.proc;
      if (o.craftGrid) state.craftGrid = o.craftGrid;
      if (o.shipGrid) state.shipGrid = o.shipGrid;
      if (o.wt) state.wt = o.wt;
      if (o.shipZones) state.shipZones = o.shipZones;
      if (o.customSpecs) state.customSpecs = o.customSpecs;
      if (o.specOrder) state.specOrder = o.specOrder;
      if (o.craftOrder) state.craftOrder = o.craftOrder;
      if (o.customCrafts) state.customCrafts = o.customCrafts;
      if (o.specDims) state.specDims = o.specDims;
      if (o.specHidden) state.specHidden = o.specHidden;
      if (o.quoteImg && o.quoteImg.src) state.quoteImg = o.quoteImg;
      if (o.viewId) { VIEW.pendingId = String(o.viewId); VIEW.pendingDirty = !!o.viewDirty; }
      applySpecDims();
      if (o.boxCfg) state.boxCfg = o.boxCfg;
      if (o.addon) state.addon = Object.assign(state.addon, o.addon);
      // 旧存档里已废弃的加价字段（含结构工费），加载后清掉
      ['material', 'weight', 'lining', 'struct'].forEach(function (k) { delete state.addon[k]; });
      // 旧存档迁移：结构 + 每层材质/克重 → 纸杯配置
      if (!o.cupPaper && (o.structure || o.papers)) {
        var oldStruct = o.structure === 'hollow' ? 'double' : (o.structure || '');
        if (oldStruct && structOf(oldStruct).id !== oldStruct) oldStruct = '';
        var oldPapers = o.papers || {};
        var curId = o.specId || state.specId;
        state.cupPaper = {};
        allSpecs().forEach(function (s) {
          // 旧「结构」只是当时这一单的结构，只套到当时的杯型；其它杯型用分组默认
          var sid = defaultStructId(s);
          if (s.id === curId && oldStruct) sid = oldStruct;
          var st = structOf(sid);
          // 旧 papers 可能是数组，也可能是按杯型 id 存的
          var ps = (oldPapers.length != null) ? oldPapers : (oldPapers[s.id] || []);
          var layers = [];
          for (var i = 0; i < (st.layers || 1); i++) {
            var op = ps[i] || ps[0] || {};
            var pid = defaultPaperId(s, i, sid);
            // 旧存档里有「材质 + 克重」时，尽量对上纸库里同一张纸
            if (op.material || op.weight) {
              var ob = op.material || '';
              var og = num(op.weight) || 0;
              var hit = (state.paperStock || []).filter(function (p) {
                return (p.base || p.id) === ob && (!og || num(p.gsm) === og);
              })[0];
              if (hit) pid = hit.id;
            }
            // 旧存档的损耗可能是系数（0.89 = 损耗 11%）或已是百分数
            var ol = num(state.paper.lossDefault);
            if (!ol) ol = 8;
            else if (ol > 0 && ol <= 1) ol = Math.round((1 - ol) * 1000) / 10;
            layers.push({ paperId: pid, pack: 0, loss: ol });
          }
          state.cupPaper[s.id] = { structure: sid, layers: layers, stash: [] };
        });
      }
      if (o.lead) state.lead = Object.assign(state.lead, o.lead);
      if (o.params) Object.assign(state.params, o.params);
      // 旧存档迁移（纸库换成开料表）：旧纸张 id 已不存在 → 换新纸库、纸杯配置按开料表重建；
      // 纸碗 / 纸桶 已下线，自建的也一并去掉。迁移后写上 stockV，下次不再触发
      if (o.stockV !== 2) {
        state.paperStock = JSON.parse(JSON.stringify(D.paperStock || []));
        state.cupPaper = {};
        state.customSpecs = (state.customSpecs || []).filter(function (s) { return !/纸桶|纸碗/.test(s.group || ''); });
        state.specOrder = (state.specOrder || []).filter(function (id) { return allSpecs().some(function (s) { return s.id === id; }); });
        save();
      }
      // 当前杯型已不存在（如纸碗纸桶）→ 回到第一个
      if (!allSpecs().some(function (s) { return s.id === state.specId; })) state.specId = (allSpecs()[0] || {}).id;
    } catch (e) {}
  }

  /* ---------------- 取值 ---------------- */
  /* 当前杯型（标准 + 自定义） */
  function spec() { return allSpecs().filter(function (s) { return s.id === state.specId; })[0] || D.specs[0]; }
  /* 任意杯型（含自定义）；找不到返回 undefined（见下方 specById） */
  /* 当前杯型的结构 id（来自纸杯表） */
  function curStructId() { return cupCfg(spec()).structure; }
  function struct() { return structOf(curStructId()); }
  /* 淋膜：买来的纸本身就是淋膜纸，纸价已含 PE 涂膜 → 不再单独计成本、也不再可选 */
  function lining() { return { id: 'pe', name: 'PE淋膜（纸价已含）', sides: 0 }; }

  /* 对数插值：values 与 state.gradients 一一对应 */
  function interp(values, qty) {
    var g = state.gradients, pts = [];
    for (var i = 0; i < g.length; i++) {
      var v = values[i];
      if (v != null && v !== '' && isFinite(v)) pts.push([g[i], +v]);
    }
    if (!pts.length) return 0;
    if (qty <= pts[0][0]) return pts[0][1];
    if (qty >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (var j = 0; j < pts.length - 1; j++) {
      if (qty >= pts[j][0] && qty <= pts[j + 1][0]) {
        var t = (Math.log10(qty) - Math.log10(pts[j][0])) / (Math.log10(pts[j + 1][0]) - Math.log10(pts[j][0]));
        return pts[j][1] + t * (pts[j + 1][1] - pts[j][1]);
      }
    }
    return pts[0][1];
  }

  function craftPrice(id, qty) { return interp(state.craftGrid[id] || [], qty); }

  /* 淋膜成本：买来的纸就是淋膜纸，PE 涂膜含在纸价里 → 不再单独计 */
  function liningCost() { return 0; }

  /* 单只成本 = 纸（按层累计）+ 加工 + 工艺。
     单层/双层的纸已按层计入，结构工费不再单列；淋膜含在纸价里。
     加急费是「按单」计，不进单只成本（见 tiers / buildQuote） */
  function costDetail() {
    var sp = spec();
    var pd = cupPaperCalc(sp);
    var d = {
      paper: pd.cost, lining: 0, proc: procCostAll(state.qty),
      craft: 0, total: 0, pd: pd, layers: pd.layers
    };
    state.crafts.forEach(function (id) { d.craft += craftPrice(id, state.qty); });
    d.total = d.paper + d.proc + d.craft;
    return d;
  }

  function unitCost() { return costDetail().total; }

  /* 任意杯型的单只成本（纸杯表用） */
  function cupCost(sp, qty) {
    var pd = cupPaperCalc(sp);
    var proc = procCostAll(qty);
    var craft = 0;
    state.crafts.forEach(function (id) { craft += craftPrice(id, qty); });
    return { paper: pd.cost, lining: 0, proc: proc, craft: craft, total: pd.cost + proc + craft, pd: pd };
  }
  /* 全部工艺 = 自定义 + 内置 */
  function allCrafts() {
    var all = (state.customCrafts || []).concat(D.crafts);
    var ord = state.craftOrder;
    if (ord && ord.length) {
      var map = {}; all.forEach(function (c) { map[c.id] = c; });
      var out = [];
      ord.forEach(function (id) { if (map[id]) { out.push(map[id]); delete map[id]; } });
      all.forEach(function (c) { if (map[c.id]) out.push(c); });
      return out;
    }
    return all;
  }
  function craftById(id) {
    return allCrafts().filter(function (x) { return x.id === id; })[0];
  }
  function plate() {
    var s = 0;
    (state.crafts || []).forEach(function (id) {
      var c = allCrafts().filter(function (x) { return x.id === id; })[0];
      if (c) s += num(c.plate) || 0;
    });
    return s;
  }

  /* 当前开票类型 */
  function invoiceObj() {
    return (D.invoices || []).filter(function (x) { return x.id === state.invoice; })[0] || { id: 'none', name: '不开票', rate: 0 };
  }
  function shippingObj() {
    return (D.shipping || []).filter(function (x) { return x.id === state.shipping; })[0] || { id: 'none', name: '不含运费', mode: 'none' };
  }
  /* 税点：不开票 0；普票 3%；专票 13%（可在数据里改） */
  function taxRate() { return num(invoiceObj().rate) || 0; }

  /* ---------------- 发货时间 ---------------- */
  /* 天 = 基准 + 杯型分组 + 结构 + 各工艺 + 克重（取最重一层） */
  function leadTime(specId, structureId, craftIds) {
    var L = state.lead || D.leadTime;
    var sp = specById(specId || state.specId) || spec();
    var st = structureId || curStructId();
    var cr = craftIds || state.crafts;

    var d = num(L.base) || 0;
    var parts = [{ label: '基准', d: num(L.base) || 0 }];

    var gAdd = num((L.byGroup || {})[sp.group]) || 0;
    if (gAdd) { d += gAdd; parts.push({ label: sp.group + ' +' + gAdd, d: gAdd }); }

    var sAdd = num((L.byStructure || {})[st]) || 0;
    if (sAdd) {
      d += sAdd;
      var stName = (D.structures.filter(function (x) { return x.id === st; })[0] || {}).name || st;
      parts.push({ label: stName + ' +' + sAdd, d: sAdd });
    }

    var cAdd = 0;
    var cNames = [];
    (cr || []).forEach(function (id) {
      var add = num((L.byCraft || {})[id]) || 0;
      if (add) {
        cAdd += add;
        var c = allCrafts().filter(function (x) { return x.id === id; })[0];
        cNames.push((c ? c.name : id) + ' +' + add);
      }
    });
    if (cAdd) { d += cAdd; parts.push({ label: cNames.join('、'), d: cAdd }); }

    // 克重：取最重一层
    var maxG = 0;
    cupCfg(sp).layers.forEach(function (L) {
      var g = num((paperById(L.paperId) || {}).gsm);
      if (g > maxG) maxG = g;
    });
    var hAdd = maxG > num(L.heavyGsm || 320) ? (num(L.heavyAdd) || 1) : 0;
    if (hAdd) { d += hAdd; parts.push({ label: '重纸 ' + maxG + 'g +' + hAdd, d: hAdd }); }

    if (state.urgent) {
      d = Math.min(d, num(L.urgentDays) || 3);
      parts = [{ label: '加急', d: d }];
    }

    return { days: Math.max(1, Math.round(d)), parts: parts };
  }

  function leadText(specId, structureId, craftIds) {
    var r = leadTime(specId, structureId, craftIds);
    return r.days + ' 天';
  }

  function tiers() {
    var uc = unitCost();
    var p = state.params;
    // 版费始终摊入单价（对外不单列）
    var per = state.qty > 0 ? plate() / state.qty : 0;
    var cost = uc + per;
    var tr = taxRate();          // 按开票类型取税点
    var urgentFee = state.urgent ? (num(p.urgentFee) || 0) : 0;   // 加急费按单计

    return D.tiers.map(function (t) {
      var price = cost / (1 - Math.min(t.margin, 0.9));
      price *= (1 + tr);
      var step = p.round > 0 ? p.round : 0.001;
      price = p.roundUp ? Math.ceil(price / step) * step : Math.round(price / step) * step;
      return {
        name: t.name, margin: t.margin, cost: cost, price: price,
        amount: price * state.qty + urgentFee,
        urgentFee: urgentFee,
        gross: (price - cost * (1 + tr)) * state.qty
      };
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderSpecSelect() {
    ['#specSelect', '#specSelect2'].forEach(function (sel) {
      var box = $(sel);
      if (!box) return;
      box.innerHTML = '';
      D.groups.concat(['自定义']).forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        allSpecs().filter(function (s) { return s.group === g; }).forEach(function (s) {
          var o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.name + '　' + s.oz + 'oz/' + s.ml + 'ml';
          og.appendChild(o);
        });
        box.appendChild(og);
      });
      box.value = state.specId;
    });
  }

  function renderSpecLine() {
    var s = spec();
    $('#specName').textContent = s.name;
    $('#specLine1').textContent = s.oz + 'oz / ' + s.ml + 'ml　上' + s.top + '×下' + s.bottom + '×高' + s.height + 'mm';
    $('#specLine2').textContent = s.box ? '箱规 ' + s.box : '';
    renderSummary();
  }

  function renderSummary() {
    var box = $('#cfgSummary');
    if (!box) return;
    var sp = spec();
    var cc = cupCfg(sp);
    var st = structOf(cc.structure), parts = [];
    parts.push('<span>' + st.name + '</span>');
    cc.layers.forEach(function (L, i) {
      var p = paperById(L.paperId);
      parts.push('<span>' + (st.layers > 1 ? (i === 0 ? '内 ' : '外 ') : '') + esc(paperLabel(p)) + '</span>');
    });
    parts.push('<span>' + lining().name + '</span>');
    if (state.crafts.length) {
      parts.push('<span class="hi">' + state.crafts.map(function (id) {
        var c = allCrafts().filter(function (x) { return x.id === id; })[0];
        return c ? c.name : '';
      }).filter(Boolean).join(' + ') + '</span>');
    }
    box.innerHTML = parts.join('<i>·</i>');
  }

  /* 计算面板里的发货时间 */
  function renderLeadBadge() {
    var box = $('#leadBadge');
    if (!box) return;
    var r = leadTime();
    box.innerHTML = '<span class="lb-l">发货</span><b>' + r.days + ' 天</b>' +
      '<span class="lb-d">' + r.parts.map(function (x) {
        return x.label === '基准' ? '基准 ' + x.d + ' 天' : x.label;
      }).join(' · ') + '</span>';
  }

  /* 单杯克重 / 箱规 / 总重量 */
  function renderWeightBox() {
    if (!$('#weightBox')) return;
    var sp = spec();

    var gram = curGram();
    var totalKg = gram * state.qty / 1000;

    $('#wbGram').textContent = gram > 0 ? gram.toFixed(1) + ' g' : '未填';
    $('#wbTotal').textContent = gram <= 0 ? '—' : totalKg >= 1000
      ? (totalKg / 1000).toFixed(2) + ' 吨'
      : totalKg.toFixed(1) + ' kg';

    // 箱规
    var boxTxt = sp.box || '未设置';
    $('#wbBox').textContent = boxTxt;

    // 装箱估算：解析箱规里的第一个"X千装"，估算箱数与毛重
    var m = String(sp.box || '').match(/(\d+(?:\.\d+)?)\s*(千|万)装/);
    if (m) {
      var per = num(m[1]) * (m[2] === '万' ? 10000 : 1000);
      if (per > 0) {
        var cartons = Math.ceil(state.qty / per);
        var gross = totalKg * 1.08 + cartons * 0.55;   // 加纸箱与内袋约 8%，每箱 0.55kg
        $('#wbCarton').innerHTML = cartons + ' 箱（每箱 ' + fq(per) + ' 只，毛重约 ' + gross.toFixed(1) + ' kg）';
      } else {
        $('#wbCarton').textContent = '—';
      }
    } else {
      $('#wbCarton').textContent = state.qty + ' 只，总重 ' + totalKg.toFixed(1) + ' kg';
    }
  }

  /* 切换结构（结构下拉与识别套用共用） */
  function setStructure(id) {
    var sp2 = spec();
    var c = cupCfg(sp2);
    if (!c) return;
    c.structure = id;
    var n = (structOf(id) || { layers: 1 }).layers || 1;
    var cfg = paperCfg();
    if (!c.stash) c.stash = [];
    while (c.layers.length < n) {
      var src = c.stash[c.layers.length] || {};
      c.layers.push({
        paperId: src.paperId || defaultPaperId(sp2, c.layers.length, c.structure),
        pack: src.pack != null ? src.pack : 0,
        loss: src.loss != null ? src.loss : cfg.lossDefault
      });
    }
    if (c.layers.length > n) {
      for (var k = n; k < c.layers.length; k++) c.stash[k] = c.layers[k];
      c.layers.length = n;
    }
  }

  function renderStruct() {
    var box = $('#structureSelect');
    if (!box) return;
    var sp = spec();
    var cc = cupCfg(sp);
    box.innerHTML = D.structures.map(function (s) {
      return '<option value="' + s.id + '"' + (cc.structure === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    box.onchange = function () { setStructure(this.value); save(); sync(); };
    var st = structOf(cc.structure);
    var hint = $('#structHint');
    if (hint) hint.textContent = st.layers > 1 ? '（两层纸）' : '（一层纸）';
    var pl = $('#paperLabel');
    if (pl) pl.textContent = st.layers > 1 ? '纸张（内杯 / 外杯）' : '纸张';
  }

  /* 某层的损耗说明：「8% + 调机 3%」（没设调机损耗就只有前半段） */
  function lossStartTxt(L) {
    var s = num(L && L.startLoss) || 0;
    return s > 0 ? ' + 调机 ' + (Math.round(s * 10) / 10) + '%' : '';
  }

  /* 报价页的纸张行：每层一行「克重 + 纸张」两列；成本按该材质的吨价算（同材质各克重同一吨价，
     克重只影响单张重量），开料尺寸 / 拼版沿用当前行 */
  function matLabel(base) {
    return { cupstock: '口杯纸', white: '白卡纸', gold: '金箔纸', silver: '银箔纸', foil: '铝箔纸', corr: '瓦楞纸' }[base] || base;
  }
  /* 纸库的三个概念分开管（底层仍是一行一张纸，由这里按需合成）：
     材质 → 吨价（同材质所有行共用，改一处全改）
     开料尺寸 → 长宽（决定拼版）
     克重 → 只在「纸杯」页每一层上选，决定单张重量
     某个「材质 × 开料 × 克重」组合没有现成的行时自动生成一张 */
  function stockRows() { return state.paperStock || []; }
  function sizeKey(len, wid) { return num(len) + 'x' + num(wid); }
  /* 该材质的吨价：行里出现最多的那个价 */
  function matPrice(base) {
    var cnt = {};
    stockRows().forEach(function (p) { if ((p.base || '') === base) { var k = String(num(p.price)); cnt[k] = (cnt[k] || 0) + 1; } });
    var best = null;
    Object.keys(cnt).forEach(function (k) { if (best === null || cnt[k] > cnt[best]) best = k; });
    return best === null ? 0 : num(best);
  }
  function setMatPrice(base, price) {
    stockRows().forEach(function (p) { if ((p.base || '') === base) p.price = price; });
  }
  function autoRow(base, len, wid, gsm) {
    len = num(len); wid = num(wid); gsm = num(gsm);
    var hit = stockRows().filter(function (p) {
      return (p.base || '') === base && num(p.len) === len && num(p.wid) === wid && num(p.gsm) === gsm;
    })[0];
    if (hit) return hit;
    var r = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      base: base, name: matLabel(base) + ' ' + len + '×' + wid + ' ' + gsm + 'g',
      len: len, wid: wid, gsm: gsm, price: matPrice(base), desc: ''
    };
    stockRows().push(r);
    return r;
  }
  /* 改开料尺寸后可能和别的行重复（同材质同尺寸同克重）→ 只留一张，杯型配置改指向留下的那张 */
  function dedupeStock() {
    var seen = {}, remap = {}, out = [];
    stockRows().forEach(function (p) {
      var k = (p.base || '') + '|' + sizeKey(p.len, p.wid) + '|' + num(p.gsm);
      if (seen[k]) { remap[p.id] = seen[k]; return; }
      seen[k] = p.id; out.push(p);
    });
    state.paperStock = out;
    Object.keys(state.cupPaper || {}).forEach(function (sid) {
      var c = state.cupPaper[sid] || {};
      (c.layers || []).concat(c.stash || []).forEach(function (L) { if (L && remap[L.paperId]) L.paperId = remap[L.paperId]; });
    });
  }
  function matOptions() {
    var seen = {}, out = [];
    (state.paperStock || []).forEach(function (m) {
      if (m.base && !seen[m.base]) { seen[m.base] = 1; out.push({ base: m.base, name: matLabel(m.base) }); }
    });
    return out;
  }
  /* 某层生效的纸：有手动选择（paperSel）就按「材质找吨价行 + 指定克重」合成 */
  function effPaper(sp, L, li) {
    var p = paperById(L.paperId);
    var sel = (state.paperSel || {})[sp.id] || {};
    var s = sel[li];
    if (!s || !s.base || !(num(s.gsm) > 0)) return p;
    /* 开料尺寸跟着杯型走（拼版不变）；换材质只换吨价，改克重只换单张重量 */
    var base = s.base, gsm = num(s.gsm);
    return {
      id: p.id, base: base, len: num(p.len), wid: num(p.wid),
      gsm: gsm, price: matPrice(base),
      name: matLabel(base) + ' ' + num(p.len) + '×' + num(p.wid) + ' ' + gsm + 'g'
    };
  }
  function renderPapers() {
    var box = $('#paperLayers');
    if (!box) return;
    box.innerHTML = '';
    var sp = spec();
    var cc = cupCfg(sp);
    var st = structOf(cc.structure);
    if (!state.paperSel) state.paperSel = {};
    if (!state.paperSel[sp.id]) state.paperSel[sp.id] = {};
    var selAll = state.paperSel[sp.id];
    cc.layers.forEach(function (L, i) {
      var p = effPaper(sp, L, i);
      var row = el('div', 'paper-row');
      row.appendChild(el('span', 'ptag', st.layers > 1 ? (i === 0 ? '内杯' : '外杯') : '杯身'));
      /* 克重 */
      var g = document.createElement('input');
      g.type = 'number'; g.min = 150; g.max = 500; g.step = 1;
      g.value = num(p.gsm) || '';
      g.title = '克重 g/m²（改了杯重、纸钱、ERP 纸种都跟着变）';
      g.style.width = '72px';
      g.onchange = function () {
        if (!selAll[i]) selAll[i] = { base: p.base || 'cupstock', gsm: 0 };
        selAll[i].base = p.base || 'cupstock';
        selAll[i].gsm = num(this.value) || 0;
        save(); renderPapers(); sync();
      };
      row.appendChild(g);
      row.appendChild(el('span', 'ptxt', 'g'));
      /* 纸张材质 */
      var sel = document.createElement('select');
      sel.title = '纸张（吨价取成本页纸库里该材质的价）';
      var curBase = p.base || (paperById(L.paperId).base) || 'cupstock';
      sel.innerHTML = matOptions().map(function (m) {
        return '<option value="' + m.base + '"' + (m.base === curBase ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      }).join('');
      sel.onchange = function () {
        if (!selAll[i]) selAll[i] = { base: this.value, gsm: 0 };
        selAll[i].base = this.value;
        selAll[i].gsm = num(p.gsm) || num(selAll[i].gsm) || 0;
        save(); renderPapers(); sync();
      };
      row.appendChild(sel);
      var pl0 = cupPaperCalc(sp).layers[i] || {};
      var man = num(L.pack) > 0;
      var packN = num(pl0.pack) || 0;
      row.appendChild(el('span', 'ptxt', (packN > 0 ? '拼版 ' + packN + '（' + (man ? '手填' : '自动') + '）' : '拼版放不下') +
        ' ｜ 损耗 ' + (num(pl0.loss) || 0) + '%' + lossStartTxt(pl0)));
      box.appendChild(row);
    });
    var tip = el('div', 'ptip', '<a href="#" id="lnkCostPaper">去成本页改拼版 / 损耗 / 吨价 →</a>');
    box.appendChild(tip);
    var a = $('#lnkCostPaper');
    if (a) a.onclick = function (e) {
      e.preventDefault();
      page('cost');
      var tb = $('.cost-tabs button[data-cost-tab="cup"]');
      if (tb) tb.click();
    };
  }

  /* 淋膜：纸价已含 PE 涂膜，这里只显示说明，不再可选、不再单独计成本 */
  function renderLining() {
    var out = $('#liningOut');
    if (out) out.value = 'PE 淋膜（纸价已含）';
  }

  function renderTiers() {
    var rows = tiers();
    var tb = $('#tierTable tbody');
    tb.innerHTML = '';
    rows.forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (i === state.quoteTier) tr.className = 'sel';
      tr.innerHTML =
        '<td>' + r.name + (i === state.quoteTier ? '<span class="tag">对客</span>' : '') + '</td>' +
        '<td class="r"><input class="mg" type="number" min="0" max="90" step="1" data-i="' + i + '" value="' + (r.margin * 100).toFixed(0) + '"><span class="pct">%</span></td>' +
        '<td class="r price">¥' + fp(r.price) + '</td>' +
        '<td class="r amt">¥' + fm(r.amount) + '</td>';
      tb.appendChild(tr);
    });
    $$('#tierTable .mg').forEach(function (inp) {
      inp.onchange = function () {
        D.tiers[+inp.dataset.i].margin = Math.max(0, Math.min(90, num(inp.value))) / 100;
        sync();
      };
    });
    $('#unitCostOut').value = fp(rows[0].cost);
    var d = costDetail();
    var urgentTxt = state.urgent ? '　|　加急费 ¥' + fm(num(state.params.urgentFee) || 0) + '/单' : '';
    var noFitTxt = (d.pd && d.pd.noFit) ? '　|　<span style="color:#c0392b;font-weight:600">⚠ 有纸张拼版放不下，纸成本未计入，请到成本页「纸杯」填拼版</span>' : '';
    $('#tierNote').innerHTML = '<b>' + fq(state.qty) + '</b> 只　|　成本 <b>¥' + fp(rows[0].cost) + '</b>/只　|　' +
      bracketHint() + '　|　<span style="color:var(--ac)">报价单只给「' + D.tiers[state.quoteTier].name + '」</span>' + urgentTxt + noFitTxt;
    renderCostBreak(d);
  }

  /* 成本构成（纸 / 加工 / 工艺） */
  function renderCostBreak(d) {
    var box = $('#costBreak');
    if (!box) return;
    var pd = d.pd;
    var lay = pd.layers.map(function (L, i) {
      return (pd.layers.length > 1 ? (i === 0 ? '内杯 ' : '外杯 ') : '') +
        paperLabel(L.paper) + ' @' + L.price + '元/吨　¥' + fp(L.bodyCost + L.startCost + (L.bottomCost || 0));
    }).join('　|　');
    var packTxt = pd.layers.map(function (L) {
      return (pd.layers.length > 1 ? L.name + ' ' : '') + '拼版 ' + L.pack + ' · 损耗 ' + L.loss + '%' + lossStartTxt(L);
    }).join('；');
    box.innerHTML =
      '<b>成本构成</b>　纸：' + lay + '　（' + packTxt + '）<br>' +
      '加工 ¥' + fp(d.proc) + '（成型 ¥' + fp(procCost('make', state.qty)) +
      ' + 印刷 ¥' + fp(procCost('print', state.qty)) + '）　+ 工艺 ¥' + fp(d.craft) + '　= <b>¥' + fp(d.total) + '</b>';
  }

  function bracketHint() {
    var g = state.gradients, arr = (state.proc && state.proc.make) || [];
    var pts = [];
    for (var i = 0; i < g.length; i++) {
      var v = arr[i];
      if (v != null && v !== '' && isFinite(v) && v > 0) pts.push([g[i], +v]);
    }
    if (!pts.length) return '加工费未填';
    if (state.qty <= pts[0][0]) return '加工费取最低档 ' + fq(pts[0][0]);
    if (state.qty >= pts[pts.length - 1][0]) return '加工费取最高档 ' + fq(pts[pts.length - 1][0]);
    for (var j = 0; j < pts.length - 1; j++) {
      if (state.qty >= pts[j][0] && state.qty <= pts[j + 1][0]) {
        return '加工费 ' + fq(pts[j][0]) + '–' + fq(pts[j + 1][0]) + ' 档插值';
      }
    }
    return '';
  }

  /* 多选下拉：单击即增减，不用按 Ctrl */
  function bindMultiSelect(sel) {
    if (!sel || sel.dataset.multiBound) return;
    sel.dataset.multiBound = '1';
    sel.addEventListener('mousedown', function (e) {
      if (e.target.tagName !== 'OPTION') return;
      e.preventDefault();
      e.target.selected = !e.target.selected;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function renderCrafts() {
    var box = $('#craftSelect');
    if (!box) return;
    var all = (state.customCrafts || []).concat(D.crafts);
    box.innerHTML = all.map(function (c) {
      var on = state.crafts.indexOf(c.id) >= 0;
      var v = craftPrice(c.id, state.qty);
      return '<option value="' + c.id + '"' + (on ? ' selected' : '') + '>' + esc(c.name) + '（+' + fp(v) + '/只）</option>';
    }).join('');
    bindMultiSelect(box);
    box.onchange = function () {
      state.crafts = Array.prototype.filter.call(box.options, function (o) { return o.selected; })
        .map(function (o) { return o.value; });
      sync();
    };
  }

  /* 开票类型 */
  function renderInvoice() {
    var box = $('#invoiceSelect');
    if (!box) return;
    box.innerHTML = (D.invoices || []).map(function (inv) {
      var rate = num(inv.rate) || 0;
      return '<option value="' + inv.id + '"' + (state.invoice === inv.id ? ' selected' : '') + '>' +
        esc(inv.name) + (rate ? '（' + (rate * 100).toFixed(0) + '%）' : '') + '</option>';
    }).join('');
    box.onchange = function () { state.invoice = this.value; sync(); };
    var hint = $('#invoiceHint');
    if (hint) {
      var inv = invoiceObj();
      hint.textContent = num(inv.rate) ? '税点 ' + (num(inv.rate) * 100).toFixed(0) + '%' : '不含税';
    }
  }

  /* 运费方式 */
  function renderShipping() {
    var box = $('#shippingSelect');
    if (!box) return;
    box.innerHTML = (D.shipping || []).map(function (s) {
      return '<option value="' + s.id + '"' + (state.shipping === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    box.onchange = function () {
      state.shipping = this.value;
      // 选了快递：按梯度表自动带出运费
      if (this.value !== 'none' && state.freightPay === 'prepaid') {
        state.quote.freight = shipCost(this.value, state.qty);
        if ($('#qFreight2')) $('#qFreight2').value = Math.round(state.quote.freight);
      }
      if (this.value === 'none') {
        state.quote.freight = 0;
        if ($('#qFreight2')) $('#qFreight2').value = '';
      }
      sync();
    };
  }

  /* 运费自动算：优先按箱规（按方/按重量），无箱规则回退梯度表 */
  function shipAutoCalc(shipId) {
    var sh = (D.shipping || []).filter(function (x) { return x.id === shipId; })[0];
    if (!sh || !sh.calc || sh.calc === 'none') return null;

    var bx, gram, qty;
    if (state.mode === 'tea') {
      var r = teaCalc();
      bx = { per: r.per, l: r.boxL, w: r.boxW, h: r.boxH };
      gram = r.gram; qty = r.qty;
    } else {
      var b = boxOf(spec());
      bx = { per: b.per, l: b.l, w: b.w, h: b.h };
      gram = curGram(); qty = state.qty;
    }

    if (!(bx.per > 0) || !(bx.l > 0) || !(bx.w > 0) || !(bx.h > 0)) return null;

    var cartons = Math.ceil(qty / bx.per);
    var volOne = bx.l * bx.w * bx.h / 1e6;
    var totalVol = volOne * cartons;
    var totalKg = gram > 0 ? gram * qty / 1000 : 0;

    // 分区价：按订单省份从上到下匹配第一行
    var zoneRows = (state.shipZones || {})[shipId] || [];
    var zoneHit = null;
    var prov = (state.quote.province || '').trim();
    if (zoneRows.length && prov) {
      for (var zi = 0; zi < zoneRows.length; zi++) {
        if ((zoneRows[zi].zones || []).indexOf(prov) >= 0) { zoneHit = zoneRows[zi]; break; }
      }
      if (!zoneHit) return null;   // 该省未报价
    }
    var zf = zoneHit ? num(zoneHit.first) : num(sh.first);
    var zn = zoneHit ? num(zoneHit.next) : num(sh.next);
    var zc = zoneHit ? num(zoneHit.charge) : (num(sh.charge) || 6000);
    var zTag = zoneHit ? '【' + prov + '】' : '';

    var volWt = totalVol * 1e6 / (zc || 6000);   // 体积重 kg
    var realWt = totalKg + cartons * 0.5;                     // 实重（含纸箱）
    var charged = Math.max(realWt, volWt);                    // 计费重取大者
    var fee = 0, basis = '';
    if (sh.calc === 'byVolume') {
      var fv = num(sh.firstM3) || 0.1;
      fee = zf + Math.max(0, totalVol - fv) * zn;
      basis = zTag + cartons + ' 箱 ' + totalVol.toFixed(2) + ' m³（体积重 ' + volWt.toFixed(0) + 'kg / 实重 ' + realWt.toFixed(0) + 'kg，取' + (volWt > realWt ? '体积' : '实重') + '）';
    } else if (sh.calc === 'byWeight') {
      if (!(gram > 0)) return { err: '未填单杯克重，算不出实重', fee: 0, basis: '' };
      if (!(charged > 0)) return { err: '无法计算计费重', fee: 0, basis: '' };
      var fk = num(sh.firstKg) || 1;
      fee = zf + Math.max(0, charged - fk) * zn;
      basis = zTag + '计费重 ' + charged.toFixed(1) + 'kg（实重 ' + realWt.toFixed(0) + ' / 体积重 ' + volWt.toFixed(0) + '，取大）';
    }
    if (fee <= 0) return { err: '该快递未设首重/续重价格', fee: 0, basis: '' };
    return { fee: Math.round(fee * 100) / 100, basis: basis, cartons: cartons, vol: totalVol, kg: totalKg };
  }

  /* 运费：能自动算就自动算，否则用梯度表插值 */
  function shipCost(shipId, qty) {
    var auto = shipAutoCalc(shipId);
    if (auto) return auto.err ? 0 : auto.fee;
    var arr = (state.shipGrid || {})[shipId];
    if (!arr || !arr.length) return 0;
    return interp(arr, qty || state.qty);
  }

  /* ---------------- 茶叶杯 ---------------- */
  function teaData() { return D.tea; }

  /* 茶叶杯发货天数：基准 + 尺寸加天 + 数量档加天 */
  function teaLead(sizeId, qtyIdx) {
    var t = teaData();
    var base = num(t.leadBase) || 7;
    var bySize = t.leadBySize || {};
    var szAdd = num(bySize[sizeId]) || 0;
    var qAdd = num((t.leadByQty || [])[qtyIdx]) || 0;
    var days = base + szAdd + qAdd;

    var parts = [{ label: '基准', d: base }];
    var sz = (t.sizes || []).filter(function (x) { return x.id === sizeId; })[0];
    if (szAdd) parts.push({ label: (sz ? sz.name : sizeId) + ' +' + szAdd, d: szAdd });
    if (qAdd) parts.push({ label: fq(t.tiers[qtyIdx]) + '杯 +' + qAdd, d: qAdd });

    if (state.urgent) {
      days = Math.min(days, num((state.lead || D.leadTime).urgentDays) || 3);
      parts = [{ label: '加急', d: days }];
    }

    return {
      days: Math.max(1, Math.round(days)),
      parts: parts,
      text: Math.max(1, Math.round(days)) + ' 天'
    };
  }

  /* 茶叶杯当前价格（整单） */
  function teaCalc() {
    var t = teaData();
    var s = state.tea || {};
    var qi = Math.max(0, Math.min(t.tiers.length - 1, +s.qtyIdx || 0));
    var qty = t.tiers[qi];

    // 尺寸档：每升一档单杯 +0.05
    var sz = (t.sizes || []).filter(function (x) { return x.id === s.size; })[0] || (t.sizes || [])[0] || { id: 'eu8', name: '欧8中空', add: 0, spec: t.size, ml: 300 };
    var sizeAdd = (num(sz.add) || 0) * qty;

    var isPrem = s.grade === 'premium';
    var total = (isPrem ? t.pricePremium : t.priceNormal)[qi] || 0;
    var p = state.params;

    var pack = (t.packs || []).filter(function (x) { return x.id === s.pack; })[0] || t.packs[0];
    var packAdd = (num(pack.add) || 0) * qty;

    var leafCut = s.source === 'client' ? -0.2 * qty : 0;

    // 工艺加价（与空纸杯共用工艺表，按当前数量插值）
    var craftAdd = 0;
    var craftNames = []
    state.crafts.forEach(function (id) {
      var v = craftPrice(id, qty);
      if (v > 0) { craftAdd += v * qty; craftNames.push((craftById(id) || {}).name || id); }
    });

    var sub = total + sizeAdd + packAdd + leafCut + craftAdd;

    var tr = taxRate();
    var withTax = sub * (1 + tr);
    var urgentAdd = state.urgent ? (num(p.urgentFee) || 300) : 0;

    var ship = shippingObj();
    var freight = num(state.quote.freight);
    var freightAdd = (ship.id !== 'none' && state.freightPay !== 'collect') ? freight : 0;

    var grand = withTax + urgentAdd + freightAdd + num(state.quote.other);

    var lt = teaLead(sz.id, qi);
    var tw = teaWeightOf(sz.id, pack.id);
    var teaTotalKg = tw.gram > 0 ? tw.gram * qty / 1000 : 0;

    return {
      qty: qty, qi: qi,
      leadDays: lt.days, leadParts: lt.parts,
      gram: tw.gram, per: tw.per, boxL: tw.l, boxW: tw.w, boxH: tw.h, totalKg: teaTotalKg,
      leaf: (t.leaves || [])[+s.leaf || 0] || '',
      gradeName: isPrem ? '一级茶' : '普通茶',
      isPrem: isPrem,
      sizeName: sz.name, sizeMl: sz.ml, sizeSpec: sz.spec,
      sizeAdd: sizeAdd, sizeUnit: num(sz.add) || 0,
      base: total, unitBase: qty ? total / qty : 0,
      packName: pack.name, packAdd: packAdd, packUnit: num(pack.add) || 0,
      craftAdd: craftAdd, craftNames: craftNames,
      leafCut: leafCut, source: s.source,
      sub: sub, taxRate: tr, taxAdd: withTax - sub, withTax: withTax,
      urgentAdd: urgentAdd, freightAdd: freightAdd,
      other: num(state.quote.other),
      grand: grand,
      unit: qty ? grand / qty : 0,
      lead: lt.text,
      net: t.netWeight
    };
  }

  /* 尺寸名 → 杯名（去掉「中空」避免和「双层」重复）：欧8中空 → 欧8双层铝箔杯 */
  function teaCupTitle(sizeName) {
    return String(sizeName || '欧8').replace(/中空$/, '') + '双层铝箔杯';
  }

  function renderTea() {
    var t = teaData();
    var s = state.tea;

    // 标题卡跟着「杯子尺寸」下拉实时变
    var curSz = (t.sizes || []).filter(function (x) { return x.id === (s.size || 'eu8'); })[0] ||
      (t.sizes || [])[0] || { name: '欧8中空', spec: t.size, ml: 300 };
    if ($('#teaCupName')) $('#teaCupName').textContent = teaCupTitle(curSz.name);
    if ($('#teaCupSub')) {
      $('#teaCupSub').textContent = t.cupWeight + ' · ' + t.cupMaterial + ' · ' + curSz.spec +
        (curSz.ml ? ' · ' + curSz.ml + 'ml' : '');
    }

    if ($('#teaSize')) $('#teaSize').innerHTML = (t.sizes || []).map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === (s.size || 'eu8') ? ' selected' : '') + '>' +
        esc(x.name) + (x.add ? '（+¥' + fm(x.add) + '/杯）' : '（基础）') + '</option>';
    }).join('');

    if ($('#teaLeaf')) $('#teaLeaf').innerHTML = (t.leaves || []).map(function (n, i) {
      return '<option value="' + i + '"' + (i === +s.leaf ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');

    if ($('#teaQty')) $('#teaQty').innerHTML = t.tiers.map(function (q, i) {
      return '<option value="' + i + '"' + (i === +s.qtyIdx ? ' selected' : '') + '>' + fq(q) + ' 杯</option>';
    }).join('');

    if ($('#teaGrade')) $('#teaGrade').innerHTML = (t.grades || []).map(function (g) {
      return '<option value="' + g.id + '"' + (g.id === s.grade ? ' selected' : '') + '>' + esc(g.name) + '</option>';
    }).join('');

    if ($('#teaPack')) $('#teaPack').innerHTML = (t.packs || []).map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === s.pack ? ' selected' : '') + '>' +
        esc(x.name) + (x.add ? '（+¥' + fm(x.add) + '/杯）' : '（默认）') + '</option>';
    }).join('');

    if ($('#teaSource')) $('#teaSource').value = s.source || 'ours';
    if ($('#teaNet')) $('#teaNet').value = t.netWeight + ' / 杯';

    var r = teaCalc();

    if ($('#teaSummary')) $('#teaSummary').innerHTML = [
      '<span>' + esc(r.sizeName) + '</span>',
      '<span>' + esc(r.leaf) + '</span>',
      '<span>' + r.gradeName + '</span>',
      '<span>' + fq(r.qty) + ' 杯</span>',
      '<span>' + esc(r.packName) + '</span>',
      r.craftNames.length ? '<span>工艺 ' + r.craftNames.length + ' 项</span>' : '',
      r.source === 'client' ? '<span class="hi">客户供茶</span>' : '',
      '<span>保质期 ' + t.shelfLife + '</span>',
      r.gram > 0 ? '<span>单杯 ' + r.gram + 'g / 总重 ' + fmtKg(r.totalKg) + '</span>' : ''
    ].filter(Boolean).join('<i>·</i>');

    var rows = [
      ['杯子 + 茶叶（' + r.sizeName + ' · ' + r.gradeName + '）', r.base],
      r.sizeAdd ? ['尺寸加价：' + r.sizeName + '（+¥' + fm(r.sizeUnit) + '/杯）', r.sizeAdd] : null,
      ['包装：' + r.packName + (r.packUnit ? '（+¥' + fm(r.packUnit) + '/杯）' : ''), r.packAdd],
      r.craftAdd ? ['工艺：' + r.craftNames.join('、') + '（×' + fq(r.qty) + '）', r.craftAdd] : null,
      r.leafCut ? ['客户提供茶叶（−0.2/杯）', r.leafCut] : null,
      r.taxAdd ? ['开票税点（' + invoiceObj().name + ' ' + (r.taxRate * 100).toFixed(0) + '%）', r.taxAdd] : null,
      state.urgent ? ['加急费', r.urgentAdd] : null,
      r.freightAdd ? ['运费（' + shippingObj().name + '）', r.freightAdd] : null,
      r.other ? ['打样 / 专版费', r.other] : null
    ].filter(Boolean);

    if ($('#teaTierTable')) {
      $('#teaTierTable tbody').innerHTML = rows.map(function (x) {
        return '<tr><td>' + esc(x[0]) + '</td><td class="r amt">' + (x[1] < 0 ? '−' : '') + '¥' + fm(Math.abs(x[1])) + '</td></tr>';
      }).join('') +
        '<tr class="total"><td>合计（' + fq(r.qty) + ' 杯 · 每杯 ¥' + fp(r.unit) + '）</td><td class="r price">¥' + fm(r.grand) + '</td></tr>';
    }

    if ($('#teaNote')) {
      var lp = (r.leadParts || []).map(function (x) {
        return x.label === '基准' ? '基准 ' + x.d + ' 天' : x.label;
      }).join(' · ');
      $('#teaNote').innerHTML = '工期 <b>' + esc(r.lead) + '</b>' +
        (lp ? '　<span class="dim">（' + esc(lp) + '）</span>' : '') +
        '　|　净含量 <b>' + esc(r.net) + '/杯</b>　|　' + esc(t.note || '');
    }
  }

  function switchMode(m) {
    state.mode = m || 'cup';
    $$('.mode-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === state.mode); });
    var isTea = state.mode === 'tea';

    if ($('#calcCup')) $('#calcCup').style.display = isTea ? 'none' : '';
    if ($('#calcTea')) $('#calcTea').style.display = isTea ? '' : 'none';

    // 右下角：茶叶杯模式隐藏「杯型/结构/纸张/淋膜」
    ['#structureRow', '#paperLayers', '#liningRow'].forEach(function (sel) {
      var n = $(sel);
      if (n) n.style.display = isTea ? 'none' : '';
    });
    $$('#panelCraft .sub').forEach(function (n) {
      var t = (n.textContent || '').trim();
      if (t.indexOf('结构') === 0 || t.indexOf('纸张') === 0) n.style.display = isTea ? 'none' : '';
    });
    var sp2 = $('#specSelect2');
    if (sp2) {
      var row = sp2.closest('.field-row');
      if (row) row.style.display = isTea ? 'none' : '';
    }

    if (isTea) { renderTea(); renderDoc(); }
    else sync();

    // 成本页 tab 显隐
    $$('.cost-tabs button[data-mode]').forEach(function (b) {
      b.style.display = (b.dataset.mode === state.mode) ? '' : 'none';
    });
    // 当前 tab 若被隐藏，自动回到该模式第一个可用 tab
    var onBtn = $('.cost-tabs button.on');
    if (onBtn && onBtn.style.display === 'none') {
      onBtn.classList.remove('on');
      var first = $$('.cost-tabs button').filter(function (b) { return b.style.display !== 'none'; })[0];
      if (first) first.click();
    }
    if ($('#quoteTierSel')) $('#quoteTierSel').style.display = isTea ? 'none' : '';

    save();
  }

  /* ---------------- 报价单（对客：只一个价） ---------------- */
  function buildQuote() {
    if (state.mode === 'tea') return buildTeaQuote();
    var sp = spec(), st = struct();
    var rows = tiers();
    var r = rows[state.quoteTier] || rows[1];

    var papers = [];
    cupCfg(sp).layers.forEach(function (L, i) {
      var p = effPaper(sp, L, i);
      papers.push((st.layers > 1 ? (i === 0 ? '内层 ' : '外层 ') : '') + esc(paperLabel(p)));
    });

    ensureNo();

    // 明细行：杯子本体 + 版费 + 运费 + 其他
    var items = [];
    items.push({
      idx: 1,
      name: sp.name,
      spec: sp.oz + 'oz / ' + sp.ml + 'ml　上口 ' + sp.top + ' × 下口 ' + sp.bottom + ' × 高 ' + sp.height + 'mm　' + sp.defW + 'g',
      craft: st.name + '　' + papers.join('　') + '　' + lining().name +
        (state.crafts.length ? '　' + state.crafts.map(function (id) {
          var c = allCrafts().filter(function (x) { return x.id === id; })[0];
          return c ? c.name : '';
        }).filter(Boolean).join('、') : '') +
        (curGram() > 0 ? '<br>单杯克重 ' + curGram().toFixed(1) + 'g' +
        '　总重量 ' + (curGram() * state.qty / 1000).toFixed(1) + 'kg' : '') +
        (sp.box ? '<br>箱规：' + sp.box : ''),
      unit: '只',
      qty: state.qty,
      price: r.price,
      amount: r.amount
    });
    // 版费不单独显示：自动并入单价（plateAmort 视为始终开启）
    var ship = shippingObj();
    var freight = num(state.quote.freight);
    // 到付时运费不由我方收，不计入明细
    var freightCharged = (state.freightPay !== 'collect') ? freight : 0;
    if (freightCharged > 0) {
      var shipLabel = (ship.id !== 'none') ? ship.name : '运费';
      items.push({ idx: items.length + 1, name: (ship.id !== 'none' ? '运费（' + ship.name + '）' : '运费'), spec: '按实际重量/体积结算', unit: '项', qty: 1, price: freightCharged, amount: freightCharged });
    }
    var other = num(state.quote.other);
    if (other > 0) {
      items.push({ idx: items.length + 1, name: '打样 / 专版费', spec: '', unit: '项', qty: 1, price: other, amount: other });
    }
    // 加急费按单计（不再乘进单价）
    var urgentFee = state.urgent ? (num(state.params.urgentFee) || 0) : 0;
    if (urgentFee > 0) {
      items.push({ idx: items.length + 1, name: '加急费', spec: '交期压缩至 ' + leadTime().days + ' 天', unit: '项', qty: 1, price: urgentFee, amount: urgentFee });
    }

    var total = items.reduce(function (s, it) { return s + it.amount; }, 0);

    return {
      no: state._no,
      date: state.quote.date || today(),
      customer: state.quote.customer || '',
      contact: state.quote.contact || '',
      buyerTaxNo: state.quote.buyerTaxNo || '',
      buyerAddr: state.quote.buyerAddr || '',
      spec: { name: sp.name, oz: sp.oz, ml: sp.ml, size: '上口 ' + sp.top + ' × 下口 ' + sp.bottom + ' × 高 ' + sp.height + 'mm', box: sp.box, weight: sp.defW + 'g' },
      cupGram: curGram(),
      totalKg: curGram() * state.qty / 1000,
      struct: st.name,
      paper: papers.join('　'),
      lining: lining().name,
      crafts: state.crafts.map(function (id) {
        var c = allCrafts().filter(function (x) { return x.id === id; })[0];
        return c ? c.name : '';
      }).filter(Boolean),
      qty: state.qty,
      price: r.price,
      amount: r.amount,
      leadText: leadText(),
      leadDays: leadTime().days,
      items: items,
      total: total,
      plate: plate(),
      plateAmort: state.plateAmort,
      urgent: state.urgent,
      freight: freight,
      other: other,
      params: state.params,
      company: D.company
    };
  }

  /* 金额大写 */
  function moneyCN(n) {
    if (!isFinite(n) || n < 0) return '';
    var num2 = Math.round(n * 100) / 100;
    var intPart = Math.floor(num2);
    var dec = Math.round((num2 - intPart) * 100);
    var digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
    var units = ['', '拾', '佰', '仟'];
    var bigUnits = ['', '万', '亿', '万亿'];

    if (intPart === 0) {
      var s0 = '';
      if (dec === 0) return '人民币零元整';
      var j0 = Math.floor(dec / 10), f0 = dec % 10;
      if (j0) s0 += digits[j0] + '角';
      if (f0) s0 += digits[f0] + '分';
      else if (j0) s0 += '整';
      return '人民币' + s0;
    }

    function sec(s) {
      var out = '', zero = false;
      var arr = String(s).split('').reverse();
      for (var i = 0; i < arr.length; i++) {
        var d = +arr[i];
        if (d === 0) { zero = true; }
        else {
          if (zero && out) out = '零' + out;
          zero = false;
          out = digits[d] + units[i] + out;
        }
      }
      return out;
    }

    var s = String(intPart), parts = [];
    while (s.length > 4) { parts.unshift(s.slice(-4)); s = s.slice(0, -4); }
    parts.unshift(s);

    var intStr = '';
    for (var i = 0; i < parts.length; i++) {
      var p = sec(+parts[i]);
      var bu = bigUnits[parts.length - 1 - i];
      if (p) intStr += p + bu;
      else if (intStr && i < parts.length - 1) intStr += '零';
    }
    intStr = intStr.replace(/零+/g, '零').replace(/零$/, '') || '零';

    var decStr = '';
    if (dec === 0) decStr = '整';
    else {
      var jiao = Math.floor(dec / 10), fen = dec % 10;
      if (jiao) decStr += digits[jiao] + '角';
      else if (fen && intStr !== '零') decStr += '零';
      if (fen) decStr += digits[fen] + '分';
      else if (jiao) decStr += '整';
    }
    return '人民币' + intStr + '元' + decStr;
  }

  /* 茶叶杯报价单数据 */
  function buildTeaQuote() {
    var t = teaData();
    var r = teaCalc();
    var inv = invoiceObj(), ship = shippingObj();

    ensureNo();

    var items = [{
      idx: 1,
      name: teaCupTitle(r.sizeName) + '（' + r.leaf + '·' + r.gradeName + '）',
      spec: t.cupWeight + '　' + t.cupMaterial + '　' + r.sizeSpec + '　净含量 ' + r.net + '/杯',
      craft: '包装：' + r.packName + (r.packUnit ? '（+¥' + fm(r.packUnit) + '/杯）' : '') +
        '　保质期 ' + t.shelfLife +
        (r.source === 'client' ? '　客户提供茶叶' : '') +
        (r.craftNames.length ? '<br>工艺：' + r.craftNames.join('、') : '') +
        (r.gram > 0 ? '<br>单杯 ' + r.gram + 'g　总重 ' + fmtKg(r.totalKg) : '') +
        (r.per > 0 ? '<br>箱规：' + fq(r.per) + '只装 ' + (r.boxL||'?') + '×' + (r.boxW||'?') + '×' + (r.boxH||'?') + 'cm' : ''),
      unit: '杯',
      qty: r.qty,
      price: r.unit,
      amount: r.grand - r.freightAdd - r.other,
      note: ''
    }];
    if (r.freightAdd > 0) {
      items.push({ idx: 2, name: '运费（' + ship.name + '）', spec: '按实际结算', unit: '项', qty: 1, price: r.freightAdd, amount: r.freightAdd });
    }

    return {
      no: state._no,
      date: state.quote.date || today(),
      customer: state.quote.customer || '',
      contact: state.quote.contact || '',
      buyerTaxNo: state.quote.buyerTaxNo || '',
      buyerAddr: state.quote.buyerAddr || '',
      spec: {
        name: r.sizeName + '茶叶杯',
        oz: '',
        ml: r.sizeMl,
        size: r.sizeSpec,
        box: '',
        weight: t.cupWeight
      },
      struct: teaCupTitle(r.sizeName) + '（含茶叶）',
      paper: t.cupMaterial,
      lining: '铝箔内衬',
      crafts: [],
      qty: r.qty,
      price: r.unit,
      amount: r.grand - r.freightAdd - r.other,
      items: items,
      total: r.grand,
      plate: 0,
      plateAmort: false,
      urgent: state.urgent,
      freight: r.freightAdd,
      other: r.other,
      params: state.params,
      company: D.company,
      leadText: r.lead,
      leadDays: r.leadDays,
      isTea: true,
      tea: r
    };
  }

  function renderDoc() {
    renderCustSummary();
    var q = buildQuote();
    var s = q.spec;
    var c = q.company;
    // 版面图：有图才多一列，放在「品名及规格」前面，只显示在第一行（杯子那一行）
    renderQuoteImg();
    quoteImgEl();                                              // 顺手开始解码（下载图片 / 复制图片要用）
    var hasImg = !!state.quoteImg;
    var imgCell = function (on) {
      return hasImg ? '<td class="imgc">' + (on ? '<img src="' + state.quoteImg.src + '" alt="版面图">' : '') + '</td>' : '';
    };
    var nCol = 6 + (hasImg ? 1 : 0);

    var trs = q.items.map(function (it, i) {
      return '<tr>' +
        '<td class="c">' + it.idx + '</td>' +
        imgCell(i === 0) +
        '<td><b>' + esc(it.name) + '</b>' + (it.spec ? '<span class="sub2">' + esc(it.spec) + '</span>' : '') +
        (it.craft ? it.craft.split('<br>').map(function (seg) { return '<span class="sub2">' + esc(seg) + '</span>'; }).join('') : '') + '</td>' +
        '<td class="c">' + it.unit + '</td>' +
        '<td class="r">' + fq(it.qty) + '</td>' +
        '<td class="r">' + fm(it.price) + '</td>' +
        '<td class="r b">' + fm(it.amount) + '</td>' +
        '</tr>';
    }).join('');

    var terms = [];
    var inv = invoiceObj(), ship = shippingObj();
    terms.push('以上报价为' + (taxRate() > 0 ? '含 ' + (taxRate() * 100).toFixed(0) + '% 增值税' : '不含税') +
      '价格，开票类型：' + inv.name + '。');
    terms.push('交期：' + q.leadText + '（自确认样品及收到定金之日起算）。');
    terms.push('付款方式：' + q.params.pay + '。');
    terms.push('报价有效期：' + q.params.valid + '，逾期需重新核价。');
    if (ship.id !== 'none') {
      terms.push('运输方式：' + ship.name + (state.freightPay === 'collect' ? '，运费到付（客户自付）。' : '，运费已计入报价。'));
    } else {
      terms.push('运输方式：运费另议（' + q.params.ship + '）。');
    }
    // 茶叶杯专属说明
    if (q.isTea && q.tea) {
      terms.push('茶叶：' + q.tea.leaf + '（' + q.tea.gradeName + '），每杯净含量 ' + q.tea.net + '，保质期 ' + teaData().shelfLife + '。');
      terms.push('包装：' + q.tea.packName + '。');
      if (q.tea.source === 'client') terms.push('茶叶由定作方提供，已按每杯 0.2 元在单价中扣减。');
    } else {
      terms.push('本报价按 ' + q.paper + '、' + s.size + ' 核算；如需变更克重、尺寸、材质或工艺，须重新核价。');
    }
    terms.push('实际容量及印刷效果以双方确认的实物打样为准，色差在行业标准范围内属正常。');

    $('#quoteDoc').innerHTML =
      '<div class="qdoc">' +
        '<div class="qdoc-head">' +
          '<div class="qdoc-co">' +
            '<div class="qdoc-co-name">' + esc(c.name || '（请在「成本 → 参数」填公司名）') + '</div>' +
            (c.addr ? '<div class="qdoc-co-line">' + esc(c.addr) + '</div>' : '') +
            ((c.phone || c.taxNo) ? '<div class="qdoc-co-line">' +
              [c.phone ? '电话 ' + c.phone : '', c.taxNo ? '税号 ' + c.taxNo : ''].filter(Boolean).map(esc).join('　') + '</div>' : '') +
          '</div>' +
          '<div class="qdoc-title-box">' +
            '<div class="qdoc-title">报 价 单</div>' +
            '<div class="qdoc-title-en">QUOTATION</div>' +
          '</div>' +
          '<div class="qdoc-blank"></div>' +
        '</div>' +
        '<div class="qdoc-rule"></div>' +
        '<table class="qdoc-info">' +
          '<tr>' +
            '<td class="lb">致（客户）</td><td class="vl">' + esc(q.customer || '　') + '</td>' +
            '<td class="lb">报价单号</td><td class="vl">' + q.no + '</td>' +
          '</tr>' +
          '<tr>' +
            '<td class="lb">联系人</td><td class="vl">' + esc(q.contact || '　') + '</td>' +
            '<td class="lb">报价日期</td><td class="vl">' + q.date + '</td>' +
          '</tr>' +
          (q.buyerTaxNo || q.buyerAddr ? '<tr>' +
            '<td class="lb">纳税人识别号</td><td class="vl" colspan="3">' + esc(q.buyerTaxNo || '　') +
            (q.buyerAddr ? '　　地址：' + esc(q.buyerAddr) : '') + '</td>' +
          '</tr>' : '') +
        '</table>' +
        '<table class="qdoc-body">' +
          '<thead><tr>' +
            '<th class="c" style="width:34px">序号</th>' +
            (hasImg ? '<th class="c" style="width:64px">版面图</th>' : '') +
            '<th>品名及规格</th>' +
            '<th class="c" style="width:46px">单位</th>' +
            '<th class="r" style="width:78px">数量</th>' +
            '<th class="r" style="width:78px">单价(元)</th>' +
            '<th class="r" style="width:92px">金额(元)</th>' +
          '</tr></thead>' +
          '<tbody>' + trs +
            '<tr class="sum"><td colspan="' + (nCol - 1) + '" class="r">合计金额（' + (taxRate() > 0 ? '含税' : '不含税') + '）</td><td class="r b">' + fm(q.total) + '</td></tr>' +
            '<tr class="cn"><td colspan="' + nCol + '">金额大写：' + moneyCN(q.total) + '</td></tr>' +
          '</tbody>' +
        '</table>' +
        '<div class="qdoc-terms">' +
          '<div class="qdoc-terms-t">说　明</div>' +
          '<ol>' + terms.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>' +
        '</div>' +
        '<div class="qdoc-sign">' +
          '<div class="sg"><span class="sg-l">供方（盖章）：</span><span class="sg-line"></span><span class="sg-s">' + esc(c.name || '') + '</span></div>' +
          '<div class="sg"><span class="sg-l">需方（盖章）：</span><span class="sg-line"></span><span class="sg-s">确认签字 / 日期</span></div>' +
        '</div>' +
      '</div>';

    state._q = q;
  }

  function quoteText() {
    var q = state._q || buildQuote();
    var L = ['报　价　单', ''];
    L.push((q.company.name || '') + (q.company.phone ? '　电话：' + q.company.phone : ''));
    L.push('报价单号：' + q.no + '　　报价日期：' + q.date);
    L.push('致（客户）：' + q.customer + (q.contact ? '　联系人：' + q.contact : ''));
    if (q.buyerTaxNo) L.push('纳税人识别号：' + q.buyerTaxNo);
    if (q.buyerAddr) L.push('地址：' + q.buyerAddr);
    L.push('');
    L.push('序号　品名及规格');
    if (state.quoteImg) L.push('（附版面图一张）');
    q.items.forEach(function (it) {
      L.push(' ' + it.idx + '　　' + it.name);
      if (it.spec) L.push('　　　' + it.spec);
      if (it.craft) String(it.craft).split('<br>').forEach(function (seg) { L.push('　　　' + seg); });
      L.push('　　　' + fq(it.qty) + it.unit + ' × ' + fm(it.price) + ' 元 = ' + fm(it.amount) + ' 元');
    });
    L.push('');
    L.push('合计金额（' + (taxRate() > 0 ? '含税' : '不含税') + '）：' + fm(q.total) + ' 元');
    L.push('金额大写：' + moneyCN(q.total));
    L.push('');
    L.push('【说明】');
    L.push('1. 交期：' + q.leadText + '（自确认样品及收到定金之日起算）');
    L.push('2. 付款：' + q.params.pay);
    L.push('3. 有效期：' + q.params.valid + '，逾期重新核价');
    var shp = shippingObj();
    if (shp.id !== 'none') {
      L.push('4. 运输：' + shp.name + (state.freightPay === 'collect' ? '（运费到付）' : (q.freight > 0 ? '（运费 ¥' + fm(q.freight) + '）' : '')));
    } else {
      L.push('4. 运输：运费另议（' + q.params.ship + '）');
    }
    L.push('5. 开票：' + invoiceObj().name + (taxRate() > 0 ? '，含 ' + (taxRate() * 100).toFixed(0) + '% 增值税' : '，不含税'));
    if (!q.isTea) L.push('6. 变更克重/尺寸/材质/工艺需重新核价；实际以确认样品为准');
    else L.push('6. 茶叶每杯净含量 ' + q.tea.net + '，保质期 ' + teaData().shelfLife + '；实际以确认样品为准');
    return L.join('\n');
  }

  /* ---------------- 合同（按现用「定作合同」格式） ---------------- */
  function contractData(opt) {
    opt = opt || {};
    var q = state._q || buildQuote();
    var p = state.params;

    // 茶叶杯 / 空纸杯 分支：数据源完全不同
    if (q.isTea) return teaContractData(q, opt);

    var sp = spec(), st = struct();

    var leadDays = num(opt.leadDays) > 0 ? Math.round(num(opt.leadDays)) : leadTime().days;
    var payText = (opt.pay != null && String(opt.pay).trim() !== '') ? String(opt.pay).trim() : p.pay;
    // 解析付款渠道（用于第九条结算方式）
    var payChannel = (function (t) {
      var s = String(t || '');
      if (s.indexOf('微信') >= 0) return '微信电商下单';
      if (s.indexOf('支付宝') >= 0) return '支付宝';
      if (s.indexOf('银行卡') >= 0) return '银行卡转账';
      if (s.indexOf('对公') >= 0) return '对公转账';
      return '双方约定的方式';
    })(payText);

    function cm(mm) {
      var v = num(mm) / 10;
      return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '');
    }
    var specText = '上口' + cm(sp.top) + '*高' + cm(sp.height) + '*下口' + cm(sp.bottom) + 'cm';

    var inv = invoiceObj(), ship = shippingObj();

    // 备注列：装箱 + 开票 + 运输
    var noteParts = [];
    if (sp.box) noteParts.push('箱规 ' + sp.box);
    if (inv.id !== 'none') noteParts.push(inv.name);
    if (ship.id !== 'none') noteParts.push(ship.name + (state.freightPay === 'collect' ? '到付' : '包邮'));
    else noteParts.push('不含运费');

    var items = [{
      name: sp.name,
      spec: specText + (num(q.cupGram) > 0 ? '　单杯克重 ' + num(q.cupGram).toFixed(1) + 'g　总重 ' +
        num(q.totalKg).toFixed(1) + 'kg' : ''),
      unit: '杯',
      qty: state.qty,
      price: q.price,
      amount: q.amount,
      note: noteParts.join('，')
    }];
    if (q.freight > 0 && state.freightPay !== 'collect') {
      items.push({ name: '运费', spec: ship.name, unit: '项', qty: 1, price: q.freight, amount: q.freight, note: '按实际结算' });
    }
    if (q.other > 0) {
      items.push({ name: '打样 / 专版费', spec: '', unit: '项', qty: 1, price: q.other, amount: q.other, note: '' });
    }

    // 二、印刷要求
    var printReq = '四色印刷';
    if (q.crafts.length) printReq += '，另加' + q.crafts.join('、');
    if (st.layers > 1) printReq += '；' + st.name + '（' + q.paper + '）';

    var deliverAddr = (state.quote.deliverAddr || '').trim();

    var clauses = [
      { n: '二', t: '以定作方要求为准', b: printReq + '。' },
      { n: '三', t: '承揽方对质量负责的条件', b: '如果有质量问题将由承揽方负责。不漏水、干净卫生无异味、杯身不能压变形，做工整齐。' },
      { n: '四', t: '技术资料、图纸提供办法及保密要求', b: '纸杯资料、图纸由定作方提供，承揽方排版制作后回传，经定作方确认无误并定稿方可生产，并对提供资料保密。' },
      { n: '五', t: '交货期限', b: '支付货款之后 ' + leadDays + ' 日内出货。' },
      {
        n: '六', t: '物品运输及其它费用负担',
        b: (ship.id !== 'none'
          ? '发往目的地运费由' + (state.freightPay === 'collect' ? '定作方承担（到付）' : '承揽方负责') + '，如有其它要求，费用由承揽方负责。'
          : '运费由定作方自行承担。') +
          '运输过程中有破损或者遗漏之类的，需要补发的话，费用由承揽方负责。'
      },
      { n: '七', t: '交（提）货方式及地点', b: deliverAddr || '需方提供' },
      { n: '八', t: '付款方式', b: payText },
      {
        n: '九', t: '结算方式',
        b: '按第八条约定通过' + payChannel + '结算' + (inv.id === 'special' ? '，开具增值税专用发票' : inv.id === 'normal' ? '，开具增值税普通发票' : '') + '。'
      },
      { n: '十', t: '违约责任', b: '按《中华人民共和国民法典》的有关规定执行。' },
      { n: '十一', t: '双方协商的其它条款', b: '传真件有效（交易完成后无效）。' },
      { n: '十二', t: '', b: '本合同经双方盖章签字后，自签订日期起生效，货到款清后合同自动作终止。' }
    ];

    return {
      title: (opt.title || '').trim() || '纸杯定作合同',
      no: 'HT' + q.no.replace(/^PC/, ''),
      date: q.date,
      maker: {
        name: q.customer || '',
        taxNo: q.buyerTaxNo || '',
        contact: q.contact || '',
        addr: q.buyerAddr || ''
      },
      taker: {
        name: D.company.name || '',
        addr: D.company.addr || '',
        taxNo: D.company.taxNo || '',
        phone: D.company.phone || '',
        bank: D.company.bank || '',
        account: D.company.account || ''
      },
      items: items,
      total: q.total,
      leadDays: leadDays,
      payText: payText,
      clauses: clauses,
      q: q
    };
  }

  /* 茶叶杯合同数据 */
  function teaContractData(q, opt) {
    var t = teaData();
    var r = q.tea;
    var p = state.params;
    var inv = invoiceObj(), ship = shippingObj();

    var leadDays = num(opt.leadDays) > 0 ? Math.round(num(opt.leadDays)) : 10;
    var payText = (opt.pay != null && String(opt.pay).trim() !== '') ? String(opt.pay).trim() : p.pay;
    // 解析付款渠道（用于第九条结算方式）
    var payChannel = (function (t) {
      var s = String(t || '');
      if (s.indexOf('微信') >= 0) return '微信电商下单';
      if (s.indexOf('支付宝') >= 0) return '支付宝';
      if (s.indexOf('银行卡') >= 0) return '银行卡转账';
      if (s.indexOf('对公') >= 0) return '对公转账';
      return '双方约定的方式';
    })(payText);

    var noteParts = [];
    noteParts.push(r.sizeName);
    noteParts.push('含茶叶·' + r.leaf + '·' + r.gradeName);
    noteParts.push('包装：' + r.packName);
    if (r.source === 'client') noteParts.push('客户供茶');
    if (inv.id !== 'none') noteParts.push(inv.name);
    if (ship.id !== 'none') noteParts.push(ship.name + (state.freightPay === 'collect' ? '到付' : '包邮'));
    else noteParts.push('运费另议');

    var items = [{
      name: teaCupTitle(r.sizeName),
      spec: r.sizeSpec,
      unit: '杯',
      qty: r.qty,
      price: r.unit,
      amount: q.amount,
      note: noteParts.join('，')
    }];
    if (q.freight > 0 && state.freightPay !== 'collect') {
      items.push({ name: '运费', spec: ship.name, unit: '项', qty: 1, price: q.freight, amount: q.freight, note: '按实际结算' });
    }
    if (q.other > 0) {
      items.push({ name: '打样 / 专版费', spec: '', unit: '项', qty: 1, price: q.other, amount: q.other, note: '' });
    }

    var printReq = '四色印刷；' + r.sizeName + '（' + t.cupWeight + '，' + t.cupMaterial + '）；每杯净含量 ' + r.net + '；' +
      r.leaf + '（' + r.gradeName + '）；包装：' + r.packName;
    if (r.source === 'client') printReq += '；茶叶由定作方提供';
    if (r.craftNames && r.craftNames.length) printReq += '；工艺：' + r.craftNames.join('、');

    var clauses = [
      { n: '二', t: '以定作方要求为准', b: printReq + '。' },
      { n: '三', t: '承揽方对质量负责的条件', b: '如果有质量问题将由承揽方负责。不漏水、干净卫生无异味、杯身不能压变形，做工整齐；茶叶须在保质期内，无霉变、无异味。' },
      { n: '四', t: '技术资料、图纸提供办法及保密要求', b: '纸杯资料、图纸由定作方提供，承揽方排版制作后回传，经定作方确认无误并定稿方可生产，并对提供资料保密。' },
      { n: '五', t: '交货期限', b: '支付货款之后 ' + leadDays + ' 日内出货。' },
      {
        n: '六', t: '物品运输及其它费用负担',
        b: (ship.id !== 'none'
          ? '发往目的地运费由' + (state.freightPay === 'collect' ? '定作方承担（到付）' : '承揽方负责') + '，如有其它要求，费用由承揽方负责。'
          : '运费另议。') +
          '运输过程中有破损或者遗漏之类的，需要补发的话，费用由承揽方负责。'
      },
      { n: '七', t: '交（提）货方式及地点', b: (state.quote.deliverAddr || '').trim() || '需方提供' },
      { n: '八', t: '付款方式', b: payText },
      {
        n: '九', t: '结算方式',
        b: '按第八条约定通过' + payChannel + '结算' + (inv.id === 'special' ? '，开具增值税专用发票' : inv.id === 'normal' ? '，开具增值税普通发票' : '') + '。'
      },
      { n: '十', t: '违约责任', b: '按《中华人民共和国民法典》的有关规定执行。' },
      { n: '十一', t: '双方协商的其它条款', b: '传真件有效（交易完成后无效）。' },
      { n: '十二', t: '', b: '本合同经双方盖章签字后，自签订日期起生效，货到款清后合同自动作终止。' }
    ];

    return {
      title: (opt.title || '').trim() || '茶叶杯定作合同',
      no: 'HT' + q.no.replace(/^PC/, ''),
      date: q.date,
      maker: {
        name: q.customer || '',
        taxNo: q.buyerTaxNo || '',
        contact: q.contact || '',
        addr: q.buyerAddr || ''
      },
      taker: {
        name: D.company.name || '',
        addr: D.company.addr || '',
        taxNo: D.company.taxNo || '',
        phone: D.company.phone || '',
        bank: D.company.bank || '',
        account: D.company.account || ''
      },
      items: items,
      total: q.total,
      leadDays: leadDays,
      payText: payText,
      clauses: clauses,
      q: q
    };
  }

  /* ---------- 合同 HTML（打印用） ---------- */
  function contractHTML(opt) {
    var c = contractData(opt);
    var W = function (n) { return n ? esc(n) : '　　　　　　　　'; };

    // 版面图：有图才多一列，放在「定作物品名称」前面
    var hasImg = !!state.quoteImg;
    var imgH = hasImg ? '<th style="width:7%">图片</th>' : '';
    var imgD = function (on) { return hasImg ? '<td class="c imgc">' + (on ? '<img src="' + state.quoteImg.src + '" alt="版面图">' : '') + '</td>' : ''; };

    var rows = c.items.map(function (it, i) {
      return '<tr>' + imgD(i === 0) +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(it.spec || '—') + '</td>' +
        '<td class="c">' + esc(it.unit) + '</td>' +
        '<td class="c">' + fq(it.qty) + '</td>' +
        '<td class="r">' + fm(it.price) + '</td>' +
        '<td class="r">' + fm(it.amount) + '</td>' +
        '<td class="sm">' + esc(it.note || '') + '</td>' +
        '</tr>';
    }).join('');

    var clauses = c.clauses.map(function (cl) {
      return '<p>' + cl.n + '、' + (cl.t ? cl.t + '：' : '') + esc(cl.b) + '</p>';
    }).join('');

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(c.title) + ' ' + esc(c.no) + '</title>' +
      '<style>' +
      '@page { size: A4; margin: 20mm 18mm; }' +
      'body { font-family: "SimSun","宋体",serif; font-size: 10.5pt; line-height: 1.7; color: #000; margin:0; padding:20mm 18mm; background:#fff; }' +
      '@media print { body { padding: 0; } }' +
      'h1 { font-family: "SimHei","黑体"; font-size: 17pt; text-align: center; letter-spacing: 4pt; margin: 0 0 14pt; }' +
      '.row2 { display:flex; justify-content:space-between; margin-bottom:4pt; }' +
      '.lead { margin: 4pt 0; }' +
      'h2 { font-family:"SimHei","黑体"; font-size:10.5pt; font-weight:normal; margin: 12pt 0 4pt; }' +
      'table.items { width:100%; border-collapse:collapse; font-size:9.5pt; margin:6pt 0 10pt; table-layout:fixed; }' +
      'table.items th, table.items td { border:0.5pt solid #000; padding:3pt 4pt; vertical-align:middle; }' +
      'table.items th { background:#f0f0f0; font-family:"SimHei","黑体"; font-weight:normal; text-align:center; }' +
      'table.items td.c { text-align:center; } table.items td.r { text-align:right; }' +
      'table.items td.sm { font-size:8.5pt; }' +
      'table.items td.cn { font-size:8pt; line-height:1.35; word-break:break-all; }' +
      'table.items td.imgc img { width:2.1cm; height:2.1cm; object-fit:contain; display:block; margin:0 auto; }' +
      'p { margin: 3pt 0; text-align: justify; }' +
      'table.sign { width:100%; border-collapse:collapse; margin-top:14pt; font-size:9.5pt; table-layout:fixed; }' +
      'table.sign td { border:0.5pt solid #000; padding:6pt 8pt; vertical-align:top; width:50%; }' +
      'table.sign .h { font-family:"SimHei","黑体"; text-align:center; letter-spacing:2pt; margin-bottom:6pt; }' +
      'table.sign .l { line-height:2.0; }' +
      '.blank { height: 40pt; }' +
      '</style></head><body>' +

      '<h1>' + esc(c.title) + '</h1>' +
      '<div class="row2"><span>定作方：' + W(c.maker.name) + '</span><span>日期：' + esc(c.date) + '</span></div>' +
      '<div class="lead">承揽方：' + W(c.taker.name) + '</div>' +
      '<div class="lead">品名或项目、规格型号、数量、单价、金额。</div>' +

      '<table class="items"><thead><tr>' + imgH +
      (hasImg
        ? '<th style="width:17%">定作物品名称</th><th style="width:16%">规格型号</th><th style="width:6%">单位</th><th style="width:9%">数量</th><th style="width:10%">单价</th><th style="width:12%">总金额</th><th style="width:23%">备注</th>'
        : '<th style="width:22%">定作物品名称</th><th style="width:19%">规格型号</th>' +
      '<th style="width:7%">单位</th><th style="width:10%">数量</th>' +
      '<th style="width:11%">单价</th><th style="width:13%">总金额</th>' +
      '<th style="width:18%">备注</th>') +
      '</tr></thead><tbody>' + rows +
      '<tr><td colspan="' + (5 + (hasImg ? 1 : 0)) + '" class="r"><b>合计</b></td><td class="r"><b>' + fm(c.total) + '</b></td><td class="sm cn">' + moneyCN(c.total) + '</td></tr>' +
      '</tbody></table>' +

      clauses +

      '<table class="sign"><tr>' +
      '<td><div class="h">定　作　方</div><div class="l">' + W(c.maker.name) + '<br>' +
      '纳税识别号：' + W(c.maker.taxNo) + '<br>' +
      '联系人：' + W(c.maker.contact) + '<br>' +
      '地址：' + W(c.maker.addr) +
      '<div class="blank"></div>（盖章）</div></td>' +
      '<td><div class="h">承　揽　方</div><div class="l">' +
      '单位名称：' + W(c.taker.name) + '<br>' +
      '单位地址：' + W(c.taker.addr) + '<br>' +
      '纳税识别号：' + W(c.taker.taxNo) + '<br>' +
      '户　　名：' + W(c.taker.name) + '<br>' +
      '开户银行：' + W(c.taker.bank) + '<br>' +
      '账　　号：' + W(c.taker.account) + '<br>' +
      '电　　话：' + W(c.taker.phone) +
      '<div class="blank"></div>（盖章）</div></td>' +
      '</tr></table>' +

      '</body></html>';
  }

  /* ---------- 合同 DOCX（真 Word） ---------- */
  function contractDOCX(opt) {
    var D3 = window.PC_DOCX;
    var c = contractData(opt);
    var S = D3.SONG, H = D3.HEI;
    var W = 9638;
    var B = '';

    function W_(n) { return n ? n : '　　　　　　　　'; }

    /* 标题 */
    B += D3.p(c.title, { font: H, sz: 34, bold: true, align: 'center', after: 220, line: 300 });

    /* 定作方 / 日期 */
    B += D3.p([{ t: '定作方：' + W_(c.maker.name) }, { t: '　　　　　日期：' + c.date }], { sz: 21, after: 60 });
    B += D3.p('承揽方：' + W_(c.taker.name), { sz: 21, after: 60 });
    B += D3.p('品名或项目、规格型号、数量、单价、金额。', { sz: 21, after: 80 });

    /* 明细表（有版面图时最前面多一列） */
    var img = quoteImgBytes();                      // { bytes, w, h } 或 null
    var cols = img ? [1000, 1800, 1500, 640, 900, 1000, 1200, 1598] : [2120, 1830, 680, 960, 1060, 1260, 1728];
    // 图在 Word 里最大 1.55cm 见方（1cm = 360000 EMU），等比缩放
    var imgCell = function (on) {
      if (!img) return [];
      if (!on) return [{ img: null }];
      var k = Math.min(558000 / img.w, 558000 / img.h);
      return [{ img: { rid: 'rIdImg1', cx: Math.round(img.w * k), cy: Math.round(img.h * k) } }];
    };
    var rows = [{
      header: true,
      cells: (img ? [{ text: '图片', align: 'center', font: H, shade: 'F2F2F2' }] : []).concat([
        { text: '定作物品名称', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '规格型号', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '单位', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '数量', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '单价', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '总金额', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '备注', align: 'center', font: H, shade: 'F2F2F2' }
      ])
    }];

    c.items.forEach(function (it, i) {
      rows.push({
        cells: imgCell(i === 0).concat([
          { text: it.name },
          { text: it.spec || '—' },
          { text: it.unit, align: 'center' },
          { text: fq(it.qty), align: 'center' },
          { text: fm(it.price), align: 'right' },
          { text: fm(it.amount), align: 'right' },
          { text: it.note || '', sz: 16 }
        ])
      });
    });

    rows.push({
      cells: (img ? [{ text: '', span: 1 }] : []).concat([
        { text: '合计', span: 5, align: 'right', b: true, shade: 'F8F6F2' },
        { text: fm(c.total), align: 'right', b: true, shade: 'F8F6F2' },
        { text: moneyCN(c.total), sz: 16, shade: 'F8F6F2' }
      ])
    });

    B += D3.tbl(rows, { width: W, cols: cols });
    B += D3.p('', { sz: 12, after: 100 });

    /* 条款 */
    c.clauses.forEach(function (cl) {
      B += D3.p(cl.n + '、' + (cl.t ? cl.t + '：' : '') + cl.b, { sz: 21, after: 40, line: 320 });
    });

    /* 签署表 */
    B += D3.p('', { sz: 12, after: 160 });
    var signRows = [{
      cells: [
        {
          lines: [
            { t: '定　作　方', font: H, align: 'center', b: true },
            { t: W_(c.maker.name) },
            { t: '纳税识别号：' + W_(c.maker.taxNo) },
            { t: '联系人：' + W_(c.maker.contact) },
            { t: '地址：' + W_(c.maker.addr) },
            { t: '' }, { t: '' },
            { t: '（盖章）' }
          ], sz: 19, valign: 'top'
        },
        {
          lines: [
            { t: '承　揽　方', font: H, align: 'center', b: true },
            { t: '单位名称：' + W_(c.taker.name) },
            { t: '单位地址：' + W_(c.taker.addr) },
            { t: '纳税识别号：' + W_(c.taker.taxNo) },
            { t: '户　　名：' + W_(c.taker.name) },
            { t: '开户银行：' + W_(c.taker.bank) },
            { t: '账　　号：' + W_(c.taker.account) },
            { t: '电　　话：' + W_(c.taker.phone) },
            { t: '（盖章）' }
          ], sz: 19, valign: 'top'
        }
      ]
    }];
    B += D3.tbl(signRows, { width: W, cols: [Math.round(W / 2), Math.round(W / 2)] });

    return D3.build(B, c.title + ' ' + c.no, img ? [{ name: 'image1.jpeg', data: img.bytes }] : null);
  }

  function exportContract() {
    openContractModal();
  }

  /* ---------- 导出合同确认弹窗 ---------- */
  var modalState = { leadDays: 0, pay: '' };

  function openContractModal() {
    var c = contractData();
    var auto = leadTime();
    modalState.leadDays = auto.days;
    modalState.pay = c.q.params.pay || '';

    var mask = $('#contractModal');
    if (!mask) { doExportContract(); return; }

    // 天数
    $('#mLeadDays').value = auto.days;
    var hint = $('#mLeadHint');
    if (hint) {
      hint.innerHTML = '系统估算：<b>' + auto.days + ' 天</b>　（' +
        auto.parts.map(function (x) { return x.label === '基准' ? '基准 ' + x.d : x.label; }).join(' · ') + '）';
    }

    // 快捷选项
    var quick = $('#mLeadQuick');
    if (quick) {
      quick.innerHTML = '';
      [auto.days, 7, 10, 15, 20, 25, 30].filter(function (v, i, a) {
        return a.indexOf(v) === i;
      }).sort(function (a, b) { return a - b; }).forEach(function (d) {
        var b = el('button', d === auto.days ? 'on' : '', d + ' 天');
        b.onclick = function () {
          $('#mLeadDays').value = d;
          $$('#mLeadQuick button').forEach(function (x) { x.classList.toggle('on', x === b); });
        };
        quick.appendChild(b);
      });
    }

    // 付款方式：渠道 + 节奏 两个下拉自动拼条款
    function composePay() {
      var m = $('#mPayMethod') ? $('#mPayMethod').value : '对公转账';
      var s = $('#mPayStage') ? $('#mPayStage').value : '预付 30%，余款发货前结清';
      // 微信电商下单本身即在线支付，不再重复"对公"
      if (m === '微信电商下单') return '微信电商下单，' + s.replace('，余款发货前结清', '，余款发货前在店铺结清') + '。';
      return m + '，' + s + '。';
    }
    if ($('#mPayMethod') && $('#mPayStage')) {
      $('#mPayMethod').onchange = function () { $('#mPayText').value = composePay(); };
      $('#mPayStage').onchange = function () { $('#mPayText').value = composePay(); };
      $('#mPayText').value = composePay();
    } else if ($('#mPayText')) {
      $('#mPayText').value = modalState.pay;
    }

    // 金额
    $('#mTotal').textContent = '¥' + fm(c.q.total);

    // 合同标题
    if ($('#mTitle')) $('#mTitle').value = c.title;

    mask.classList.add('on');
    setTimeout(function () { $('#mLeadDays').focus(); }, 60);
  }

  function closeContractModal() {
    var m = $('#contractModal');
    if (m) m.classList.remove('on');
  }

  function confirmContractModal() {
    var days = Math.max(1, Math.round(num($('#mLeadDays').value) || 7));
    var pay = ($('#mPayText').value || '').trim();
    var title = $('#mTitle') ? ($('#mTitle').value || '').trim() : '';
    modalState.leadDays = days;
    modalState.pay = pay;
    closeContractModal();
    doExportContract({ leadDays: days, pay: pay, title: title });
  }

  function doExportContract(opt) {
    opt = opt || {};
    var c = contractData();
    var missing = [];
    if (!D.company.name) missing.push('公司名');
    if (!(c.q && c.q.customer)) missing.push('客户名');
    if (missing.length) {
      if (!confirm('以下信息还没填：' + missing.join('、') + '\n合同仍可导出，但抬头会留空。继续？')) return;
    }
    try {
      var blob = contractDOCX(opt);
      saveBlob(blob, '纸杯采购合同-' + ((c.q && c.q.customer) || '客户') + '-' + c.q.date + '.docx');
      toast('合同已导出 .docx（Word 可直接编辑）');
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  function printContract() {
    var html = contractHTML();
    var w = window.open('', '_blank');
    if (!w) { toast('请允许弹出窗口'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 400);
  }

  /* ---------------- 图片 ---------------- */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function lineCount(ctx, t, w) {
    var l = '', n = 1;
    for (var i = 0; i < t.length; i++) { var s2 = l + t[i]; if (ctx.measureText(s2).width > w && l) { n++; l = t[i]; } else l = s2; }
    return n;
  }
  function wrap(ctx, t, x, y, w, lh) {
    var l = '';
    for (var i = 0; i < t.length; i++) {
      var s2 = l + t[i];
      if (ctx.measureText(s2).width > w && l) { ctx.fillText(l, x, y); l = t[i]; y += lh; } else l = s2;
    }
    if (l) ctx.fillText(l, x, y);
  }

  function drawDoc() {
    var q = state._q || buildQuote();
    var s = q.spec, c = q.company;
    var W = 860, pad = 46, SC = 2;

    // 说明文字（与 HTML 版一致）
    var ship = shippingObj();
    var terms = [];
    terms.push('以上报价为' + (taxRate() > 0 ? '含 ' + (taxRate() * 100).toFixed(0) + '% 增值税，可开' + invoiceObj().name : '不含税，' + invoiceObj().name) + '。');
    terms.push('交期：' + q.leadText + '（自确认样品及收到定金之日起算）。');
    terms.push('付款方式：' + q.params.pay + '。');
    terms.push('报价有效期：' + q.params.valid + '，逾期需重新核价。');
    if (ship.id !== 'none') {
      terms.push('运输方式：' + ship.name + (state.freightPay === 'collect' ? '，运费到付（客户自付）。' : '，运费已计入报价。'));
    } else {
      terms.push('运输方式：运费另议。');
    }
    if (q.isTea && q.tea) {
      terms.push('茶叶：' + q.tea.leaf + '（' + q.tea.gradeName + '），每杯净含量 ' + q.tea.net + '，保质期 ' + teaData().shelfLife + '。');
      terms.push('包装：' + q.tea.packName + '。');
      if (q.tea.source === 'client') terms.push('茶叶由定作方提供，已按每杯 0.2 元在单价中扣减。');
    } else {
      terms.push('本报价按 ' + q.paper + '、' + s.size + ' 核算；如需变更克重、尺寸、材质或工艺，须重新核价。');
    }
    terms.push('实际容量及印刷效果以双方确认的实物打样为准，色差在行业标准范围内属正常。');

    var cv = document.createElement('canvas');
    cv.width = W * SC; cv.height = 1400;
    var ctx = cv.getContext('2d');
    ctx.scale(SC, SC);
    ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
    var maxW = W - pad * 2;

    // 高度预估
    var idxW = 34, unitW = 44, qtyW = 74, priceW = 76, amtW = 88;
    // 版面图：有图才多一列，放在「品名及规格」前面，只画在第一行（杯子那一行）
    var hasImg = !!state.quoteImg, imgW = hasImg ? 60 : 0;
    var im = quoteImgEl();
    var nameW = maxW - idxW - imgW - unitW - qtyW - priceW - amtW;
    var rowH = [];
    var sumRow = 0;
    q.items.forEach(function (it, i) {
      var h = 20;
      if (it.spec) h += 14;
      if (it.craft) {
        it.craft.split('<br>').forEach(function (seg) {
          h += Math.round(14 * lineCount(ctx, seg, nameW - 14));
        });
      }
      if (i === 0 && hasImg) h = Math.max(h, 62);
      var rh = Math.max(30, h);
      rowH.push(rh);
      sumRow += rh;
    });
    var termsH = 0;
    ctx.font = '400 10px "Microsoft YaHei", sans-serif';
    terms.forEach(function (t, i) {
      termsH += 15 * lineCount(ctx, (i + 1) + '. ' + t, maxW - 12);
    });

    // 逐段累加：抬头 34 + 客户信息 78 + 表头 30 + 行 + 合计/大写 52 + 说明 28 + 条款 + 签署 78 + 留白
    var H = 46 + 34 + 78 + 30 + sumRow + 52 + 28 + termsH + 78 + 16;
    cv.width = W * SC; cv.height = H * SC;
    ctx = cv.getContext('2d');
    ctx.scale(SC, SC);

    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

    var y = 46;

    /* ---- 抬头 ---- */
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '600 13px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(c.name || '', pad, y);

    ctx.fillStyle = '#666';
    ctx.font = '400 9px "Microsoft YaHei", sans-serif';
    var coL1 = c.addr || '';
    var coL2 = [c.phone ? '电话 ' + c.phone : '', c.taxNo ? '税号 ' + c.taxNo : ''].filter(Boolean).join('　');
    if (coL1) ctx.fillText(coL1, pad, y + 14);
    if (coL2) ctx.fillText(coL2, pad, y + 26);

    // 标题居中（放在中间栏，避免与左侧公司信息重叠）
    var midW = 200;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '700 25px "Microsoft YaHei", sans-serif';
    ctx.fillText('报　价　单', W / 2, y + 4);
    ctx.fillStyle = '#888';
    ctx.font = '400 7.5px "Arial", sans-serif';
    ctx.fillText('Q U O T A T I O N', W / 2, y + 18);
    ctx.textAlign = 'left';

    y += 34;
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    ctx.lineWidth = 1;

    /* ---- 客户信息 ---- */
    y += 20;
    ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText('致（客户）', pad, y);
    ctx.fillText('报价单号', pad + maxW / 2 + 10, y);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '400 11px "Microsoft YaHei", sans-serif';
    ctx.fillText(q.customer || '', pad + 62, y);
    ctx.fillText(q.no, pad + maxW / 2 + 68, y);

    y += 18;
    ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText('联系人', pad, y);
    ctx.fillText('报价日期', pad + maxW / 2 + 10, y);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '400 11px "Microsoft YaHei", sans-serif';
    ctx.fillText(q.contact || '', pad + 62, y);
    ctx.fillText(q.date, pad + maxW / 2 + 68, y);

    y += 16;
    ctx.strokeStyle = '#ccc';
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();

    /* ---- 明细表 ---- */
    y += 4;
    var x0 = pad, x1 = x0 + idxW, xi = x1 + imgW, x2 = xi + nameW, x3 = x2 + unitW, x4 = x3 + qtyW, x5 = x4 + priceW, x6 = x5 + amtW;

    // 表头
    ctx.fillStyle = '#f2f0ec';
    ctx.fillRect(x0, y, maxW, 26);
    ctx.fillStyle = '#333';
    ctx.font = '600 10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('序号', x0 + idxW / 2, y + 17);
    if (hasImg) ctx.fillText('版面图', x1 + imgW / 2, y + 17);
    ctx.textAlign = 'left'; ctx.fillText('品名及规格', xi + 8, y + 17);
    ctx.textAlign = 'center'; ctx.fillText('单位', x2 + unitW / 2, y + 17);
    ctx.textAlign = 'right'; ctx.fillText('数量', x3 + qtyW - 6, y + 17);
    ctx.fillText('单价(元)', x4 + priceW - 6, y + 17);
    ctx.fillText('金额(元)', x5 + amtW - 6, y + 17);
    y += 26;

    ctx.strokeStyle = '#ddd';
    q.items.forEach(function (it, i) {
      var h = rowH[i];
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();

      ctx.fillStyle = '#1a1a1a';
      ctx.textAlign = 'center';
      ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
      ctx.fillText(String(it.idx), x0 + idxW / 2, y + 16);

      // 版面图：缩放进 46×46 的方框里，保持原比例
      if (i === 0 && hasImg) {
        var bx = x1 + 7, by = y + (h - 46) / 2;
        ctx.strokeStyle = '#ddd';
        ctx.strokeRect(bx + 0.5, by + 0.5, 45, 45);
        if (im) {
          var k = Math.min(44 / im.naturalWidth, 44 / im.naturalHeight);
          var dw = im.naturalWidth * k, dh = im.naturalHeight * k;
          ctx.drawImage(im, bx + 23 - dw / 2, by + 23 - dh / 2, dw, dh);
        }
      }

      ctx.textAlign = 'left';
      ctx.font = '600 11px "Microsoft YaHei", sans-serif';
      ctx.fillText(it.name, xi + 8, y + 16);

      ctx.font = '400 9.5px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#777';
      var ty = y + 30;
      if (it.spec) { ctx.fillText(it.spec, xi + 8, ty); ty += 14; }
      if (it.craft) {
        it.craft.split('<br>').forEach(function (seg) {
          var n = lineCount(ctx, seg, nameW - 16);
          wrap(ctx, seg, xi + 8, ty, nameW - 16, 13);
          ty += 13 * n;
        });
      }

      ctx.fillStyle = '#1a1a1a';
      ctx.textAlign = 'center';
      ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
      ctx.fillText(it.unit, x2 + unitW / 2, y + 16);

      ctx.textAlign = 'right';
      ctx.fillText(fq(it.qty), x3 + qtyW - 6, y + 16);
      ctx.fillText(fm(it.price), x4 + priceW - 6, y + 16);
      ctx.font = '600 11px "Microsoft YaHei", sans-serif';
      ctx.fillText(fm(it.amount), x5 + amtW - 6, y + 16);
      ctx.textAlign = 'left';

      y += h;
    });

    // 合计
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    ctx.fillStyle = '#f8f6f2';
    ctx.fillRect(x0, y, maxW, 26);
    ctx.fillStyle = '#333';
    ctx.textAlign = 'right';
    ctx.font = '600 10.5px "Microsoft YaHei", sans-serif';
    ctx.fillText('合计金额（' + (taxRate() > 0 ? '含税' : '不含税') + '）', x5 - 8, y + 17);
    ctx.fillStyle = '#b4552b';
    ctx.font = '700 12px "Microsoft YaHei", sans-serif';
    ctx.fillText(fm(q.total), x5 + amtW - 6, y + 17);
    y += 26;

    // 大写
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    ctx.font = '400 10.5px "Microsoft YaHei", sans-serif';
    ctx.fillText('金额大写：' + moneyCN(q.total), x0 + 8, y + 17);
    y += 26;
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();

    /* ---- 说明 ---- */
    y += 22;
    ctx.fillStyle = '#333';
    ctx.font = '600 10.5px "Microsoft YaHei", sans-serif';
    ctx.fillText('说　明', pad, y);
    y += 6;
    ctx.font = '400 10px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#555';
    terms.forEach(function (t, i) {
      var txt = (i + 1) + '. ' + t;
      var n = lineCount(ctx, txt, maxW - 12);
      wrap(ctx, txt, pad + 2, y + 12, maxW - 12, 15);
      y += 15 * n;
    });

    /* ---- 签署 ---- */
    y += 26;
    var halfW = maxW / 2 - 20;
    ctx.fillStyle = '#666';
    ctx.font = '400 10px "Microsoft YaHei", sans-serif';
    ctx.fillText('供方（盖章）：', pad, y);
    ctx.fillText('需方（盖章）：', pad + maxW / 2 + 10, y);

    ctx.strokeStyle = '#999';
    ctx.beginPath(); ctx.moveTo(pad, y + 40); ctx.lineTo(pad + halfW, y + 40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad + maxW / 2 + 10, y + 40); ctx.lineTo(pad + maxW, y + 40); ctx.stroke();

    ctx.fillStyle = '#999';
    ctx.font = '400 9px "Microsoft YaHei", sans-serif';
    ctx.fillText(c.name || '', pad, y + 52);
    ctx.fillText('确认签字 / 日期', pad + maxW / 2 + 10, y + 52);

    return cv;
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  /* 复制报价单图片
     关键：必须在「用户点击」的同步栈里调用 execCommand / clipboard.write，
     一旦进入 toBlob 回调就已丢失手势，Chrome 会拒绝，所以这里分两条路：
       A) 同步路径：canvas.toDataURL → img → 选区 → execCommand('copy')
       B) 异步路径：ClipboardItem 写 blob（现代 Chrome + https/localhost 才可靠）
     两者都失败才下载文件。
  */
  function copyImg() {
    var cv = drawDoc();
    if (!cv) { toast('生成失败'); return; }

    // ---- A. 同步 execCommand 路径（file:// 下最可靠）----
    function syncCopy() {
      try {
        var dataUrl = cv.toDataURL('image/png');
        var box = document.createElement('div');
        box.contentEditable = 'true';
        box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
        var img = document.createElement('img');
        img.src = dataUrl;
        box.appendChild(img);
        document.body.appendChild(box);

        var range = document.createRange();
        range.selectNodeContents(box);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }

        sel.removeAllRanges();
        document.body.removeChild(box);
        return ok;
      } catch (e) { return false; }
    }

    // 先试同步路径
    var okSync = false;
    try { okSync = syncCopy(); } catch (e) { okSync = false; }
    if (okSync) {
      toast('图片已复制，可直接粘贴到微信 / QQ');
      return;
    }

    // ---- B. 异步 ClipboardItem 路径 ----
    function asyncCopy() {
      cv.toBlob(function (b) {
        if (!b) { toast('生成失败'); return; }
        if (navigator.clipboard && window.ClipboardItem) {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])
            .then(function () { toast('图片已复制，可直接粘贴到微信 / QQ'); })
            .catch(function () {
              saveBlob(b, '报价单-' + (state.quote.customer || '客户') + '.png');
              toast('浏览器不允许直接复制，已下载图片');
            });
        } else {
          saveBlob(b, '报价单-' + (state.quote.customer || '客户') + '.png');
          toast('浏览器不支持复制，已下载图片');
        }
      }, 'image/png');
    }
    asyncCopy();
  }

  /* 手动另存图片（给不支持复制的环境兜底） */
  function saveImg() {
    var cv = drawDoc();
    if (!cv) { toast('生成失败'); return; }
    cv.toBlob(function (b) {
      if (!b) { toast('生成失败'); return; }
      saveBlob(b, '报价单-' + (state.quote.customer || '客户') + '.png');
      toast('图片已下载');
    }, 'image/png');
  }
  function copyText(t, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast(msg || '已复制'); })
        .catch(function () { fallback(t, msg); });
    } else fallback(t, msg);
  }
  function fallback(t, msg) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg || '已复制'); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 识别 ---------------- */
  /* 数量解析：支持 10万 / 十万 / 1.5万 / 10000 / 一万 / 五千 / 十万零五千 */
  function parseQty(t) {
    var CN = { '零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9 };
    function cn2num(s) {
      var total = 0, section = 0, num = 0;
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (CN[ch] != null) num = CN[ch];
        else if (ch === '十') { section += (num || 1) * 10; num = 0; }
        else if (ch === '百') { section += (num || 1) * 100; num = 0; }
        else if (ch === '千') { section += (num || 1) * 1000; num = 0; }
        else if (ch === '万') { total += (section + num) * 10000; section = 0; num = 0; }
      }
      return total + section + num;
    }

    // 1) 阿拉伯数字 + 万/千/w/k
    var m = t.match(/(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)\s*(?:只|个|支|pcs)?/);
    if (m) {
      var v = parseFloat(m[1]), u = m[2];
      if (u === '万' || u === 'w' || u === 'W') return Math.round(v * 10000);
      if (u === '千' || u === 'k' || u === 'K') return Math.round(v * 1000);
    }
    // 2) 中文数字 + 万/千（如「十万」「一万五千」「五千」）
    var m3 = t.match(/([零一二两三四五六七八九十百千万]+)\s*(?:只|个|支)/);
    if (m3) {
      var n3 = cn2num(m3[1]);
      if (n3 > 0) return n3;
    }
    var m3b = t.match(/([零一二两三四五六七八九十百千]+)\s*万/);
    if (m3b) {
      var n3b = cn2num(m3b[1]) * 10000;
      if (n3b > 0) return n3b;
    }
    // 3) 纯数字 + 单位
    var m2 = t.match(/(\d{3,8})\s*(?:只|个|支|pcs)/);
    if (m2) return parseInt(m2[1], 10);
    // 4) 裸数字（3 位以上，且不是克重/ml）
    var m4 = t.match(/(?<![\d.])(\d{4,8})(?!\s*(?:克|g|ml|毫升|mm|cm))/);
    return m4 ? parseInt(m4[1], 10) : 0;
  }

  /* 工艺同义词（扩充） */
  var CRAFT_ALIAS = {
    gold:     /烫金|烫印|烫金字|金烫|hot\s*stamp/i,
    silver:   /烫银|银烫/i,
    emboss:   /压纹|液压|压花|压痕|凹凸纹|纹理/i,
    uv:       /UV|上光|局部光|光油/i,
    lam:      /覆膜|亮膜|哑膜|过膜|光膜|亚膜/i,
    relief:   /击凸|压凸|起凸|浮雕/i,
    laser:    /镭射|激光/i,
    silk:     /丝印|丝网|网印/i,
    digital:  /数码|数码印/i
  };

  /* 材质同义词（扩充） */
  var MAT_ALIAS = {
    gold:   /金箔|金色铝箔|金铝|金卡/i,
    silver: /银箔|银色铝箔|银铝|银卡/i,
    kraft:  /牛皮|牛卡|本色纸|原色纸/i,
    corr:   /瓦楞|瓦愣|坑纸/i,
    coated: /铜版|铜板/i,
    white:  /白卡|白板|白底/i,
    cupstock: /食品级|杯纸|淋膜纸|原纸/i
  };

  function recognize(raw) {
    var oz = null, ml = null;
    // 盎司：9oz / 9安士 / 9盎司 / 欧8 / 欧八 / 九盎司
    var CN = { '零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
    var m1 = raw.match(/(\d+(?:\.\d+)?)\s*(?:安士|盎司|oz)/i);
    if (m1) oz = parseFloat(m1[1]);
    var m1b = raw.match(/([一二两三四五六七八九十])\s*(?:安士|盎司)/);
    if (!oz && m1b) oz = CN[m1b[1]];
    var m1c = raw.match(/欧\s*([0-9一二两三四五六七八九十]+)/);
    if (!oz && m1c) { var e1 = m1c[1]; oz = /^\d+$/.test(e1) ? parseFloat(e1) : CN[e1]; }

    var m2 = raw.match(/(\d{2,4})\s*(?:ml|毫升)/i);
    if (m2) ml = parseFloat(m2[1]);
    // 「250cc」「0.25L」「半斤」之类
    var m2b = raw.match(/(\d+(?:\.\d+)?)\s*(?:cc)/i);
    if (!ml && m2b) ml = parseFloat(m2b[1]);
    var m2c = raw.match(/(\d+(?:\.\d+)?)\s*(?:l|升)(?![a-z])/i);
    if (!ml && m2c) ml = parseFloat(m2c[1]) * 1000;

    // 克重：内层/外层（允许「内层268外层248」紧挨着）+ 通用扫描
    var wi = raw.match(/(?:内层|内杯|里层|内纸|内壁)\s*(\d{3})\s*(?:克|g|克重)?/i);
    var wo = raw.match(/(?:外层|外杯|外套|外纸|外壁)\s*(\d{3})\s*(?:克|g|克重)?/i);
    var ws = [], re = /(\d{3})\s*(?:克|g|克重)(?![a-z])/gi, mm;
    while ((mm = re.exec(raw)) !== null) ws.push(parseInt(mm[1], 10));
    var w1 = wi ? parseInt(wi[1], 10) : (ws[0] || null);
    var w2 = wo ? parseInt(wo[1], 10) : (ws[1] || null);

    // 结构
    var struct = 'single';
    if (/中空|双层|双壁|两层|二重|夹层/.test(raw)) struct = 'double';
    else if (/瓦楞|瓦愣/.test(raw)) struct = 'corrugated';
    else if (/外贴|贴纸|裱纸/.test(raw)) struct = 'outer';

    // 工艺（同义词表）
    var crafts = [];
    Object.keys(CRAFT_ALIAS).forEach(function (id) {
      if (CRAFT_ALIAS[id].test(raw)) crafts.push(id);
    });

    // 材质
    var mats = [];
    var hasInner = /内(层|杯|纸|壁)?[^，。;；]{0,6}(金箔|银箔|牛皮|牛卡|白卡|铜版|瓦楞)/;
    var hasOuter = /外(层|杯|纸|套|壁)?[^，。;；]{0,6}(金箔|银箔|牛皮|牛卡|白卡|铜版|瓦楞)/;
    function pick(txt) {
      if (MAT_ALIAS.gold.test(txt)) return 'gold';
      if (MAT_ALIAS.silver.test(txt)) return 'silver';
      if (MAT_ALIAS.kraft.test(txt)) return 'kraft';
      if (MAT_ALIAS.corr.test(txt)) return 'corr';
      if (MAT_ALIAS.coated.test(txt)) return 'coated';
      if (MAT_ALIAS.white.test(txt)) return 'white';
      return null;
    }
    var mi = hasInner ? pick(hasInner[0]) : null;
    var mo = hasOuter ? pick(hasOuter[0]) : null;
    // mats 按层位放：[内层, 外层]；null = 这层不改
    if (mi || mo) {
      mats = [mi || null, mo || null];
    } else {
      var found = [];
      ['gold','silver','corr','white','coated','kraft'].forEach(function (k) {
        if (MAT_ALIAS[k].test(raw) && found.indexOf(k) < 0) found.push(k);
      });
      if (found.length) {
        // 没写内外层：单层杯材质就是杯身；多层杯说的通常是外面那层（金箔、瓦楞），第二个材质给内层
        mats = struct === 'single' ? [found[0]] : [found[1] || null, found[0]];
      }
    }

    // 淋膜
    var lin = null;
    if (/双淋膜|双PE|双面淋膜|内外淋膜/i.test(raw)) lin = 'double';
    else if (/单淋膜|单PE|淋膜/.test(raw)) lin = 'single';

    // 杯型匹配
    var best = null, bestSc = 0;
    allSpecs().forEach(function (s) {
      var sc = 0;
      if (oz != null) {
        if (Math.abs(s.oz - oz) < 0.01) sc += 100;
        else if (Math.abs(s.oz - oz) <= 0.6) sc += 40;
        else if (Math.abs(s.oz - oz) <= 1.2) sc += 12;
        else sc -= 30;
      }
      if (ml != null) {
        var d = Math.abs(s.ml - ml);
        if (d <= 8) sc += 65; else if (d <= 25) sc += 30; else if (d <= 60) sc += 8; else sc -= 20;
      }
      if (w1 != null) { if (s.defW === w1) sc += 30; else if (Math.abs(s.defW - w1) <= 15) sc += 15; }
      if (struct === 'double' && s.group === '中空杯') sc += 50;
      if (mats.indexOf('gold') >= 0 && s.group === '金箔铝箔') sc += 45;
      if (mats.indexOf('silver') >= 0 && s.group === '外贴/银箔') sc += 40;
      if (struct === 'outer' && s.group === '外贴/银箔') sc += 40;
      if (/奶茶|饮品类|水果茶/.test(raw) && s.group === '奶茶杯') sc += 28;
      if (/广告杯|企业杯|定制杯|宣传/.test(raw) && s.group === '广告杯') sc += 28;
      if (/纸桶|桶装/.test(raw) && s.group === '纸桶') sc += 40;
      if (/纸碗|碗装/.test(raw) && s.group === '纸碗') sc += 40;
      if (sc > bestSc) { bestSc = sc; best = s; }
    });

    return {
      oz: oz, ml: ml, w1: w1, w2: w2, qty: parseQty(raw),
      struct: struct, crafts: crafts, mats: mats, lining: lin,
      spec: best, score: bestSc
    };
  }
  /* 识别：一次识别，直接套用到报价（结果在「工艺 · 配置调整」里改） */
  function applyOcr() {
    var ta = $('#ocrText');
    var raw = ta ? ta.value : '';
    if (!raw.trim()) {
      toast('先粘贴客户需求文字');
      if (ta) ta.focus();
      return;
    }
    var r = recognize(raw);
    var tips = [];
    if (!r.spec) tips.push('杯型没认出来');
    if (!r.qty) tips.push('数量没认出来');

    var result = {
      spec: r.spec || null,
      struct: r.struct || null,
      qty: r.qty || 0,
      w1: r.w1 != null ? r.w1 : null,
      w2: r.w2 != null ? r.w2 : null,
      mats: r.mats || [],
      crafts: r.crafts || []
    };
    apply(result, true);

    // 提示 + 高亮配置面板
    var hint = $('#adjustHint');
    if (hint) {
      var msg = '✓ 已识别' + (r.spec ? '「' + r.spec.name + '」' : '') + (tips.length ? '（' + tips.join('、') + '，请在下方面板补）' : '，可在下面改');
      hint.textContent = msg;
      hint.style.color = 'var(--ac)';
      setTimeout(function () { hint.textContent = '识别后在这里改'; hint.style.color = ''; }, 4000);
    }
    var panel = $('#panelCraft');
    if (panel) {
      panel.classList.add('flash');
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { panel.classList.remove('flash'); }, 1400);
    }
    toast(tips.length ? '已套用（' + tips.join('、') + '）' : '已识别并套用到报价');
  }

  /* ---------------- 客户信息弹窗（含文字识别） ---------------- */
  var custDraft = null;
  var PROV_RE = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|台湾|香港|澳门';

  /* 从一段文字里抠客户信息（带标签优先，其次按特征猜） */
  function parseCustomer(raw) {
    var t = String(raw || '').replace(/\u3000/g, ' ').trim();
    var out = { customer: '', contact: '', taxNo: '', addr: '', province: '', freight: null };
    var grab = function (re) {
      var m = t.match(re);
      return m && m[1] ? String(m[1]).trim() : '';
    };
    // 公司：带标签优先，其次按后缀猜（猜之前先把标签词抹掉，免得被吃进公司名）
    out.customer = grab(/(?:客户名称|客户单位|公司名称|单位名称|客户|公司|单位|抬头)[：:]\s*([^\n，,。；;]{2,40})/);
    if (!out.customer) {
      // 只抹字段词；「公司/客户/单位」可能是公司名的一部分，只在带冒号时才抹
      var t2 = t.replace(/(?:客户名称|客户单位|公司名称|单位名称|客户|公司|单位|抬头)[：:]\s*|(?:联系人|收货人|对接人|收件人|客户联系人|税号|纳税人识别号|统一社会信用代码|地址|收货地址|开票地址|运费|物流费|快递费)[：:]?\s*/g, ' ');
      var cm = t2.match(new RegExp('([\\u4e00-\\u9fa5A-Za-z0-9（）()]{2,30}(?:股份有限公司|有限责任公司|有限公司|集团|公司|包装厂|纸杯厂|印刷厂|厂|商行|经营部|工作室))'));
      if (cm) out.customer = cm[1].trim();
    }
    // 联系人 = 姓名 + 电话（冒号可有可无；没标签时取电话前面紧挨着的 2~4 个汉字）
    var name = grab(/(?:联系人|收货人|对接人|收件人|客户联系人)[：:]?\s*([\u4e00-\u9fa5]{1,4})/) ||
      grab(/([\u4e00-\u9fa5]{2,4})\s*(?:先生|女士|经理)?\s*1[3-9]\d{9}/);
    var phone = grab(/(1[3-9]\d{9})/) || grab(/(0\d{2,3}[-\s]?\d{7,8})/);
    out.contact = [name, phone].filter(Boolean).join(' ');
    // 税号（18 位统一社会信用代码，排除纯数字电话）
    out.taxNo = grab(/(?:税号|纳税人识别号|统一社会信用代码)[：:]\s*([0-9A-Za-z]{15,20})/) ||
      grab(/([0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10})/);
    // 地址：带标签优先（到逗号/分号为止），其次找含省市路号的片段
    out.addr = grab(/(?:收货地址|开票地址|地址)[：:]\s*([^\n；;，,]{4,60})/);
    if (!out.addr) {
      var m = t.match(new RegExp('((?:' + PROV_RE + ')[^\\n，,。；;]{4,60}?(?:路|街|道|号|镇|村|区|县|市)[^\\n，,。；;]{0,20})'));
      if (m) out.addr = m[1].trim();
    }
    // 省份：地址开头的省优先，其次全文第一个省名
    var pm = out.addr ? out.addr.match(new RegExp('^(' + PROV_RE + ')')) : null;
    out.province = pm ? pm[1] : grab(new RegExp('(' + PROV_RE + ')'));
    // 运费
    var f = grab(/(?:运费|物流费|快递费|运费金额)[：:]?\s*(?:¥|￥)?\s*(\d+(?:\.\d+)?)/);
    if (f) out.freight = num(f);
    return out;
  }

  function fillCustInputs() {
    var d = custDraft || {};
    var set = function (sel, v) { var n = $(sel); if (n) n.value = v == null ? '' : v; };
    set('#qCustomer', d.customer || '');
    set('#qTaxNo', d.taxNo || '');
    set('#qContact', d.contact || '');
    set('#qAddr', d.addr || '');
    set('#qProvince', d.province || '');
    set('#qDate', d.date || today());
    set('#qFreight', num(d.freight) ? d.freight : '');
  }

  function openCustModal() {
    custDraft = {
      customer: state.quote.customer || '',
      taxNo: state.quote.buyerTaxNo || '',
      contact: state.quote.contact || '',
      addr: state.quote.buyerAddr || '',
      province: state.quote.province || '',
      date: state.quote.date || today(),
      freight: num(state.quote.freight) || 0
    };
    fillCustInputs();
    var tip = $('#custOcrTip');
    if (tip) { tip.textContent = '识别后回填到下面，可再改'; tip.style.color = ''; }
    var ta = $('#custOcrText');
    if (ta) ta.value = state.custOcrText || '';
    var m = $('#custModal');
    if (m) m.classList.add('on');
    setTimeout(function () { if ($('#qCustomer')) $('#qCustomer').focus(); }, 80);
  }

  function closeCustModal() {
    var m = $('#custModal');
    if (m) m.classList.remove('on');
    custDraft = null;
  }

  /* 弹窗里点「识别」：只回填到弹窗，不直接写报价单 */
  function applyCustOcr() {
    var ta = $('#custOcrText');
    var raw = ta ? ta.value : '';
    if (!String(raw).trim()) { toast('先粘贴客户信息文字'); if (ta) ta.focus(); return; }
    state.custOcrText = raw; save();
    var r = parseCustomer(raw);
    if (!custDraft) custDraft = {};
    if (r.customer) custDraft.customer = r.customer;
    if (r.contact) custDraft.contact = r.contact;
    if (r.taxNo) custDraft.taxNo = r.taxNo;
    if (r.addr) custDraft.addr = r.addr;
    if (r.province) custDraft.province = r.province;
    if (r.freight != null) custDraft.freight = r.freight;
    fillCustInputs();
    var got = [];
    if (r.customer) got.push('公司');
    if (r.contact) got.push('联系人');
    if (r.taxNo) got.push('税号');
    if (r.addr) got.push('地址');
    if (r.province) got.push('省份');
    if (r.freight != null) got.push('运费');
    var tip = $('#custOcrTip');
    if (got.length) {
      if (tip) { tip.textContent = '✓ 识别到：' + got.join(' / ') + '，核对后点「确定，保存到报价单」'; tip.style.color = 'var(--ac)'; }
      toast('已识别 ' + got.length + ' 项，确认后保存');
    } else {
      if (tip) { tip.textContent = '⚠ 没认出内容，请手动填或换个说法'; tip.style.color = '#b45309'; }
    }
  }

  /* 点「确定」：草稿写入报价单 */
  function confirmCust() {
    var d = custDraft || {};
    state.quote.customer = String(d.customer || '').trim();
    state.quote.buyerTaxNo = String(d.taxNo || '').trim();
    state.quote.contact = String(d.contact || '').trim();
    state.quote.buyerAddr = String(d.addr || '').trim();
    state.quote.province = d.province || '';
    state.quote.date = d.date || today();
    state.quote.freight = num(d.freight) || 0;
    if ($('#qFreight2')) $('#qFreight2').value = state.quote.freight || '';
    renderCustSummary(); renderShipQuote(); renderDoc(); save();
    closeCustModal();
    toast('客户信息已保存到报价单');
  }

  /* 报价单上方的客户摘要 */
  function renderCustSummary() {
    var n = $('#custSummary');
    if (!n) return;
    var q = state.quote, parts = [];
    if (q.customer) parts.push(q.customer);
    if (q.contact) parts.push(q.contact);
    if (q.buyerTaxNo) parts.push('税号 ' + q.buyerTaxNo);
    if (q.buyerAddr) parts.push(q.buyerAddr);
    if (q.province) parts.push(q.province);
    if (num(q.freight)) parts.push('运费 ¥' + fq(q.freight));
    // 只有日期不算填过客户，避免摘要里孤零零一个日期
    var hasCust = parts.length > 0;
    if (hasCust && q.date) parts.push(q.date);
    n.textContent = hasCust ? parts.join(' ｜ ') : '未填写客户信息（点右侧「客户」填写）';
    n.classList.toggle('dim', !hasCust);
  }

  /* 在同材质族里找克重最接近的纸
     只在同一开料尺寸里换克重；这个尺寸没有要的克重时退到「通用」整张纸，
     不会把别的杯型的开料纸配过来 */
  function closestPaper(paperId, gsm) {
    var cur = paperById(paperId) || {};
    var base = cur.base;
    if (!base) return null;          // 没有材质族就不要跨族乱配
    var want = num(gsm);
    var pool = (state.paperStock || []).filter(function (p) {
      if ((p.base || p.id) !== base) return false;
      return (num(p.len) === num(cur.len) && num(p.wid) === num(cur.wid)) || p.gen;
    });
    var exact = pool.filter(function (p) { return num(p.gsm) === want; })[0];
    if (exact) return exact;
    // 这个克重没有现成的纸：同一开料上自动生成一张（吨价跟材质走）
    if (want > 0 && num(cur.len) > 0 && num(cur.wid) > 0) return autoRow(base, cur.len, cur.wid, want);
    var best = null;
    pool.forEach(function (p) {
      var sameSize = num(p.len) === num(cur.len) && num(p.wid) === num(cur.wid);
      var bSame = best && num(best.len) === num(cur.len) && num(best.wid) === num(cur.wid);
      // 先比是不是同一开料尺寸（同尺寸优先），再比克重差距
      if (!best || (sameSize && !bSame) ||
          (sameSize === bSame && Math.abs(num(p.gsm) - want) < Math.abs(num(best.gsm) - want))) best = p;
    });
    return best;
  }

  function apply(r, quiet) {
    if (r.spec) state.specId = r.spec.id;
    var sp = spec();
    if (r.struct) setStructure(r.struct);
    if (r.qty) state.qty = r.qty;
    if (r.crafts && r.crafts.length) state.crafts = r.crafts.slice();

    var c2 = cupCfg(sp);
    if (r.mats && r.mats.length) {
      // 材质是族名（gold / white …）→ 换成该族里克重最接近的「通用」纸；对不上就保持原纸
      c2.layers.forEach(function (L, i) {
        var m = r.mats[i];
        if (!m) return;
        var mp = paperInBase(m, num(paperById(L.paperId).gsm) || num(sp.defW) || 268);
        if (mp) L.paperId = mp.id;
      });
    }
    if (r.w1) { var p1 = closestPaper(c2.layers[0] && c2.layers[0].paperId, r.w1); if (p1 && c2.layers[0]) c2.layers[0].paperId = p1.id; }
    if (r.w2 && c2.layers[1]) { var p2 = closestPaper(c2.layers[1].paperId, r.w2); if (p2) c2.layers[1].paperId = p2.id; }
    sync();
    if (!quiet) {
      toast('已应用');
      var hint = $('#adjustHint');
      if (hint) {
        hint.textContent = '已应用，可在下方改';
        hint.style.color = 'var(--ac)';
        setTimeout(function () { hint.textContent = '识别后在这里改'; hint.style.color = ''; }, 3500);
      }
    }
  }

  /* ---------------- 成本页 ---------------- */
  /* 数量档位（只）：加工页与工艺页共用同一套档位，所有 [data-grad-list] 容器同步渲染 */
  function renderGradients() {
    var boxes = $$('[data-grad-list]');
    if (!boxes.length) return;
    boxes.forEach(function (box) {
      box.innerHTML = '';
      state.gradients.forEach(function (g, i) {
        var item = el('div', 'grad-item');
        var inp = document.createElement('input');
        inp.type = 'number'; inp.value = g; inp.min = 1; inp.step = 100;
        inp.onchange = function () {
          state.gradients[i] = Math.max(1, Math.round(num(inp.value)));
          save(); renderGradients(); renderProcTable(); renderCraftTable(); sync();
        };
        var del = el('button', 'del', '×');
        del.title = '删除该梯度';
        del.onclick = function () {
          if (state.gradients.length <= 1) { toast('至少保留一档'); return; }
          state.gradients.splice(i, 1);
          ['make', 'print'].forEach(function (k) { if (state.proc[k]) state.proc[k].splice(i, 1); });
          allCrafts().forEach(function (c) { if (state.craftGrid[c.id]) state.craftGrid[c.id].splice(i, 1); });
          save(); renderGradients(); renderProcTable(); renderCraftTable(); sync();
        };
        item.appendChild(inp); item.appendChild(del);
        box.appendChild(item);
      });

      var add = el('button', 'add', '+ 加一档');
      add.onclick = function () {
        var last = state.gradients[state.gradients.length - 1] || 1000;
        var next = Math.round(last * 2 / 100) * 100;
        state.gradients.push(next);
        ['make', 'print'].forEach(function (k) {
          if (!state.proc[k]) state.proc[k] = [];
          state.proc[k].push(state.proc[k][state.proc[k].length - 1] || suggestProc(k, next));
        });
        allCrafts().forEach(function (c) {
          if (!state.craftGrid[c.id]) state.craftGrid[c.id] = [];
          state.craftGrid[c.id].push(state.craftGrid[c.id][state.craftGrid[c.id].length - 1] || c.prices[1]);
        });
        save(); renderGradients(); renderProcTable(); renderCraftTable(); sync();
      };
      box.appendChild(add);
    });
  }

  /* ---------------- 纸 / 纸杯（核心） ---------------- */

  /* 工艺参数：默认损耗 / 卷边 / 杯底余量 / PE */
  function renderPaperCfg() {
    var box = $('#paperGrid');
    if (!box) return;
    var cfg = paperCfg();
    var html = '';
    html += '<label><span>正常损耗 (%)</span><input type="number" step="1" data-pp="lossDefault" value="' + cfg.lossDefault + '"><span class="hint">跑机过程中的损耗；有效拼版 = 拼版 ×(1−损耗)</span></label>';
    html += '<label><span>调机损耗（张/单）</span><input type="number" min="0" step="1" data-pp="lossStart" value="' + cfg.lossStart + '"><span class="hint">每单开机调机报废几张纸，按这一单的数量摊到每只杯；0 = 不算</span></label>';
    box.innerHTML = html;
    $$('#paperGrid input').forEach(function (inp) {
      inp.onchange = function () {
        var k = inp.dataset.pp, v = num(inp.value);
        var lim = { lossDefault: [0, 90], lossStart: [0, 100000] }[k];
        if (lim) v = Math.min(lim[1], Math.max(lim[0], v));
        state.paper[k] = v;
        save(); renderPaperCfg(); renderPaperTable(); sync();
      };
    });
  }

  /* 纸页 = 两张表：材质吨价（同材质共用一个吨价）+ 开料尺寸（只管长宽）。
     克重不在这里，在「纸杯」页每一层上选 */
  function renderMaterialTable() {
    var mt = $('#matPriceTable'), st = $('#sizeTable');
    if (!mt || !st) return;
    if (!state.sizesExtra) state.sizesExtra = [];
    var stock = stockRows();

    // —— 材质吨价 ——
    var mats = {};
    stock.forEach(function (p) {
      var b = p.base || 'cupstock';
      var m = mats[b] = mats[b] || { base: b, prices: {}, n: 0 };
      m.n++;
      var k = String(num(p.price));
      m.prices[k] = (m.prices[k] || 0) + 1;
    });
    var order = Object.keys(mats);
    // 常用材质排前面，其余按出现顺序
    ['cupstock', 'white', 'gold', 'silver', 'foil', 'corr'].forEach(function (b) {
      var i = order.indexOf(b);
      if (i > 0) { order.splice(i, 1); order.unshift(b); }
    });
    var html = '<thead><tr><th class="l">材质</th><th>吨价（元/吨）</th><th class="l">备注</th></tr></thead><tbody>';
    order.forEach(function (b) {
      var m = mats[b], ks = Object.keys(m.prices).sort(function (a, c) { return m.prices[c] - m.prices[a]; });
      var mixed = ks.length > 1;
      html += '<tr data-mat="' + esc(b) + '"><td class="nm">' + esc(matLabel(b)) + '</td>' +
        '<td><input type="number" min="0" step="50" data-mprice="' + esc(b) + '" value="' + num(ks[0]) + '"' +
        (mixed ? ' title="这个材质现在有多种吨价，填一个数会把它们全部统一"' : '') + '></td>' +
        '<td class="dim">' + (mixed
          ? '<span style="color:#c0392b">⚠ 这个材质现在有 ' + ks.length + ' 种吨价（' +
            ks.map(function (k) { return k + ' × ' + m.prices[k] + ' 张'; }).join('、') + '）。填左边的数字 = 全部统一成这个价</span>'
          : '该材质的 ' + m.n + ' 张纸都用这个吨价') + '</td></tr>';
    });
    mt.innerHTML = html + '</tbody>';
    $$('#matPriceTable input[data-mprice]').forEach(function (inp) {
      inp.onchange = function () {
        var v = Math.max(0, num(inp.value));
        setMatPrice(inp.dataset.mprice, v);
        save(); renderMaterialTable(); renderPaperTable(); sync();
        toast(matLabel(inp.dataset.mprice) + ' 的吨价已全部改成 ' + v);
      };
    });

    // —— 开料尺寸 ——
    var sizes = {};
    stock.forEach(function (p) {
      var k = sizeKey(p.len, p.wid);
      var s = sizes[k] = sizes[k] || { len: num(p.len), wid: num(p.wid), bases: {}, descs: {}, n: 0 };
      s.n++; s.bases[p.base || 'cupstock'] = 1;
      if (p.desc) s.descs[p.desc] = 1;
    });
    state.sizesExtra.forEach(function (x) {
      var k = sizeKey(x.len, x.wid);
      if (!sizes[k]) sizes[k] = { len: num(x.len), wid: num(x.wid), bases: {}, descs: {}, n: 0, extra: true };
    });
    var keys = Object.keys(sizes).sort(function (a, c) { return sizes[c].n - sizes[a].n; });
    html = '<thead><tr><th>长 (mm)</th><th>宽 (mm)</th><th class="l">有哪些材质</th><th class="l">适用杯型（来自原来的纸名说明）</th><th style="width:36px"></th></tr></thead><tbody>';
    keys.forEach(function (k) {
      var s = sizes[k];
      var matsTxt = Object.keys(s.bases).map(matLabel).join('、');
      var descTxt = Object.keys(s.descs).join('；');
      html += '<tr data-skey="' + esc(k) + '">' +
        '<td><input type="number" min="50" max="5000" step="1" data-slen="' + esc(k) + '" value="' + s.len + '"' + (s.extra ? '' : '') + '></td>' +
        '<td><input type="number" min="50" max="5000" step="1" data-swid="' + esc(k) + '" value="' + s.wid + '"></td>' +
        '<td class="dim">' + esc(matsTxt || '—') + (s.extra ? ' <span class="mini">新加，还没被杯型用上</span>' : '') + '</td>' +
        '<td class="dim">' + esc(descTxt || '—') + '</td>' +
        '<td class="ops-cell"><button class="rop rop-del" data-size-del="' + esc(k) + '" title="删除这种开料">×</button></td>' +
        '</tr>';
    });
    html += '</tbody><tfoot><tr><td colspan="5" class="ops-cell"><button class="link" id="btnAddSize">＋ 添加开料</button>' +
      '<span class="dim" style="margin-left:8px">改长宽 = 这种开料的纸全部跟着改；在「纸杯」页选了一个还没组合过的「材质 + 克重 + 开料」，纸会自动生成，不用来这里加</span></td></tr></tfoot>';
    st.innerHTML = html;

    function sizeOf(k) {
      var parts = String(k).split('x');
      return { len: num(parts[0]), wid: num(parts[1]) };
    }
    $$('#sizeTable input[data-slen], #sizeTable input[data-swid]').forEach(function (inp) {
      inp.onchange = function () {
        var k = inp.dataset.slen || inp.dataset.swid;
        var old = sizeOf(k);
        var row = inp.closest('tr');
        var nl = Math.min(5000, Math.max(50, num(row.querySelector('[data-slen]').value) || old.len));
        var nw = Math.min(5000, Math.max(50, num(row.querySelector('[data-swid]').value) || old.wid));
        if (nl === old.len && nw === old.wid) return;
        stockRows().forEach(function (p) {
          if (num(p.len) === old.len && num(p.wid) === old.wid) {
            p.len = nl; p.wid = nw;
            p.name = String(p.name || '').replace(/\d+\s*[×x]\s*\d+/, nl + '×' + nw);
          }
        });
        state.sizesExtra = state.sizesExtra.filter(function (x) { return !(num(x.len) === old.len && num(x.wid) === old.wid); });
        state.sizesExtra.push({ len: nl, wid: nw });
        dedupeStock();
        save(); renderMaterialTable(); renderPaperTable(); sync();
        toast('开料 ' + old.len + '×' + old.wid + ' 已改成 ' + nl + '×' + nw);
      };
    });
    $$('#sizeTable button[data-size-del]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.sizeDel, s = sizeOf(k);
        var rows = stockRows().filter(function (p) { return num(p.len) === s.len && num(p.wid) === s.wid; });
        if (rows.length >= stockRows().length) { toast('至少保留一种开料'); return; }
        var used = [];
        Object.keys(state.cupPaper || {}).forEach(function (sid) {
          (state.cupPaper[sid].layers || []).forEach(function (L, i) {
            if (rows.some(function (p) { return p.id === L.paperId; })) used.push((specById(sid) || {}).name + ' 第' + (i + 1) + '层');
          });
        });
        if (used.length && !confirm('开料 ' + s.len + '×' + s.wid + ' 正被 ' + used.length + ' 个杯型层用着（' + used.slice(0, 4).join('、') + (used.length > 4 ? '…' : '') + '）。\n删除后它们会改用同材质的其他纸，拼版按新开料重算。继续？')) return;
        var ids = {}; rows.forEach(function (p) { ids[p.id] = 1; });
        state.paperStock = stockRows().filter(function (p) { return !ids[p.id]; });
        state.sizesExtra = state.sizesExtra.filter(function (x) { return !(num(x.len) === s.len && num(x.wid) === s.wid); });
        Object.keys(state.cupPaper || {}).forEach(function (sid) {
          var c = state.cupPaper[sid];
          (c.layers || []).concat(c.stash || []).forEach(function (L) {
            if (!L || !ids[L.paperId]) return;
            var old = rows.filter(function (p) { return p.id === L.paperId; })[0];
            var same = stockRows().filter(function (p) { return (p.base || '') === (old.base || ''); })[0] || stockRows()[0];
            L.paperId = same.id; L.pack = 0;
          });
        });
        save(); renderMaterialTable(); renderPaperTable(); sync();
      };
    });
    var add = $('#btnAddSize');
    if (add) add.onclick = function () {
      // 默认给一个还不存在的尺寸，免得加了却和现有开料并成一行、看着像没反应
      var len = 787, wid = 1092;
      while (stockRows().some(function (p) { return num(p.len) === len && num(p.wid) === wid; })) len += 10;
      state.sizesExtra.push({ len: len, wid: wid });
      save(); renderMaterialTable();
      var tr = $('#sizeTable tbody tr[data-skey="' + sizeKey(len, wid) + '"]');
      if (tr) { var first = tr.querySelector('[data-slen]'); first.focus(); first.select(); }
    };
  }
  /* 纸杯表：每个杯型选纸 / 选单双层 / 填拼版与损耗，自动算单杯重量 */
  function renderPaperTable() {
    var tbl = $('#paperTable');
    if (!tbl) return;
    var cfg = paperCfg();
    var specs = allSpecs();
    var stock = state.paperStock || [];

    var head = '<thead><tr>' +
      '<th class="l">杯型</th>' +
      '<th class="cap-th">容量</th>' +
      '<th class="dim-th" title="杯口外径（mm）。改了尺寸，拼版数、克重、纸价都跟着重算">上口<br><i>mm</i></th>' +
      '<th class="dim-th" title="杯底外径（mm）">下口<br><i>mm</i></th>' +
      '<th class="dim-th" title="杯高（mm）">杯高<br><i>mm</i></th>' +
      '<th>结构</th>' +
      '<th>层</th>' +
      '<th title="材质决定吨价，克重决定单张重量，开料尺寸决定拼版数；组合没有现成的纸会自动生成">材质 · 克重 · 开料</th>' +
      '<th>拼版数</th>' +
      '<th>损耗 %</th>' +
      '<th>杯身重</th>' +
      '<th>杯身成本</th>' +
      '<th>底片重</th>' +
      '<th>底片成本</th>' +
      '<th>层重</th>' +
      '<th style="width:104px"></th></tr></thead>';

    var rows = [];
    specs.forEach(function (s, si) {
      var cc = cupCfg(s);
      var st = structOf(cc.structure);
      var calc = cupPaperCalc(s);
      var cur = s.id === state.specId ? ' cur' : '';
      // 分组行：杯型 + 结构 + 汇总
      var optHtml = (D.structures || []).map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === cc.structure ? ' selected' : '') + '>' + x.name + '</option>';
      }).join('');
      rows.push('<tr class="grp' + cur + '" data-rid="' + s.id + '">' +
        '<td class="nm">' + esc(s.name) + '</td>' +
        '<td class="cap-cell">' + (s.oz || '—') + 'oz / ' + (s.ml || '—') + 'ml</td>' +
        ['top', 'bottom', 'height'].map(function (k) {
          return '<td class="dim-cell"><input type="number" min="1" step="1" data-dim="' + k + '" data-sid="' + s.id + '" value="' +
            (num(s[k]) || '') + '"' + (s.custom ? '' : ' title="内置杯型，改了尺寸会一直记着"') + '></td>';
        }).join('') +
        '<td><select data-struct="' + s.id + '">' + optHtml + '</select></td>' +
        '<td class="dim" colspan="9">单杯 <b>' + calc.gram.toFixed(1) + ' g</b>　｜　纸价 <b>¥' + fp(calc.cost) + '</b>/只' +
        (num(cfg.lossStart) > 0 ? '<span class="mini note">含调机损耗 ' + num(cfg.lossStart) + ' 张/单，按当前订单 ' + num(state.qty) + ' 只摊</span>' : '') +
        (calc.noFit ? '　<span style="color:#c0392b;font-weight:600">⚠ 拼版放不下</span>' : '') + '</td>' +
        '<td class="ops-cell">' + rowOps('spec', s.id, si, specs.length) + '</td>' +
        '</tr>');
      // 层行
      calc.layers.forEach(function (L) {
        var raw = cc.layers[L.i] || {};
        var lp = L.paper || {};
        var lpBase = lp.base || 'cupstock';
        var matOpts = matOptions().map(function (m) {
          return '<option value="' + esc(m.base) + '"' + (m.base === lpBase ? ' selected' : '') + '>' + esc(m.name) + '</option>';
        }).join('');
        var sizeSeen = {}, sizeOpts = '';
        stock.forEach(function (p) {
          var k = sizeKey(p.len, p.wid);
          if (sizeSeen[k]) return;
          sizeSeen[k] = 1;
          sizeOpts += '<option value="' + k + '"' + (k === sizeKey(lp.len, lp.wid) ? ' selected' : '') + '>' + num(p.len) + '×' + num(p.wid) + '</option>';
        });
        (state.sizesExtra || []).forEach(function (x) {
          var k = sizeKey(x.len, x.wid);
          if (sizeSeen[k]) return;
          sizeSeen[k] = 1;
          sizeOpts += '<option value="' + k + '"' + (k === sizeKey(lp.len, lp.wid) ? ' selected' : '') + '>' + num(x.len) + '×' + num(x.wid) + '（新）</option>';
        });
        var lpAttr = ' data-lpick="' + s.id + '" data-li="' + L.i + '"';
        var autoPackN = autoPack(s, L.paper, cfg, L.i);
        var man = num(raw.pack) > 0;
        var packTip = man ? '手填值，点右边的「手填」恢复自动' : '留空 = 自动算。填了数字 = 按你填的算';
        rows.push('<tr class="layerrow">' +
          '<td class="dim" colspan="6"></td>' +
          '<td class="dim">' + (L.i === 0 ? '内杯' : '外杯') + '</td>' +
          '<td class="lp-cell"><select data-lmat="1"' + lpAttr + ' title="材质：决定吨价">' + matOpts + '</select>' +
          '<input type="number" min="100" max="600" step="1" data-lgsm="1"' + lpAttr + ' value="' + (num(lp.gsm) || '') + '" title="克重 g/m²：决定单张重量" style="width:58px"><span class="mini">g</span>' +
          '<select data-lsize="1"' + lpAttr + ' title="开料尺寸：决定拼版数">' + sizeOpts + '</select></td>' +
          '<td class="pack-cell"><div class="pack-wrap"><input type="number" min="0" step="1" data-pack="' + s.id + '" data-li="' + L.i + '" value="' +
          (man ? num(raw.pack) : '') + '" placeholder="—" title="' + packTip + '">' +
          '<b class="auto-tag' + (man ? ' man' : '') + '" data-packtag="' + s.id + '" data-li="' + L.i + '" title="' + packTip + '">' +
          (man ? '手填' : (autoPackN > 0 ? '自动 <u>' + autoPackN + '</u>' : '放不下')) + '</b></div></td>' +
          '<td class="loss-cell"><input type="number" min="0" max="90" step="1" data-loss="' + s.id + '" data-li="' + L.i + '" value="' +
          (num(raw.loss) || 0) + '">' +
          (L.startLoss > 0 ? '<i class="mini">' + lossStartTxt(L).replace(' + ', '') + '</i>' : '') + '</td>' +
          '<td class="dim">' + L.bodyGram.toFixed(1) + ' g</td>' +
          '<td class="dim">¥' + fp(L.bodyCost + L.startCost) + '</td>' +
          '<td class="dim">' + (L.bottomGram != null ? L.bottomGram.toFixed(1) + ' g' : '—') + '</td>' +
          '<td class="dim">' + (L.bottomCost != null ? '¥' + fp(L.bottomCost) : '—') + '</td>' +
          '<td class="dim">' + ((L.bodyGram + (L.bottomGram || 0)).toFixed(1)) + ' g</td>' +
          '<td class="ops-cell"></td>' +
          '</tr>');
      });
    });

    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';

    // 结构下拉
    $$('#paperTable select[data-struct]').forEach(function (sel) {
      sel.onchange = function () {
        var s = specById(sel.dataset.struct);
        if (!s) return;
        var c = cupCfg(s);
        c.structure = sel.value;
        var st = structOf(c.structure);
        var n = st.layers || 1;
        var cfg = paperCfg();
        if (!c.stash) c.stash = [];
        while (c.layers.length < n) {
          // 切回双层时沿用之前那层的拼版/损耗
          var src = c.stash[c.layers.length] || {};
          c.layers.push({
            paperId: src.paperId || defaultPaperId(s, c.layers.length, c.structure),
            pack: src.pack != null ? src.pack : 0,
            loss: src.loss != null ? src.loss : cfg.lossDefault
          });
        }
        if (c.layers.length > n) {
          for (var k = n; k < c.layers.length; k++) c.stash[k] = c.layers[k];
          c.layers.length = n;
        }
        save(); renderPaperTable(); sync();
      };
    });
    // 选纸 = 材质 + 克重 + 开料，三个控件联动；组合没有现成的纸就自动生成一张
    $$('#paperTable [data-lpick]').forEach(function (ctl) {
      ctl.onchange = function () {
        var s = specById(ctl.dataset.lpick);
        if (!s) return;
        var c = cupCfg(s);
        var L = c.layers[num(ctl.dataset.li)] || c.layers[0];
        if (!L) return;
        var cell = ctl.closest('.lp-cell');
        var base = cell.querySelector('[data-lmat]').value;
        var gsmInp = cell.querySelector('[data-lgsm]');
        var gsm = Math.min(600, Math.max(100, Math.round(num(gsmInp.value)) || num(paperById(L.paperId).gsm) || 268));
        var sk = cell.querySelector('[data-lsize]').value.split('x');
        var old = paperById(L.paperId);
        var sameSize = num(old.len) === num(sk[0]) && num(old.wid) === num(sk[1]);
        var r = autoRow(base, num(sk[0]), num(sk[1]), gsm);
        if (sameSize) L.paperId = r.id;        // 换材质 / 克重不动拼版
        else setLayerPaper(c, L, r.id);        // 换开料才按新开料重算拼版（手填值记在备忘里）
        save(); renderPaperTable(); sync();
      };
    });
    // 拼版数
    $$('#paperTable input[data-pack]').forEach(function (inp) {
      inp.onchange = function () {
        var s = specById(inp.dataset.pack);
        if (!s) return;
        var c = cupCfg(s);
        var L = c.layers[num(inp.dataset.li)] || c.layers[0];
        if (!L) return;
        var v = inp.value === '' ? 0 : Math.max(0, Math.round(num(inp.value)));
        L.pack = v;
        save(); renderPaperTable(); sync();
      };
    });
    // 「手填」标记点一下 → 清掉手填值，恢复自动
    $$('#paperTable [data-packtag].man').forEach(function (tag) {
      tag.onclick = function () {
        var c = cupCfg(specById(tag.dataset.packtag));
        var L = c && (c.layers[num(tag.dataset.li)] || c.layers[0]);
        if (!L) return;
        L.pack = 0;
        save(); renderPaperTable(); sync();
      };
    });
    // 损耗
    $$('#paperTable input[data-loss]').forEach(function (inp) {
      inp.onchange = function () {
        var s = specById(inp.dataset.loss);
        if (!s) return;
        var c = cupCfg(s);
        var L = c.layers[num(inp.dataset.li)] || c.layers[0];
        if (!L) return;
        L.loss = Math.min(90, Math.max(0, num(inp.value)));
        save(); renderPaperTable(); sync();
      };
    });
    makeSortable('#paperTable', 'spec', function () { renderPaperTable(); renderSpecSelect(); sync(); });
    // 尺寸：改了就重算拼版 / 克重 / 纸价
    $$('#paperTable input[data-dim]').forEach(function (inp) {
      inp.onchange = function () {
        var s = specById(inp.dataset.sid);
        if (!s) return;
        var k = inp.dataset.dim, v = Math.round(num(inp.value));
        if (!(v > 0)) { renderPaperTable(); return; }          // 清空或填了 0 → 不改，还原
        var next = { top: num(s.top), bottom: num(s.bottom), height: num(s.height) };
        next[k] = v;
        if (next.bottom >= next.top) { toast('下口要比上口小'); renderPaperTable(); return; }
        if (next[k] === num(s[k])) { renderPaperTable(); return; }
        s[k] = v;
        if (!s.custom) {
          state.specDims = state.specDims || {};
          state.specDims[s.id] = { top: s.top, bottom: s.bottom, height: s.height };
        }
        // 杯子大小变了，原来手填的拼版数不再对应 → 这一层的拼版全部恢复自动
        var c = cupCfg(s), cleared = false;
        c.layers.forEach(function (L) { if (num(L.pack) > 0) { L.pack = 0; cleared = true; } });
        c.packMemo = {};
        save(); renderPaperTable(); renderSpecSelect(); sync();
        if (cleared) toast('尺寸已改，这个杯型的拼版数恢复自动');
      };
    });
    // 行操作：上下移动（全部杯型）、删除（自定义 = 直接删；内置 = 隐藏，可恢复）
    $$('#paperTable .rop[data-op]').forEach(function (b) {
      b.onclick = function () {
        var op = b.dataset.op, id = b.dataset.id;
        var ids = allSpecs().map(function (x) { return x.id; });
        var i = ids.indexOf(id);
        if (i < 0) return;
        if (op === 'up' && i > 0) { ids.splice(i, 1); ids.splice(i - 1, 0, id); state.specOrder = ids; }
        else if (op === 'down' && i < ids.length - 1) { ids.splice(i, 1); ids.splice(i + 1, 0, id); state.specOrder = ids; }
        else if (op === 'del') {
          var name = (specById(id) || {}).name || '';
          if (String(id).indexOf('custom-') === 0) {
            if (!confirm('删除「' + name + '」？删除后不能恢复')) return;
            state.customSpecs = state.customSpecs.filter(function (x) { return x.id !== id; });
          } else {
            if (!confirm('删除「' + name + '」？内置杯型删除后可以点右上角「恢复」找回来')) return;
            state.specHidden = (state.specHidden || []).concat(id);
          }
          delete state.cupPaper[id];
        } else return;
        if (state.specId === id) state.specId = (allSpecs()[0] || {}).id;
        save(); renderPaperTable(); renderSpecSelect(); sync();
      };
    });
    // 恢复被删除的内置杯型
    var rs = $('#specRestore');
    if (rs) {
      var hidden = (state.specHidden || []).filter(function (id) { return (D.specs || []).some(function (x) { return x.id === id; }); });
      rs.textContent = hidden.length ? '恢复已删除的内置杯型（' + hidden.length + '）' : '';
      rs.style.display = hidden.length ? '' : 'none';
      rs.onclick = function () {
        state.specHidden = [];
        save(); renderPaperTable(); renderSpecSelect(); sync();
        toast('已恢复 ' + hidden.length + ' 个内置杯型');
      };
    }
  }

  /* 加工费梯度（成型 / 印刷） */
  function renderProcTable() {
    var tbl = $('#procTable');
    if (!tbl) return;
    var items = [
      { k: 'make', name: '成型加工', desc: '模切 / 卷边 / 粘合 / 成型，含开机摊销' },
      { k: 'print', name: '印刷开机', desc: '油墨 + 开机损耗摊销（版费另计，摊入单价）' }
    ];
    var head = '<thead><tr><th class="l">加工项</th>' +
      state.gradients.map(function (g) { return '<th>' + fq(g) + ' 只</th>'; }).join('') +
      '<th>当前</th><th class="l">说明</th></tr></thead>';
    var rows = items.map(function (it) {
      var arr = (state.proc || {})[it.k] || [];
      return '<tr><td class="nm">' + it.name + '</td>' +
        state.gradients.map(function (g, i) {
          return '<td><input type="number" min="0" step="0.0005" data-pr="' + it.k + '" data-i="' + i + '" value="' + (arr[i] != null ? arr[i] : '') + '"></td>';
        }).join('') +
        '<td class="cur-cell">¥' + fp(procCost(it.k, state.qty)) + '</td>' +
        '<td class="ds">' + esc(it.desc) + '</td></tr>';
    });
    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
    $$('#procTable input').forEach(function (inp) {
      inp.onchange = function () {
        var k = inp.dataset.pr, i = +inp.dataset.i;
        if (!state.proc[k]) state.proc[k] = [];
        state.proc[k][i] = inp.value === '' ? null : num(inp.value);
        save(); renderProcTable(); sync();
      };
    });
  }

  /* 「结构附加工费」表已移除：单层/双层由「纸杯」页选纸决定，工费随纸自动计 */

  /* 添加自定义杯型（弹窗式） */
  function openSpecModal() {
    var m = $('#specModal');
    if (!m) return;
    var gs = $('#spGroup');
    if (gs.options.length === 0) {
      gs.innerHTML = D.groups.concat(['自定义']).map(function (g) {
        return '<option value="' + g + '">' + g + '</option>';
      }).join('');
      gs.value = '自定义';
    }
    $('#spName').value = '';
    m.classList.add('on');
    setTimeout(function () { $('#spName').focus(); }, 60);
  }

  function confirmAddSpec() {
    var name = ($('#spName').value || '').trim();
    if (!name) { toast('请填杯型名称'); $('#spName').focus(); return; }
    var id = 'custom-' + Date.now();
    var spec = {
      id: id,
      group: $('#spGroup').value || '自定义',
      name: name,
      oz: num($('#spOz').value) || 9,
      ml: num($('#spMl').value) || 250,
      top: num($('#spTop').value) || 75,
      bottom: num($('#spBottom').value) || 53,
      height: num($('#spHeight').value) || 88,
      defW: num($('#spW').value) || 268,
      box: '', ref: {}, note: '', custom: true
    };
    state.customSpecs.push(spec);
    $('#specModal').classList.remove('on');
    save(); renderPaperTable(); renderSpecSelect(); sync();
    toast('已添加「' + name + '」');
  }
  function renderWeightTable() {
    var tbl = $('#wtTable');
    if (!tbl) return;

    // 右上角提示：自动克重已联动纸杯表，只有箱规需要手填
    var hint = $('#wtHint');
    if (hint) {
      var noFit = allSpecs().filter(function (s) { return cupPaperCalc(s).noFit; }).length;
      hint.textContent = noFit
        ? '自动克重按「纸杯」表算（' + noFit + ' 个杯型拼版放不下，见红字）· 箱规需手填'
        : '自动克重按「纸杯」表实时算 · 实测克重可覆盖 · 箱规需手填';
    }

    var head = '<thead><tr>' +
      '<th class="l">杯型</th>' +
      '<th>自动克重 (g)</th>' +
      '<th>实测克重 (g)</th>' +
      '<th class="l">箱规（可多行）</th>' +
      '<th>箱体 m³</th>' +
      '<th>总重</th>' +
      '</tr></thead>';

    var rows = allSpecs().map(function (s) {
      var calc = cupPaperCalc(s);
      var auto = autoGram(s);
      var manual = gramOf(s);
      var g1 = manual > 0 ? manual : auto;
      var hasW = g1 > 0;
      var boxes = boxesOf(s);
      var totalKg = hasW ? g1 * state.qty / 1000 : 0;
      // 选与订单最接近的箱规来算体积展示
      var best = boxes.filter(function (b) { return b.per > 0 && state.qty >= b.per; }).pop() || boxes[0];
      var vol = best && best.per > 0 ? (best.l * best.w * best.h / 1e6) : 0;
      // 净重不受拼版影响照常显示；放不下（影响成本）时加红标
      var autoCell = (auto > 0 ? auto.toFixed(1) + ' g' : '—') +
        (calc.noFit ? ' <span style="color:#c0392b;font-weight:600" title="该杯型纸张拼版放不下，纸成本未计入，请到「纸杯」表填拼版">⚠</span>' : '');

      var boxHtml = boxes.map(function (b, bi) {
        return '<div class="bx-row" data-sp="' + s.id + '" data-bi="' + bi + '">' +
          '<input type="number" min="0" step="1" class="mini-inp" data-bxp="' + s.id + '" data-bi="' + bi + '" value="' + (b.per || '') + '" placeholder="每箱只数">' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-bxl="' + s.id + '" data-bi="' + bi + '" value="' + (b.l || '') + '" placeholder="长">' +
          '<span class="bx-x">×</span>' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-bxw="' + s.id + '" data-bi="' + bi + '" value="' + (b.w || '') + '" placeholder="宽">' +
          '<span class="bx-x">×</span>' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-bxh="' + s.id + '" data-bi="' + bi + '" value="' + (b.h || '') + '" placeholder="高">' +
          (boxes.length > 1 ? '<button class="zdel bx-del" data-bxdel="' + s.id + '" data-bi="' + bi + '">删</button>' : '') +
          '</div>';
      }).join('');

      return '<tr' + (s.id === state.specId ? ' class="cur"' : '') + '>' +
        '<td class="nm">' + esc(s.name) + '</td>' +
        '<td class="dim">' + autoCell + '</td>' +
        '<td><div class="inp-wrap">' +
          '<input type="number" min="0" step="0.1" class="mini-inp" data-wtg="' + s.id + '" placeholder="' + (auto > 0 ? auto.toFixed(1) : '填写') + '" value="' + (manual > 0 ? manual : '') + '">' +
        '</div></td>' +
        '<td class="box-multi">' + boxHtml +
          '<button class="bx-add" data-bxadd="' + s.id + '">＋ 加箱规</button>' +
        '</td>' +
        '<td class="vol-cell">' + (vol ? vol.toFixed(4) : '—') + '</td>' +
        '<td class="cur-cell">' + (hasW ? fmtKg(totalKg) : '—') + '</td>' +
        '</tr>';
    });

    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';

    function saveBox(id) {
      var rows2 = [];
      $$('#wtTable .bx-row[data-sp="' + id + '"]').forEach(function (rowEl) {
        var get = function (attr) {
          var n = rowEl.querySelector('[data-' + attr + '="' + id + '"]');
          return n ? num(n.value) : 0;
        };
        rows2.push({ per: get('bxp'), l: get('bxl'), w: get('bxw'), h: get('bxh') });
      });
      state.boxCfg[id] = rows2.filter(function (b) { return b.per > 0; });
      save(); sync();
    }

    $$('#wtTable input[data-wtg]').forEach(function (inp) {
      inp.onchange = function () {
        var v = num(inp.value);
        if (v > 0) state.wt[inp.dataset.wtg] = v;
        else delete state.wt[inp.dataset.wtg];
        save(); renderWeightTable(); sync();
      };
    });
    $$('#wtTable input[data-bxp], #wtTable input[data-bxl], #wtTable input[data-bxw], #wtTable input[data-bxh]').forEach(function (inp) {
      inp.onchange = function () { saveBox(inp.dataset.bxp || inp.dataset.bxl || inp.dataset.bxw || inp.dataset.bxh); };
    });
    $$('#wtTable .bx-del').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.bxdel;
        state.boxCfg[id].splice(+b.dataset.bi, 1);
        save(); renderWeightTable(); sync();
      };
    });
    $$('#wtTable .bx-add').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.bxadd;
        var sp = specById(id) || spec();
        var arr = (state.boxCfg[id] && state.boxCfg[id].length) ? state.boxCfg[id].slice() : boxesOf(sp).slice();
        arr.push({ per: 0, l: 0, w: 0, h: 0 });
        state.boxCfg[id] = arr;
        save(); renderWeightTable(); sync();
      };
    });
  }
  /* 重量格式化：kg / 吨 */
  function fmtKg(kg) {
    if (kg >= 1000) return (kg / 1000).toFixed(2) + ' 吨';
    if (kg >= 100) return kg.toFixed(0) + ' kg';
    return kg.toFixed(1) + ' kg';
  }

  /* 发货时间设置页 */
  function renderLeadTable() {
    var tbl = $('#leadTable');
    if (!tbl) return;
    if ($('#leadHintCup')) $('#leadHintCup').style.display = state.mode === 'tea' ? 'none' : '';
    if ($('#leadHintTea')) $('#leadHintTea').style.display = state.mode === 'tea' ? '' : 'none';

    /* 茶叶杯：按尺寸分类设天数 */
    if (state.mode === 'tea') return renderTeaLeadTable(tbl);

    var L = state.lead;
    var html = '<thead><tr><th class="l">项目</th><th>加天数</th><th class="l">说明</th></tr></thead><tbody>';

    html += '<tr class="grp"><td colspan="3">基准</td></tr>';
    html += '<tr><td class="nm">基准交期</td><td><input type="number" min="0" step="1" data-l="base" value="' + L.base + '"></td><td class="ds">所有杯型的起点天数，默认 7 天</td></tr>';
    html += '<tr><td class="nm">加急最短天数</td><td><input type="number" min="0" step="1" data-l="urgentDays" value="' + (L.urgentDays || 3) + '"></td><td class="ds">勾选「加急」后直接按这个天数报</td></tr>';

    html += '<tr class="grp"><td colspan="3">按杯型分组加天数</td></tr>';
    D.groups.forEach(function (g) {
      var v = (L.byGroup || {})[g] != null ? L.byGroup[g] : 0;
      html += '<tr><td class="nm">' + esc(g) + '</td><td><input type="number" min="0" step="1" data-lg="' + esc(g) + '" value="' + v + '"></td><td class="ds">该分组所有杯型统一加的天数</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">按结构加天数</td></tr>';
    D.structures.forEach(function (s) {
      var v = (L.byStructure || {})[s.id] != null ? L.byStructure[s.id] : 0;
      html += '<tr><td class="nm">' + esc(s.name) + '</td><td><input type="number" min="0" step="1" data-ls="' + s.id + '" value="' + v + '"></td><td class="ds">' + esc(s.desc) + '</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">按工艺加天数（多选时累加）</td></tr>';
    D.crafts.forEach(function (c) {
      var v = (L.byCraft || {})[c.id] != null ? L.byCraft[c.id] : 0;
      html += '<tr><td class="nm">' + esc(c.name) + '</td><td><input type="number" min="0" step="1" data-lc="' + c.id + '" value="' + v + '"></td><td class="ds">' + esc(c.desc) + '</td></tr>';
    });

    html += '</tbody>';
    tbl.innerHTML = html;

    $$('#leadTable input').forEach(function (inp) {
      inp.onchange = function () {
        var v = Math.max(0, Math.round(num(inp.value)));
        if (inp.dataset.l) state.lead[inp.dataset.l] = v;
        if (inp.dataset.lg) state.lead.byGroup[inp.dataset.lg] = v;
        if (inp.dataset.ls) state.lead.byStructure[inp.dataset.ls] = v;
        if (inp.dataset.lc) state.lead.byCraft[inp.dataset.lc] = v;
        save(); sync();
      };
    });
  }

  /* 茶叶杯成本表 */
  function renderTeaCost() {
    var t = D.tea;
    var tb = $('#teaCostTable');
    if (!tb) return;
    var head = '<thead><tr><th class="l">数量（杯）</th>' +
      (t.tiers || []).map(function (q) { return '<th>' + fq(q) + '</th>'; }).join('') +
      '</tr></thead>';
    var r1 = '<tr><td class="nm">普通茶 总价（元）</td>' + t.tiers.map(function (q, i) {
      return '<td><input type="number" min="0" step="1" data-ttp="normal" data-i="' + i + '" value="' + (t.priceNormal[i] != null ? t.priceNormal[i] : '') + '"></td>';
    }).join('') + '</tr>';
    var r2 = '<tr><td class="nm">一级茶 总价（元）</td>' + t.tiers.map(function (q, i) {
      return '<td><input type="number" min="0" step="1" data-ttp="premium" data-i="' + i + '" value="' + (t.pricePremium[i] != null ? t.pricePremium[i] : '') + '"></td>';
    }).join('') + '</tr>';
    var r3 = '<tr><td class="nm">单价 普通 / 一级</td>' + t.tiers.map(function (q, i) {
      var a = num(t.priceNormal[i]) / q, b = num(t.pricePremium[i]) / q;
      return '<td class="dim">' + fp(a) + ' / ' + fp(b) + '</td>';
    }).join('') + '</tr>';
    tb.innerHTML = head + '<tbody>' + r1 + r2 + r3 + '</tbody>';

    $$('#teaCostTable input').forEach(function (inp) {
      inp.onchange = function () {
        var k = inp.dataset.ttp === 'premium' ? 'pricePremium' : 'priceNormal';
        D.tea[k][+inp.dataset.i] = num(inp.value);
        save(); renderTeaCost(); renderTea(); renderDoc();
      };
    });

    // 包装加价
    var pt = $('#teaPackTable');
    if (!pt) return;
    var phtml = '<thead><tr><th class="l">包装方式</th><th>单杯加价（元）</th><th class="l">说明</th><th style="width:76px"></th></tr></thead><tbody>';
    (t.packs || []).forEach(function (x, pi) {
      phtml += '<tr data-rid="' + x.id + '"><td class="nm">' + esc(x.name) + '</td>' +
        '<td><input type="number" min="0" step="0.01" data-tpk="' + x.id + '" value="' + num(x.add) + '"></td>' +
        '<td class="ds">' + esc(x.desc || '') + '</td>' +
        '<td class="ops-cell">' + rowOps('teaPack', x.id, pi, t.packs.length) + '</td></tr>';
    });
    phtml += '</tbody>';
    pt.innerHTML = phtml;
    $$('#teaPackTable input').forEach(function (inp) {
      inp.onchange = function () {
        var pk = (D.tea.packs || []).filter(function (x) { return x.id === inp.dataset.tpk; })[0];
        if (pk) pk.add = num(inp.value);
        save(); renderTeaCost(); renderTea(); renderDoc();
      };
    });
    makeSortable('#teaPackTable', 'teaPack', function () { renderTeaCost(); renderTea(); renderTeaWeight(); renderDoc(); });
    bindRowOps('#teaPackTable', function () {
      renderTeaCost(); renderTea(); renderTeaWeight(); renderDoc();
    });
    var addPack = pt.parentElement.querySelector('.tea-add-pack');
    if (!addPack) {
      addPack = document.createElement('button');
      addPack.className = 'link tea-add-pack';
      addPack.textContent = '＋ 添加包装';
      addPack.style.cssText = 'margin:6px 0 0 4px';
      pt.parentElement.appendChild(addPack);
    }
    addPack.onclick = function () {
      var name = prompt('包装名称：', '新包装');
      if (!name) return;
      D.tea.packs.push({ id: 'pk-' + Date.now(), name: name, add: 0, desc: '自定义包装' });
      save(); renderTeaCost(); renderTea(); renderTeaWeight(); renderDoc();
    };
    // 尺寸加价
    var st = $('#teaSizeTable');
    if (!st) return;
    var shtml = '<thead><tr><th class="l">杯子尺寸</th><th>容量</th><th class="l">规格</th><th>单杯加价（元）</th><th style="width:76px"></th></tr></thead><tbody>';
    (t.sizes || []).forEach(function (x, si) {
      shtml += '<tr data-rid="' + x.id + '"><td class="nm">' + esc(x.name) + '</td>' +
        '<td class="dim">' + (x.ml ? x.ml + 'ml' : '—') + '</td>' +
        '<td class="ds">' + esc(x.spec || '') + '</td>' +
        '<td><input type="number" min="0" step="0.01" data-tsz="' + x.id + '" value="' + num(x.add) + '"></td>' +
        '<td class="ops-cell">' + rowOps('teaSize', x.id, si, t.sizes.length) + '</td></tr>';
    });
    shtml += '</tbody>';
    st.innerHTML = shtml;
    $$('#teaSizeTable input').forEach(function (inp) {
      inp.onchange = function () {
        var sz = (D.tea.sizes || []).filter(function (x) { return x.id === inp.dataset.tsz; })[0];
        if (sz) sz.add = num(inp.value);
        save(); renderTeaCost(); renderTea(); renderDoc();
      };
    });
    makeSortable('#teaSizeTable', 'teaSize', function () { renderTeaCost(); renderTea(); renderTeaWeight(); renderTeaLeadTable(document.getElementById('leadTable')); renderDoc(); });
    bindRowOps('#teaSizeTable', function () {
      renderTeaCost(); renderTea(); renderTeaWeight(); renderTeaLeadTable(document.getElementById("leadTable")); renderDoc();
    });
    var addSize = st.parentElement.querySelector('.tea-add-size');
    if (!addSize) {
      addSize = document.createElement('button');
      addSize.className = 'link tea-add-size';
      addSize.textContent = '＋ 添加尺寸';
      addSize.style.cssText = 'margin:6px 0 0 4px';
      st.parentElement.appendChild(addSize);
    }
    addSize.onclick = function () {
      var name = prompt('尺寸名称：', '新尺寸');
      if (!name) return;
      D.tea.sizes.push({ id: 'sz-' + Date.now(), name: name, ml: 0, spec: '', add: 0 });
      save(); renderTeaCost(); renderTea(); renderTeaWeight(); renderTeaLeadTable(document.getElementById("leadTable")); renderDoc();
    };
  }

  /* 茶叶杯发货时间设置：按尺寸分类 */
  function renderTeaLeadTable(tbl) {
    var t = D.tea;
    var html = '<thead><tr><th class="l">项目</th><th>天数</th><th class="l">说明</th></tr></thead><tbody>';

    html += '<tr class="grp"><td colspan="3">基准</td></tr>';
    html += '<tr><td class="nm">基准交期</td><td><input type="number" min="0" step="1" data-tlb="base" value="' + (num(t.leadBase) || 7) + '"></td><td class="ds">茶叶杯的起点天数，默认 7 天</td></tr>';
    html += '<tr><td class="nm">加急最短天数</td><td><input type="number" min="0" step="1" data-l="urgentDays" value="' + ((state.lead.urgentDays) || 3) + '"></td><td class="ds">勾选「加急」后直接按这个天数报</td></tr>';

    html += '<tr class="grp"><td colspan="3">按尺寸加天数</td></tr>';
    (t.sizes || []).forEach(function (sz) {
      var v = num((t.leadBySize || {})[sz.id]) || 0;
      html += '<tr><td class="nm">' + esc(sz.name) + '</td>' +
        '<td><input type="number" min="0" step="1" data-tls="' + sz.id + '" value="' + v + '"></td>' +
        '<td class="ds">' + esc(sz.name) + '（' + (sz.ml || '') + 'ml）在该基准上增加的天数</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">按数量档加天数</td></tr>';
    (t.tiers || []).forEach(function (q, i) {
      var v = num((t.leadByQty || [])[i]) || 0;
      html += '<tr><td class="nm">' + fq(q) + ' 杯</td>' +
        '<td><input type="number" min="0" step="1" data-tlq="' + i + '" value="' + v + '"></td>' +
        '<td class="ds">该数量档增加的天数（量越大越久）</td></tr>';
    });

    html += '</tbody>';
    tbl.innerHTML = html;

    $$('#leadTable input').forEach(function (inp) {
      inp.onchange = function () {
        var v = Math.max(0, Math.round(num(inp.value)));
        if (inp.dataset.tlb === 'base') D.tea.leadBase = v;
        if (inp.dataset.l) state.lead[inp.dataset.l] = v;
        if (inp.dataset.tls) {
          if (!D.tea.leadBySize) D.tea.leadBySize = {};
          D.tea.leadBySize[inp.dataset.tls] = v;
        }
        if (inp.dataset.tlq != null) {
          var i = +inp.dataset.tlq;
          if (!D.tea.leadByQty) D.tea.leadByQty = [];
          D.tea.leadByQty[i] = v;
        }
        save(); renderTea(); renderDoc();
      };
    });
  }


  /* 茶叶杯重量·箱规表：尺寸 × 包装 */
  /* 取茶叶杯指定尺寸+包装的克重与箱规 */
  function teaWeightOf(sizeId, packId) {
    var t = D.tea;
    var v = ((t.wt || {})[sizeId + '|' + packId]) || {};
    return { gram: num(v.gram), per: num(v.per), l: num(v.l), w: num(v.w), h: num(v.h) };
  }

  /* 茶叶杯重量·箱规：尺寸 × 包装，每个组合支持多行箱规 */
  function renderTeaWeight() {
    var tbl = $('#teaWtTable');
    if (!tbl) return;
    var t = D.tea;
    if (!t.wt) t.wt = {};

    var combos = [];
    (t.sizes || []).forEach(function (sz) {
      (t.packs || []).forEach(function (pk) {
        combos.push({ key: sz.id + '|' + pk.id, size: sz, pack: pk });
      });
    });

    var head = '<thead><tr>' +
      '<th class="l">尺寸 / 包装</th>' +
      '<th>单杯克重 (g)</th>' +
      '<th class="l">箱规（可多行）</th>' +
      '<th>箱体 m³</th>' +
      '<th>每箱毛重</th>' +
      '</tr></thead>';

    function boxRows(key) {
      var v = t.wt[key] || {};
      var list = (v.boxes && v.boxes.length) ? v.boxes : ((num(v.per) > 0) ? [{ per: v.per, l: v.l, w: v.w, h: v.h }] : []);
      if (!list.length) list = [{ per: 0, l: 0, w: 0, h: 0 }];
      return list;
    }

    var rows = combos.map(function (cb) {
      var key = cb.key;
      var v = t.wt[key] || {};
      var gram = num(v.gram);
      var list = boxRows(key);

      var boxesHtml = list.map(function (b, bi) {
        var vol = (num(b.l) > 0 && num(b.w) > 0 && num(b.h) > 0) ? (b.l * b.w * b.h / 1e6) : 0;
        var gross = (num(b.per) > 0 && gram > 0) ? (gram * b.per / 1000 + 0.3) : 0;
        return '<div class="bx-row" data-tkey="' + key + '" data-bi="' + bi + '">' +
          '<input type="number" min="0" step="1" class="mini-inp" data-tpr="' + key + '" data-bi="' + bi + '" value="' + (num(b.per) || '') + '" placeholder="每箱只数">' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-tl="' + key + '" data-bi="' + bi + '" value="' + (num(b.l) || '') + '" placeholder="长">' +
          '<span class="bx-x">×</span>' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-tw="' + key + '" data-bi="' + bi + '" value="' + (num(b.w) || '') + '" placeholder="宽">' +
          '<span class="bx-x">×</span>' +
          '<input type="number" min="0" step="0.5" class="mini-inp bx-num" data-th="' + key + '" data-bi="' + bi + '" value="' + (num(b.h) || '') + '" placeholder="高">' +
          '<span class="vol-cell">m³ ' + (vol ? vol.toFixed(3) : '—') + (gross ? ' · 毛' + gross.toFixed(1) + 'kg' : '') + '</span>' +
          (list.length > 1 ? '<button class="zdel bx-del" data-tdel="' + key + '" data-bi="' + bi + '">删</button>' : '') +
          '</div>';
      }).join('');

      var firstVol = (num(list[0].l) > 0) ? (list[0].l * list[0].w * list[0].h / 1e6) : 0;

      return '<tr data-key="' + key + '">' +
        '<td class="nm">' + esc(cb.size.name) + '<br><span class="ds">' + esc(cb.pack.name) + (cb.pack.add ? ' +' + fm(cb.pack.add) : '') + '</span></td>' +
        '<td><input type="number" min="0" step="0.1" class="mini-inp" data-twg="' + key + '" placeholder="填写" value="' + (gram || '') + '"></td>' +
        '<td class="box-multi">' + boxesHtml +
          '<button class="bx-add" data-tadd="' + key + '">＋ 加箱规</button>' +
        '</td>' +
        '<td class="vol-cell">' + (firstVol ? firstVol.toFixed(4) : '—') + '</td>' +
        '<td class="cur-cell">' + (gram > 0 && num(list[0].per) > 0 ? (gram * list[0].per / 1000 + 0.3).toFixed(1) + ' kg' : '—') + '</td>' +
        '</tr>';
    });

    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';

    function setV(key, field, val, bi) {
      if (!t.wt[key]) t.wt[key] = {};
      if (field === 'gram') { t.wt[key].gram = val; }
      else {
        if (!t.wt[key].boxes || !t.wt[key].boxes.length) {
          var old = t.wt[key];
          t.wt[key].boxes = [{ per: num(old.per), l: num(old.l), w: num(old.w), h: num(old.h) }];
        }
        if (bi == null) bi = 0;
        if (!t.wt[key].boxes[bi]) t.wt[key].boxes[bi] = {};
        t.wt[key].boxes[bi][field] = val;
      }
      save(); renderTeaWeight(); renderTea();
    }

    $$('#teaWtTable input[data-twg]').forEach(function (i) { i.onchange = function () { setV(i.dataset.twg, 'gram', num(i.value)); }; });
    $$('#teaWtTable input[data-tpr]').forEach(function (i) { i.onchange = function () { setV(i.dataset.tpr, 'per', num(i.value), +i.dataset.bi); }; });
    $$('#teaWtTable input[data-tl]').forEach(function (i) { i.onchange = function () { setV(i.dataset.tl, 'l', num(i.value), +i.dataset.bi); }; });
    $$('#teaWtTable input[data-tw]').forEach(function (i) { i.onchange = function () { setV(i.dataset.tw, 'w', num(i.value), +i.dataset.bi); }; });
    $$('#teaWtTable input[data-th]').forEach(function (i) { i.onchange = function () { setV(i.dataset.th, 'h', num(i.value), +i.dataset.bi); }; });
    $$('#teaWtTable .bx-del').forEach(function (b) {
      b.onclick = function () {
        var key = b.dataset.tdel;
        if (t.wt[key] && t.wt[key].boxes) {
          t.wt[key].boxes.splice(+b.dataset.bi, 1);
          save(); renderTeaWeight(); renderTea();
        }
      };
    });
    $$('#teaWtTable .bx-add').forEach(function (b) {
      b.onclick = function () {
        var key = b.dataset.tadd;
        if (!t.wt[key]) t.wt[key] = {};
        if (!t.wt[key].boxes || !t.wt[key].boxes.length) {
          var old = t.wt[key];
          t.wt[key].boxes = [{ per: num(old.per), l: num(old.l), w: num(old.w), h: num(old.h) }];
        }
        t.wt[key].boxes.push({ per: 0, l: 0, w: 0, h: 0 });
        save(); renderTeaWeight(); renderTea();
      };
    });
  }
  /* ================= 列表行管理：添加 / 删除 / 上下移动 ================= */
  /* 杯型、工艺、茶叶杯尺寸/包装/茶叶 都用它 */
  /* 内置杯型的原始尺寸：改过尺寸后要能恢复 */
  var SPEC_DIMS0 = {};
  (D.specs || []).forEach(function (s) { SPEC_DIMS0[s.id] = { top: s.top, bottom: s.bottom, height: s.height }; });

  /* 把内置杯型的尺寸恢复成出厂值，再套上用户改过的（存在 specDims 里）。
     自定义杯型的尺寸直接改在它自己身上，不在这里 */
  function applySpecDims() {
    (D.specs || []).forEach(function (s) {
      var o = SPEC_DIMS0[s.id];
      if (o) { s.top = o.top; s.bottom = o.bottom; s.height = o.height; }
    });
    Object.keys(state.specDims || {}).forEach(function (id) {
      var s = (D.specs || []).filter(function (x) { return x.id === id; })[0];
      var d = state.specDims[id];
      if (s && d && num(d.top) > 0 && num(d.bottom) > 0 && num(d.height) > 0) {
        s.top = num(d.top); s.bottom = num(d.bottom); s.height = num(d.height);
      }
    });
  }

  function allSpecs() {
    var hid = state.specHidden || [];
    var all = (state.customSpecs || []).concat(D.specs).filter(function (s) { return hid.indexOf(s.id) < 0; });
    var ord = state.specOrder;
    if (ord && ord.length) {
      var map = {};
      all.forEach(function (s) { map[s.id] = s; });
      var out = [];
      ord.forEach(function (id) { if (map[id]) { out.push(map[id]); delete map[id]; } });
      all.forEach(function (s) { if (map[s.id]) out.push(s); });
      return out;
    }
    return all;
  }

  /* 记录当前排序到 state.specOrder / craftOrder */
  function saveOrder(kind, ids) {
    if (kind === 'spec') state.specOrder = ids;
    if (kind === 'craft') state.craftOrder = ids;
  }
  function specById(id) {
    return allSpecs().filter(function (s) { return s.id === id; })[0];
  }
  /* 自定义项列表：kind = 'spec' | 'craft' | 'teaSize' | 'teaPack' | 'teaLeaf' */
  function listFor(kind) {
    if (kind === 'spec') return state.customSpecs;
    if (kind === 'craft') return state.customCrafts;
    if (kind === 'teaSize') return D.tea.sizes;
    if (kind === 'teaPack') return D.tea.packs;
    if (kind === 'teaLeaf') return D.tea.leaves;
    return [];
  }
  /* 行操作：删除按钮（排序用拖拽或上下按钮）。
     杯型这一行：全部可删（内置的删掉只是隐藏，能恢复）、可上下移动 */
  function rowOps(kind, id, idx, total) {
    var isSpec = kind === 'spec';
    var canDel = isSpec || kind === 'teaSize' || kind === 'teaPack' || (id && String(id).indexOf('custom-') === 0);
    return '<span class="row-ops">' +
      '<span class="drag-handle" title="按住拖动排序">⋮⋮</span>' +
      (isSpec ? '<button class="rop rop-mv" data-op="up" data-kind="spec" data-id="' + esc(id) + '" title="上移"' + (idx <= 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="rop rop-mv" data-op="down" data-kind="spec" data-id="' + esc(id) + '" title="下移"' + (idx >= total - 1 ? ' disabled' : '') + '>↓</button>' : '') +
      (canDel ? '<button class="rop rop-del" data-op="del" data-kind="' + kind + '" data-id="' + esc(id) + '" title="' + (isSpec && String(id).indexOf('custom-') !== 0 ? '删除（内置杯型可恢复）' : '删除') + '">×</button>' : '') +
      '</span>';
  }

  /* 拖拽排序：给表格 tbody 的 tr 加 HTML5 draggable */
  function makeSortable(tableSel, kind, afterChange) {
    var tbody = document.querySelector(tableSel + ' tbody');
    if (!tbody) return;
    var dragRow = null;

    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      var handle = tr.querySelector('.drag-handle');
      if (!handle) return;
      tr.draggable = true;

      tr.addEventListener('dragstart', function (e) {
        dragRow = tr;
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', ''); } catch (err) {}
      });
      tr.addEventListener('dragend', function () {
        tr.classList.remove('dragging');
        Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (x) { x.classList.remove('drag-over'); });
        dragRow = null;
      });
      tr.addEventListener('dragover', function (e) {
        if (!dragRow || dragRow === tr || !tr.dataset.rid) return;
        e.preventDefault();
        tr.classList.add('drag-over');
      });
      tr.addEventListener('dragleave', function () { tr.classList.remove('drag-over'); });
      tr.addEventListener('drop', function (e) {
        if (!dragRow || dragRow === tr || !tr.dataset.rid) return;
        e.preventDefault();
        tr.classList.remove('drag-over');
        // 只按带 data-rid 的主行排序（子行随主行走）
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-rid]'));
        var from = rows.indexOf(dragRow);
        var to = rows.indexOf(tr);
        if (from < 0 || to < 0) return;
        // 读取当前表格顺序的 id，重排后写回 order
        var ids = rows.map(function (r) {
          var cell = r.querySelector('.nm');
          return r.dataset.rid || (cell ? cell.textContent.trim() : '');
        });
        var moved = ids.splice(from, 1)[0];
        ids.splice(to, 0, moved);
        saveOrder(kind, ids);
        save();
        afterChange();
      });
    });
  }

  /* 绑定删除按钮（按 id 找，避免拖拽排序后下标错位） */
  function bindRowOps(container, afterChange) {
    $$(container + ' .rop').forEach(function (b) {
      b.onclick = function () {
        var kind = b.dataset.kind, op = b.dataset.op, id = b.dataset.id;
        if (op !== 'del') return;
        var arr = listFor(kind);
        var at = -1;
        for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i].id === id) { at = i; break; } }
        if (at < 0) return;
        var item = arr[at];
        arr.splice(at, 1);
        if (kind === 'spec' && item && item.id) delete state.cupPaper[item.id];
        if (kind === 'craft' && item && item.id && state.craftGrid) delete state.craftGrid[item.id];
        save(); afterChange();
      };
    });
  }

  /* ================= 快递分区报价 ================= */
  /* 大区 → 省份映射（按快递公司常见分区习惯） */
  var ZONES = [
    { id: 'east', name: '华东', provinces: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'] },
    { id: 'north', name: '华北', provinces: ['北京', '天津', '河北', '山西', '内蒙古'] },
    { id: 'south', name: '华南', provinces: ['广东', '广西', '海南'] },
    { id: 'central', name: '华中', provinces: ['河南', '湖北', '湖南'] },
    { id: 'southwest', name: '西南', provinces: ['重庆', '四川', '贵州', '云南', '西藏'] },
    { id: 'northwest', name: '西北', provinces: ['陕西', '甘肃', '青海', '宁夏', '新疆'] },
    { id: 'northeast', name: '东北', provinces: ['辽宁', '吉林', '黑龙江'] },
    { id: 'remote', name: '偏远', provinces: ['新疆', '西藏', '内蒙古', '青海', '甘肃'] }
  ];
  var ALL_PROVINCES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
    '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东',
    '河南', '湖北', '湖南', '广东', '广西', '海南',
    '重庆', '四川', '贵州', '云南', '西藏',
    '陕西', '甘肃', '青海', '宁夏', '新疆', '台湾', '香港', '澳门'];

  /* ================= 快递独立页：按公司分标签 ================= */
  function shipTabs() {
    var tabs = $('#shipTabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    (D.shipping || []).filter(function (s) { return s.id !== 'none'; }).forEach(function (s, i) {
      var b = el('button', i === 0 ? 'on' : '', s.name);
      b.onclick = function () {
        $$('#shipTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        renderShipCompany(s.id);
      };
      tabs.appendChild(b);
    });
  }

  /* 单家快递：分区价表（区域多选 + 首重 + 续重），可加行 */
  /* 单家快递：分区价表（每行下拉多选省份 + 首重 + 续重），可加行 */
  function renderShipCompany(id) {
    var box = $('#shipPanels');
    if (!box) return;
    var s = (D.shipping || []).filter(function (x) { return x.id === id; })[0];
    if (!s) { box.innerHTML = ''; return; }

    if (!state.shipZones) state.shipZones = {};
    if (!state.shipZones[id]) state.shipZones[id] = [];
    var rows = state.shipZones[id];
    if (!rows.length) {
      rows.push({ zones: ['上海','江苏','浙江','安徽','福建','江西','山东'], first: num(s.first) || 8, next: num(s.next) || 1.5, charge: num(s.charge) || 6000 });
    }

    var isWt = s.calc === 'byWeight';
    var isVol = s.calc === 'byVolume';
    var unit = isVol ? '元/m³' : '元/kg';

    var html = '<div class="card">' +
      '<div class="grad-head"><span class="grad-label">' + esc(s.name) + ' · 分区报价</span>' +
      '<div class="btns"><button class="link" id="btnZoneAdd">＋ 添加一行</button></div></div>';

    html += '<table class="ct" id="zoneTable"><thead><tr>' +
      '<th class="l" style="width:46%">省份（下拉多选）</th>' +
      '<th>首重/首方</th><th>续重/续方 (' + unit + ')</th>' +
      '<th>抛重比</th>' +
      '<th style="width:56px"></th></tr></thead><tbody>';

    function zoneRow(row, idx) {
      var zones = row.zones || [];
      var provTxt = zones.length ? zones.join('、') : '点击选择省份';
      var opts = ALL_PROVINCES.map(function (p) {
        var on = zones.indexOf(p) >= 0;
        return '<label class="popt"><input type="checkbox" value="' + esc(p) + '"' + (on ? ' checked' : '') + '>' + esc(p) + '</label>';
      }).join('');
      return '<tr data-zi="' + idx + '">' +
        '<td class="zone-cell">' +
          '<div class="psel" data-zi="' + idx + '">' +
            '<button class="psel-btn" data-pselbtn="' + idx + '">' + esc(provTxt) + ' ▾</button>' +
            '<div class="psel-pop" data-pselpop="' + idx + '">' +
              '<div class="psel-acts">' +
                '<button class="link" data-pall="' + idx + '">全选</button>' +
                '<button class="link" data-pnone="' + idx + '">清空</button>' +
                '<button class="link" data-peast="' + idx + '">华东</button>' +
                '<button class="link" data-pclose="' + idx + '">收起</button>' +
              '</div>' +
              '<div class="psel-grid">' + opts + '</div>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td><input type="number" min="0" step="0.5" class="mini-inp" data-zf="' + idx + '" value="' + num(row.first) + '"></td>' +
        '<td><input type="number" min="0" step="0.5" class="mini-inp" data-zn="' + idx + '" value="' + num(row.next) + '"></td>' +
        '<td><input type="number" min="0" step="100" class="mini-inp" data-zc="' + idx + '" value="' + (num(row.charge) || 6000) + '"></td>' +
        '<td><button class="zdel" data-zdel="' + idx + '">×</button></td>' +
        '</tr>';
    }

    html += rows.map(zoneRow).join('');
    html += '</tbody></table>';
    html += '<p class="tip">点「省份 ▾」展开勾选（支持全选/清空/华东快捷）。计费时<b>按行从上到下匹配第一个命中的省份</b>，把更细的价格行放在上面。</p></div>';

    box.innerHTML = html;

    function closeAll() {
      document.querySelectorAll('.psel-pop.portal').forEach(function (p) {
        p.classList.remove('on');
      });
      document.querySelectorAll('#zoneTable .psel-pop').forEach(function (p) { p.classList.remove('on'); });
    }

    // 展开收起
    $$('#zoneTable [data-pselbtn]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var zi = b.dataset.pselbtn;
        var sel = '.psel-pop[data-pselpop="' + zi + '"]';
        var pop = document.querySelector(sel);
        var open = pop && pop.classList.contains('on');
        closeAll();
        if (!open && pop) {
          // 挪到 body 下并给最高层级，避免被下方卡片遮挡
          if (pop.parentElement !== document.body) {
            pop.classList.add('portal');
            document.body.appendChild(pop);
          }
          pop.style.position = 'fixed';
          pop.style.zIndex = '2147483000';
          var rect = b.getBoundingClientRect();
          pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 412)) + 'px';
          pop.style.top = (rect.bottom + 4) + 'px';
          pop.classList.add('on');
        }
      };
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.psel')) closeAll();
    });
    // 勾选省份
    $$('#zoneTable .popt input').forEach(function (chk) {
      chk.onchange = function () {
        var pop = chk.closest('.psel-pop');
        var zi = pop.dataset.pselpop;
        var row = state.shipZones[id][+zi];
        var picked = $$('#zoneTable .psel-pop[data-pselpop="' + zi + '"] .popt input:checked').map(function (x) { return x.value; });
        row.zones = picked;
        var btn = document.querySelector('.psel-btn[data-pselbtn="' + zi + '"]');
        if (btn) btn.textContent = (picked.length ? picked.join('、') : '点击选择省份') + ' ▾';
        save();
      };
    });
    // 快捷键
    $$('#zoneTable [data-pall]').forEach(function (b) {
      b.onclick = function (e) {
        e.preventDefault();
        var zi = b.dataset.pall;
        $$('#zoneTable .psel-pop[data-pselpop="' + zi + '"] .popt input').forEach(function (x) { x.checked = true; });
        var row = state.shipZones[id][+zi];
        row.zones = ALL_PROVINCES.slice();
        var btn = document.querySelector('.psel-btn[data-pselbtn="' + zi + '"]');
        if (btn) btn.textContent = ALL_PROVINCES.join('、') + ' ▾';
        save();
      };
    });
    $$('#zoneTable [data-pnone]').forEach(function (b) {
      b.onclick = function (e) {
        e.preventDefault();
        var zi = b.dataset.pnone;
        $$('#zoneTable .psel-pop[data-pselpop="' + zi + '"] .popt input').forEach(function (x) { x.checked = false; });
        state.shipZones[id][+zi].zones = [];
        var btn = document.querySelector('.psel-btn[data-pselbtn="' + zi + '"]');
        if (btn) btn.textContent = '点击选择省份 ▾';
        save();
      };
    });
    $$('#zoneTable [data-peast]').forEach(function (b) {
      b.onclick = function (e) {
        e.preventDefault();
        var zi = b.dataset.peast;
        var east = ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'];
        $$('#zoneTable .psel-pop[data-pselpop="' + zi + '"] .popt input').forEach(function (x) { x.checked = east.indexOf(x.value) >= 0; });
        state.shipZones[id][+zi].zones = east.slice();
        var btn = document.querySelector('.psel-btn[data-pselbtn="' + zi + '"]');
        if (btn) btn.textContent = east.join('、') + ' ▾';
        save();
      };
    });
    $$('#zoneTable [data-pclose]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); closeAll(); };
    });
    // 首重/续重/抛比
    $$('#zoneTable input[data-zf], #zoneTable input[data-zn], #zoneTable input[data-zc]').forEach(function (inp) {
      inp.onchange = function () {
        var idx = (inp.dataset.zf !== undefined && inp.dataset.zf !== '') ? +inp.dataset.zf :
                  (inp.dataset.zn !== undefined && inp.dataset.zn !== '') ? +inp.dataset.zn :
                  +inp.dataset.zc;
        var row = state.shipZones[id][idx];
        if (!row) return;
        if (inp.dataset.zf !== undefined && inp.dataset.zf !== '') row.first = num(inp.value);
        if (inp.dataset.zn !== undefined && inp.dataset.zn !== '') row.next = num(inp.value);
        if (inp.dataset.zc !== undefined && inp.dataset.zc !== '') row.charge = num(inp.value);
        save(); renderShipQuote();
      };
    });
    // 删行
    $$('#zoneTable .zdel').forEach(function (b) {
      b.onclick = function () {
        state.shipZones[id].splice(+b.dataset.zdel, 1);
        save(); renderShipCompany(id); renderShipQuote();
      };
    });
    // 加行
    var add = $('#btnZoneAdd');
    if (add) add.onclick = function () {
      state.shipZones[id].push({ zones: [], first: 0, next: 0, charge: isVol ? 10000 : 6000 });
      save(); renderShipCompany(id);
    };
  }
  /* 试算表：所有快递按当前订单 */
  function renderShipQuote() {
    var tbl = $('#shipQuoteTable');
    var info = $('#shipQuoteInfo');
    if (!tbl) return;
    var bx, gram, qty, label;
    if (state.mode === 'tea') {
      var r = teaCalc();
      bx = { per: r.per, l: r.boxL, w: r.boxW, h: r.boxH };
      gram = r.gram; qty = r.qty; label = r.sizeName + ' / ' + r.packName;
    } else {
      var b = boxOf(spec());
      bx = { per: b.per, l: b.l, w: b.w, h: b.h };
      gram = curGram(); qty = state.qty; label = spec().name;
    }

    if (info) {
      info.textContent = label + '　' + fq(qty) + (state.mode === 'tea' ? ' 杯' : ' 只') +
        (bx.per > 0 ? '　箱规 ' + fq(bx.per) + '只装 ' + bx.l + '×' + bx.w + '×' + bx.h + 'cm' : '　箱规未填') +
        (gram > 0 ? '　单杯 ' + gram + 'g' : '');
    }

    var head = '<thead><tr><th class="l">快递</th><th class="l">方式</th><th>实重</th><th>体积重</th><th>计费重/体积</th><th>运费</th><th>成本合计</th></tr></thead>';
    var rows = (D.shipping || []).filter(function (s) { return s.id !== 'none'; }).map(function (s) {
      var auto = shipAutoCalc(s.id);
      var cartons = (bx.per > 0) ? Math.ceil(qty / bx.per) : 0;
      var volOne = (bx.l > 0 && bx.w > 0 && bx.h > 0) ? bx.l * bx.w * bx.h / 1e6 : 0;
      var totalVol = volOne * cartons;
      var charge = num(s.charge) || 6000;
      var volWt = totalVol * 1e6 / charge;
      var realWt = gram > 0 ? gram * qty / 1000 + cartons * 0.5 : 0;
      var charged = Math.max(realWt, volWt);
      var total = auto ? (auto.fee + buildQuote().amount) : 0;
      return '<tr' + (state.shipping === s.id ? ' class="cur"' : '') + '>' +
        '<td class="nm">' + esc(s.name) + '</td>' +
        '<td class="ds">' + (s.calc === 'byWeight' ? '按重量' : s.calc === 'byVolume' ? '按方' : '按票') + '</td>' +
        '<td>' + (gram > 0 ? realWt.toFixed(1) + ' kg' : '<span style="color:#b26a00">未填克重</span>') + '</td>' +
        '<td>' + (totalVol ? volWt.toFixed(1) + ' kg' : '—') + '</td>' +
        '<td class="ds">' + (auto ? esc(auto.err || auto.basis) : '箱规未填') + '</td>' +
        '<td class="cur-cell">' + (auto ? (auto.err ? '未设价' : '¥' + fm(auto.fee)) : '—') + '</td>' +
        '<td>' + (auto && !auto.err ? (total ? '¥' + fm(total) : '—') : '—') + '</td>' +
        '</tr>';
    });
    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
  }
  /* 快递运费：按箱规自动算（按方 / 按重量），并显示计算依据 */
  function renderShipTable() {
    var tbl = $('#shipTable');
    if (!tbl) return;

    // 当前订单的箱规信息，供表头说明
    var info;
    if (state.mode === 'tea') {
      var r = teaCalc();
      info = { per: r.per, l: r.boxL, w: r.boxW, h: r.boxH, gram: r.gram, qty: r.qty, name: r.sizeName + ' / ' + r.packName };
    } else {
      var b = boxOf(spec());
      info = { per: b.per, l: b.l, w: b.w, h: b.h, gram: curGram(), qty: state.qty, name: spec().name };
    }
    var cartons = (info.per > 0) ? Math.ceil(info.qty / info.per) : 0;
    var vol = (info.per > 0 && info.l > 0) ? (info.l * info.w * info.h / 1e6) * cartons : 0;
    var kg = info.gram > 0 ? info.gram * info.qty / 1000 : 0;

    var head = '<thead><tr>' +
      '<th class="l">运输方式</th>' +
      '<th class="l">计费方式</th>' +
      '<th>首费</th><th>续费</th>' +
      '<th>当前运费</th>' +
      '<th class="l">计算依据</th>' +
      '</tr></thead>';

    var rows = (D.shipping || []).filter(function (s) { return s.id !== 'none'; }).map(function (s) {
      var auto = shipAutoCalc(s.id);
      var isVol = s.calc === 'byVolume';
      var isWt = s.calc === 'byWeight';

      var calcTxt = isVol ? '按方' : isWt ? '按重量' : '按票';
      var first = isVol ? (num(s.first) + ' 元/首方') : isWt ? (num(s.first) + ' 元/' + (num(s.firstKg)||1) + 'kg') : '—';
      var nextV = isVol ? (num(s.next) + ' 元/m³') : isWt ? (num(s.next) + ' 元/kg') : '—';

      return '<tr>' +
        '<td class="nm">' + esc(s.name) + '</td>' +
        '<td class="ds">' + calcTxt + '</td>' +
        '<td><input type="number" min="0" step="1" class="mini-inp" data-sf="' + s.id + '" value="' + num(s.first) + '"></td>' +
        '<td><input type="number" min="0" step="1" class="mini-inp" data-sn="' + s.id + '" value="' + num(s.next) + '"></td>' +
        '<td class="cur-cell">' + (auto ? (auto.err ? '未设价' : '¥' + fm(auto.fee)) : '—') + '</td>' +
        '<td class="ds">' + (auto ? esc(auto.basis) : (s.desc || '箱规未填，无法计算')) + '</td>' +
        '</tr>';
    });

    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';

    $$('#shipTable input[data-sf]').forEach(function (inp) {
      inp.onchange = function () {
        var sh = (D.shipping || []).filter(function (x) { return x.id === inp.dataset.sf; })[0];
        if (sh) sh.first = num(inp.value);
        save(); renderShipTable(); sync();
      };
    });
    $$('#shipTable input[data-sn]').forEach(function (inp) {
      inp.onchange = function () {
        var sh = (D.shipping || []).filter(function (x) { return x.id === inp.dataset.sn; })[0];
        if (sh) sh.next = num(inp.value);
        save(); renderShipTable(); sync();
      };
    });
  }

  /* 工艺表：内置 + 自定义，支持添加/删除/上下移动 */
  function renderCraftTable() {
    var tbl = $('#craftCostTable');
    if (!tbl) return;
    var crafts = allCrafts();
    var head = '<thead><tr><th class="l">工艺</th>' +
      state.gradients.map(function (g) { return '<th>' + fq(g) + ' 只</th>'; }).join('') +
      '<th>当前</th><th>版费</th><th class="l">说明</th><th style="width:76px"></th></tr></thead>';

    var rows = crafts.map(function (c, ci) {
      var arr = state.craftGrid[c.id] || [];
      var cur = craftPrice(c.id, state.qty);
      var isCustom = c.id.indexOf('custom-') === 0;
      return '<tr data-rid="' + c.id + '"><td class="nm">' + esc(c.name) + '</td>' +
        state.gradients.map(function (g, i) {
          return '<td><input type="number" min="0" step="0.001" data-c="' + c.id + '" data-i="' + i + '" value="' + (arr[i] != null ? arr[i] : '') + '"></td>';
        }).join('') +
        '<td class="cur-cell">¥' + fp(cur) + '</td>' +
        '<td class="dim">' + (c.plate ? '¥' + c.plate : '—') + '</td>' +
        '<td class="ds">' + esc(c.desc || '') + '</td>' +
        '<td class="ops-cell">' + rowOps('craft', c.id, ci, crafts.length) + '</td>' +
        '</tr>';
    });
    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
    $$('#craftCostTable input').forEach(function (inp) {
      inp.onchange = function () {
        var id = inp.dataset.c, i = +inp.dataset.i;
        if (!state.craftGrid[id]) state.craftGrid[id] = [];
        state.craftGrid[id][i] = inp.value === '' ? null : num(inp.value);
        save(); sync();
        var cell = inp.closest('tr').querySelector('.cur-cell');
        if (cell) cell.textContent = '¥' + fp(craftPrice(id, state.qty));
      };
    });
    makeSortable('#craftCostTable', 'craft', function () { renderCraftTable(); renderCrafts(); sync(); });
    bindRowOps('#craftCostTable', function () {
      state.customCrafts = state.customCrafts.filter(function (c) {
        if (c._del) { delete state.craftGrid[c.id]; return false; }
        return true;
      });
      renderCraftTable(); renderCrafts(); sync();
    });
  }

  /* 添加自定义工艺 */
  function addCustomCraft() {
    var name = prompt('工艺名称：', '新工艺');
    if (!name) return;
    var id = 'custom-' + Date.now();
    var c = { id: id, name: name, prices: [0.03, 0.02, 0.015], plate: 0, plateUnit: '元/色', desc: '自定义工艺' };
    state.customCrafts.push(c);
    state.craftGrid[id] = state.gradients.map(function (g, i) { return c.prices[i] || c.prices[c.prices.length - 1]; });
    save(); renderCraftTable(); renderCrafts(); sync();
    toast('已添加「' + name + '」');
  }
  function renderParams() {
    var p = state.params;
    var html = '';
    html += '<label><span>开票类型</span><select data-inv="main">' +
      (D.invoices || []).map(function (iv) {
        return '<option value="' + iv.id + '"' + (state.invoice === iv.id ? ' selected' : '') + '>' +
          iv.name + (num(iv.rate) ? '（' + (num(iv.rate) * 100).toFixed(0) + '%）' : '') + '</option>';
      }).join('') +
      '</select><span class="hint">决定单价里的税点</span></label>';
    (D.invoices || []).forEach(function (iv) {
      html += '<label><span>' + iv.name + ' 税点</span><input type="number" step="0.01" data-invr="' + iv.id + '" value="' + num(iv.rate) + '"><span class="hint">0.13 = 13%</span></label>';
    });
    html += '<label><span>取整步长</span><input type="number" step="0.001" data-p="round" value="' + p.round + '"><span class="hint">0.001 保留到厘</span></label>';
    html += '<label><span>加急加价（元/单）</span><input type="number" step="50" data-p="urgentFee" value="' + (p.urgentFee != null ? p.urgentFee : 300) + '"><span class="hint">固定金额</span></label>';
    html += '<label><span>有效期</span><input type="text" data-p="valid" value="' + esc(p.valid) + '"></label>';
    html += '<label><span>付款方式</span><input type="text" data-p="pay" value="' + esc(p.pay) + '"></label>';
    html += '<label><span>运费说明</span><input type="text" data-p="ship" value="' + esc(p.ship) + '"></label>';
    html += '<label><span>签订地点</span><input type="text" data-q="place" value="' + esc(state.quote.place || '') + '"><span class="hint">合同用</span></label>';
    html += '<label><span>公司名</span><input type="text" data-c="name" value="' + esc(D.company.name) + '"></label>';
    html += '<label><span>落款电话</span><input type="text" data-c="phone" value="' + esc(D.company.phone) + '"></label>';
    html += '<label><span>公司地址</span><input type="text" data-c="addr" value="' + esc(D.company.addr) + '"></label>';
    html += '<label><span>税号</span><input type="text" data-c="taxNo" value="' + esc(D.company.taxNo) + '"></label>';
    html += '<label><span>开户银行</span><input type="text" data-c="bank" value="' + esc(D.company.bank) + '"><span class="hint">合同用</span></label>';
    html += '<label><span>银行账号</span><input type="text" data-c="account" value="' + esc(D.company.account) + '"><span class="hint">合同用</span></label>';
    html += '<label><span>交货地点</span><input type="text" data-q="deliverAddr" value="' + esc(state.quote.deliverAddr || '') + '"><span class="hint">合同第七条</span></label>';
    html += '<label><span>合同标题</span><input type="text" data-h="title" value="' + esc(state.contractTitle || '') + '"><span class="hint">默认「纸杯定作合同」</span></label>';
    D.tiers.forEach(function (t, i) {
      html += '<label><span>' + t.name + ' 毛利率</span><input type="number" step="0.01" data-t="' + i + '" value="' + t.margin + '"><span class="hint">0.15 = 15%</span></label>';
    });
    $('#paramGrid').innerHTML = html;
    $$('#paramGrid input, #paramGrid select').forEach(function (inp) {
      inp.onchange = function () {
        if (inp.dataset.p) {
          var k = inp.dataset.p;
          if (['delivery', 'valid', 'pay', 'ship'].indexOf(k) >= 0) state.params[k] = inp.value;
          else state.params[k] = num(inp.value);
        }
        if (inp.dataset.c) D.company[inp.dataset.c] = inp.value;
        if (inp.dataset.q) state.quote[inp.dataset.q] = inp.value;
        if (inp.dataset.h === 'title') state.contractTitle = inp.value;
        if (inp.dataset.inv === 'main') state.invoice = inp.value;
        if (inp.dataset.invr) {
          var iv = (D.invoices || []).filter(function (x) { return x.id === inp.dataset.invr; })[0];
          if (iv) iv.rate = num(inp.value);
        }
        if (inp.dataset.t != null) D.tiers[+inp.dataset.t].margin = num(inp.value);
        save(); sync();
      };
    });
  }

  /* ---------------- 同步 ---------------- */
  /* 正在查看一张已保存的报价单、而且没改过 → 临时换成它当时的成本表来算，
     这样页面上的价格和当时发给客户的一模一样；成本页始终显示现在的成本表 */
  function sync() {
    if (VIEW.rec && !VIEW.dirty && VIEW.rec.cost && VIEW.rec.cost.s) {
      var costOn = $('#page-cost').classList.contains('on');
      withCost(VIEW.rec.cost, function () { syncCore(true); });
      if (costOn) renderCostTables();
      return;
    }
    syncCore(false);
  }

  function renderCostTables() { renderPaperTable(); renderProcTable(); renderCraftTable(); renderWeightTable(); }

  function syncCore(swapped) {
    ['#specSelect', '#specSelect2'].forEach(function (s) { var n = $(s); if (n) n.value = state.specId; });
    ['#qtyInput', '#qtyInput2'].forEach(function (s) { var n = $(s); if (n) n.value = state.qty; });
    renderSpecLine();
    renderStruct();
    renderPapers();
    renderLining();
    renderCrafts();
    renderInvoice();
    renderShipping();
    renderTiers();
    renderLeadBadge();
    renderWeightBox();
    renderDoc();
    save();
    if (!swapped && $('#page-cost').classList.contains('on')) renderCostTables();
  }

  function page(name) {
    $$('.tabs button[data-page]').forEach(function (b) { b.classList.toggle('on', b.dataset.page === name); });
    $$('.page').forEach(function (p) { p.classList.toggle('on', p.id === 'page-' + name); });
    if (name === 'ship') { shipTabs(); if (!document.getElementById('shipPanels').innerHTML) renderShipCompany((D.shipping || [])[1].id); renderShipQuote(); }
    if (name === 'cost') {
      renderGradients(); renderPaperCfg(); renderMaterialTable(); renderPaperTable();
      renderProcTable(); renderCraftTable(); renderTeaCost(); renderLeadTable(); renderParams();
      // 茶叶杯模式：切到茶叶杯页
      if (state.mode === 'tea') {
        var tb = $('.cost-tabs button[data-cost-tab="tea"]');
        if (tb) tb.click();
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  function setSpec(id) {
    state.specId = id;
    var s = spec();
    // 没有配置过的杯型按分组给默认结构 + 默认纸
    cupCfg(s);
    sync();
  }

  function setQty(v) {
    state.qty = Math.max(1, Math.round(num(v)));
    ['#qtyInput', '#qtyInput2'].forEach(function (s) { var n = $(s); if (n && n.value != state.qty) n.value = state.qty; });
    renderTiers(); renderCrafts(); renderDoc(); save();
  }

  function bind() {
    initQuoteImg();
    initView();
    initSearch();

    $$('.mode-btn').forEach(function (b) {
      b.onclick = function () { switchMode(b.dataset.mode); };
    });

    // 茶叶杯控件
    // 收货省份下拉
    if ($('#qProvince')) {
      var qProv = $('#qProvince');
      if (qProv.options.length <= 1) {
        qProv.innerHTML = '<option value="">未选</option>' + ALL_PROVINCES.map(function (p) {
          return '<option value="' + p + '"' + (state.quote.province === p ? ' selected' : '') + '>' + p + '</option>';
        }).join('');
      }
      qProv.onchange = function () { state.quote.province = this.value; renderShipQuote(); renderDoc(); save(); };
    }

    if ($('#teaLeaf')) $('#teaLeaf').onchange = function () { state.tea.leaf = +this.value; renderTea(); renderDoc(); save(); };
    if ($('#teaSize')) $('#teaSize').onchange = function () { state.tea.size = this.value; renderTea(); renderDoc(); save(); };
    if ($('#teaQty')) $('#teaQty').onchange = function () { state.tea.qtyIdx = +this.value; renderTea(); renderDoc(); save(); };
    if ($('#teaGrade')) $('#teaGrade').onchange = function () { state.tea.grade = this.value; renderTea(); renderDoc(); save(); };
    if ($('#teaPack')) $('#teaPack').onchange = function () { state.tea.pack = this.value; renderTea(); renderDoc(); save(); };
    if ($('#teaSource')) $('#teaSource').onchange = function () { state.tea.source = this.value; renderTea(); renderDoc(); save(); };

    $$('.tabs button[data-page]').forEach(function (b) { b.onclick = function () { page(b.dataset.page); }; });

    $('#specSelect').onchange = function () { setSpec(this.value); };
    if ($('#specSelect2')) $('#specSelect2').onchange = function () { setSpec(this.value); };

    $('#qtyInput').oninput = function () { setQty(this.value); };
    if ($('#qtyInput2')) $('#qtyInput2').oninput = function () { setQty(this.value); };

    var lsel = $('#liningSel');
    if (lsel) lsel.onchange = function () { state.lining = this.value; sync(); };
    $('#urgentOn').onchange = function () { state.urgent = this.checked; sync(); };
    if ($('#freightPay')) $('#freightPay').onchange = function () { state.freightPay = this.value; sync(); };
    if ($('#qFreight2')) {
      $('#qFreight2').oninput = function () {
        state.quote.freight = num(this.value);
        if ($('#qFreight')) $('#qFreight').value = this.value === '' ? '' : this.value;
        renderDoc(); save();
      };
    }
    if ($('#quoteTierSel')) {
      $('#quoteTierSel').onchange = function () { state.quoteTier = +this.value; sync(); };
    }

    /* 客户信息：弹窗内编辑草稿，点「确定」才写入报价单 */
    [['#qCustomer', 'customer'], ['#qTaxNo', 'taxNo'], ['#qContact', 'contact'], ['#qAddr', 'addr']].forEach(function (p) {
      var n = $(p[0]);
      if (!n) return;
      n.oninput = function () { if (custDraft) custDraft[p[1]] = this.value; };
    });
    if ($('#qProvince')) $('#qProvince').onchange = function () { if (custDraft) custDraft.province = this.value; };
    if ($('#qDate')) $('#qDate').onchange = function () { if (custDraft) custDraft.date = this.value; };
    if ($('#qFreight')) $('#qFreight').oninput = function () { if (custDraft) custDraft.freight = num(this.value); };

    if ($('#btnCustomer')) $('#btnCustomer').onclick = openCustModal;
    if ($('#custBar')) $('#custBar').onclick = openCustModal;
    if ($('#btnCustClose')) $('#btnCustClose').onclick = closeCustModal;
    if ($('#btnCustCancel')) $('#btnCustCancel').onclick = closeCustModal;
    if ($('#btnCustOk')) $('#btnCustOk').onclick = confirmCust;
    if ($('#btnCustOcr')) $('#btnCustOcr').onclick = applyCustOcr;
    if ($('#custOcrText')) {
      $('#custOcrText').oninput = function () { state.custOcrText = this.value; save(); };
      $('#custOcrText').onkeydown = function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') applyCustOcr(); };
    }
    if ($('#btnCustOcrClear')) $('#btnCustOcrClear').onclick = function () {
      if ($('#custOcrText')) $('#custOcrText').value = '';
      state.custOcrText = ''; save();
      var tip = $('#custOcrTip');
      if (tip) { tip.textContent = '识别后回填到下面，可再改'; tip.style.color = ''; }
    };
    // 点遮罩空白处关闭
    ['#custModal', '#specModal', '#contractModal'].forEach(function (sel) {
      var m = $(sel);
      if (!m) return;
      m.addEventListener('mousedown', function (e) { if (e.target === m) m.classList.remove('on'); });
    });

    /* 报价页「客户公司」输入 → 搜 ERP 客户：选中自动带联系人/手机（都可改），没有的就自己输 */
    var qCustRows = [], qCustTimer = null;
    var qCustInp = $('#qCustomer');
    if (qCustInp) {
      qCustInp.setAttribute('autocomplete', 'off');
      qCustInp.addEventListener('input', function () {
        var v = this.value.trim();
        clearTimeout(qCustTimer);
        if (!v) return;
        qCustTimer = setTimeout(function () {
          api('GET', '/api/erp?w=customers&q=' + encodeURIComponent(v)).then(function (r) {
            qCustRows = (r.ok && r.list) || [];
            var dl = $('#qCustList');
            if (dl) dl.innerHTML = qCustRows.map(function (c) {
              return '<option value="' + esc(c.name) + '">' + esc(c.name + (c.linkman ? '　' + c.linkman : '') + (c.mobile ? '　' + c.mobile : '')) + '</option>';
            }).join('');
          });
        }, 300);
      });
      qCustInp.addEventListener('change', function () {
        var v = this.value.trim();
        var hit = qCustRows.filter(function (c) { return c.name === v; })[0];
        if (!hit) return;
        if (!$('#qContact').value.trim() && hit.linkman) $('#qContact').value = hit.linkman;
        if (!$('#qAddr').value.trim() && hit.address) $('#qAddr').value = hit.address;
      });
    }
    $('#qOther').oninput = function () { state.quote.other = num(this.value); renderDoc(); save(); };

    $('#btnOcr').onclick = applyOcr;
    $('#ocrText').oninput = function () { state.ocrText = this.value; save(); };
    $('#ocrText').onkeydown = function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') applyOcr(); };
    $('#btnExample').onclick = function () {
      $('#ocrText').value = '10万只 9盎司广告杯，268克，双层，内层268外层248，内外都是金箔纸，烫金加压纹';
      state.ocrText = $('#ocrText').value; save();
      applyOcr();
    };
    $('#btnClearOcr').onclick = function () { $('#ocrText').value = ''; state.ocrText = ''; save(); };

    $('#btnCopyText').onclick = function () { copyText(quoteText(), '文字已复制'); };
    $('#btnCopyImg').onclick = copyImg;
    if ($('#btnSaveImg')) $('#btnSaveImg').onclick = saveImg;
    // 用事件委托，避免重渲染后按钮失效
    document.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.id) return;
      if (t.id === 'btnAddSpec') { openSpecModal(); return; }
      if (t.id === 'btnAddCraft') { addCustomCraft(); return; }
      if (t.id === 'btnSpecOk') { confirmAddSpec(); return; }
      if (t.id === 'btnSpecCancel' || t.id === 'btnSpecClose') { document.getElementById('specModal').classList.remove('on'); return; }
    });
    $('#btnExportContract').onclick = exportContract;
    $('#btnModalClose').onclick = closeContractModal;
    $('#btnModalCancel').onclick = closeContractModal;
    $('#btnModalOk').onclick = confirmContractModal;
    $('#contractModal').onclick = function (e) {
      if (e.target === this) closeContractModal();
    };
    $('#mLeadDays').onchange = function () {
      $$('#mLeadQuick button').forEach(function (x) { x.classList.remove('on'); });
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('#contractModal').classList.contains('on')) closeContractModal();
    });
    $('#btnPrint').onclick = function () { window.print(); };
    $('#btnCopyPrice').onclick = function () {
      var q = buildQuote();
      copyText(spec().name + '（' + fq(q.qty) + '只）\n¥' + fp(q.price) + '/只，合计 ¥' + fm(q.amount), '价格已复制');
    };

    $$('.cost-tabs button').forEach(function (b) {
      b.onclick = function () {
        $$('.cost-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        var t = b.dataset.costTab;
        ['stock', 'cup', 'proc', 'craft', 'weight', 'tea', 'teaweight', 'lead', 'param'].forEach(function (k) {
          var box = $('#costTab' + (k.charAt(0).toUpperCase() + k.slice(1)));
          if (box) box.style.display = k === t ? '' : 'none';
        });
        if (t === 'tea') renderTeaCost();
        if (t === 'stock') { renderPaperCfg(); renderMaterialTable(); }
        if (t === 'cup') { renderPaperTable(); }
        if (t === 'proc') { renderGradients(); renderProcTable(); }
        if (t === 'craft') { renderGradients(); renderCraftTable(); }
        if (t === 'weight') renderWeightTable();
        if (t === 'teaweight') renderTeaWeight();
      };
    });

    /* 备份快照（导出/存服务器共用） */
    function backupObj() {
      return {
        v: 5, stockV: 2, gradients: state.gradients,
        paper: state.paper, paperStock: state.paperStock, sizesExtra: state.sizesExtra, cupPaper: state.cupPaper, proc: state.proc,
        craftGrid: state.craftGrid, addon: state.addon,
        specOrder: state.specOrder, craftOrder: state.craftOrder, teaState: state.tea,
        tiers: D.tiers, invoices: D.invoices,
        params: state.params, company: D.company,
        wt: state.wt, boxCfg: state.boxCfg, shipZones: state.shipZones, shipGrid: state.shipGrid,
        customSpecs: state.customSpecs, customCrafts: state.customCrafts,
        specHidden: state.specHidden, specDims: state.specDims,
        tea: D.tea, lead: state.lead
      };
    }

    /* 应用一份备份 JSON（导入备份 / 启动时从服务器取回共用） */
    function applyBackup(o) {
      if (o.gradients) state.gradients = o.gradients;
      if (o.paperSel) state.paperSel = o.paperSel;
      if (o.paper) state.paper = o.paper;
      // 旧备份（纸库还是整张纸）：纸张 id 已对不上，纸杯配置按开料表重建，纸库用当前的
      if (o.stockV === 2 && o.paperStock && o.paperStock.length) state.paperStock = o.paperStock;
      if (o.sizesExtra) state.sizesExtra = o.sizesExtra;
      state.cupPaper = o.stockV === 2 ? (o.cupPaper || {}) : {};
      if (o.proc) state.proc = o.proc;
      if (o.craftGrid) state.craftGrid = o.craftGrid;
      if (o.addon) state.addon = o.addon;
      if (o.params) Object.assign(state.params, o.params);
      if (o.tiers) D.tiers = o.tiers;
      if (o.invoices) D.invoices = o.invoices;
      if (o.materials) (o.materials || []).forEach(function (mm) {
        var m = (state.paperStock || []).filter(function (x) { return x.id === mm.id; })[0] ||
          (state.paperStock || []).filter(function (x) { return (x.base || x.id) === mm.id; })[0];
        if (m && mm.price != null) m.price = num(mm.price);
      });
      if (o.wt) state.wt = o.wt;
      if (o.boxCfg) state.boxCfg = o.boxCfg;
      if (o.shipZones) state.shipZones = o.shipZones;
      if (o.shipGrid) state.shipGrid = o.shipGrid;
      if (o.customSpecs) state.customSpecs = o.customSpecs.filter(function (s) { return !/纸桶|纸碗/.test(s.group || ''); });
      if (o.customCrafts) state.customCrafts = o.customCrafts;
      if (o.specOrder) state.specOrder = o.specOrder;
      if (Array.isArray(o.specHidden)) state.specHidden = o.specHidden;
      state.specDims = (o.specDims && typeof o.specDims === 'object') ? o.specDims : {};
      applySpecDims();
      if (o.craftOrder) state.craftOrder = o.craftOrder;
      if (o.teaState) state.tea = Object.assign(state.tea, o.teaState);
      if (o.tea) D.tea = o.tea;
      if (o.lead) state.lead = o.lead;
      if (o.company) Object.assign(D.company, o.company);
    }

    $('#btnSaveCost').onclick = function () {
      save();
      api('POST', '/api/cost', backupObj()).then(function (r) {
        toast(r && r.ok ? '成本已保存（本机 + 服务器）' : '已存本机，服务器保存失败：' + ((r && r.error) || ''));
      });
    };
    $('#btnFillSuggest').onclick = function () {
      if (!confirm('用参考值填充「加工」梯度表所有格？已填的会被覆盖。')) return;
      ['make', 'print'].forEach(function (k) {
        state.proc[k] = state.gradients.map(function (g) { return suggestProc(k, g); });
      });
      save(); renderProcTable(); sync();
      toast('已填充加工费参考值');
    };

    $('#btnExportCost').onclick = function () {
      var cfg = paperCfg();
      var head = ['杯型', '规格', '结构', '层', '纸张', '克重g', '拼版数', '损耗%', '杯身重g', '杯身成本元', '底片重g', '底片成本元', '单杯重g', '单只纸价元'];
      var L = [head.join(',')];
      allSpecs().forEach(function (s) {
        var cc = cupCfg(s);
        var calc = cupPaperCalc(s);
        calc.layers.forEach(function (ly) {
          L.push([s.name, s.oz + 'oz/' + s.ml + 'ml', structOf(cc.structure).name,
            ly.name, ly.paper.name, ly.gsm, ly.pack, ly.loss,
            ly.bodyGram.toFixed(1), ly.bodyCost.toFixed(5),
            ly.bottomGram != null ? ly.bottomGram.toFixed(1) : '',
            ly.bottomCost != null ? ly.bottomCost.toFixed(5) : '',
            calc.gram.toFixed(1), calc.cost.toFixed(5)].join(','));
        });
      });
      saveBlob(new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' }), '纸杯成本表.csv');
    };

    $('#btnExportAll').onclick = function () {
      saveBlob(new Blob([JSON.stringify({
        v: 5, stockV: 2, gradients: state.gradients,
        paper: state.paper, paperStock: state.paperStock, sizesExtra: state.sizesExtra, cupPaper: state.cupPaper, proc: state.proc,
        craftGrid: state.craftGrid, addon: state.addon,
        specOrder: state.specOrder, craftOrder: state.craftOrder, teaState: state.tea,
        tiers: D.tiers, invoices: D.invoices,
        params: state.params, company: D.company,
        wt: state.wt, boxCfg: state.boxCfg, shipZones: state.shipZones, shipGrid: state.shipGrid,
        customSpecs: state.customSpecs, customCrafts: state.customCrafts,
        specHidden: state.specHidden, specDims: state.specDims,
        tea: D.tea, lead: state.lead
      }, null, 2)], { type: 'application/json' }), '纸杯报价备份.json');
    };

    $('#btnImport').onclick = function () { $('#fileImport').click(); };
    $('#fileImport').onchange = function () {
      var f = this.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var o = JSON.parse(fr.result);
          applyBackup(o);
          initData(); save(); page('cost'); sync(); toast('已导入');
        } catch (e) { toast('格式不对'); }
      };
      fr.readAsText(f);
      this.value = '';
    };

    $('#btnReset').onclick = function () {
      if (!confirm('恢复出厂数据？你填的成本梯度会丢失。')) return;
      try { localStorage.removeItem(KEY); } catch (e) {}
      location.reload();
    };

    $$('.kb-nav a').forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var t = $(a.getAttribute('href'));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
  }

  function init() {
    load(); initData();
    renderSpecSelect(); bind();
    /* 本机没有任何存档（换电脑/清缓存）→ 自动取回服务器上的成本参数 */
    try {
      if (!localStorage.getItem(KEY)) {
        api('GET', '/api/cost').then(function (r) {
          if (r && r.ok && r.data && r.data.gradients) {
            applyBackup(r.data);
            initData(); save(); sync(); renderSpecSelect();
            toast('已从服务器取回成本参数');
          }
        });
      }
    } catch (e) { /* 隐私模式等拿不到 localStorage 就跳过 */ }
    // 模式
    $$('.mode-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === (state.mode || 'cup')); });
    var isTea = state.mode === 'tea';
    if ($('#calcCup')) $('#calcCup').style.display = isTea ? 'none' : '';
    if ($('#calcTea')) $('#calcTea').style.display = isTea ? '' : 'none';
    if (isTea) {
      $$('#panelCraft .sub').forEach(function (n) {
        var t = (n.textContent || '').trim();
        if (t.indexOf('结构') === 0 || t.indexOf('纸张') === 0) n.style.display = 'none';
      });
      var sp2 = $('#specSelect2');
      if (sp2) { var row = sp2.closest('.field-row'); if (row) row.style.display = 'none'; }
      ['#structureRow', '#paperLayers', '#liningRow'].forEach(function (sel) { var n = $(sel); if (n) n.style.display = 'none'; });
    }
    $('#ocrText').value = state.ocrText || '';
    if ($('#custOcrText')) $('#custOcrText').value = state.custOcrText || '';
    if ($('#qCustomer')) $('#qCustomer').value = state.quote.customer || '';
    if ($('#qContact')) $('#qContact').value = state.quote.contact || '';
    if ($('#qTaxNo')) $('#qTaxNo').value = state.quote.buyerTaxNo || '';
    if ($('#qAddr')) $('#qAddr').value = state.quote.buyerAddr || '';
    if ($('#qDate')) $('#qDate').value = state.quote.date || today();
    if ($('#qFreight')) $('#qFreight').value = state.quote.freight || '';
    renderCustSummary();
    $('#qOther').value = state.quote.other || '';
    if ($('#qFreight2')) $('#qFreight2').value = state.quote.freight || '';
    if ($('#freightPay')) $('#freightPay').value = state.freightPay || 'prepaid';
    $('#urgentOn').checked = state.urgent;
    if ($('#quoteTierSel')) $('#quoteTierSel').value = state.quoteTier;
    if ($('#quoteTierSel')) $('#quoteTierSel').style.display = isTea ? 'none' : '';
    $$('.cost-tabs button[data-mode]').forEach(function (b) {
      b.style.display = (b.dataset.mode === state.mode) ? '' : 'none';
    });
    sync();
    if (isTea) renderTea();

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyImg(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ==================== 版面图 ==================== */
  var IMG = { key: '', el: null };          // 已解码的图片元素，画到画布上要用

  function renderQuoteImg() {
    var box = $('#quoteImgBox');
    if (!box) return;
    var im = state.quoteImg;
    box.style.display = im ? '' : 'none';
    if (im) { var v = $('#quoteImgView'); if (v.getAttribute('src') !== im.src) v.src = im.src; }
  }

  /* 拿到已加载完的图片元素；还没加载完就返回 null（加载完会自动重画报价单） */
  function quoteImgEl() {
    var im = state.quoteImg;
    if (!im) return null;
    if (IMG.key !== im.src) {
      var el = new Image();
      IMG = { key: im.src, el: el };
      el.onload = function () {
        if (IMG.el !== el) return;
        if ($('#page-quote').classList.contains('on')) renderDoc();
      };
      el.src = im.src;
    }
    return (IMG.el.complete && IMG.el.naturalWidth) ? IMG.el : null;
  }

  /* 版面图的原始字节（生成 Word 合同要嵌进去） */
  function quoteImgBytes() {
    var im = state.quoteImg;
    if (!im || !/^data:image\/(jpeg|png);base64,/i.test(im.src)) return null;
    var b64 = im.src.split(',')[1], bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return { bytes: u, w: im.w, h: im.h };
  }

  /* 上传的图先缩小再存：最长边 1400 像素、转成 JPG。
     原图动辄好几 MB，直接存会撑爆浏览器的本机存储，报价单上也用不着那么大 */
  function compressQuoteImg(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('这不是图片文件')); return; }
      if (file.size > 30 * 1024 * 1024) { reject(new Error('图片超过 30MB，太大了')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片打不开，换一张试试')); };
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);       // 透明底转成白底
          ctx.drawImage(img, 0, 0, w, h);
          var q = 0.85, src;
          for (var n = 0; n < 4; n++) {                             // 还太大就再降一点画质
            src = cv.toDataURL('image/jpeg', q);
            if (src.length < 900000 || q <= 0.55) break;
            q -= 0.1;
          }
          var done = new Image();                                  // 先解码好，画布出图时才来得及用
          var out = { src: src, w: w, h: h, name: (file.name || '版面图').slice(0, 60) };
          done.onload = function () { out.el = done; resolve(out); };
          done.onerror = function () { resolve(out); };
          done.src = src;
        } catch (e) { reject(new Error('图片处理失败')); }
      };
      img.src = url;
    });
  }

  function loadQuoteImg(file) {
    compressQuoteImg(file).then(function (im) {
      if (im.el) IMG = { key: im.src, el: im.el };            // 已解码好的图直接记下，马上点「复制图片」也来得及画
      delete im.el;
      state.quoteImg = im;
      toast('版面图已加入，会显示在报价单和合同里');
      page('quote');
      sync();
    }).catch(function (e) { toast(e.message || '图片处理失败'); });
  }

  function initQuoteImg() {
    var f = $('#fileQuoteImg');
    if (f) f.onchange = function () { var file = this.files[0]; this.value = ''; if (file) loadQuoteImg(file); };
    var del = $('#btnQuoteImgDel');
    if (del) del.onclick = function () {
      if (!confirm('移除版面图？报价单和合同里就不再显示图片')) return;
      state.quoteImg = null;
      sync();
    };
    // 在报价页直接 Ctrl+V 粘贴截图
    document.addEventListener('paste', function (e) {
      if (!$('#page-quote').classList.contains('on')) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          e.preventDefault();
          loadQuoteImg(items[i].getAsFile());
          return;
        }
      }
    });
  }

  /* ==================== 服务器接口 ==================== */
  var API_ON = /^https?:$/.test(location.protocol);       // 双击本地打开的文件没有服务器

  function api(method, path, body) {
    if (!API_ON) return Promise.resolve({ ok: false, error: '本地打开的文件没有服务器，请在正式网址上使用' });
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return (j && j.ok) ? j : { ok: false, error: (j && j.error) || ('服务器返回 ' + r.status) };
      });
    }).catch(function () {
      return { ok: false, error: '连不上服务器，请检查网络后重试' };
    }).then(function (j) { clearTimeout(timer); return j; });
  }

  /* ==================== 单号 ==================== */
  /* PC + 日期 + 三位流水。流水号先问服务器（多人同时用时大家从同一个数往后排），
     问不到（本地打开 / 断网）就先用随机的，保存时服务器发现重号会再调 */
  var SEQ = { date: '', next: 0 };

  function ymd8(d) {
    d = d || new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function refreshSeq() {
    return api('GET', '/api/seq?date=' + ymd8()).then(function (r) {
      if (!r.ok) return r;
      SEQ = { date: today(), next: num(r.next) || 100 };
      // 页面刚打开时流水号还没回来，当时的单号是随机的：还没保存过就换成流水号
      if (state._noRand && state._noDate === today() && !(VIEW.rec && !VIEW.dirty) && !VIEW.applying) {
        state._noRand = false;
        state._no = '';
        ensureNo();
        if ($('#page-quote').classList.contains('on')) renderDoc();
        save();
      }
      return r;
    });
  }

  function ensureNo() {
    // 查看一张没改过的已保存报价单：单号就是那张单的，不换
    if (VIEW.rec && !VIEW.dirty) { state._no = VIEW.rec.no; state._noDate = today(); return; }
    if (state._no && state._noDate === today()) return;
    state._noDate = today();
    if (SEQ.date === today() && SEQ.next > 0) { state._noRand = false; state._no = 'PC' + ymd8() + '-' + (SEQ.next++); }
    else { state._noRand = true; state._no = 'PC' + ymd8() + '-' + Math.floor(Math.random() * 900 + 100); }
  }

  /* ==================== 已保存报价单 ==================== */
  /* 一张报价单 = 报价内容（inputs，客户 / 杯型 / 数量 / 工艺 / 版面图…）
     + 当时的成本表（cost）。打开旧单时成本表只是临时换进去算一下，不覆盖现在的成本表 */
  var QUOTE_KEYS = ['specId', 'lining', 'qty', 'crafts', 'plateAmort', 'urgent', 'quoteTier', 'quote', 'invoice', 'shipping', 'freightPay',
    'mode', 'tea', 'ocrText', 'custOcrText', 'quoteImg', '_no', '_noDate', 'paperSel'];
  var FP_KEYS = QUOTE_KEYS.filter(function (k) { return k !== '_no' && k !== '_noDate'; });
  var COST_KEYS = ['cupPaper', 'gradients', 'paper', 'paperStock', 'sizesExtra', 'proc', 'craftGrid', 'addon', 'lead', 'shipGrid', 'wt', 'boxCfg',
    'shipZones', 'customSpecs', 'customCrafts', 'specOrder', 'craftOrder', 'specHidden', 'specDims', 'params'];
  var D_KEYS = ['tea', 'company', 'tiers', 'invoices'];

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
  function isPlainObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function quoteFp() { return JSON.stringify(pick(state, FP_KEYS)); }

  function costSnapshot() { return { s: clone(pick(state, COST_KEYS)), d: clone(pick(D, D_KEYS)) }; }

  /* 临时换成某一版成本表来跑 fn，跑完立刻换回来。
     期间 save() 不写本机存档（见 save 开头），免得把旧成本写进现在的存档 */
  function withCost(snap, fn) {
    if (!snap || !snap.s) return fn();
    var keepS = pick(state, COST_KEYS), keepD = pick(D, D_KEYS);
    VIEW.swap = true;
    try {
      COST_KEYS.forEach(function (k) {
        var a = keepS[k], b = snap.s[k];
        if (b === undefined) return;
        // 普通对象：旧单没有的项沿用现在的（以后新加的字段），数组和其它直接整个换
        state[k] = (isPlainObj(a) && isPlainObj(b)) ? Object.assign({}, a, clone(b)) : clone(b);
      });
      D_KEYS.forEach(function (k) { if (snap.d && snap.d[k] !== undefined) D[k] = clone(snap.d[k]); });
      applySpecDims();
      return fn();
    } finally {
      COST_KEYS.forEach(function (k) { state[k] = keepS[k]; });
      D_KEYS.forEach(function (k) { D[k] = keepD[k]; });
      applySpecDims();
      VIEW.swap = false;
    }
  }

  /* 按现在的成本表算一遍（只用来对比价格和当时一样不一样） */
  function liveQuote() {
    var keep = VIEW.rec, no = state._no, nd = state._noDate;
    VIEW.rec = null;
    try { return buildQuote(); } finally { VIEW.rec = keep; state._no = no; state._noDate = nd; }
  }

  function fmtTs(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* 报价单上方的提示条：正在看哪张旧单、有没有改过、按现价算是多少 */
  function renderBanner() {
    var b = $('#savedBanner');
    if (!b) return;
    var rec = VIEW.rec;
    if (!rec) { b.style.display = 'none'; b.innerHTML = ''; return; }
    b.style.display = '';
    b.classList.toggle('changed', VIEW.dirty);
    var html;
    if (VIEW.dirty) {
      html = '正在修改已保存的报价单 <b class="sb-no">' + esc(rec.no) + '</b>　<span class="dim">有改动，价格已按<b>现在的成本</b>重新计算；点「保存」会存成新单号 ' +
        esc(state._no) + '，原单保持不变</span>';
    } else {
      html = '正在查看已保存的报价单 <b class="sb-no">' + esc(rec.no) + '</b>　<span class="dim">' + fmtTs(rec.ts) + ' 保存 · 按当时的成本计算，价格与当时一致</span>' +
        (rec.erp && rec.erp.code ? '　<span class="sb-erp">已下生产单 <b>' + esc(rec.erp.code) + '</b></span>' : '');
      try {
        var now = liveQuote(), was = state._q || buildQuote();
        if (Math.abs(now.total - was.total) > 0.005 || Math.abs(now.price - was.price) > 0.0001) {
          html += '　<span class="sb-diff">按现在的成本重算：单价 ¥' + fm(now.price) + '、合计 ¥' + fm(now.total) + '，和当时不一样</span>';
        }
      } catch (e) {}
    }
    b.innerHTML = '<span class="sb-tag">' + (VIEW.dirty ? '已修改' : '已保存') + '</span>' + html +
      '<span class="sb-btns">' +
      '<button data-act="close" title="关掉这张旧单，回到刚才在做的内容">' + (VIEW.stash ? '退出查看，回到刚才的内容' : '退出查看') + '</button>' +
      '<button data-act="del" class="danger">删除这张</button></span>';
  }

  function applyInputs(inp) {
    QUOTE_KEYS.forEach(function (k) { if (inp[k] !== undefined) state[k] = clone(inp[k]); });
    VIEW.applying = true;
    try { switchMode(state.mode); } finally { VIEW.applying = false; }
  }

  /* 打开一张已保存的报价单：页面恢复成当时的内容，价格按当时的成本算 */
  function openRecord(rec, opt) {
    opt = opt || {};
    // 记住打开之前在做的内容：没保存的新单，或者一张改到一半的旧单（回来时接着改）
    if (!opt.noStash && (!VIEW.rec || VIEW.dirty)) {
      VIEW.stash = { inputs: clone(pick(state, QUOTE_KEYS)), rec: VIEW.dirty ? VIEW.rec : null };
    }
    VIEW.rec = rec;
    VIEW.dirty = !!opt.dirty;
    VIEW.applying = true;
    try {
      page('quote');
      applyInputs(rec.inputs || {});
      state._no = rec.no; state._noDate = today();
      sync();
      VIEW.fp = quoteFp();
    } finally { VIEW.applying = false; }
    renderBanner();
    renderQuoteImg();
    window.scrollTo(0, 0);
  }

  function openById(id, opt) {
    return api('GET', '/api/quote/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) { toast(r.error || '这张报价单打不开'); forgetRecord(); return r; }
      var x = r.record;
      openRecord({ id: x.id, no: x.no, ts: x.ts, inputs: (x.data || {}).inputs || {}, cost: (x.data || {}).cost || null, erp: (x.data || {}).erp || null }, opt);
      return r;
    });
  }

  function forgetRecord() {
    if (!VIEW.rec && !VIEW.pendingId) return;
    VIEW.rec = null; VIEW.dirty = false; VIEW.pendingId = null;
    state._no = ''; state._noDate = '';
    save();
  }

  /* 退出查看：回到打开旧单之前在做的单 */
  function closeRecord() {
    var st = VIEW.stash;
    VIEW.rec = null; VIEW.dirty = false; VIEW.stash = null;
    if (st) {
      VIEW.rec = st.rec || null;                               // 之前是改到一半的旧单 → 接着改
      VIEW.dirty = !!st.rec;
      applyInputs(st.inputs);
    } else {
      state._no = ''; state._noDate = '';
    }
    sync();
    renderBanner();
  }

  function deleteRecord(id, no) {
    if (!confirm('删除报价单 ' + no + '？删除后不能恢复。')) return;
    api('DELETE', '/api/quote/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) { toast(r.error || '删除失败'); return; }
      toast('已删除 ' + no);
      if (VIEW.rec && VIEW.rec.id === id) closeRecord();
      qsRefresh();
    });
  }

  /* ---------- ERP 下单：把报价单推送到印刷 ERP 生成生产单 ---------- */
  var ERP = { mask: null, prods: [], pk: [], order: null };

  /* 按盎司数+结构挑 ERP 产品：单层 → “9盎司”；双层/中空 → 含“中空”的同盎司名 */
  function erpPickProduct(oz, structName, specName) {
    var sn = structName || '';
    var eu = /欧\s*8/.test(specName || '');
    /* ERP 里「外贴」是独立产品（9.5外贴、欧8外贴），优先匹配 */
    if (/外贴/.test(sn)) {
      var wai = ERP.prods.filter(function (p) { return p.name === (eu ? '欧8外贴' : oz + '外贴'); })[0];
      if (wai) return wai;
    }
    var hollow = /双|中空/.test(sn);
    /* 「欧8」在 ERP 是独立产品（欧8单层/欧8中空），不要落到「8盎司」上 */
    if (eu) {
      var euHit = ERP.prods.filter(function (p) { return p.name === (hollow ? '欧8中空' : '欧8单层'); })[0] ||
        ERP.prods.filter(function (p) { return p.name.indexOf(hollow ? '欧8中空' : '欧8单层') === 0; })[0];
      if (euHit) return euHit;
    }
    var want = hollow ? (oz + '中空') : (oz + '盎司');
    var hit = ERP.prods.filter(function (p) { return p.name === want; })[0];
    if (!hit && hollow) hit = ERP.prods.filter(function (p) { return p.name.indexOf(oz + '中空') === 0; })[0];
    if (!hit) hit = ERP.prods.filter(function (p) { return p.name === oz + '盎司'; })[0];
    if (!hit && hollow) hit = ERP.prods.filter(function (p) { return /欧8中空/.test(p.name); })[0];
    return hit || ERP.prods[0] || null;
  }

  /* 选每箱装多少：优先选能整除且箱数适中的 */
  function erpPickPk(qty) {
    var ok = ERP.pk.filter(function (p) { return p.per > 0 && qty % p.per === 0 && p.name.indexOf('定制') < 0; });
    var pool = ok.length ? ok : ERP.pk.filter(function (p) { return p.name.indexOf('定制') < 0; });
    if (!pool.length) pool = ERP.pk;
    pool = pool.slice().sort(function (a, b) { return b.per - a.per; });
    for (var i = 0; i < pool.length; i++) { var c = Math.ceil(qty / pool[i].per); if (c >= 5 && c <= 60) return pool[i]; }
    return pool[pool.length - 1] || null;
  }

  function erpModal(html) {
    erpClose();
    var mask = document.createElement('div');
    mask.className = 'erp-mask';
    mask.innerHTML = '<div class="erp-modal">' + html + '</div>';
    document.body.appendChild(mask);
    ERP.mask = mask;
    mask.addEventListener('click', function (e) {
      if (e.target === mask || e.target.closest('[data-erp-close]')) erpClose();
    });
    return mask;
  }
  function erpClose() { if (ERP.mask) { ERP.mask.remove(); ERP.mask = null; } }

  /* 没配账号时先填账号（存服务器 DATA/erp.json，不入 git） */
  function erpConfigUI() {
    erpModal(
      '<h3>连接印刷 ERP</h3>' +
      '<div class="erp-tip dim">填一次就行，账号保存在服务器上（ERP 的登录账号）</div>' +
      '<label>ERP 地址<input id="erpCfgUrl" value="http://dhbz.chenhukeji.cn"></label>' +
      '<label>账号<input id="erpCfgUser"></label>' +
      '<label>密码<input id="erpCfgPass" type="password"></label>' +
      '<div class="erp-foot"><button class="btn" data-erp-close>取消</button><button class="btn primary" id="erpCfgSave">保存并继续</button></div>');
    $('#erpCfgSave').onclick = function () {
      var user = $('#erpCfgUser').value.trim(), pass = $('#erpCfgPass').value;
      if (!user || !pass) { toast('账号和密码都要填'); return; }
      api('POST', '/api/erp', { config: { url: $('#erpCfgUrl').value.trim(), user: user, pass: pass } }).then(function (r) {
        if (!r.ok) { toast(r.error || '保存失败'); return; }
        toast('已保存 ERP 账号');
        erpOpen();
      });
    };
  }

  function erpOpen() {
    if (!VIEW.rec || VIEW.dirty) { toast('请先点「保存」存好这张报价单，再下生产单'); return; }
    api('GET', '/api/erp?w=config').then(function (r) {
      if (!r.ok || !r.config || !r.config.configured) { erpConfigUI(); return; }
      return api('GET', '/api/erp?w=meta').then(function (m) {
        if (!m.ok) { toast('ERP 连不上：' + (m.error || '') + '　点「下单ERP」重试'); erpConfigUI(); return; }
        ERP.prods = m.products || [];
        if (VIEW.rec.erp && VIEW.rec.erp.code) {
          if (!confirm('这张单已经下过生产单 ' + VIEW.rec.erp.code + '，要再下一张新的吗？')) return;
        }
        erpFormUI();
      });
    });
  }

  function erpFormUI() {
    var q = state._q || buildQuote();
    var oz = num(q.spec && q.spec.oz) || 0;
    var prod = erpPickProduct(oz, q.struct, q.spec && q.spec.name);
    var freightCharged = (state.freightPay !== 'collect') ? num(q.freight) : 0;
    var d0 = new Date(Date.now() + (num(q.leadDays) || 7) * 86400000);
    var defDate = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
    /* 物流公司联动：报价单选的运费方式 → ERP 物流公司名（可改） */
    var shipMap = { sf: '顺丰', yto: '圆通', zto: '中通快运', logistics: '创新物流' };
    var shipDefault = shipMap[state.shipping];
    if (shipDefault === undefined) shipDefault = state.shipping && state.shipping !== 'none' ? '创新物流' : '创新物流';
    if (state.shipping === 'none') shipDefault = '';
    var layout = [q.spec.name, q.struct, q.lining, (q.crafts || []).join('、'), '四色印刷', '印刷要求(按图印刷)']
      .filter(Boolean).join(';') + ';';
    var remark = '报价单 ' + (q.no || '') + (state.freightPay === 'collect' ? '；运费到付' : '');

    erpModal(
      '<h3>下生产单到印刷 ERP</h3>' +
      '<div class="erp-sum">' + esc(q.spec.name) + '　' + esc(q.struct) + '　' + fq(q.qty) + ' 只 × ¥' + fm(q.price) +
      ' ＝ <b>¥' + fm(q.total) + '</b>' + (freightCharged > 0 ? '（含运费 ¥' + fm(freightCharged) + '）' : '') + '</div>' +
      /* 产品与纸种自动按报价单匹配（隐藏，不需要人工选） */
      '<div style="display:none"><select id="erpProd"></select><select id="erpPaper"></select></div>' +
      '<label>装箱<select id="erpPk"></select></label>' +
      '<label id="erpPackRow" style="display:none">包装要求（定制内容，写进 ERP 包装要求）<input id="erpPack" placeholder="如：定制彩盒 / 装茶不用包装"></label>' +
      '<label>客户（报价单自动带过去，ERP 没有同名会自动建档）<span class="dim">' + esc(q.customer || '') + '　' + esc(q.contact || '') + '</span></label>' +
      '<label>业务员（选 ERP 系统用户，存进客户档案）<select id="erpSale"><option value="">（不填）</option></select></label>' +
      '<label>交货日期（今天 + 生产周期' + (num(q.leadDays) || 7) + ' 天）<input id="erpDate" type="date" value="' + defDate + '"></label>' +
      '<label>物流公司（按报价单的运费方式自动带出）<input id="erpLogi" value="' + esc(shipDefault) + '"></label>' +
      '<label>版面 / 工艺说明（进 ERP 的「订单详情」）<textarea id="erpLayout" rows="2">' + esc(layout) + '</textarea></label>' +
      '<label>备注<input id="erpRemark" value="' + esc(remark) + '"></label>' +
      '<div class="erp-foot"><button class="btn" data-erp-close>取消</button><button class="btn primary" id="erpGo">确认下单</button></div>');

    var selP = $('#erpProd'), selK = $('#erpPk'), selPa = $('#erpPaper');
    selP.innerHTML = ERP.prods.map(function (p) {
      return '<option value="' + p.id + '"' + (prod && p.id === prod.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
    function loadPaper() {
      var gsm = num(q.cupGram) || 0;
      return api('GET', '/api/erp?w=papers&pid=' + selP.value).then(function (r) {
        var ps = (r.ok && r.list || []).filter(function (p) { return p && p.name && p.suttleId; });
        var pick = ps.filter(function (p) { return p.name.indexOf(gsm + 'g') >= 0; })[0] ||
          ps.filter(function (p) { return p.def === 1; })[0] || ps[0];
        selPa.innerHTML = ps.map(function (p) {
          return '<option value="' + p.suttleId + '"' + (pick && p.suttleId === pick.suttleId ? ' selected' : '') +
            ' data-name="' + esc(p.name) + '" data-paper="' + esc(p.paper || '') + '">' + esc(p.name) + '</option>';
        }).join('');
      });
    }
    function loadPk() {
      return api('GET', '/api/erp?w=pk&pid=' + selP.value).then(function (r) {
        ERP.pk = (r.ok && r.list) || [];
        var pick = erpPickPk(num(q.qty)) || ERP.pk[0];
        selK.innerHTML = ERP.pk.map(function (p) {
          return '<option value="' + p.goodId + '" data-per="' + p.per + '"' + (pick && p.goodId === pick.goodId ? ' selected' : '') + '>' +
            esc(p.name) + '（每箱 ' + fq(p.per) + ' 只）</option>';
        }).join('') + '<option value="custom">定制…</option>';
        syncPackRow();
      });
    }
    /* 装箱选「定制…」才出现包装要求输入框 */
    function syncPackRow() {
      var row = $('#erpPackRow'), inp = $('#erpPack');
      if (row) row.style.display = selK.value === 'custom' ? '' : 'none';
      if (selK.value !== 'custom' && inp) inp.value = '';
    }
    loadPk();
    loadPaper();
    selK.onchange = syncPackRow;
    selP.onchange = function () { selK.innerHTML = '<option>加载中…</option>'; selPa.innerHTML = '<option>加载中…</option>'; loadPk(); loadPaper(); };

    /* 客户名称/联系人直接取报价单，ERP 确认框不再输入 */

    /* 业务员下拉：ERP 系统用户名单 */
    api('GET', '/api/erp?w=saleman').then(function (r) {
      var sel = $('#erpSale');
      if (r.ok) sel.innerHTML += (r.list || []).map(function (u) {
        return '<option value="' + esc(u.name) + '">' + esc(u.name) + '</option>';
      }).join('');
    });

    $('#erpGo').onclick = function () {
      var cust = String(q.customer || '').trim();
      if (!cust) { toast('报价单还没填客户公司'); return; }
      var opt = selK.options[selK.selectedIndex];
      /* 选了「定制…」：装箱规格仍按数量自动挑最合适的（planVoList 需要），定制内容走包装要求 */
      if (selK.value === 'custom') {
        var autoPk = erpPickPk(num(q.qty)) || ERP.pk[0];
        opt = null;
        for (var oi = 0; oi < selK.options.length; oi++) if (num(selK.options[oi].value) === autoPk.goodId) { opt = selK.options[oi]; break; }
      }
      var per = opt ? num(opt.dataset.per) : 0;
      if (!per) { toast('装箱规格没取到'); return; }
      var count = Math.ceil(q.qty / per);
      var packSelVal = selK.value === 'custom' ? opt.value : selK.value;
      var btn = $('#erpGo');
      btn.disabled = true; btn.textContent = '正在下单…';
      var order = {
        name: ((q.no ? q.no + ' ' : '') + q.spec.name).slice(0, 60),
        productId: num(selP.value), product: selP.options[selP.selectedIndex].text,
        productSize: selP.options[selP.selectedIndex].text + '||' + selP.options[selP.selectedIndex].text,
        color: '4||四色', printSided: '1||单面',
        orderQty: q.qty, unitPrice: q.price, productMoney: q.amount, orderMoney: q.total,
        sendFee: 0, trueSendFee: freightCharged, deliverTime: $('#erpDate').value,
        remark: $('#erpRemark').value.trim(), paperRemark: '', mainOrderInfo: $('#erpLayout').value.trim(),
        operate: 2, orderStatus: 0, origin: '线下渠道', autoLayoutFlag: 0,
        planVoList: [{ packageType: 0, packageId: num(packSelVal), count: count, num: per }]
      };
      /* 纸种关键词与工艺名，给服务端去 ERP 字典里匹配（材质名→ERP 纸种名前缀） */
      var paperTxt = String(q.paper || '');
      var kwMap = { '白卡纸': '白卡', '金箔纸': '金箔', '银箔纸': '银箔', '铝箔纸': '铝箔', '牛皮纸': '牛皮', '涂布纸': '涂布', '纸杯纸': '口杯' };
      var paperKw = /双淋膜/.test(paperTxt) ? '双淋膜' : /单淋膜/.test(paperTxt) ? '单淋膜' :
        (function () {
          for (var k in kwMap) if (paperTxt.indexOf(k) >= 0) return kwMap[k];
          return paperTxt.trim().split(/\s+/).filter(function (w) { return w !== '内层' && w !== '外层'; })[0] || '';
        })();
      api('POST', '/api/erp', {
        customer: {
          name: cust, contact: String(q.contact || '').trim(),
          receiveAddress: String(q.addr || '').trim(), saleMan: $('#erpSale').value.trim()
        },
        order: order,
        crafts: q.crafts || [],
        paperGsm: num(q.cupGram) || 0,
        paperKw: paperKw.replace(/g$/i, ''),
        saleMan: $('#erpSale').value.trim(),
        logistics: $('#erpLogi').value.trim(),
        packInfo: (selK.value === 'custom' && $('#erpPack')) ? $('#erpPack').value.trim() : '',
        paper: (selPa.value ? { suttleId: num(selPa.value), name: selPa.options[selPa.selectedIndex].getAttribute('data-name'), paperName: selPa.options[selPa.selectedIndex].getAttribute('data-paper') } : null),
        design: (state.quoteImg && state.quoteImg.src) ? {
          name: (q.no ? q.no : 'layout') + '-版面图.jpg',
          b64: state.quoteImg.src,
          w: state.quoteImg.w || 0, h: state.quoteImg.h || 0
        } : null
      }).then(function (r) {
        if (!r.ok) { toast(r.error || '下单失败'); btn.disabled = false; btn.textContent = '确认下单'; return; }
        toast('已下生产单 ' + r.code);
        erpClose();
        if (VIEW.rec) {
          VIEW.rec.erp = { code: r.code, id: r.id, ts: Date.now() };
          api('POST', '/api/quote', { id: VIEW.rec.id, erp: VIEW.rec.erp });
          renderBanner();
        }
      }).catch(function () { btn.disabled = false; btn.textContent = '确认下单'; });
    };
  }

  /* 报价单上的「保存」 */
  function saveQuote() {
    if (VIEW.saving) return;
    if (VIEW.rec && !VIEW.dirty) { toast('这张报价单已经保存过了，还没有改动'); return; }
    var q = state._q || buildQuote();
    var inputs = clone(pick(state, QUOTE_KEYS));
    var again = !!VIEW.rec;                                   // 看着一张旧单再保存 = 另存新单号
    VIEW.saving = true;
    toast('正在保存…');
    api('POST', '/api/quote', {
      no: again ? '' : state._no,
      spec: (q.spec && q.spec.name) || '',
      total: q.total,
      data: { inputs: inputs, cost: costSnapshot() }
    }).then(function (r) {
      VIEW.saving = false;
      if (!r.ok) { toast(r.error || '保存失败'); return; }
      var changed = r.no !== state._no;
      inputs._no = r.no;
      VIEW.rec = { id: r.id, no: r.no, ts: r.ts, inputs: inputs, cost: costSnapshot() };
      VIEW.dirty = false;                                   // stash 不清：那是来查旧单之前在做的内容，退出查看时还要回去
      state._no = r.no; state._noDate = today();
      VIEW.fp = quoteFp();
      refreshSeq();
      save();
      renderDoc();
      renderBanner();
      toast(changed ? '已保存，单号 ' + r.no : '已保存');
    }).catch(function () { VIEW.saving = false; });
  }

  /* 刷新页面后接着显示上次在看的那张旧单 */
  function initView() {
    if (!API_ON) return;
    if (VIEW.pendingId) {
      var id = VIEW.pendingId, dirty = VIEW.pendingDirty;
      VIEW.pendingId = null;
      openById(id, { noStash: true, dirty: dirty });
    } else {
      refreshSeq();
    }
  }

  /* ==================== 顶部搜索栏 ==================== */
  var qs = { timer: 0, q: null, rows: [], idx: -1, seq: 0 };

  function qsHide() { var d = $('#qSearchDrop'); if (d) d.style.display = 'none'; qs.idx = -1; }

  function qsRefresh() { if (qs.q !== null) { var k = qs.q; qs.q = null; qsQuery(k); } }

  function qsQuery(q) {
    var drop = $('#qSearchDrop');
    if (!drop) return;
    var my = ++qs.seq;                                       // 只认最后一次请求的结果（输得快时前后会乱序回来）
    api('GET', '/api/search?q=' + encodeURIComponent(q)).then(function (r) {
      if (my !== qs.seq) return;
      qs.q = q;
      qs.rows = r.ok ? r.list : [];
      qs.idx = -1;
      if (!r.ok) {
        drop.innerHTML = '<div class="qs-empty">' + esc(r.error || '搜索不了') + '</div>';
      } else if (!qs.rows.length) {
        drop.innerHTML = '<div class="qs-empty">' + (q ? '没有找到「' + esc(q) + '」相关的报价单' : '还没有保存过报价单') + '</div>';
      } else {
        drop.innerHTML = (q ? '' : '<div class="qs-head">最近保存</div>') + qs.rows.map(function (x, i) {
          return '<div class="qs-item" data-id="' + esc(x.id) + '" data-i="' + i + '">' +
            '<span class="qs-no">' + esc(x.no) + '</span>' +
            '<span class="qs-cust">' + esc(x.cust || '（没填客户）') + (x.contact ? '<i>' + esc(x.contact) + '</i>' : '') + '</span>' +
            '<span class="qs-spec">' + esc(x.spec || '') + (x.qty ? ' · ' + fq(x.qty) : '') + '</span>' +
            '<span class="qs-amt">' + (x.total ? '¥' + fm(x.total) : '') + '</span>' +
            '<span class="qs-date">' + fmtTs(x.ts) + '</span>' +
            '<button class="qs-del" data-del="' + esc(x.id) + '" data-no="' + esc(x.no) + '" title="删除这张报价单">×</button>' +
            '</div>';
        }).join('');
      }
      drop.style.display = '';
    });
  }

  function qsMark() {
    $$('#qSearchDrop .qs-item').forEach(function (n, i) { n.classList.toggle('on', i === qs.idx); });
  }

  function initSearch() {
    var inp = $('#qSearchInput'), drop = $('#qSearchDrop');
    if (!inp || !drop) return;
    if (!API_ON) { inp.disabled = true; inp.placeholder = '本地打开没有搜索（请在正式网址上用）'; return; }
    inp.addEventListener('input', function () {
      clearTimeout(qs.timer);
      var v = inp.value.trim();
      qs.timer = setTimeout(function () { qsQuery(v); }, 180);
    });
    inp.addEventListener('focus', function () { var v = inp.value.trim(); clearTimeout(qs.timer); qs.q = null; qsQuery(v); });
    inp.addEventListener('blur', function () { setTimeout(qsHide, 160); });
    inp.addEventListener('keydown', function (e) {
      var items = $$('#qSearchDrop .qs-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        qs.idx = (qs.idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        qsMark();
        items[qs.idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (qs.idx >= 0 && items[qs.idx]) { e.preventDefault(); items[qs.idx].click(); }
      } else if (e.key === 'Escape') {
        qsHide(); inp.blur();
      }
    });
    // 按下时不让输入框失焦，否则列表先消失、点击就落空
    drop.addEventListener('mousedown', function (e) { e.preventDefault(); });
    drop.addEventListener('click', function (e) {
      var del = e.target.closest('.qs-del');
      if (del) { deleteRecord(del.dataset.del, del.dataset.no); return; }
      var it = e.target.closest('.qs-item');
      if (!it) return;
      var row = qs.rows[+it.dataset.i];
      if (!row) return;
      $('#qSearchInput').value = row.no;
      qsHide();
      openById(row.id, {});
    });
    var banner = $('#savedBanner');
    if (banner) banner.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b || !VIEW.rec) return;
      if (b.dataset.act === 'close') closeRecord();
      else if (b.dataset.act === 'del') deleteRecord(VIEW.rec.id, VIEW.rec.no);
    });
    var sb = $('#btnSaveQuote');
    if (sb) sb.onclick = saveQuote;
    var eb = $('#btnErp');
    if (eb) eb.onclick = erpOpen;
  }

  /* 右上角显示当前版本：取自脚本地址里的 ?v=（打镜像时填的提交号），用来确认浏览器跑的是不是新版 */
  (function () {
    var sc = document.querySelector('script[src*="app.js"]');
    var m = sc ? /(?:[?&])v=([^&]+)/.exec(sc.getAttribute('src') || '') : null;
    var v = m && m[1] !== '__V__' ? m[1] : '';
    var box = $('#appVer');
    if (v && box) { box.textContent = '版本 ' + v; box.style.display = ''; }
  })();

  window.PC_APP = {
    tiers: tiers, costDetail: costDetail, unitCost: unitCost, cupCost: cupCost,
    cupPaperCalc: cupPaperCalc, cupCfg: cupCfg, fanBlank: fanBlank, autoPack: autoPack, paperCfg: paperCfg, paperById: paperById,
    procCost: procCost, craftPrice: craftPrice, fanArea: fanArea,
    leadTime: leadTime, leadText: leadText,
    teaCalc: teaCalc, renderTea: renderTea, switchMode: switchMode, teaData: teaData,
    shipAutoCalc: shipAutoCalc, shipCost: shipCost, curGram: curGram,
    build: buildQuote, text: quoteText, draw: drawDoc, moneyCN: moneyCN,
    contract: contractData, contractHTML: contractHTML, contractDOCX: contractDOCX,
    recognize: recognize, state: state, data: D, save: save, renderShipQuote: renderShipQuote,
// 已保存报价单 / 服务器接口（调试与自测用）
view: VIEW, api: api, openById: openById, saveQuote: saveQuote, renderBanner: renderBanner, costSnapshot: costSnapshot,
switchPage: page, sync: sync
  };
})();