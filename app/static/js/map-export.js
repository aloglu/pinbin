// Client-side PNG & PDF export for Project wiring maps (zero external dependencies).
import { esc, sevGlyph, toast, isGuest, plainWarningText } from './state.js';
import { warningsOfProject, resolveProjectItem } from './rules.js';
import { buildMapDiagramData } from './views/projects.js';

const LIGHT_PALETTE = {
  outerBg: '#FFFFFF',
  bg: '#ECEDEA',
  surface: '#F7F7F5',
  raised: '#FFFFFF',
  line: '#D3D4CF',
  hair: '#E2E3DF',
  ink: '#141517',
  ink2: '#44464A',
  ink3: '#686A6E',
  dot: 'rgba(0, 0, 0, .10)',
  bat: '#7C4DDB',
  v33: '#E3701B',
  v5: '#C8302C',
  i2c: '#0F9A8A',
  spi: '#2F5BD3',
  sig: '#7D7F83',
  danger: '#D93A36',
  check: '#C99400',
  ok: '#2E9A61',
  sel: '#17181A',
};

function currentPalette(forceLight) {
  const cs = getComputedStyle(document.documentElement);
  const g = (k, fb) => (cs.getPropertyValue(k) || '').trim() || fb;
  const sans = g('--sans', "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif");
  const mono = g('--mono', "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace");
  const wBody = g('--w-body', '400');
  const wMid = g('--w-mid', '500');
  const wStrong = g('--w-strong', '600');

  if (forceLight) {
    return { ...LIGHT_PALETTE, sans, mono, wBody, wMid, wStrong };
  }
  return {
    outerBg: g('--bg', LIGHT_PALETTE.bg),
    bg: g('--bg', LIGHT_PALETTE.bg),
    surface: g('--surface', LIGHT_PALETTE.surface),
    raised: g('--raised', LIGHT_PALETTE.raised),
    line: g('--line', LIGHT_PALETTE.line),
    hair: g('--hair', LIGHT_PALETTE.hair),
    ink: g('--ink', LIGHT_PALETTE.ink),
    ink2: g('--ink-2', LIGHT_PALETTE.ink2),
    ink3: g('--ink-3', LIGHT_PALETTE.ink3),
    dot: g('--dot', LIGHT_PALETTE.dot),
    bat: g('--bat', LIGHT_PALETTE.bat),
    v33: g('--v33', LIGHT_PALETTE.v33),
    v5: g('--v5', LIGHT_PALETTE.v5),
    i2c: g('--i2c', LIGHT_PALETTE.i2c),
    spi: g('--spi', LIGHT_PALETTE.spi),
    sig: g('--sig', LIGHT_PALETTE.sig),
    danger: g('--danger', LIGHT_PALETTE.danger),
    check: g('--check', LIGHT_PALETTE.check),
    ok: g('--ok', LIGHT_PALETTE.ok),
    sel: g('--sel', LIGHT_PALETTE.sel),
    sans,
    mono,
    wBody,
    wMid,
    wStrong,
  };
}

