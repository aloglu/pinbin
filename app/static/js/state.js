// Shared client state, icons, formatting, and small UI primitives.

export const G = {
  mcu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9.5 4v3M12 4v3M14.5 4v3M9.5 17v3M12 17v3M14.5 17v3M4 9.5h3M4 12h3M4 14.5h3M17 9.5h3M17 12h3M17 14.5h3"/>',
  sensor: '<circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  display: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  actuator: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>',
  passive: '<path d="M2 12h4l1.5-3 3 6 3-6 3 6 1.5-3h4"/>',
  proto: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M7.5 9.5h.01M10.5 9.5h.01M13.5 9.5h.01M16.5 9.5h.01M7.5 14.5h.01M10.5 14.5h.01M13.5 14.5h.01M16.5 14.5h.01" stroke-width="2.4"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.6-.4-.4-2.6z"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4M7 12h4M9 10v4"/>',
  switch: '<circle cx="6" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><path d="M7.4 11.3 16 7"/>',
  diode: '<path d="M3 12h6M15 12h6M9 7v10l6-5zM15 7v10"/>',
  button: '<rect x="5" y="5" width="14" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 9v6M9 12h6"/>',
  cable: '<path d="M4 12h8a4 4 0 0 0 4-4V5M16 5h4"/><rect x="2" y="10" width="4" height="4"/>',
  wire: '<path d="M3 18c4 0 4-12 9-12s5 12 9 12"/>',
  led: '<path d="M8 14V9a4 4 0 0 1 8 0v5H8zM6 14h12M10 14v6M14 14v4"/>',
};

export const CATG = {
  Microcontrollers: 'mcu',
  Sensors: 'sensor',
  Displays: 'display',
  Actuators: 'actuator',
  Passives: 'passive',
  Prototyping: 'proto',
  Tools: 'tool',
};

export const CATEGORIES = [
  'Microcontrollers',
  'Sensors',
  'Displays',
  'Actuators',
  'Passives',
  'Prototyping',
  'Tools',
];

export const VT = { v33: '3.3V', v5: '5V', vboth: '3.3–5V' };

export const SORTS = [
  ['recent', 'Recently added'],
  ['name', 'Name A–Z'],
  ['fewest', 'Fewest first'],
  ['most', 'Most first'],
  ['bin', 'By bin'],
  ['category', 'By category'],
  ['care', 'Needs care first'],
];

export const BASE =
  typeof location !== 'undefined' && (location.pathname === '/guest' || location.pathname.startsWith('/guest/'))
    ? '/guest'
    : '';

export const isGuest = () => Boolean(BASE || (state.config && state.config.guest_mode));

export function appHref(path) {
  const clean = String(path || '/inventory');
  const norm = clean.startsWith('/') ? clean : `/${clean}`;
  if (BASE && (norm === BASE || norm.startsWith(`${BASE}/`))) return norm;
  return BASE ? `${BASE}${norm}` : norm;
}

export function apiUrl(path) {
  const norm = String(path || '').startsWith('/') ? path : `/${path}`;
  return BASE ? `${BASE}${norm}` : norm;
}

