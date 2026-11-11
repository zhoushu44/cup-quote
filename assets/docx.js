/* ============================================================
   PC_DOCX —— 纯前端 DOCX 生成器（无依赖，离线可用）
   生成真正的 .docx（OOXML + ZIP Store）
   ============================================================ */
window.PC_DOCX = (function () {
  'use strict';

  /* ---------- CRC32 ---------- */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(b) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function u8(str) { return new TextEncoder().encode(str); }

  /* ---------- ZIP（Store，不压缩） ---------- */
  function zip(files) {
    var parts = [], central = [], offset = 0;
    var d = new Date();
    var dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

    files.forEach(function (f) {
      var nb = u8(f.name), data = f.data, crc = crc32(data);

      var lo = new Uint8Array(30 + nb.length);
      var dv = new DataView(lo.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nb.length, true);
      dv.setUint16(28, 0, true);
      lo.set(nb, 30);

      parts.push(lo, data);

      var cd = new Uint8Array(46 + nb.length);
      var d2 = new DataView(cd.buffer);
      d2.setUint32(0, 0x02014b50, true);
      d2.setUint16(4, 20, true);
      d2.setUint16(6, 20, true);
      d2.setUint16(8, 0x0800, true);
      d2.setUint16(10, 0, true);
      d2.setUint16(12, dosTime, true);
      d2.setUint16(14, dosDate, true);
      d2.setUint32(16, crc, true);
      d2.setUint32(20, data.length, true);
      d2.setUint32(24, data.length, true);
      d2.setUint16(28, nb.length, true);
      d2.setUint16(30, 0, true);
      d2.setUint16(32, 0, true);
      d2.setUint16(34, 0, true);
      d2.setUint16(36, 0, true);
      d2.setUint32(38, 0, true);
      d2.setUint32(42, offset, true);
      cd.set(nb, 46);
      central.push(cd);

      offset += lo.length + data.length;
    });

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var d3 = new DataView(end.buffer);
    d3.setUint32(0, 0x06054b50, true);
    d3.setUint16(8, files.length, true);
    d3.setUint16(10, files.length, true);
    d3.setUint32(12, cdSize, true);
    d3.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end]), {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  /* ---------- XML 片段 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  var SONG = 'SimSun', HEI = 'SimHei', TNR = 'Times New Roman';

  function rPr(o) {
    o = o || {};
    var f = o.font || SONG;
    var x = '<w:rPr><w:rFonts w:ascii="' + (o.ascii || f) + '" w:hAnsi="' + (o.ascii || f) +
      '" w:eastAsia="' + (o.ea || f) + '" w:cs="' + (o.ascii || f) + '"/>';
    if (o.b) x += '<w:b/><w:bCs/>';
    if (o.i) x += '<w:i/>';
    if (o.u) x += '<w:u w:val="single"/>';
    if (o.color) x += '<w:color w:val="' + o.color + '"/>';
    if (o.sz) x += '<w:sz w:val="' + o.sz + '"/><w:szCs w:val="' + o.sz + '"/>';
    x += '</w:rPr>';
    return x;
  }

  function run(text, o) {
    if (text == null || text === '') return '';
    return '<w:r>' + rPr(o) + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }

  /* 段落：text 可为字符串或 [{t, ...样式}] 数组 */
  function p(text, o) {
    o = o || {};
    var pp = '<w:pPr>';
    if (o.style) pp += '<w:pStyle w:val="' + o.style + '"/>';
    var sp = '';
    if (o.line) sp += ' w:line="' + o.line + '" w:lineRule="auto"';
    if (o.before != null) sp += ' w:before="' + o.before + '"';
    if (o.after != null) sp += ' w:after="' + o.after + '"';
    if (o.beforeLines != null) sp += ' w:beforeLines="' + o.beforeLines + '"';
    if (o.afterLines != null) sp += ' w:afterLines="' + o.afterLines + '"';
    if (sp) pp += '<w:spacing' + sp + '/>';
    if (o.align) pp += '<w:jc w:val="' + o.align + '"/>';
    if (o.indent != null) pp += '<w:ind w:firstLine="' + o.indent + '"/>';
    if (o.left != null) pp += '<w:ind w:left="' + o.left + '"/>';
    if (o.keepNext) pp += '<w:keepNext/>';
    pp += '<w:rPr>' + (o.font ? '<w:rFonts w:ascii="' + o.font + '" w:hAnsi="' + o.font + '" w:eastAsia="' + o.font + '"/>' : '') +
      (o.sz ? '<w:sz w:val="' + o.sz + '"/>' : '') + '</w:rPr>';
    pp += '</w:pPr>';

    var body = '';
    if (Array.isArray(text)) {
      text.forEach(function (seg) { body += run(seg.t, Object.assign({}, o, seg)); });
    } else {
      body = run(text, o);
    }
    return '<w:p>' + pp + body + '</w:p>';
  }

  /* 表格 */
  function tbl(rows, opt) {
    opt = opt || {};
    var W = opt.width || 9412;
    var cols = opt.cols || [];
    var borders = opt.borders === false ? '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
        return '<w:' + s + ' w:val="none" w:sz="0" w:space="0" w:color="auto"/>';
      }).join('') + '</w:tblBorders>' :
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) {
        return '<w:' + s + ' w:val="' + (opt.borderStyle || 'single') + '" w:sz="' + (opt.borderSz || 4) +
          '" w:space="0" w:color="' + (opt.borderColor || '000000') + '"/>';
      }).join('') + '</w:tblBorders>';

    var x = '<w:tbl><w:tblPr>' +
      '<w:tblW w:w="' + W + '" w:type="dxa"/>' +
      '<w:tblLayout w:type="fixed"/>' +
      borders +
      '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
      '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
      '</w:tblPr>';

    if (cols.length) {
      x += '<w:tblGrid>' + cols.map(function (c) { return '<w:gridCol w:w="' + c + '"/>'; }).join('') + '</w:tblGrid>';
    }

    rows.forEach(function (r) {
      x += '<w:tr>';
      if (r.header) x += '<w:trPr><w:tblHeader/></w:trPr>';
      if (r.height) x += '<w:trPr><w:trHeight w:val="' + r.height + '" w:hRule="atLeast"/></w:trPr>';
      (r.cells || []).forEach(function (cell, i) {
        var w = cols[i] || Math.round(W / (r.cells.length || 1));
        var span = cell.span || 1;
        var cw = w;
        for (var k = 1; k < span; k++) cw += (cols[i + k] || w);
        x += '<w:tc><w:tcPr><w:tcW w:w="' + cw + '" w:type="dxa"/>' +
          (span > 1 ? '<w:gridSpan w:val="' + span + '"/>' : '') +
          (cell.shade ? '<w:shd w:val="clear" w:color="auto" w:fill="' + cell.shade + '"/>' : '') +
          '<w:vAlign w:val="' + (cell.valign || 'center') + '"/>' +
          '</w:tcPr>';
        var lines = cell.lines || [cell.text || ''];
        lines.forEach(function (ln, li) {
          if (typeof ln === 'string') {
            x += p(ln, {
              align: cell.align || 'left',
              sz: cell.sz || 19,
              font: cell.font || SONG,
              b: cell.b,
              before: li === 0 ? 20 : 0, after: 20, line: 240
            });
          } else {
            x += p(ln.t, Object.assign({
              align: cell.align || 'left', sz: cell.sz || 19,
              font: cell.font || SONG, before: li === 0 ? 20 : 0, after: 20, line: 240
            }, ln));
          }
        });
        x += '</w:tc>';
      });
      x += '</w:tr>';
    });

    x += '</w:tbl>';
    return x;
  }

  /* ---------- 打包 ---------- */
  var CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  var RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  var DOC_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  var STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="' + TNR + '" w:hAnsi="' + TNR + '" w:eastAsia="' + SONG + '" w:cs="' + TNR + '"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:style>' +
    '</w:styles>';

  function coreXml(title) {
    var d = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(title) + '</dc:title>' +
      '<dc:creator>纸杯报价系统</dc:creator>' +
      '<cp:lastModifiedBy>纸杯报价系统</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + d + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + d + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  var APP =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity>' +
    '</Properties>';

  /* 生成本体：bodyXml 为 <w:p>/<w:tbl> 序列 */
  function build(bodyXml, title) {
    var sectPr = '<w:sectPr>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" ' +
      'w:header="851" w:footer="992" w:gutter="0"/>' +
      '<w:docGrid w:linePitch="312"/>' +
      '</w:sectPr>';

    var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:body>' + bodyXml +
      '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>' +
      sectPr + '</w:body></w:document>';

    return zip([
      { name: '[Content_Types].xml', data: u8(CONTENT_TYPES) },
      { name: '_rels/.rels', data: u8(RELS) },
      { name: 'word/document.xml', data: u8(doc) },
      { name: 'word/_rels/document.xml.rels', data: u8(DOC_RELS) },
      { name: 'word/styles.xml', data: u8(STYLES) },
      { name: 'docProps/core.xml', data: u8(coreXml(title || '文档')) },
      { name: 'docProps/app.xml', data: u8(APP) }
    ]);
  }

  return { build: build, p: p, run: run, tbl: tbl, esc: esc, SONG: SONG, HEI: HEI };
})();