const fontCssCache = new Map();

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function getEmbeddedFontCss() {
  const fontKey = document.documentElement.getAttribute('data-font') === 'instrument' ? 'instrument' : 'plex';
  if (fontCssCache.has(fontKey)) return fontCssCache.get(fontKey);

  const specs =
    fontKey === 'instrument'
      ? [
          ['Instrument Sans', '400 700', '/static/fonts/instrument-sans-latin-wght-normal.woff2', 'woff2-variations'],
          ['JetBrains Mono', '500', '/static/fonts/jetbrains-mono-latin-500-normal.woff2', 'woff2'],
          ['JetBrains Mono', '600', '/static/fonts/jetbrains-mono-latin-600-normal.woff2', 'woff2'],
        ]
      : [
          ['IBM Plex Sans', '400', '/static/fonts/ibm-plex-sans-latin-400-normal.woff2', 'woff2'],
          ['IBM Plex Sans', '500', '/static/fonts/ibm-plex-sans-latin-500-normal.woff2', 'woff2'],
          ['IBM Plex Sans', '600', '/static/fonts/ibm-plex-sans-latin-600-normal.woff2', 'woff2'],
          ['IBM Plex Sans', '700', '/static/fonts/ibm-plex-sans-latin-700-normal.woff2', 'woff2'],
          ['IBM Plex Mono', '500', '/static/fonts/ibm-plex-mono-latin-500-normal.woff2', 'woff2'],
          ['IBM Plex Mono', '600', '/static/fonts/ibm-plex-mono-latin-600-normal.woff2', 'woff2'],
        ];

  const assetBase = isGuest() ? '/guest' : '';

  const rules = await Promise.all(
    specs.map(async ([family, weight, url, fmt]) => {
      try {
        const res = await fetch(`${assetBase}${url}`);
        if (!res.ok) return '';
        const b64 = bytesToBase64(new Uint8Array(await res.arrayBuffer()));
        return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url('data:font/woff2;base64,${b64}') format('${fmt}');}`;
      } catch {
        return '';
      }
    })
  );
  const css = rules.filter(Boolean).join('\n');
  fontCssCache.set(fontKey, css);
  return css;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapLines(text, maxChars, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur) lines.push(cur);
  // Clamp last line if overflowed
  const joinedCount = lines.join(' ').split(/\s+/).length;
  if (joinedCount < words.length && lines.length) {
    let last = lines[lines.length - 1];
    if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
    lines[lines.length - 1] = `${last.replace(/[.,;:\s]+$/, '')}…`;
  } else if (lines.length && lines[lines.length - 1].length > maxChars) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, maxChars - 1)}…`;
  }
  return lines;
}

function resolveVars(svgMarkup, pal) {
  const map = {
    '--bg': pal.bg,
    '--surface': pal.surface,
    '--raised': pal.raised,
    '--line': pal.line,
    '--hair': pal.hair,
    '--ink': pal.ink,
    '--ink-2': pal.ink2,
    '--ink-3': pal.ink3,
    '--dot': pal.dot,
    '--bat': pal.bat,
    '--v33': pal.v33,
    '--v5': pal.v5,
    '--i2c': pal.i2c,
    '--spi': pal.spi,
    '--sig': pal.sig,
    '--danger': pal.danger,
    '--check': pal.check,
    '--ok': pal.ok,
    '--sel': pal.sel,
  };
  return svgMarkup.replace(/var\((--[a-z0-9-]+)\)/gi, (m, k) => map[k] || m);
}

function slugify(name) {
  return (
    String(name || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

async function buildStandaloneSheetSvg(proj, { forceLight = false } = {}) {
  const diagram = buildMapDiagramData(proj);
  if (!diagram) return null;

  const pal = currentPalette(forceLight);
  const fontCss = await getEmbeddedFontCss();

  const pad = 28;
  const innerW = Math.max(diagram.W, 860);
  const sheetW = innerW + pad * 2;

  // Header
  const descLines = proj.description ? wrapLines(proj.description, Math.floor((innerW - 140) / 7.2), 2) : [];
  const headerH = 26 + (descLines.length ? 8 + descLines.length * 17 : 0) + 14;
  const frameY = pad + headerH;
  const frameH = diagram.H;

  // Legend
  const legendY = frameY + frameH + 22;
  const legendItems = [
    { kind: 'wire', col: pal.bat, label: 'battery', w: 72 },
    { kind: 'wire', col: pal.v5, label: '5 V', w: 50 },
    { kind: 'wire', col: pal.v33, label: '3.3 V', w: 60 },
    { kind: 'wire', col: pal.i2c, label: 'I2C', w: 52 },
    { kind: 'wire', col: pal.spi, label: 'SPI', w: 52 },
    { kind: 'wire', col: pal.sig, label: 'signal', w: 66 },
    { kind: 'sev', col: pal.danger, fg: '#ffffff', ch: '!', label: 'can damage parts', w: 138 },
    { kind: 'sev', col: pal.check, fg: '#1a1400', ch: '?', label: 'check first', w: 94 },
    { kind: 'sev', col: pal.ok, fg: '#ffffff', ch: '✓', label: 'works together', w: 118 },
  ];
  let lx = pad;
  const legendSvg = legendItems
    .map((it) => {
      const x = lx;
      lx += it.w + 10;
      if (it.kind === 'wire') {
        return `<rect x="${x}" y="${legendY - 2}" width="16" height="3.5" rx="1.75" fill="${it.col}"/><text class="sh-leg" x="${x + 22}" y="${legendY + 3.5}">${esc(it.label)}</text>`;
      }
      return `<circle cx="${x + 8}" cy="${legendY}" r="8" fill="${it.col}"/><text class="sh-sev" x="${x + 8}" y="${legendY + 0.5}" fill="${it.fg}">${esc(it.ch)}</text><text class="sh-leg" x="${x + 22}" y="${legendY + 3.5}">${esc(it.label)}</text>`;
    })
    .join('');

  const legendNoteY = legendY + 22;
  let curY = legendNoteY + 12;

  // Checks & warnings summary (so badges on the map are readable on paper/PNG)
  const ws = warningsOfProject(proj);
  const checks = ws.filter((w) => w.sev !== 'ok');
  let checksSvg = '';
  if (checks.length) {
    curY += 10;
    const lineY = curY;
    checksSvg += `<line x1="${pad}" y1="${lineY}" x2="${sheetW - pad}" y2="${lineY}" stroke="${pal.hair}" stroke-width="1"/>`;
    curY += 20;
    checksSvg += `<text class="sh-sec" x="${pad}" y="${curY}">Before you power it</text>`;
    curY += 16;

    const twoCol = checks.length > 3 && innerW >= 820;
    const colW = twoCol ? Math.floor((innerW - 24) / 2) : innerW;
    const maxCh = Math.floor((colW - 28) / 6.8);
    const rows = twoCol ? Math.ceil(checks.length / 2) : checks.length;

    checks.forEach((w, idx) => {
      const col = twoCol && idx >= rows ? 1 : 0;
      const row = twoCol ? (col === 0 ? idx : idx - rows) : idx;
      const cx = pad + col * (colW + 24);
      const cy = curY + row * 22;
      const done = w.src === 'assistant' && w.is_done;
      const fill = done ? pal.surface : w.sev === 'danger' ? pal.danger : w.sev === 'check' ? pal.check : pal.ok;
      const stroke = done ? pal.ok : 'none';
      const fg = done ? pal.ok : w.sev === 'check' ? '#1a1400' : '#ffffff';
      const ch = sevGlyph(w.sev, done);
      const plain = plainWarningText(w.t);
      const clipped = plain.length > maxCh ? `${plain.slice(0, maxCh - 1)}…` : plain;
      checksSvg += `<circle cx="${cx + 8}" cy="${cy}" r="7.5" fill="${fill}"${
        stroke !== 'none' ? ` stroke="${stroke}" stroke-width="1.5"` : ''
      }/><text class="sh-sev" x="${cx + 8}" y="${cy + 0.5}" fill="${fg}">${esc(ch)}</text><text class="sh-chk${
        done ? ' done' : ''
      }" x="${cx + 22}" y="${cy + 4}">${esc(clipped)}</text>`;
    });
    curY += rows * 22 + 4;
  }

  // Also on the bench (build materials)
  const mats = (proj.items || []).filter((x) => x.role === 'material');
  let matsSvg = '';
  if (mats.length) {
    curY += 8;
    const names = mats
      .map((q) => {
        const x = resolveProjectItem(proj, q.ref);
        return x ? `${x.displayName} (${x.owned ? 'owned' : 'to buy'})` : '';
      })
      .filter(Boolean)
      .join('  ·  ');
    const matLines = wrapLines(names, Math.floor((innerW - 120) / 6.8), 2);
    matsSvg += `<line x1="${pad}" y1="${curY}" x2="${sheetW - pad}" y2="${curY}" stroke="${pal.hair}" stroke-width="1"/>`;
    curY += 19;
    matsSvg += `<text class="sh-sec" x="${pad}" y="${curY}">Also on the bench</text>`;
    matLines.forEach((ln, i) => {
      matsSvg += `<text class="sh-sub" x="${pad + 124}" y="${curY + i * 16}">${esc(ln)}</text>`;
    });
    curY += matLines.length * 16 + 4;
  }

  const sheetH = curY + pad - 6;
  const mapOffsetX = pad + Math.round((innerW - diagram.W) / 2);

  // Clean diagram inner markup with CSS variables resolved
  const resolvedInner = resolveVars(diagram.inner, pal);

  const optionPill = proj.option
    ? `<text class="sh-opt" x="${pad + Math.min(proj.name.length * 11.4 + 14, innerW - 220)}" y="${pad + 17}">${esc(
        proj.option
      )}</text>`
    : '';

  const descSvg = descLines
    .map((ln, i) => `<text class="sh-sub" x="${pad}" y="${pad + 39 + i * 17}">${esc(ln)}</text>`)
    .join('');

  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const css = `
${fontCss}
.sh-title { font-family: ${pal.sans}; font-size: 20px; font-weight: ${pal.wStrong}; fill: ${pal.ink}; }
.sh-opt { font-family: ${pal.sans}; font-size: 12px; font-weight: ${pal.wMid}; fill: ${pal.ink2}; }
.sh-sub { font-family: ${pal.sans}; font-size: 12.5px; font-weight: ${pal.wBody}; fill: ${pal.ink2}; }
.sh-stamp { font-family: ${pal.mono}; font-size: 11px; font-weight: 500; fill: ${pal.ink3}; text-anchor: end; }
.sh-leg { font-family: ${pal.sans}; font-size: 12px; font-weight: ${pal.wBody}; fill: ${pal.ink2}; }
.sh-note { font-family: ${pal.sans}; font-size: 11.5px; font-weight: ${pal.wBody}; fill: ${pal.ink3}; }
.sh-sec { font-family: ${pal.sans}; font-size: 11.5px; font-weight: ${pal.wStrong}; fill: ${pal.ink2}; }
.sh-chk { font-family: ${pal.sans}; font-size: 12px; font-weight: ${pal.wMid}; fill: ${pal.ink}; }
.sh-chk.done { fill: ${pal.ink3}; text-decoration: line-through; }
.sh-sev { font-family: ${pal.mono}; font-size: 10.5px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }

.map text { font-family: ${pal.sans}; fill: ${pal.ink}; }
.map .pin { font-family: ${pal.mono}; font-size: 11px; font-weight: 500; fill: ${pal.ink2}; }
.map .lab { font-family: ${pal.mono}; font-size: 11.5px; font-weight: 600; }
.map .node rect.box { fill: ${pal.raised}; stroke: ${pal.ink3}; stroke-width: 1; }
.map .node.buy rect.box { stroke-dasharray: 4 3; }
.map .node.mcu rect.box { stroke: ${pal.ink}; stroke-width: 1.4; }
.map .node .nm { font-size: 13px; font-weight: ${pal.wStrong}; fill: ${pal.ink}; }
.map .node .st { font-family: ${pal.mono}; font-size: 11px; font-weight: 500; fill: ${pal.ink2}; }
.map .node .gl { fill: none; stroke: ${pal.ink3}; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.map .node .phb { fill: ${pal.bg}; }

.map .net path.w { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.map .net path.bus { fill: none; stroke-width: 6; stroke-linejoin: round; stroke-linecap: round; }
.map .net path.bus-in { fill: none; stroke: ${pal.surface}; stroke-width: 1.4; stroke-linejoin: round; }
.map .net path.hit, .map .net path.flow { display: none; }

.map .mk circle.b { stroke: ${pal.surface}; stroke-width: 2; }
.map .mk text { font-family: ${pal.mono}; font-size: 11.5px; font-weight: 700; fill: #ffffff; text-anchor: middle; dominant-baseline: central; }
.map .mk.check text { fill: #1a1400; }
.map .mk.danger circle.b { fill: ${pal.danger}; }
.map .mk.check circle.b { fill: ${pal.check}; }
.map .mk.ok circle.b { fill: ${pal.ok}; }
.map .mk.done circle.b { fill: ${pal.surface}; stroke: ${pal.ok}; stroke-width: 1.8; }
.map .mk.done text { fill: ${pal.ok}; }
.map .mk .ring, .map .mk .mhit { display: none; }
`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}">
  <defs>
    <style><![CDATA[${css}]]></style>
    <pattern id="pbDotGrid" width="16" height="16" patternUnits="userSpaceOnUse">
      <circle cx="8" cy="8" r="1" fill="${pal.dot}"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${sheetW}" height="${sheetH}" fill="${pal.outerBg}"/>
  <text class="sh-title" x="${pad}" y="${pad + 18}">${esc(proj.name)}</text>
  ${optionPill}
  <text class="sh-stamp" x="${sheetW - pad}" y="${pad + 17}">Pinbin · Wiring map · ${esc(dateStr)}</text>
  ${descSvg}
  <rect x="${pad}" y="${frameY}" width="${innerW}" height="${frameH}" rx="8" fill="${pal.surface}" stroke="${pal.line}" stroke-width="1"/>
  <rect x="${pad}" y="${frameY}" width="${innerW}" height="${frameH}" rx="8" fill="url(#pbDotGrid)"/>
  <g class="map" transform="translate(${mapOffsetX} ${frameY})">${resolvedInner}</g>
  ${legendSvg}
  <text class="sh-note" x="${pad}" y="${legendNoteY}">solid outline: owned  ·  dashed outline: to buy  ·  GND not drawn  ·  logical diagram (check Bench for physical pinout)</text>
  ${checksSvg}
  ${matsSvg}
</svg>`;

  return { svg, width: sheetW, height: sheetH, outerBg: pal.outerBg };
}

function renderSvgToCanvas(svgString, width, height, bgColor) {
  return new Promise((resolve, reject) => {
    const scale = Math.max(1.5, Math.min(3, Math.floor(4096 / Math.max(width, height)) || 2));
    const pxW = Math.round(width * scale);
    const pxH = Math.round(height * scale);

    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = bgColor || '#FFFFFF';
        ctx.fillRect(0, 0, pxW, pxH);
        ctx.drawImage(img, 0, 0, pxW, pxH);
        URL.revokeObjectURL(url);
        resolve(canvas);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not render wiring map image'));
    };
    img.src = url;
  });
}

async function compressZlib(rawBytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(rawBytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pdfEscapeText(str) {
  return String(str || '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/([\\()])/g, '\\$1');
}

async function buildPdfBlobFromCanvas(canvas, title) {
  const pxW = canvas.width;
  const pxH = canvas.height;

  let imgBytes;
  let imgFilter;
  if (typeof CompressionStream === 'function') {
    const rgba = canvas.getContext('2d').getImageData(0, 0, pxW, pxH).data;
    const rgb = new Uint8Array(pxW * pxH * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i];
      rgb[j++] = rgba[i + 1];
      rgb[j++] = rgba[i + 2];
    }
    imgBytes = await compressZlib(rgb);
    imgFilter = '/FlateDecode';
  } else {
    imgBytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.96));
    imgFilter = '/DCTDecode';
  }

  // Fit neatly onto A4 landscape or portrait depending on aspect ratio
  const landscape = pxW >= pxH;
  const pageW = landscape ? 841.89 : 595.28;
  const pageH = landscape ? 595.28 : 841.89;
  const margin = 24;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const ratio = Math.min(maxW / pxW, maxH / pxH);
  const drawW = pxW * ratio;
  const drawH = pxH * ratio;
  const drawX = (pageW - drawW) / 2;
  const drawY = (pageH - drawH) / 2;

  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const pushText = (s) => {
    const b = enc.encode(s);
    parts.push(b);
    offset += b.byteLength;
  };
  const pushBytes = (b) => {
    parts.push(b);
    offset += b.byteLength;
  };

  // PDF header with binary marker comment
  pushText('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [0];
  const startObj = (num) => {
    offsets[num] = offset;
    pushText(`${num} 0 obj\n`);
  };

  startObj(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObj(2);
  pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  startObj(3);
  pushText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(
      2
    )}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
  );

  startObj(4);
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${imgFilter} /Length ${imgBytes.byteLength} >>\nstream\n`
  );
  pushBytes(imgBytes);
  pushText('\nendstream\nendobj\n');

  const contentStream = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(
    2
  )} cm\n/Im0 Do\nQ\n`;
  const contentBytes = enc.encode(contentStream);
  startObj(5);
  pushText(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
  pushBytes(contentBytes);
  pushText('endstream\nendobj\n');

  startObj(6);
  pushText(`<< /Title (${pdfEscapeText(title)}) /Creator (Pinbin) >>\nendobj\n`);

  const xrefOffset = offset;
  pushText('xref\n0 7\n0000000000 65535 f \n');
  for (let i = 1; i <= 6; i++) {
    pushText(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportProjectMap(proj, format) {
  if (!proj) return;
  const fmt = format === 'pdf' ? 'pdf' : 'png';
  const sheet = await buildStandaloneSheetSvg(proj, { forceLight: fmt === 'pdf' });
  if (!sheet) {
    toast('No wiring map to download yet');
    return;
  }
  const canvas = await renderSvgToCanvas(sheet.svg, sheet.width, sheet.height, sheet.outerBg);
  const filename = `${slugify(proj.name)}-wiring-map.${fmt}`;

  if (fmt === 'png') {
    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode PNG'))), 'image/png')
    );
    triggerDownload(blob, filename);
  } else {
    const pdfBlob = await buildPdfBlobFromCanvas(canvas, `${proj.name} — Wiring Map`);
    triggerDownload(pdfBlob, filename);
  }
  toast(`Downloaded ${filename}`);
}
