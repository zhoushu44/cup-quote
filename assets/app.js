/* ============================================================
   纸杯报价 · 简约版
   成本 = 数量梯度表（杯型 × 数量 → 单只成本）
        + 结构加价 + 淋膜加价
        + 材质加价（按层累计：内外都双金 = 加两次）
        + 克重加价（按层）
        + 工艺加价（同样按数量梯度）
   报价 = 成本 ÷ (1 − 毛利率) × (1 + 税率)
   对客户只展示一个价（默认标准价）
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
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 1800); }

  var state = {
    specId: 'ad-9-268',
    structure: 'single',
    papers: [{ material: 'cupstock', weight: 268 }, { material: 'cupstock', weight: 248 }],
    lining: 'single',
    qty: 10000,
    crafts: [],
    plateAmort: false,
    urgent: false,
    quoteTier: 1,            // 对客户展示哪一档：0 底价 / 1 标准 / 2 品牌
    quote: { customer: '', contact: '', date: today(), freight: 0, other: 0, buyerTaxNo: '', buyerAddr: '' },
    invoice: 'none',
    shipping: 'none',
    freightPay: 'prepaid',
    shipGrid: {},
    wt: {},                 // 每个杯型的实测单杯克重（空=自动估算）
    customSpecs: [],        // 自定义杯型
    specOrder: null,        // 杯型显示顺序（id 数组）
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
    grid: {},                // specId -> [每档成本]
    craftGrid: {},           // craftId -> [每档加价]
    addon: {
      struct: { single: 0, double: 0.055, corrugated: 0.065, outer: 0.016 },
      lining: { none: 0, single: 0, double: 0.020 },
      material: { cupstock: 0, white: 0.004, kraft: -0.004, coated: 0.002, gold: 0.10, silver: 0.09, corr: 0.030 },
      weight: 0.013          // 每 100g 每层
    },
    params: JSON.parse(JSON.stringify(D.params)),
    lead: JSON.parse(JSON.stringify(D.leadTime)),
    ocrText: ''
  };

  /* ---------------- 参考成本（仅首次填充） ---------------- */
  function areaOf(sp) {
    var r1 = sp.top / 2000, r2 = sp.bottom / 2000, h = sp.height / 1000;
    var slant = Math.sqrt(h * h + (r1 - r2) * (r1 - r2));
    return Math.PI * (r1 + r2) * slant * 1.06 * 1.08;
  }

  /* 单杯克重（克）：各层纸张 + 淋膜 + 杯底
     areaOf 返回单层展开面积（m²，已含 6% 卷边 / 8% 损耗） */
  function cupGram(sp, structure, papers, liningId) {
    var a = areaOf(sp);                        // m²
    var st = D.structures.filter(function (x) { return x.id === structure; })[0] || { layers: 1 };
    var layers = st.layers || 1;
    var g = 0;
    for (var i = 0; i < layers; i++) {
      var cfg = (papers || [])[i] || (papers || [])[0] || {};
      var w = num(cfg.weight) || sp.defW;
      g += a * w;                              // a(m²) × w(g/m²) = 克
    }
    // 淋膜：PE 膜约 18g/m²，双淋膜按面数
    var ln = (D.linings || []).filter(function (x) { return x.id === liningId; })[0] || { sides: 1 };
    g += a * 18 * (num(ln.sides) || 0);
    // 杯底片：半径≈下口，另加一片
    var r2 = sp.bottom / 2000;
    g += Math.PI * r2 * r2 * sp.defW * 1.15;
    return Math.round(g * 10) / 10;
  }
  /* 单杯克重：纯手动输入，未填返回 0（不再自动估算） */
  function gramOf(sp) {
    return num((state.wt || {})[sp.id]) || 0;
  }

  /* 当前杯型的单杯克重（手动值；未填返回 0） */
  function curGram() {
    return gramOf(spec());
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

  function suggestCost(sp, qty) {
    var a = areaOf(sp);
    var paper = a * (sp.defW / 1000) * (6800 / 1000);
    var proc = 0.008 + 0.004 + 0.002 + (20 / Math.max(1, qty));
    return Math.round((paper + proc) * 100000) / 100000;
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
    D.specs.forEach(function (s) {
      if (!state.grid[s.id]) state.grid[s.id] = state.gradients.map(function (g) { return suggestCost(s, g); });
      while (state.grid[s.id].length < state.gradients.length) {
        state.grid[s.id].push(suggestCost(s, state.gradients[state.grid[s.id].length]));
      }
    });
    // 兼容旧版「中空」结构
    if (state.structure === 'hollow') state.structure = 'double';
    if (!state.addon.struct.double) state.addon.struct.double = 0.055;
    if (state.addon.struct.hollow != null) delete state.addon.struct.hollow;
  }

  /* ---------------- 存取 ---------------- */
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        specId: state.specId, structure: state.structure, papers: state.papers,
        lining: state.lining, qty: state.qty, crafts: state.crafts,
        plateAmort: state.plateAmort, urgent: state.urgent, quoteTier: state.quoteTier,
        quote: state.quote, gradients: state.gradients, grid: state.grid,
        craftGrid: state.craftGrid, addon: state.addon, lead: state.lead,
        shipGrid: state.shipGrid, wt: state.wt, boxCfg: state.boxCfg, shipZones: state.shipZones, customSpecs: state.customSpecs, customCrafts: state.customCrafts, specOrder: state.specOrder, craftOrder: state.craftOrder,
        invoice: state.invoice, shipping: state.shipping, freightPay: state.freightPay,
        mode: state.mode, tea: state.tea,
        params: state.params, ocrText: state.ocrText
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
      ['specId', 'structure', 'papers', 'lining', 'qty', 'crafts', 'ocrText'].forEach(function (k) {
        if (o[k] != null) state[k] = o[k];
      });
      ['plateAmort', 'urgent'].forEach(function (k) { if (typeof o[k] === 'boolean') state[k] = o[k]; });
      ['invoice', 'shipping', 'freightPay'].forEach(function (k) { if (o[k]) state[k] = o[k]; });
      if (o.mode) state.mode = o.mode;
      if (o.tea) state.tea = Object.assign(state.tea, o.tea);
      if (typeof o.quoteTier === 'number') state.quoteTier = o.quoteTier;
      if (o.quote) Object.assign(state.quote, o.quote);
      if (o.gradients && o.gradients.length) state.gradients = o.gradients;
      if (o.grid) state.grid = o.grid;
      if (o.craftGrid) state.craftGrid = o.craftGrid;
      if (o.shipGrid) state.shipGrid = o.shipGrid;
      if (o.wt) state.wt = o.wt;
      if (o.shipZones) state.shipZones = o.shipZones;
      if (o.customSpecs) state.customSpecs = o.customSpecs;
      if (o.specOrder) state.specOrder = o.specOrder;
      if (o.craftOrder) state.craftOrder = o.craftOrder;
      if (o.customCrafts) state.customCrafts = o.customCrafts;
      if (o.boxCfg) state.boxCfg = o.boxCfg;
      if (o.addon) state.addon = Object.assign(state.addon, o.addon);
      if (o.lead) state.lead = Object.assign(state.lead, o.lead);
      if (o.params) Object.assign(state.params, o.params);
    } catch (e) {}
  }

  /* ---------------- 取值 ---------------- */
  function spec() { return D.specs.filter(function (s) { return s.id === state.specId; })[0] || D.specs[0]; }
  function struct() { return D.structures.filter(function (s) { return s.id === state.structure; })[0] || D.structures[0]; }
  function mat(id) { return D.materials.filter(function (m) { return m.id === id; })[0] || D.materials[0]; }
  function lining() { return D.linings.filter(function (l) { return l.id === state.lining; })[0] || D.linings[1]; }

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

  function baseCost(specId, qty) { return interp(state.grid[specId] || [], qty); }
  function craftPrice(id, qty) { return interp(state.craftGrid[id] || [], qty); }

  /* 单只成本（含全部加价） */
  function costDetail() {
    var sp = spec(), st = struct(), ad = state.addon, p = state.params;
    var d = { base: 0, struct: 0, lining: 0, material: 0, weight: 0, craft: 0, total: 0, layers: [] };

    d.base = baseCost(sp.id, state.qty);
    d.struct = num(ad.struct[st.id]) || 0;
    d.lining = num(ad.lining[state.lining]) || 0;

    var n = st.layers;
    for (var i = 0; i < n; i++) {
      var cfg = state.papers[i] || state.papers[0];
      var w = num(cfg.weight);
      var mAdd = num(ad.material[cfg.material]) || 0;      // 每层各加一次
      var baseW = i === 0 ? sp.defW : 0;                    // 内层以杯型默认克重为基准，外层全算增量
      var wAdd = num(ad.weight) * ((w - baseW) / 100);

      d.material += mAdd;
      d.weight += wAdd;
      d.layers.push({ i: i, cfg: cfg, mat: mat(cfg.material), mAdd: mAdd, wAdd: wAdd, w: w });
    }

    state.crafts.forEach(function (id) { d.craft += craftPrice(id, state.qty); });

    d.total = d.base + d.struct + d.lining + d.material + d.weight + d.craft;
    if (state.urgent) { d.urgentAdd = num(p.urgentFee) || 300; d.total += d.urgentAdd; }
    return d;
  }

  function unitCost() { return costDetail().total; }
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
    state.crafts.forEach(function (id) {
      var c = D.crafts.filter(function (x) { return x.id === id; })[0];
      if (c && c.plate) s += c.plate;
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
  function leadTime(specId, structureId, craftIds, papers) {
    var L = state.lead || D.leadTime;
    var sp = D.specs.filter(function (s) { return s.id === (specId || state.specId); })[0] || spec();
    var st = structureId || state.structure;
    var cr = craftIds || state.crafts;
    var pp = papers || state.papers;

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
        var c = D.crafts.filter(function (x) { return x.id === id; })[0];
        cNames.push((c ? c.name : id) + ' +' + add);
      }
    });
    if (cAdd) { d += cAdd; parts.push({ label: cNames.join('、'), d: cAdd }); }

    if (state.urgent) {
      d = Math.min(d, num(L.urgentDays) || 3);
      parts = [{ label: '加急', d: d }];
    }

    return { days: Math.max(1, Math.round(d)), parts: parts };
  }

  function leadText(specId, structureId, craftIds, papers) {
    var r = leadTime(specId, structureId, craftIds, papers);
    return r.days + ' 天';
  }

  function tiers() {
    var uc = unitCost();
    var p = state.params;
    // 版费始终摊入单价（对外不单列）
    var per = state.qty > 0 ? plate() / state.qty : 0;
    var cost = uc + per;
    var tr = taxRate();          // 按开票类型取税点

    return D.tiers.map(function (t) {
      var price = cost / (1 - Math.min(t.margin, 0.9));
      price *= (1 + tr);
      var step = p.round > 0 ? p.round : 0.001;
      price = p.roundUp ? Math.ceil(price / step) * step : Math.round(price / step) * step;
      return {
        name: t.name, margin: t.margin, cost: cost, price: price,
        amount: price * state.qty,
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
    var st = struct(), parts = [];
    parts.push('<span>' + st.name + '</span>');
    for (var i = 0; i < st.layers; i++) {
      var cfg = state.papers[i] || state.papers[0];
      parts.push('<span>' + (st.layers > 1 ? (i === 0 ? '内 ' : '外 ') : '') + mat(cfg.material).name + ' ' + cfg.weight + 'g</span>');
    }
    parts.push('<span>' + lining().name + '</span>');
    if (state.crafts.length) {
      parts.push('<span class="hi">' + state.crafts.map(function (id) {
        var c = D.crafts.filter(function (x) { return x.id === id; })[0];
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
    var sp = spec(), st = struct();
    var papers = [];
    for (var i = 0; i < st.layers; i++) papers.push(state.papers[i] || state.papers[0]);

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

  function renderStruct() {
    var box = $('#structureChips');
    box.innerHTML = '';
    D.structures.forEach(function (s) {
      var b = el('button', state.structure === s.id ? 'on' : '', s.name);
      b.title = s.desc;
      b.onclick = function () {
        state.structure = s.id;
        if (s.layers > 1 && !state.papers[1]) state.papers[1] = { material: 'cupstock', weight: 248 };
        sync();
      };
      box.appendChild(b);
    });
    var st = struct();
    $('#structHint').textContent = st.layers > 1 ? '两层纸（内 + 外）' : '一层纸';
    $('#paperLabel').textContent = st.layers > 1 ? '纸张（内层 / 外层）' : '纸张';
  }

  function renderPapers() {
    var box = $('#paperLayers');
    box.innerHTML = '';
    var n = struct().layers;
    var tags = n === 1 ? ['杯身纸'] : ['内层', '外层'];

    for (var i = 0; i < n; i++) {
      if (!state.papers[i]) state.papers[i] = { material: 'cupstock', weight: i === 0 ? spec().defW : 248 };
      var cfg = state.papers[i];
      var row = el('div', 'paper-row');

      row.appendChild(el('span', 'ptag', tags[i]));

      var ms = document.createElement('select');
      D.materials.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        var add = num(state.addon.material[m.id]) || 0;
        o.textContent = m.name + (add ? '（' + (add > 0 ? '+' : '') + fp(add) + '）' : '');
        if (m.id === cfg.material) o.selected = true;
        ms.appendChild(o);
      });

      var ws = document.createElement('select');
      ws.className = 'wt';
      D.weights.forEach(function (w) {
        var o = document.createElement('option');
        o.value = w; o.textContent = w + 'g';
        if (w === cfg.weight) o.selected = true;
        ws.appendChild(o);
      });

      // 用 IIFE 固定每层的 cfg 与控件，避免闭包串层
      (function (cfg, ms, ws, idx) {
        ms.onchange = function () { state.papers[idx].material = ms.value; sync(); };
        ws.onchange = function () { state.papers[idx].weight = num(ws.value); sync(); };
      })(cfg, ms, ws, i);

      row.appendChild(ms);
      row.appendChild(ws);
      box.appendChild(row);
    }
  }

  function renderLining() {
    var sel = $('#liningSel');
    sel.innerHTML = D.linings.map(function (l) {
      var add = num(state.addon.lining[l.id]) || 0;
      return '<option value="' + l.id + '">' + l.name + (add ? '（+' + fp(add) + '）' : '') + '</option>';
    }).join('');
    sel.value = state.lining;
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
    $('#tierNote').innerHTML = '<b>' + fq(state.qty) + '</b> 只　|　成本 <b>¥' + fp(rows[0].cost) + '</b>/只　|　' +
      bracketHint() + '　|　<span style="color:var(--ac)">报价单只给「' + D.tiers[state.quoteTier].name + '」</span>';
  }

  function bracketHint() {
    var g = state.gradients, arr = state.grid[state.specId] || [];
    var pts = [];
    for (var i = 0; i < g.length; i++) {
      var v = arr[i];
      if (v != null && v !== '' && isFinite(v) && v > 0) pts.push([g[i], +v]);
    }
    if (!pts.length) return '未填成本';
    if (state.qty <= pts[0][0]) return '取最低档 ' + fq(pts[0][0]);
    if (state.qty >= pts[pts.length - 1][0]) return '取最高档 ' + fq(pts[pts.length - 1][0]);
    for (var j = 0; j < pts.length - 1; j++) {
      if (state.qty >= pts[j][0] && state.qty <= pts[j + 1][0]) {
        return fq(pts[j][0]) + '–' + fq(pts[j + 1][0]) + ' 档插值';
      }
    }
    return '';
  }

  function renderCrafts() {
    var box = $('#craftChips');
    box.innerHTML = '';
    D.crafts.forEach(function (c) {
      var on = state.crafts.indexOf(c.id) >= 0;
      var v = craftPrice(c.id, state.qty);
      var b = el('button', on ? 'on' : '', c.name + '<span class="cp">+' + fp(v) + '</span>');
      b.title = c.desc + (c.plate ? '（另收版费 ' + c.plate + ' 元，见报价单）' : '');
      b.onclick = function () {
        var i = state.crafts.indexOf(c.id);
        if (i >= 0) state.crafts.splice(i, 1); else state.crafts.push(c.id);
        sync();
      };
      box.appendChild(b);
    });
  }

  /* 开票类型 */
  function renderInvoice() {
    var box = $('#invoiceChips');
    if (!box) return;
    box.innerHTML = '';
    (D.invoices || []).forEach(function (inv) {
      var on = state.invoice === inv.id;
      var rate = num(inv.rate) || 0;
      var b = el('button', on ? 'on' : '', inv.name + (rate ? '<span class="cp">' + (rate * 100).toFixed(0) + '%</span>' : ''));
      b.onclick = function () { state.invoice = inv.id; sync(); };
      box.appendChild(b);
    });
    var hint = $('#invoiceHint');
    if (hint) {
      var inv = invoiceObj();
      hint.textContent = num(inv.rate) ? '税点 ' + (num(inv.rate) * 100).toFixed(0) + '%' : '不含税';
    }
  }

  /* 运费方式 */
  function renderShipping() {
    var box = $('#shippingChips');
    if (!box) return;
    box.innerHTML = '';
    (D.shipping || []).forEach(function (s) {
      var on = state.shipping === s.id;
      var b = el('button', on ? 'on' : '', s.name);
      b.title = s.desc || '';
      b.onclick = function () {
        state.shipping = s.id;
        // 选了快递：按梯度表自动带出运费
        if (s.id !== 'none' && state.freightPay === 'prepaid') {
          state.quote.freight = shipCost(s.id, state.qty);
          if ($('#qFreight2')) $('#qFreight2').value = Math.round(state.quote.freight);
        }
        if (s.id === 'none') {
          state.quote.freight = 0;
          if ($('#qFreight2')) $('#qFreight2').value = '';
        }
        sync();
      };
      box.appendChild(b);
    });
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
    ['#structureChips', '#paperLayers', '#liningRow'].forEach(function (sel) {
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
    for (var i = 0; i < st.layers; i++) {
      var cfg = state.papers[i] || state.papers[0];
      papers.push((st.layers > 1 ? (i === 0 ? '内层 ' : '外层 ') : '') + mat(cfg.material).name + ' ' + cfg.weight + 'g');
    }

    if (!state._no || state._noDate !== today()) {
      var d = new Date();
      state._noDate = today();
      state._no = 'PC' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(Math.floor(Math.random() * 900 + 100));
    }

    // 明细行：杯子本体 + 版费 + 运费 + 其他
    var items = [];
    items.push({
      idx: 1,
      name: sp.name,
      spec: sp.oz + 'oz / ' + sp.ml + 'ml　上口 ' + sp.top + ' × 下口 ' + sp.bottom + ' × 高 ' + sp.height + 'mm　' + sp.defW + 'g',
      craft: st.name + '　' + papers.join('　') + '　' + lining().name +
        (state.crafts.length ? '　' + state.crafts.map(function (id) {
          var c = D.crafts.filter(function (x) { return x.id === id; })[0];
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
        var c = D.crafts.filter(function (x) { return x.id === id; })[0];
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

    if (!state._no || state._noDate !== today()) {
      var d = new Date();
      state._noDate = today();
      state._no = 'PC' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(Math.floor(Math.random() * 900 + 100));
    }

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
    var q = buildQuote();
    var s = q.spec;
    var c = q.company;

    var trs = q.items.map(function (it) {
      return '<tr>' +
        '<td class="c">' + it.idx + '</td>' +
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
            '<th>品名及规格</th>' +
            '<th class="c" style="width:46px">单位</th>' +
            '<th class="r" style="width:78px">数量</th>' +
            '<th class="r" style="width:78px">单价(元)</th>' +
            '<th class="r" style="width:92px">金额(元)</th>' +
          '</tr></thead>' +
          '<tbody>' + trs +
            '<tr class="sum"><td colspan="5" class="r">合计金额（' + (taxRate() > 0 ? '含税' : '不含税') + '）</td><td class="r b">' + fm(q.total) + '</td></tr>' +
            '<tr class="cn"><td colspan="6">金额大写：' + moneyCN(q.total) + '</td></tr>' +
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

    var rows = c.items.map(function (it) {
      return '<tr>' +
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

      '<table class="items"><thead><tr>' +
      '<th style="width:22%">定作物品名称</th><th style="width:19%">规格型号</th>' +
      '<th style="width:7%">单位</th><th style="width:10%">数量</th>' +
      '<th style="width:11%">单价</th><th style="width:13%">总金额</th>' +
      '<th style="width:18%">备注</th>' +
      '</tr></thead><tbody>' + rows +
      '<tr><td colspan="5" class="r"><b>合计</b></td><td class="r"><b>' + fm(c.total) + '</b></td><td class="sm cn">' + moneyCN(c.total) + '</td></tr>' +
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

    /* 明细表 */
    var cols = [2120, 1830, 680, 960, 1060, 1260, 1728];
    var rows = [{
      header: true,
      cells: [
        { text: '定作物品名称', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '规格型号', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '单位', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '数量', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '单价', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '总金额', align: 'center', font: H, shade: 'F2F2F2' },
        { text: '备注', align: 'center', font: H, shade: 'F2F2F2' }
      ]
    }];

    c.items.forEach(function (it) {
      rows.push({
        cells: [
          { text: it.name },
          { text: it.spec || '—' },
          { text: it.unit, align: 'center' },
          { text: fq(it.qty), align: 'center' },
          { text: fm(it.price), align: 'right' },
          { text: fm(it.amount), align: 'right' },
          { text: it.note || '', sz: 16 }
        ]
      });
    });

    rows.push({
      cells: [
        { text: '合计', span: 5, align: 'right', b: true, shade: 'F8F6F2' },
        { text: fm(c.total), align: 'right', b: true, shade: 'F8F6F2' },
        { text: moneyCN(c.total), sz: 16, shade: 'F8F6F2' }
      ]
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

    return D3.build(B, c.title + ' ' + c.no);
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
    if (!c.buyer.name) missing.push('客户名');
    if (missing.length) {
      if (!confirm('以下信息还没填：' + missing.join('、') + '\n合同仍可导出，但抬头会留空。继续？')) return;
    }
    try {
      var blob = contractDOCX(opt);
      saveBlob(blob, '纸杯采购合同-' + (c.buyer.name || '客户') + '-' + c.q.date + '.docx');
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
    var nameW = maxW - idxW - unitW - qtyW - priceW - amtW;
    var rowH = [];
    var sumRow = 0;
    q.items.forEach(function (it) {
      var h = 20;
      if (it.spec) h += 14;
      if (it.craft) {
        it.craft.split('<br>').forEach(function (seg) {
          h += Math.round(14 * lineCount(ctx, seg, nameW - 14));
        });
      }
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
    var x0 = pad, x1 = x0 + idxW, x2 = x1 + nameW, x3 = x2 + unitW, x4 = x3 + qtyW, x5 = x4 + priceW, x6 = x5 + amtW;

    // 表头
    ctx.fillStyle = '#f2f0ec';
    ctx.fillRect(x0, y, maxW, 26);
    ctx.fillStyle = '#333';
    ctx.font = '600 10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('序号', x0 + idxW / 2, y + 17);
    ctx.textAlign = 'left'; ctx.fillText('品名及规格', x1 + 8, y + 17);
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

      ctx.textAlign = 'left';
      ctx.font = '600 11px "Microsoft YaHei", sans-serif';
      ctx.fillText(it.name, x1 + 8, y + 16);

      ctx.font = '400 9.5px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#777';
      var ty = y + 30;
      if (it.spec) { ctx.fillText(it.spec, x1 + 8, ty); ty += 14; }
      if (it.craft) {
        it.craft.split('<br>').forEach(function (seg) {
          var n = lineCount(ctx, seg, nameW - 16);
          wrap(ctx, seg, x1 + 8, ty, nameW - 16, 13);
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
    if (mi) mats.push(mi);
    if (mo) mats.push(mo);
    if (!mats.length) {
      // 全文中出现多个材质时按顺序取
      ['gold','silver','kraft','corr','coated','white'].forEach(function (k) {
        if (MAT_ALIAS[k].test(raw) && mats.indexOf(k) < 0) mats.push(k);
      });
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
  /* 识别结果：可编辑的确认清单 */
  function renderOcr() {
    var raw = $('#ocrText').value;
    var box = $('#ocrResult');
    if (!raw.trim()) { box.className = 'ocr-out dim'; box.textContent = '识别结果会显示在这里'; return; }

    var r = recognize(raw);
    var specs = allSpecs();

    // 下拉选项
    var specOpts = specs.map(function (s) {
      return '<option value="' + s.id + '"' + (r.spec && r.spec.id === s.id ? ' selected' : '') + '>' +
        esc(s.name) + '（' + s.oz + 'oz/' + s.ml + 'ml）</option>';
    }).join('');

    var structOpts = D.structures.map(function (st) {
      return '<option value="' + st.id + '"' + (r.struct === st.id ? ' selected' : '') + '>' + esc(st.name) + '</option>';
    }).join('');

    var craftChecks = (D.crafts || []).map(function (c) {
      var on = r.crafts.indexOf(c.id) >= 0;
      return '<label class="ck"><input type="checkbox" value="' + c.id + '"' + (on ? ' checked' : '') + '>' + esc(c.name) + '</label>';
    }).join('');

    var matOpts = function (sel) {
      return D.materials.map(function (m) {
        return '<option value="' + m.id + '"' + (sel === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      }).join('');
    };

    var html = '';
    html += '<div class="ocr-form">';

    // 数量
    html += '<div class="of-row"><span class="of-l">数量</span>' +
      '<input type="number" id="ofQty" min="1" step="100" value="' + (r.qty || '') + '" placeholder="如 100000">' +
      '<span class="of-u">只</span></div>';

    // 杯型
    html += '<div class="of-row"><span class="of-l">杯型</span>' +
      '<select id="ofSpec">' + (r.spec ? '' : '<option value="">— 未匹配，请选 —</option>') + specOpts + '</select></div>';

    // 结构
    html += '<div class="of-row"><span class="of-l">结构</span>' +
      '<select id="ofStruct">' + structOpts + '</select></div>';

    // 克重
    html += '<div class="of-row"><span class="of-l">克重</span>' +
      '<input type="number" id="ofW1" min="150" step="1" value="' + (r.w1 || '') + '" placeholder="内层">' +
      '<input type="number" id="ofW2" min="150" step="1" value="' + (r.w2 || '') + '" placeholder="外层">' +
      '<span class="of-u">g</span></div>';

    // 材质
    html += '<div class="of-row"><span class="of-l">材质</span>' +
      '<select id="ofM1">' + matOpts(r.mats[0] || 'cupstock') + '</select>' +
      '<select id="ofM2">' + matOpts(r.mats[1] || r.mats[0] || 'cupstock') + '</select></div>';

    // 淋膜
    html += '<div class="of-row"><span class="of-l">淋膜</span>' +
      '<select id="ofLining">' + D.linings.filter(function (l) { return l.id !== 'none'; }).map(function (l) {
        var sel = r.lining ? (r.lining === l.id) : (l.id === 'single');
        return '<option value="' + l.id + '"' + (sel ? ' selected' : '') + '>' + esc(l.name) + '</option>';
      }).join('') + '</select></div>';

    // 工艺
    html += '<div class="of-row of-craft"><span class="of-l">工艺</span><div class="of-ck">' + craftChecks + '</div></div>';

    html += '</div>';

    // 提示
    var tip = [];
    if (!r.spec) tip.push('杯型没认出来，请手动选');
    if (!r.qty) tip.push('数量没认出来，请手动填');
    if (tip.length) html += '<div class="ocr-tip">⚠ ' + tip.join('；') + '</div>';
    else html += '<div class="ocr-tip ok">✓ 识别到 ' + (r.spec ? r.spec.name : '') + '，确认无误后点应用</div>';

    html += '<div class="of-actions"><button class="btn" id="btnApply">应用到报价</button>' +
      '<button class="link" id="btnOcrReset">重新识别</button></div>';

    box.className = 'ocr-out';
    box.innerHTML = html;

    // 结构变化时同步内外层输入可用状态
    var stSel = $('#ofStruct');
    function syncW() {
      var st = D.structures.filter(function (x) { return x.id === stSel.value; })[0] || { layers: 1 };
      var w2 = $('#ofW2'), m2 = $('#ofM2');
      if (w2) w2.disabled = st.layers < 2;
      if (m2) m2.disabled = st.layers < 2;
    }
    if (stSel) { stSel.onchange = syncW; syncW(); }

    $('#btnApply').onclick = function () {
      var st = $('#ofStruct').value;
      var layers = (D.structures.filter(function (x) { return x.id === st; })[0] || { layers: 1 }).layers;
      var result = {
        spec: specs.filter(function (x) { return x.id === $('#ofSpec').value; })[0] || null,
        struct: st,
        qty: num($('#ofQty').value) || 0,
        w1: num($('#ofW1').value) || null,
        w2: layers > 1 ? (num($('#ofW2').value) || null) : null,
        mats: layers > 1 ? [$('#ofM1').value, $('#ofM2').value] : [$('#ofM1').value],
        lining: $('#ofLining').value,
        crafts: $$('#ocrResult .of-ck input:checked').map(function (x) { return x.value; })
      };
      apply(result);
    };
    $('#btnOcrReset').onclick = function () { renderOcr(); };

    var panel = $('#panelCraft');
    if (panel) panel.classList.add('flash');
    setTimeout(function () { if (panel) panel.classList.remove('flash'); }, 1400);
  }

  function apply(r) {
    if (r.spec) state.specId = r.spec.id;
    if (r.struct) state.structure = r.struct;
    if (r.qty) state.qty = r.qty;
    if (r.crafts.length) state.crafts = r.crafts.slice();
    if (r.lining) state.lining = r.lining;

    var n = struct().layers;
    for (var i = 0; i < n; i++) {
      if (!state.papers[i]) state.papers[i] = { material: 'cupstock', weight: 248 };
      if (i === 0 && r.w1) state.papers[i].weight = r.w1;
      if (i === 1 && r.w2) state.papers[i].weight = r.w2;
      if (!state.papers[i].weight) state.papers[i].weight = i === 0 ? r.spec.defW : 248;
      if (r.mats.length) state.papers[i].material = r.mats[i] || r.mats[0];
    }
    sync();
    toast('已应用');
    var hint = $('#adjustHint');
    if (hint) {
      hint.textContent = '已应用，可在下方改';
      hint.style.color = 'var(--ac)';
      setTimeout(function () { hint.textContent = '识别后在这里改'; hint.style.color = ''; }, 3500);
    }
  }

  /* ---------------- 成本页 ---------------- */
  function renderGradients() {
    var box = $('#gradList');
    if (!box) return;
    box.innerHTML = '';
    state.gradients.forEach(function (g, i) {
      var item = el('div', 'grad-item');
      var inp = document.createElement('input');
      inp.type = 'number'; inp.value = g; inp.min = 1; inp.step = 100;
      inp.onchange = function () {
        state.gradients[i] = Math.max(1, Math.round(num(inp.value)));
        save(); renderGradientTable(); sync();
      };
      var del = el('button', 'del', '×');
      del.title = '删除该梯度';
      del.onclick = function () {
        if (state.gradients.length <= 1) { toast('至少保留一档'); return; }
        state.gradients.splice(i, 1);
        D.specs.forEach(function (s) { if (state.grid[s.id]) state.grid[s.id].splice(i, 1); });
        D.crafts.forEach(function (c) { if (state.craftGrid[c.id]) state.craftGrid[c.id].splice(i, 1); });
        save(); renderGradients(); renderGradientTable(); sync();
      };
      item.appendChild(inp); item.appendChild(del);
      box.appendChild(item);
    });

    var add = el('button', 'add', '+ 加一档');
    add.onclick = function () {
      var last = state.gradients[state.gradients.length - 1] || 1000;
      var next = Math.round(last * 2 / 100) * 100;
      state.gradients.push(next);
      D.specs.forEach(function (s) {
        if (!state.grid[s.id]) state.grid[s.id] = [];
        state.grid[s.id].push(state.grid[s.id][state.grid[s.id].length - 1] || suggestCost(s, next));
      });
      D.crafts.forEach(function (c) {
        if (!state.craftGrid[c.id]) state.craftGrid[c.id] = [];
        state.craftGrid[c.id].push(state.craftGrid[c.id][state.craftGrid[c.id].length - 1] || c.prices[1]);
      });
      save(); renderGradients(); renderGradientTable(); renderCraftTable(); sync();
    };
    box.appendChild(add);
  }

  /* 梯度表：杯型行支持 添加/删除/上下移动（自定义杯型存 state.customSpecs） */
  function renderGradientTable() {
    var tbl = $('#gradTable');
    if (!tbl) return;
    var specs = allSpecs();
    var head = '<thead><tr>' +
      '<th class="l">杯型</th>' +
      '<th class="cap-th">容量</th>' +
      '<th>纸张克重</th>' +
      state.gradients.map(function (g) { return '<th>' + fq(g) + ' 只</th>'; }).join('') +
      '<th>当前成本</th><th>发货时间</th><th style="width:76px"></th></tr></thead>';

    var rows = specs.map(function (s, si) {
      var arr = state.grid[s.id] || [];
      var cur = baseCost(s.id, state.qty);
      var base = leadTime(s.id, 'single', [], [{ weight: s.defW }]);
      var isCustom = s.id.indexOf('custom-') === 0;
      return '<tr data-rid="' + s.id + '"' + (s.id === state.specId ? ' class="cur"' : '') + '>' +
        '<td class="nm">' + esc(s.name) + '</td>' +
        '<td class="cap-cell">' + (s.oz || '—') + 'oz / ' + (s.ml || '—') + 'ml</td>' +
        '<td class="wt-cell">' + (s.defW || '—') + 'g</td>' +
        state.gradients.map(function (g, i) {
          return '<td><input type="number" min="0" step="0.001" data-s="' + s.id + '" data-i="' + i + '" value="' + (arr[i] != null ? arr[i] : '') + '"></td>';
        }).join('') +
        '<td class="cur-cell">' + (cur ? '¥' + fp(cur) : '—') + '</td>' +
        '<td class="lead-cell" title="' + esc(base.parts.map(function (x) { return x.label + ' +' + x.d; }).join('　')) + '">' + base.days + ' 天</td>' +
        '<td class="ops-cell">' + rowOps('spec', s.id, si, specs.length) + '</td>' +
        '</tr>';
    });

    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';

    $$('#gradTable input').forEach(function (inp) {
      inp.onchange = function () {
        var id = inp.dataset.s, i = +inp.dataset.i;
        if (!state.grid[id]) state.grid[id] = [];
        state.grid[id][i] = inp.value === '' ? null : num(inp.value);
        save(); sync();
        var curCell = inp.closest('tr').querySelector('.cur-cell');
        var c = baseCost(id, state.qty);
        if (curCell) curCell.textContent = c ? '¥' + fp(c) : '—';
      };
    });
    makeSortable('#gradTable', 'spec', function () { renderGradientTable(); renderSpecSelect(); sync(); });
    bindRowOps('#gradTable', function () {
      // 删除自定义杯型时清理 grid
      state.customSpecs = state.customSpecs.filter(function (s) {
        if (s._del) { delete state.grid[s.id]; return false; }
        return true;
      });
      renderGradientTable(); renderSpecSelect(); sync();
    });

    // 添加杯型按钮
    var addBox = $('#gradAddRow');
    if (addBox) addBox.style.display = '';
  }

  /* 添加自定义杯型 */
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
    state.grid[id] = state.gradients.map(function (g) { return suggestCost(spec, g); });
    $('#specModal').classList.remove('on');
    save(); renderGradientTable(); renderSpecSelect(); sync();
    toast('已添加「' + name + '」');
  }
  function renderWeightTable() {
    var tbl = $('#wtTable');
    if (!tbl) return;

    var head = '<thead><tr>' +
      '<th class="l">杯型</th>' +
      '<th>单杯克重 (g)</th>' +
      '<th class="l">箱规（可多行）</th>' +
      '<th>箱体 m³</th>' +
      '<th>总重</th>' +
      '</tr></thead>';

    var rows = D.specs.map(function (s) {
      var g1 = gramOf(s);
      var hasW = g1 > 0;
      var boxes = boxesOf(s);
      var totalKg = hasW ? g1 * state.qty / 1000 : 0;
      // 选与订单最接近的箱规来算体积展示
      var best = boxes.filter(function (b) { return b.per > 0 && state.qty >= b.per; }).pop() || boxes[0];
      var vol = best && best.per > 0 ? (best.l * best.w * best.h / 1e6) : 0;

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
        '<td><div class="inp-wrap">' +
          '<input type="number" min="0" step="0.1" class="mini-inp" data-wtg="' + s.id + '" placeholder="填写" value="' + (hasW ? g1 : '') + '">' +
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
        var sp = D.specs.filter(function (x) { return x.id === id; })[0];
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
  function allSpecs() {
    var all = (state.customSpecs || []).concat(D.specs);
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
  /* 行操作：只剩删除按钮（排序改用拖拽） */
  function rowOps(kind, id, idx, total) {
    var canDel = (kind === 'teaSize' || kind === 'teaPack' || (id && String(id).indexOf('custom-') === 0));
    return '<span class="row-ops">' +
      '<span class="drag-handle" title="按住拖动排序">⋮⋮</span>' +
      (canDel ? '<button class="rop rop-del" data-op="del" data-kind="' + kind + '" data-idx="' + idx + '" title="删除">×</button>' : '') +
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
        if (!dragRow || dragRow === tr) return;
        e.preventDefault();
        tr.classList.add('drag-over');
      });
      tr.addEventListener('dragleave', function () { tr.classList.remove('drag-over'); });
      tr.addEventListener('drop', function (e) {
        if (!dragRow || dragRow === tr) return;
        e.preventDefault();
        tr.classList.remove('drag-over');
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
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
        save();
        afterChange();
      });
    });
  }

  /* 绑定删除按钮 */
  function bindRowOps(container, afterChange) {
    $$(container + ' .rop').forEach(function (b) {
      b.onclick = function () {
        var kind = b.dataset.kind, op = b.dataset.op, idx = +b.dataset.idx;
        if (op !== 'del') return;
        var arr = listFor(kind);
        var item = arr[idx];
        arr.splice(idx, 1);
        if (kind === 'spec' && item && item.id && state.grid) delete state.grid[item.id];
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

  function renderAddon() {
    var tbl = $('#addonTable');
    if (!tbl) return;
    var ad = state.addon;
    var html = '<thead><tr><th class="l">加价项</th><th>加价（元/只）</th><th class="l">说明</th></tr></thead><tbody>';

    html += '<tr class="grp"><td colspan="3">结构加价（相对于单层，只加一次）</td></tr>';
    D.structures.forEach(function (s) {
      html += '<tr><td class="nm">' + s.name + '</td><td><input type="number" step="0.001" data-a="struct" data-k="' + s.id + '" value="' + (ad.struct[s.id] != null ? ad.struct[s.id] : 0) + '"></td><td class="ds">' + esc(s.desc) + '</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">淋膜加价（相对于单淋膜，只加一次）</td></tr>';
    D.linings.forEach(function (l) {
      html += '<tr><td class="nm">' + l.name + '</td><td><input type="number" step="0.001" data-a="lining" data-k="' + l.id + '" value="' + ad.lining[l.id] + '"></td><td class="ds">' + esc(l.desc) + '</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">材质加价（<b>按层累计</b>：每一层纸各自加一次，内层加了外层还要再加）</td></tr>';
    html += '<tr class="hl"><td colspan="3">例：内外双金箔 = 金箔纸 0.10 × 2 层 = <b>+0.20 元/只</b>（不是 0.10）</td></tr>';
    D.materials.forEach(function (m) {
      html += '<tr><td class="nm">' + m.name + '</td><td><input type="number" step="0.001" data-a="material" data-k="' + m.id + '" value="' + ad.material[m.id] + '"></td><td class="ds">' + esc(m.desc) + '</td></tr>';
    });

    html += '<tr class="grp"><td colspan="3">克重加价（按层）</td></tr>';
    html += '<tr><td class="nm">每 100g</td><td><input type="number" step="0.001" data-a="weight" data-k="1" value="' + ad.weight + '"></td><td class="ds">内层相对杯型默认克重算增减；外层是全新增量，全部计入</td></tr>';

    html += '</tbody>';
    tbl.innerHTML = html;

    $$('#addonTable input').forEach(function (inp) {
      inp.onchange = function () {
        var a = inp.dataset.a, k = inp.dataset.k;
        if (a === 'weight') state.addon.weight = num(inp.value);
        else state.addon[a][k] = num(inp.value);
        save(); sync();
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
  function sync() {
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
    if ($('#page-cost').classList.contains('on')) { renderGradientTable(); renderCraftTable(); }
  }

  function page(name) {
    $$('.tabs button[data-page]').forEach(function (b) { b.classList.toggle('on', b.dataset.page === name); });
    $$('.page').forEach(function (p) { p.classList.toggle('on', p.id === 'page-' + name); });
    if (name === 'ship') { shipTabs(); if (!document.getElementById('shipPanels').innerHTML) renderShipCompany((D.shipping || [])[1].id); renderShipQuote(); }
    if (name === 'cost') {
      renderGradients(); renderGradientTable(); renderAddon(); renderCraftTable(); renderTeaCost(); renderLeadTable(); renderParams();
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
    if (s.group === '中空杯') state.structure = 'double';
    else if (s.group === '外贴/银箔') state.structure = 'outer';
    else if (s.group === '金箔铝箔') {
      state.structure = 'double';
      state.papers[0] = { material: 'gold', weight: 300 };
      state.papers[1] = { material: 'gold', weight: 300 };
    } else state.structure = 'single';
    if (state.papers[0]) state.papers[0].weight = s.defW;
    sync();
  }

  function setQty(v) {
    state.qty = Math.max(1, Math.round(num(v)));
    ['#qtyInput', '#qtyInput2'].forEach(function (s) { var n = $(s); if (n && n.value != state.qty) n.value = state.qty; });
    renderTiers(); renderCrafts(); renderDoc(); save();
  }

  function bind() {
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

    $('#liningSel').onchange = function () { state.lining = this.value; sync(); };
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

    $('#qCustomer').oninput = function () { state.quote.customer = this.value; renderDoc(); save(); };
    $('#qContact').oninput = function () { state.quote.contact = this.value; renderDoc(); save(); };
    if ($('#qTaxNo')) $('#qTaxNo').oninput = function () { state.quote.buyerTaxNo = this.value; renderDoc(); save(); };
    if ($('#qAddr')) $('#qAddr').oninput = function () { state.quote.buyerAddr = this.value; renderDoc(); save(); };
    $('#qDate').onchange = function () { state.quote.date = this.value; renderDoc(); save(); };
    $('#qFreight').oninput = function () {
      state.quote.freight = num(this.value);
      if ($('#qFreight2')) $('#qFreight2').value = this.value;
      renderDoc(); save();
    };
    $('#qOther').oninput = function () { state.quote.other = num(this.value); renderDoc(); save(); };

    $('#btnOcr').onclick = renderOcr;
    $('#ocrText').oninput = function () { state.ocrText = this.value; save(); };
    $('#ocrText').onkeydown = function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') renderOcr(); };
    $('#btnExample').onclick = function () {
      $('#ocrText').value = '10万只 9盎司广告杯，268克，双层，内层268外层248，内外都是金箔纸，烫金加压纹';
      renderOcr();
    };
    $('#btnClearOcr').onclick = function () { $('#ocrText').value = ''; state.ocrText = ''; renderOcr(); save(); };

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
        ['grad', 'addon', 'craft', 'weight', 'tea', 'teaweight', 'lead', 'param'].forEach(function (k) {
          var box = $('#costTab' + (k.charAt(0).toUpperCase() + k.slice(1)));
          if (box) box.style.display = k === t ? '' : 'none';
        });
        if (t === 'tea') renderTeaCost();
        if (t === 'weight') renderWeightTable();
        if (t === 'teaweight') renderTeaWeight();
      };
    });

    $('#btnFillSuggest').onclick = function () {
      if (!confirm('用「纸价估算值」覆盖梯度表所有格？已填的会被覆盖。')) return;
      D.specs.forEach(function (s) {
        state.grid[s.id] = state.gradients.map(function (g) { return suggestCost(s, g); });
      });
      save(); renderGradientTable(); sync();
      toast('已填充参考成本');
    };

    $('#btnExportCost').onclick = function () {
      var head = ['杯型', '规格'].concat(state.gradients.map(function (g) { return g + '只'; }));
      var L = [head.join(',')];
      D.specs.forEach(function (s) {
        var arr = state.grid[s.id] || [];
        L.push([s.name, s.oz + 'oz/' + s.defW + 'g'].concat(state.gradients.map(function (g, i) { return arr[i] != null ? arr[i] : ''; })).join(','));
      });
      saveBlob(new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' }), '成本梯度表.csv');
    };

    $('#btnExportAll').onclick = function () {
      saveBlob(new Blob([JSON.stringify({
        v: 3, gradients: state.gradients, grid: state.grid, craftGrid: state.craftGrid,
        addon: state.addon, params: state.params, tiers: D.tiers, company: D.company
      }, null, 2)], { type: 'application/json' }), '纸杯报价备份.json');
    };

    $('#btnImport').onclick = function () { $('#fileImport').click(); };
    $('#fileImport').onchange = function () {
      var f = this.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var o = JSON.parse(fr.result);
          if (o.gradients) state.gradients = o.gradients;
          if (o.grid) state.grid = o.grid;
          if (o.craftGrid) state.craftGrid = o.craftGrid;
          if (o.addon) state.addon = o.addon;
          if (o.params) Object.assign(state.params, o.params);
          if (o.tiers) D.tiers = o.tiers;
          if (o.company) Object.assign(D.company, o.company);
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
      ['#structureChips', '#paperLayers', '#liningRow'].forEach(function (sel) { var n = $(sel); if (n) n.style.display = 'none'; });
    }
    $('#ocrText').value = state.ocrText || '';
    $('#qCustomer').value = state.quote.customer || '';
    $('#qContact').value = state.quote.contact || '';
    if ($('#qTaxNo')) $('#qTaxNo').value = state.quote.buyerTaxNo || '';
    if ($('#qAddr')) $('#qAddr').value = state.quote.buyerAddr || '';
    $('#qDate').value = state.quote.date || today();
    $('#qFreight').value = state.quote.freight || '';
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
    if (state.ocrText) renderOcr();

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyImg(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PC_APP = {
    tiers: tiers, costDetail: costDetail, unitCost: unitCost,
    baseCost: baseCost, craftPrice: craftPrice, areaOf: areaOf,
    leadTime: leadTime, leadText: leadText,
    teaCalc: teaCalc, renderTea: renderTea, switchMode: switchMode, teaData: teaData,
    shipAutoCalc: shipAutoCalc, shipCost: shipCost, curGram: curGram,
    build: buildQuote, text: quoteText, draw: drawDoc, moneyCN: moneyCN,
    contract: contractData, contractHTML: contractHTML, contractDOCX: contractDOCX,
    recognize: recognize, state: state, data: D, save: save, renderShipQuote: renderShipQuote
  };
})();





















































