export function routeToPath(r) {
  const key = String(r || 'inventory').replace(/^#/, '');
  if (key.startsWith('/')) return appHref(key);
  if (key === 'inventory' || key === '') return appHref('/inventory');
  if (key === 'new-part') return appHref('/parts/new');
  if (key.startsWith('edit-part-')) return appHref(`/parts/${encodeURIComponent(key.slice(10))}/edit`);
  if (key === 'projects') return appHref('/projects');
  if (key === 'new-proj') return appHref('/projects/new');
  if (key.startsWith('p-')) return appHref(`/projects/${encodeURIComponent(key.slice(2))}`);
  if (key.startsWith('edit-proj-')) return appHref(`/projects/${encodeURIComponent(key.slice(10))}/edit`);
  if (key === 'shopping') return appHref('/shopping');
  if (key === 'new-item') return appHref('/shopping/new');
  if (key.startsWith('edit-item-')) return appHref(`/shopping/${encodeURIComponent(key.slice(10))}/edit`);
  if (key === 'glossary') return appHref('/glossary');
  if (key === 'bench') return appHref('/bench');
  if (key === 'settings') return appHref('/settings');
  return appHref('/inventory');
}

export function navigate(target, { replace = false } = {}) {
  const url = routeToPath(target);
  const current = location.pathname + location.search;
  if (current !== url || location.hash) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  window.dispatchEvent(new CustomEvent('pb:navigate'));
}

export const CURRENCY_SYMBOL = { TRY: 'TL', EUR: '€', USD: '$' };

export const state = {
  loaded: false,
  config: {
    guest_mode: false,
    local_dev_mode: false,
    mcp_enabled: false,
    mcp_read_only: false,
    categories: CATEGORIES,
    ui_settings: {
      theme: 'system',
      font: 'plex',
      motion: 'system',
      view_mode: 'grid',
      sort_by: 'recent',
      inline_tooltips: true,
      show_caution_badge: true,
      show_ok_checks: true,
      strap_pin_checks: true,
      currency: 'TRY',
      last_backup_at: '',
    },
  },
  parts: [],
  projects: [],
  shopping: [],
  retailers: [],
  glossary: [],

  // UI view state
  sel: null,          // 'part:<id>' | 'item:<id>' | 'node:<ref>' | 'net:<id>' | 'warn:<id>'
  hot: null,          // hovered map element 'node:<ref>' | 'net:<id>' | 'warn:<id>'
  lens: null,         // project id when filtering inventory for a project
  menu: null,         // open dropdown menu id
  ptab: 'active',     // 'active' | 'archived'
  tagf: null,         // active tag filter on Projects list
  projView: {},       // { [projectId]: 'map' | 'focus' | 'metro' | 'list' | 'notes' }
  focusRef: {},       // { [projectId]: ref }
  trail: {},          // { [projectId]: [ref, ...] }
  zoom: 1,
  shopOpt: { open: false, mode: 'fewest_orders', loading: false, error: '', result: null },
  gl: { q: '', filter: 'all', termId: '', detail: false },
  bench: {
    tool: '',
    pin: '',
    bb: 'mini',
    bbHot: '',
    res: [2, 4, 2],
    dial: 'vdc',
    dtask: null,
    calc: { ledV: 3.3, ledVf: 2.0, ledI: 10, dVin: 5, dR1: 1000, dR2: 2000, oSolve: 'I', oV: 5, oI: 20, oR: 220, bCap: 500, bMa: 50 },
    qrExtra: [],
  },
  set: {
    sec: 'appearance',
    loaded: false,
    loading: false,
    stats: null,
    mcp: null,
    guest: null,
    tokenShown: false,
    guestLinkShown: false,
    renaming: null,
    confirm: null,
    wipeText: '',
  },
  inv: {
    q: '',
    cat: 'All',
    sort: 'recent',
    view: 'grid',
    binFilter: '',    // from /?bin=... QR links
  },
  panelWasOpen: false,
  panelClosing: false,
  lightboxSrc: null,
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sv = (inner, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${inner}</svg>`;

export const caret =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

export const chev =
  '<svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

export const ph = (g, cls = '') =>
  `<div class="ph ${cls}" role="img" aria-label="Photo placeholder">${sv(G[g] || G.proto)}</div>`;

export function glyphFor(obj) {
  const f = obj.electrical_facts || {};
  if (f.glyph && G[f.glyph]) return f.glyph;
  const nm = String(obj.name || '').toLowerCase();
  if (nm.includes('led') && !nm.includes('oled')) return 'led';
  if (nm.includes('battery') || nm.includes('li-po') || nm.includes('lipo')) return 'battery';
  if (nm.includes('switch')) return 'switch';
  if (nm.includes('diode')) return 'diode';
  if (nm.includes('button')) return 'button';
  if (nm.includes('coin') || nm.includes('cr2032')) return 'coin';
  if (nm.includes('cable') || nm.includes('usb')) return 'cable';
  if (nm.includes('jumper') || nm.includes('wire')) return 'wire';
  return CATG[obj.category] || 'proto';
}

export function phPart(obj, cls = '', zoomable = false) {
  if (obj && obj.image_path) {
    const src = apiUrl(`/images/${encodeURIComponent(obj.image_path)}`);
    return `<div class="ph ${cls}${zoomable ? ' zoomable' : ''}"${zoomable ? ` data-lightbox="${src}"` : ''}><img src="${src}" alt="${esc(obj.name || '')}" loading="lazy"></div>`;
  }
  return ph(glyphFor(obj || {}), cls);
}

export const sevGlyph = (sev, done = false) => (done || sev === 'ok' ? '✓' : sev === 'danger' ? '!' : '?');

export function tagsFromFacts(obj) {
  const f = (obj && obj.electrical_facts) || {};
  const out = [];
  if (f.logic && VT[f.logic]) out.push(f.logic);
  if (Array.isArray(f.interfaces)) {
    for (const iface of f.interfaces) {
      if (iface && !out.includes(iface)) out.push(iface);
    }
  }
  return out;
}

export function tagChips(tags) {
  return (tags || [])
    .map((t) => (VT[t] ? `<span class="vt ${t}">${VT[t]}</span>` : `<span class="vt if">${esc(t)}</span>`))
    .join('');
}

export function stepHtml(attrName, key, val, label) {
  return `<span class="step" title="${esc(label)}"><button type="button" ${attrName}="${esc(key)}|-1" aria-label="${esc(label)}: fewer">−</button><output>${val}</output><button type="button" ${attrName}="${esc(key)}|1" aria-label="${esc(label)}: more">+</button></span>`;
}

export function menuHtml(id, label, value, opts) {
  const open = state.menu === id;
  return `<div class="mn"><button type="button" class="btn mnb" data-menu="${esc(id)}" aria-haspopup="menu" aria-expanded="${open}">${label ? `<span class="faint">${esc(label)}</span>` : ''}<span>${esc(value)}</span>${caret}</button><div class="mnp" role="menu"${open ? '' : ' hidden'}>${opts
    .map(
      ([v, t, cur]) =>
        `<button type="button" role="menuitemradio" aria-checked="${!!cur}" data-mpick="${esc(id)}|${esc(v)}"><span class="ck">${cur ? '✓' : ''}</span><span>${esc(t)}</span></button>`
    )
    .join('')}</div></div>`;
}

export function parsePriceNumber(priceStr) {
  const s = String(priceStr || '').trim();
  if (!s) return null;
  const m = s.match(/\d[\d.,]*/);
  if (!m) return null;
  let num = m[0];
  if (num.includes('.') && num.includes(',')) {
    num = num.lastIndexOf(',') > num.lastIndexOf('.') ? num.replace(/\./g, '').replace(',', '.') : num.replace(/,/g, '');
  } else if (num.includes(',')) {
    const p = num.split(',');
    num = p.length === 2 && p[1].length <= 2 ? `${p[0]}.${p[1]}` : num.replace(/,/g, '');
  }
  const v = parseFloat(num);
  return Number.isFinite(v) ? v : null;
}

export function money(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function currencyLabel() {
  const c = state.config.ui_settings.currency || 'TRY';
  return CURRENCY_SYMBOL[c] || c;
}

export function ago(isoStr) {
  if (!isoStr) return '';
  const ts = Date.parse(isoStr);
  if (!Number.isFinite(ts)) return '';
  const d = Math.floor((Date.now() - ts) / 86400e3);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function normalizeSort(sortVal) {
  const alias = { location: 'bin', qty_asc: 'fewest', qty_desc: 'most', needs_photo: 'recent' };
  const mapped = alias[sortVal] || sortVal;
  return SORTS.some(([k]) => k === mapped) ? mapped : 'recent';
}

export function partById(id) {
  return state.parts.find((p) => p.id === id) || null;
}

export function shoppingById(id) {
  return state.shopping.find((s) => s.id === id) || null;
}

export function projectById(id) {
  return state.projects.find((p) => p.id === id) || null;
}

export function storeDisplayName(domainOrName) {
  const raw = String(domainOrName || '').trim();
  if (!raw) return 'Store';
  const low = raw.toLowerCase().replace(/^www\./, '');
  const found = state.retailers.find((r) => (r.domain || '').toLowerCase() === low);
  if (found && (found.display_name || found.name)) return found.display_name || found.name;
  return raw;
}

export function termButton(termId, label) {
  const ui = state.config.ui_settings;
  const g = state.glossary.find((x) => x.id === termId || x.term.toLowerCase().startsWith(termId.toLowerCase()));
  const text = label || (g ? g.term : termId);
  if (!ui.inline_tooltips || !g) return esc(text);
  return `<button class="term" type="button" data-term="${esc(g.id)}">${esc(text)}</button>`;
}

let toastTimer = null;
export function toast(msg, undoFn = null) {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast" role="status">${esc(msg)}${undoFn ? '<button type="button" data-act="undo">Undo</button>' : ''}</div>`;
  root._undo = undoFn;
  toastTimer = setTimeout(() => {
    root.innerHTML = '';
    root._undo = null;
  }, 6000);
}

export function mdLite(text) {
  return esc(text || '')
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('### ')) return `<h3>${block.slice(4)}</h3>`;
      if (block.startsWith('## ')) return `<h3>${block.slice(3)}</h3>`;
      const lines = block.split('\n');
      if (lines.every((l) => l.startsWith('- ') || l.startsWith('* '))) {
        return `<ul>${lines
          .map((l) => `<li>${l.slice(2).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`)
          .join('')}</ul>`;
      }
      return `<p>${block
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}
