'use strict';

const THEME_KEY = 'pinbin_theme_v1';
const LOGO_COLOR_KEY = 'pinbin_logo_color_v1';
const DEFAULT_CATEGORIES = [
  'Microcontrollers',
  'Sensors',
  'Displays',
  'Actuators',
  'Passives',
  'Prototyping',
  'Tools',
];

const state = {
  parts: [],
  projects: [],
  glossary: [],
  shoppingItems: [],
  retailers: [],
  consolidateOpen: false,
  consolidateMode: 'fewest_orders', // 'fewest_orders' | 'lowest_cost'
  consolidatePlan: null,
  shoppingShowOtherBuilds: false,
  shoppingGroupBy: 'project', // 'project' | 'store' | 'flat'
  shoppingTagFilter: 'All',
  projectActiveTab: {}, // projectId -> 'all' | 'core' | variantId
  contextDrawer: null, // { type: 'shopping' | 'project_part', id, projectId?, projectItemId? }
  editingProjectId: null,
  projectAction: null, // { mode: 'variant' | 'item', projectId }
  categories: ['All', ...DEFAULT_CATEGORIES],
  glossaryCategories: [
    'All',
    'Electricity & Power',
    'Circuit Basics',
    'Components & Parts',
    'Signals & Protocols',
    'Soldering & Bench',
  ],
  activePage: 'inventory', // 'inventory' | 'projects' | 'glossary'
  glossaryCategory: 'All',
  glossaryInInventoryOnly: false,
  selectedGlossaryId: null,
  glossaryMobileDetail: false, // phones: true while one term is open full width
  activePreviewTab: 'overview', // 'overview' | 'specs' | 'notes'
  editingGlossaryId: null,
  popoverTermId: null,
  config: {
    ai_enabled: false,
    ai_remaining_today: 0,
    local_dev_mode: false,
  },
  uiSettings: {
    theme: 'dark',
    view_mode: 'grid',
    sort_by: 'recent',
    inline_tooltips: true,
    show_caution_badge: false,
    logo_color: '#00e676',
  },
  search: '',
  category: 'All',
  locationFilter: '',
  needsPhotoOnly: false,
  inUseOnly: false,
  lowStockOnly: false,

  drawerMode: null, // 'view' | 'edit' | 'create' | null
  activeEditTab: 'basics', // 'basics' | 'media' | 'details'
  activePartId: null,
  draftImagePath: '',
  draftPinoutImagePath: '',
  pendingMainFile: null,
  pendingPinoutFile: null,
  pinoutPasteTarget: false,
  lastScraped: { title: '', description: '' },
  imageCandidates: [],
  pendingRestoreFile: null,
};

// =============================================================================
// UTILITIES
// =============================================================================
function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _renderInlineMd(escapedLine) {
  let s = escapedLine;
  // Inline code first (protect contents from bold/italic formatting)
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });
  // Safe links [label](https://...) — protect href from bold/italic regexes below
  const linkSpans = [];
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const idx = linkSpans.length;
    linkSpans.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `\u0000LINK${idx}\u0000`;
  });
  // Bold & italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Restore links and inline code
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => linkSpans[Number(i)] || '');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSpans[Number(i)] || '');
  return s;
}

function _splitMdTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function _parseMdTableAlign(sepLine) {
  const trimmed = sepLine.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return null;
  const cells = _splitMdTableRow(trimmed);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
    else if (cell.endsWith(':')) aligns.push('right');
    else aligns.push('left');
  }
  return aligns;
}

function renderMarkdown(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '<p class="text-muted text-xs italic">Nothing to preview yet.</p>';

  const lines = text.split('\n');
  const out = [];
  let inCode = false;
  let codeLines = [];
  let listType = null; // 'ul' | 'ol' | null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.trim().startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    // Markdown pipe table: header row + separator row (+ 0 or more body rows)
    if (trimmed.includes('|') && i + 1 < lines.length) {
      const aligns = _parseMdTableAlign(lines[i + 1]);
      if (aligns) {
        closeList();
        const headerCells = _splitMdTableRow(trimmed);
        const colCount = Math.max(headerCells.length, aligns.length);
        const thHtml = Array.from({ length: colCount }, (_, idx) => {
          const al = aligns[idx] || 'left';
          const style = al !== 'left' ? ` style="text-align:${al}"` : '';
          return `<th${style}>${_renderInlineMd(escapeHTML(headerCells[idx] || ''))}</th>`;
        }).join('');
        const bodyRows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const rowCells = _splitMdTableRow(lines[i]);
          const tds = Array.from({ length: colCount }, (_, idx) => {
            const al = aligns[idx] || 'left';
            const style = al !== 'left' ? ` style="text-align:${al}"` : '';
            return `<td${style}>${_renderInlineMd(escapeHTML(rowCells[idx] || ''))}</td>`;
          }).join('');
          bodyRows.push(`<tr>${tds}</tr>`);
          i++;
        }
        i--; // compensate for loop increment
        out.push(
          `<div class="pb-md-table-wrap"><table><thead><tr>${thHtml}</tr></thead>${bodyRows.length ? `<tbody>${bodyRows.join('')}</tbody>` : ''}</table></div>`
        );
        continue;
      }
    }

    if (/^([-*_]){3,}$/.test(trimmed)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      closeList();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${_renderInlineMd(escapeHTML(hMatch[2]))}</h${lvl}>`);
      continue;
    }

    if (trimmed.startsWith('> ')) {
      closeList();
      out.push(`<blockquote>${_renderInlineMd(escapeHTML(trimmed.slice(2)))}</blockquote>`);
      continue;
    }

    const taskMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      const checked = taskMatch[1].toLowerCase() === 'x' ? 'checked' : '';
      out.push(`<li class="pb-md-task"><input type="checkbox" ${checked} disabled /><span>${_renderInlineMd(escapeHTML(taskMatch[2]))}</span></li>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${_renderInlineMd(escapeHTML(ulMatch[1]))}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${_renderInlineMd(escapeHTML(olMatch[1]))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${_renderInlineMd(escapeHTML(trimmed))}</p>`);
  }

  if (inCode) {
    out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
  }
  closeList();
  return out.join('');
}

// One-line plain text from Markdown, for short previews in list rows.
function markdownToPlain(raw) {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function setMdEditorMode(editorEl, mode) {
  if (!editorEl) return;
  const input = editorEl.querySelector('[data-md-input]');
  const preview = editorEl.querySelector('[data-md-preview]');
  if (!input || !preview) return;
  const isPreview = mode === 'preview';
  if (isPreview) {
    preview.innerHTML = renderMarkdown(input.value);
  }
  input.classList.toggle('hidden', isPreview);
  preview.classList.toggle('hidden', !isPreview);
  editorEl.querySelectorAll('button[data-md-mode]').forEach((btn) => {
    const act = btn.dataset.mdMode === mode;
    btn.classList.toggle('pb-seg-active', act);
    btn.classList.toggle('opacity-65', !act);
  });
}

function imageUrl(filename) {
  if (!filename) return '';
  if (filename.startsWith('blob:') || filename.startsWith('data:') || filename.startsWith('/images/')) {
    return filename;
  }
  return `/images/${encodeURIComponent(filename)}`;
}

function isLowStock(part) {
  return (
    part.low_stock_threshold !== null &&
    part.low_stock_threshold !== undefined &&
    part.low_stock_threshold !== '' &&
    Number(part.quantity) <= Number(part.low_stock_threshold)
  );
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('opacity-0');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('opacity-0'), 2400);
}

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    let detail = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data && data.detail) detail = data.detail;
    } catch (_) {}
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return resp.json();
  }
  return resp;
}

// =============================================================================
// CONFIG & SETTINGS (SQLite-backed)
// =============================================================================
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.classList.remove('dark');
  } else {
    document.documentElement.classList.add('dark');
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
}

function loadCachedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
    }
  } catch (_) {}
  try {
    const savedLogo = localStorage.getItem(LOGO_COLOR_KEY);
    if (savedLogo) applyLogoColor(savedLogo);
  } catch (_) {}
}

// Logo colour (Settings > Appearance). The colour fills the logo tile; the
// perfboard drawing on it is black or white, whichever reads better.
function applyLogoColor(color) {
  const known = PinbinBrand.LOGO_COLORS.some((c) => c.value === color);
  const tile = known ? color : PinbinBrand.DEFAULT_LOGO_COLOR;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--logo-bg', tile);
  rootStyle.setProperty('--logo-ink', PinbinBrand.inkFor(tile));
  const favicon = document.getElementById('faviconLink');
  if (favicon) favicon.href = `data:image/svg+xml,${encodeURIComponent(PinbinBrand.faviconSvg(tile))}`;
  try {
    localStorage.setItem(LOGO_COLOR_KEY, tile);
  } catch (_) {}
}

function renderBrand() {
  const brand = document.getElementById('brandLogo');
  if (brand) brand.innerHTML = PinbinBrand.wordSvg(22);
  const picker = document.getElementById('settingLogoColors');
  if (picker) {
    picker.innerHTML = PinbinBrand.LOGO_COLORS.map(
      (c) => `<button type="button" class="pb-logo-swatch" data-setting-logo="${c.value}" style="--swatch:${c.value};--swatch-ink:${PinbinBrand.inkFor(c.value)}" aria-label="${c.name}" title="${c.name}" aria-pressed="false"></button>`,
    ).join('');
  }
}

function saveUiSettings(patch) {
  Object.assign(state.uiSettings, patch);
  if (patch.theme) applyTheme(patch.theme);
  if (patch.logo_color) applyLogoColor(patch.logo_color);
  syncSettingsModalUi();
  const keys = Object.keys(patch);
  if (!(keys.length === 1 && (keys[0] === 'theme' || keys[0] === 'logo_color'))) {
    renderCurrentPage();
    if (state.drawerMode === 'view' && state.activePartId) {
      const p = state.parts.find((x) => x.id === state.activePartId);
      if (p) renderDrawerPreview(p);
    }
  }

  return apiFetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
    .then((updated) => {
      state.uiSettings = { ...state.uiSettings, ...updated };
      applyTheme(state.uiSettings.theme);
      applyLogoColor(state.uiSettings.logo_color);
      syncSettingsModalUi();
    })
    .catch((err) => {
      showToast(err.message);
    });
}

function syncSettingsModalUi() {
  const { theme, view_mode, sort_by, inline_tooltips, show_caution_badge, logo_color } = state.uiSettings;

  document.querySelectorAll('button[data-setting-logo]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.settingLogo === logo_color));
  });

  // Sort select
  const sortEl = document.getElementById('sortSelect');
  if (sortEl) sortEl.value = sort_by || 'recent';

  // Grid / List toolbar buttons
  const gridBtn = document.getElementById('viewGridBtn');
  const listBtn = document.getElementById('viewListBtn');
  if (view_mode === 'list') {
    listBtn.classList.add('pb-seg-active');
    listBtn.classList.remove('opacity-60');
    gridBtn.classList.remove('pb-seg-active');
    gridBtn.classList.add('opacity-60');
  } else {
    gridBtn.classList.add('pb-seg-active');
    gridBtn.classList.remove('opacity-60');
    listBtn.classList.remove('pb-seg-active');
    listBtn.classList.add('opacity-60');
  }

  // Settings modal theme & view segmented buttons
  document.querySelectorAll('button[data-setting-theme]').forEach((btn) => {
    const isAct = btn.dataset.settingTheme === theme;
    btn.classList.toggle('pb-seg-active', isAct);
    btn.classList.toggle('opacity-65', !isAct);
  });

  document.querySelectorAll('button[data-setting-view]').forEach((btn) => {
    const isAct = btn.dataset.settingView === view_mode;
    btn.classList.toggle('pb-seg-active', isAct);
    btn.classList.toggle('opacity-65', !isAct);
  });

  document.getElementById('settingShowCaution').checked = Boolean(show_caution_badge);
  document.getElementById('settingInlineTooltips').checked = Boolean(inline_tooltips);

  const aiEl = document.getElementById('settingsAiStatus');
  if (state.config.ai_enabled) {
    aiEl.textContent = `Enabled (${state.config.ai_remaining_today} left today)`;
    aiEl.className = 'font-mono text-go';
  } else {
    aiEl.textContent = 'Disabled (no API key)';
    aiEl.className = 'font-mono text-muted';
  }
}

async function loadConfig() {
  try {
    const cfg = await apiFetch('/api/config');
    state.config = cfg;
    if (Array.isArray(cfg.categories) && cfg.categories.length > 0) {
      state.categories = ['All', ...cfg.categories];
    }
    if (Array.isArray(cfg.glossary_categories) && cfg.glossary_categories.length > 0) {
      state.glossaryCategories = ['All', ...cfg.glossary_categories];
    }
    if (cfg.ui_settings) {
      state.uiSettings = { ...state.uiSettings, ...cfg.ui_settings };
      applyTheme(state.uiSettings.theme);
      applyLogoColor(state.uiSettings.logo_color);
    }
    syncAiUi();
    syncSettingsModalUi();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadParts() {
  try {
    state.parts = await apiFetch('/api/parts');
    renderCurrentPage();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadGlossary() {
  try {
    state.glossary = await apiFetch('/api/glossary');
    if (state.activePage === 'glossary') renderGlossary();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadShopping() {
  try {
    const [items, retailers] = await Promise.all([
      apiFetch('/api/shopping'),
      apiFetch('/api/retailers').catch(() => []),
    ]);
    state.shoppingItems = items;
    state.retailers = Array.isArray(retailers) ? retailers : [];
    updateNavBadges();
    if (state.activePage === 'shopping') {
      renderShopping();
      if (state.consolidateOpen) await refreshConsolidatePlan();
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function loadProjects() {
  try {
    state.projects = await apiFetch('/api/projects');
    updateNavBadges();
    if (state.activePage === 'projects') renderProjects();
    if (state.activePage === 'shopping') renderShopping();
  } catch (err) {
    showToast(err.message);
  }
}

function syncAiUi() {
  const btn = document.getElementById('smartAutofillBtn');
  const gBtn = document.getElementById('explainTermAiBtn');
  if (state.config.ai_enabled) {
    btn.classList.remove('hidden');
    btn.title = `Smart Autofill (${state.config.ai_remaining_today} left today)`;
    if (gBtn) {
      gBtn.classList.remove('hidden');
      gBtn.title = `Draft ASD-STE100 entry (${state.config.ai_remaining_today} left today)`;
    }
  } else {
    btn.classList.add('hidden');
    if (gBtn) gBtn.classList.add('hidden');
  }
}

// =============================================================================
// FILTERING, SORTING & RENDERING (GRID + LIST)
// =============================================================================
function getFilteredAndSortedParts() {
  const q = state.search.trim().toLowerCase();
  const loc = state.locationFilter.trim().toLowerCase();

  const filtered = state.parts.filter((p) => {
    if (state.category !== 'All' && p.category !== state.category) return false;
    if (loc && (p.location || '').trim().toLowerCase() !== loc) return false;
    if (state.needsPhotoOnly && Boolean(p.image_path)) return false;
    if (state.inUseOnly && !(p.in_use_project && p.in_use_project.trim())) return false;
    if (state.lowStockOnly && !isLowStock(p)) return false;

    if (q) {
      const hay = [
        p.name,
        p.subtitle,
        p.location,
        p.in_use_project,
        p.what_it_does,
        p.visual_tell,
        p.warning,
        p.notes,
        p.category,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    }
    return true;
  });

  const sortBy = state.uiSettings.sort_by || 'recent';
  if (sortBy === 'recent') {
    return filtered;
  }

  return [...filtered].sort((a, b) => {
    if (sortBy === 'name') {
      return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    }
    if (sortBy === 'location') {
      const la = (a.location || '').trim();
      const lb = (b.location || '').trim();
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      const cmp = la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? cmp : (a.name || '').localeCompare(b.name || '');
    }
    if (sortBy === 'qty_asc') {
      return Number(a.quantity || 0) - Number(b.quantity || 0);
    }
    if (sortBy === 'qty_desc') {
      return Number(b.quantity || 0) - Number(a.quantity || 0);
    }
    if (sortBy === 'needs_photo') {
      const ha = Boolean(a.image_path) ? 1 : 0;
      const hb = Boolean(b.image_path) ? 1 : 0;
      if (ha !== hb) return ha - hb;
      return (a.name || '').localeCompare(b.name || '');
    }
    return 0;
  });
}

function styleToggleChip(btn, active) {
  btn.setAttribute('aria-pressed', String(active));
}

function renderFilterStrip() {
  const strip = document.getElementById('categoryStrip');
  const catCounts = new Map();
  for (const p of state.parts) catCounts.set(p.category, (catCounts.get(p.category) || 0) + 1);

  strip.innerHTML = state.categories
    .map((cat) => {
      const active = state.category === cat;
      const count = cat === 'All' ? state.parts.length : catCounts.get(cat) || 0;
      return `<button type="button" data-cat="${escapeHTML(cat)}" aria-pressed="${active}" class="pb-side-item">
        <span>${escapeHTML(cat === 'All' ? 'All parts' : cat)}</span>
        <span class="pb-side-count">${count}</span>
      </button>`;
    })
    .join('');

  // Bin index: every bin as a label tape. Select one to show only that bin.
  const binIndex = document.getElementById('binIndex');
  if (binIndex) {
    const bins = [...new Set(state.parts.map((p) => (p.location || '').trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );
    binIndex.innerHTML = bins.length
      ? bins
          .map((b) => {
            const on = state.locationFilter.toLowerCase() === b.toLowerCase();
            return `<button type="button" data-bin="${escapeHTML(b)}" class="pb-bin-tag ${on ? 'ring-2 ring-ink ring-offset-1 ring-offset-mat' : ''}" title="Show only bin ${escapeHTML(b)}">${escapeHTML(b)}</button>`;
          })
          .join('')
      : `<p class="text-[13px] text-muted leading-snug">No bins yet. Type a bin name when you edit a part.</p>`;
    binIndex.onclick = (e) => {
      const btn = e.target.closest('button[data-bin]');
      if (!btn) return;
      state.locationFilter = state.locationFilter === btn.dataset.bin ? '' : btn.dataset.bin;
      renderGrid();
    };
  }

  const locPill = document.getElementById('activeLocationPill');
  if (state.locationFilter) {
    document.getElementById('activeLocationLabel').textContent = state.locationFilter;
    locPill.classList.remove('hidden');
  } else {
    locPill.classList.add('hidden');
  }

  const heading = document.getElementById('inventoryHeading');
  if (heading) heading.textContent = state.category === 'All' ? 'All parts' : state.category;

  const needsPhotoCount = state.parts.filter((p) => !p.image_path).length;
  const inUseCount = state.parts.filter((p) => p.in_use_project && p.in_use_project.trim()).length;
  const lowStockCount = state.parts.filter((p) => isLowStock(p)).length;

  document.getElementById('needsPhotoCount').textContent = needsPhotoCount;
  document.getElementById('inUseCount').textContent = inUseCount;
  document.getElementById('lowStockCount').textContent = lowStockCount;

  styleToggleChip(document.getElementById('needsPhotoBtn'), state.needsPhotoOnly);
  styleToggleChip(document.getElementById('inUseBtn'), state.inUseOnly);
  styleToggleChip(document.getElementById('lowStockBtn'), state.lowStockOnly);
}

// Line drawings that stand in for a missing photo, one for each category.
const CATEGORY_GLYPHS = {
  Microcontrollers:
    '<rect x="6.5" y="6.5" width="11" height="11" rx="1"/><path d="M9.5 2.5v4M14.5 2.5v4M9.5 17.5v4M14.5 17.5v4M2.5 9.5h4M2.5 14.5h4M17.5 9.5h4M17.5 14.5h4"/><circle cx="9.5" cy="9.5" r=".6" fill="currentColor"/>',
  Sensors:
    '<circle cx="12" cy="12" r="2"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.3 9.3 0 0 1 0-13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/>',
  Displays:
    '<rect x="2.5" y="5" width="19" height="12" rx="1"/><path d="M8 21h8M12 17v4"/><path d="M7 9.5h3M7 12.5h6"/>',
  Actuators:
    '<rect x="2.5" y="7.5" width="13" height="9" rx="1"/><circle cx="9" cy="12" r="2"/><path d="M15.5 12h6M19 9.5v5"/>',
  Passives:
    '<path d="M1.5 12h4l1.4-3.5 2.8 7 2.8-7 2.8 7 2.8-7 1.4 3.5h3"/>',
  Prototyping:
    '<rect x="2.5" y="4.5" width="19" height="15" rx="1"/><path d="M2.5 12h19"/><g fill="currentColor" stroke="none"><circle cx="6.5" cy="8" r=".9"/><circle cx="10" cy="8" r=".9"/><circle cx="13.5" cy="8" r=".9"/><circle cx="17" cy="8" r=".9"/><circle cx="6.5" cy="16" r=".9"/><circle cx="10" cy="16" r=".9"/><circle cx="13.5" cy="16" r=".9"/><circle cx="17" cy="16" r=".9"/></g>',
  Tools:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
};
function categoryGlyph(cat, cls = 'pb-glyph') {
  const body = CATEGORY_GLYPHS[cat] || '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h16"/>';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function binTag(location) {
  return location
    ? `<button type="button" data-bin="${escapeHTML(location)}" class="pb-bin-tag" title="Show only bin ${escapeHTML(location)}">${escapeHTML(location)}</button>`
    : `<span class="pb-bin-tag is-empty" title="This part has no bin">No bin</span>`;
}

function partStatusHtml(p) {
  if (p.in_use_project && p.in_use_project.trim()) {
    return `<span class="pb-status is-go truncate" title="Used in ${escapeHTML(p.in_use_project)}"><span class="truncate">${escapeHTML(p.in_use_project)}</span></span>`;
  }
  if (isLowStock(p)) return `<span class="pb-status is-stop">Low stock</span>`;
  if (state.uiSettings.show_caution_badge && p.warning) {
    return `<span class="pb-status is-stop" title="${escapeHTML(p.warning)}">Caution</span>`;
  }
  return '';
}

function qtyStepper(p, attr = 'data-step', size = 'w-7 h-7', withId = true) {
  const low = isLowStock(p);
  return `<div class="pb-stepper shrink-0" data-stepper>
    <button type="button" ${attr}="-1" data-id="${escapeHTML(p.id)}" class="${size} flex items-center justify-center text-sm" aria-label="Remove one">&minus;</button>
    <span ${withId ? `id="qty-${escapeHTML(p.id)}"` : ''} class="min-w-[30px] text-center text-sm font-semibold ${low ? 'pb-qty-low' : ''}">${p.quantity}</span>
    <button type="button" ${attr}="1" data-id="${escapeHTML(p.id)}" class="${size} flex items-center justify-center text-sm" aria-label="Add one">+</button>
  </div>`;
}

function renderGridCard(p) {
  const photo = p.image_path
    ? `<img src="${escapeHTML(imageUrl(p.image_path))}" alt="" loading="lazy" />`
    : `${categoryGlyph(p.category)}<span class="pb-needs-photo">No photo</span>`;

  return `
    <article data-id="${escapeHTML(p.id)}" class="interactive-card pb-part-card">
      <div class="pb-part-photo">${photo}</div>
      <div class="p-3.5 pl-4 flex flex-col min-w-0">
        <h3 class="pb-part-name line-clamp-2">${escapeHTML(p.name)}</h3>
        <p class="text-[13px] text-muted truncate mt-1">${escapeHTML(p.subtitle || p.category)}</p>
        ${partStatusHtml(p) ? `<div class="mt-1.5 flex min-w-0">${partStatusHtml(p)}</div>` : ''}
        <div class="mt-auto pt-3 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0">
            ${p.location ? binTag(p.location) : ''}
          </div>
          ${qtyStepper(p)}
        </div>
      </div>
    </article>
  `;
}

function renderListRow(p) {
  const thumb = p.image_path
    ? `<img src="${escapeHTML(imageUrl(p.image_path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" loading="lazy" />`
    : categoryGlyph(p.category, 'w-5 h-5 text-muted opacity-60');
  return `
    <tr data-id="${escapeHTML(p.id)}">
      <td class="w-14 !pr-0"><div class="pb-well w-11 h-11 rounded flex items-center justify-center overflow-hidden">${thumb}</div></td>
      <td class="w-full max-w-0">
        <div class="pb-part-name pb-table-name !text-[15px]">${escapeHTML(p.name)}</div>
        <div class="text-[13px] text-muted truncate">${escapeHTML(p.subtitle || '')}</div>
        ${p.location ? `<div class="sm:hidden mt-1">${binTag(p.location)}</div>` : ''}
      </td>
      <td class="hidden md:table-cell text-[13px] text-ink-2 whitespace-nowrap">${escapeHTML(p.category)}</td>
      <td class="hidden sm:table-cell">${p.location ? binTag(p.location) : '<span class="text-muted">&ndash;</span>'}</td>
      <td class="hidden lg:table-cell max-w-[180px]">${partStatusHtml(p)}</td>
      <td class="text-right" data-stepper>${qtyStepper(p, 'data-step', 'w-6 h-7')}</td>
    </tr>
  `;
}

function renderGrid() {
  const container = document.getElementById('partsGrid');
  const empty = document.getElementById('emptyState');
  const items = getFilteredAndSortedParts();

  renderFilterStrip();
  const countEl = document.getElementById('inventoryResultCount');
  if (countEl) countEl.textContent = `${items.length} ${items.length === 1 ? 'part' : 'parts'}`;

  if (items.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  if (state.uiSettings.view_mode === 'list') {
    container.className = '';
    container.innerHTML = `
      <table class="pb-table">
        <thead><tr>
          <th class="w-14"><span class="sr-only">Photo</span></th>
          <th>Part</th>
          <th class="hidden md:table-cell">Category</th>
          <th class="hidden sm:table-cell">Bin</th>
          <th class="hidden lg:table-cell">Status</th>
          <th class="text-right"><span class="hidden sm:inline">Quantity</span><span class="sm:hidden">Qty</span></th>
        </tr></thead>
        <tbody>${items.map(renderListRow).join('')}</tbody>
      </table>`;
  } else {
    container.className = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3';
    container.innerHTML = items.map(renderGridCard).join('');
  }
}

function refreshLocationDatalist() {
  const locs = [...new Set(state.parts.map((p) => (p.location || '').trim()).filter(Boolean))].sort();
  document.getElementById('locationSuggestions').innerHTML = locs
    .map((l) => `<option value="${escapeHTML(l)}"></option>`)
    .join('');
}

// =============================================================================
// PAGE SWITCHING, PROJECTS VIEW & DYNAMIC GLOSSARY (ASD-STE100)
// =============================================================================
function updateNavBadges() {
  const activeCount = state.projects.filter((p) => p.status !== 'archived').length;
  const pBadge = document.getElementById('navProjectsCount');
  if (pBadge) {
    if (activeCount > 0) {
      pBadge.textContent = activeCount;
      pBadge.classList.remove('hidden');
    } else {
      pBadge.classList.add('hidden');
    }
  }

  const lowCount = state.parts.filter((p) => Number(p.quantity) === 0 || isLowStock(p)).length;
  const shopTotal = state.shoppingItems.length + lowCount;
  const sBadge = document.getElementById('navShoppingCount');
  if (sBadge) {
    if (shopTotal > 0) {
      sBadge.textContent = shopTotal;
      sBadge.classList.remove('hidden');
    } else {
      sBadge.classList.add('hidden');
    }
  }
}

const VALID_PAGES = new Set(['inventory', 'projects', 'shopping', 'glossary', 'bench']);
const VALID_BENCH_TABS = new Set(['guides', 'calculators', 'compat', 'labels']);

function parseRouteFromLocation() {
  const rawPath = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (rawPath === '/' || rawPath === '/inventory') {
    return { page: 'inventory', benchSub: null };
  }
  const segs = rawPath.replace(/^\/+/, '').split('/');
  const first = (segs[0] || '').toLowerCase();
  if (VALID_PAGES.has(first)) {
    const sub = first === 'bench' && segs[1] && VALID_BENCH_TABS.has(segs[1].toLowerCase())
      ? segs[1].toLowerCase()
      : null;
    return { page: first, benchSub: sub };
  }
  return { page: 'inventory', benchSub: null };
}

function buildUrlForPage(page, benchSub) {
  const search = window.location.search || '';
  if (page === 'inventory') return `/${search}`;
  if (page === 'bench' && benchSub && VALID_BENCH_TABS.has(benchSub)) {
    return `/bench/${benchSub}${search}`;
  }
  return `/${page}${search}`;
}

window.syncBenchUrl = function syncBenchUrl(subTab) {
  if (state.activePage !== 'bench') return;
  const nextUrl = buildUrlForPage('bench', subTab);
  if (window.location.pathname + window.location.search !== nextUrl) {
    window.history.pushState({ page: 'bench', benchSub: subTab }, '', nextUrl);
  }
};

function switchPage(page, opts = {}) {
  const cleanPage = VALID_PAGES.has(page) ? page : 'inventory';
  state.activePage = cleanPage;

  if (cleanPage === 'bench' && opts.benchSub && typeof wbState !== 'undefined' && VALID_BENCH_TABS.has(opts.benchSub)) {
    wbState.subTab = opts.benchSub;
  }

  if (opts.pushState !== false) {
    const benchSub = cleanPage === 'bench' && typeof wbState !== 'undefined' ? wbState.subTab : null;
    const targetUrl = buildUrlForPage(cleanPage, benchSub);
    if (window.location.pathname + window.location.search !== targetUrl) {
      window.history.pushState({ page: cleanPage, benchSub }, '', targetUrl);
    }
  }

  document.getElementById('inventoryView').classList.toggle('hidden', cleanPage !== 'inventory');
  document.getElementById('inventoryFilterBar').classList.toggle('hidden', cleanPage !== 'inventory');
  document.getElementById('projectsView').classList.toggle('hidden', cleanPage !== 'projects');
  document.getElementById('shoppingView').classList.toggle('hidden', cleanPage !== 'shopping');
  document.getElementById('glossaryView').classList.toggle('hidden', cleanPage !== 'glossary');
  document.getElementById('benchView').classList.toggle('hidden', cleanPage !== 'bench');

  document.querySelectorAll('button[data-page]').forEach((btn) => {
    const isAct = btn.dataset.page === cleanPage;
    btn.classList.toggle('pb-tab-active', isAct);
  });

  const searchInput = document.getElementById('searchInput');
  if (cleanPage === 'glossary') {
    searchInput.placeholder = 'Search the glossary';
  } else if (cleanPage === 'projects') {
    searchInput.placeholder = 'Search projects';
  } else if (cleanPage === 'shopping') {
    searchInput.placeholder = 'Search the shopping list';
  } else {
    searchInput.placeholder = 'Search parts, bins, projects';
  }

  renderCurrentPage();
}

function renderCurrentPage() {
  updateNavBadges();
  if (state.activePage === 'projects') {
    renderProjects();
  } else if (state.activePage === 'shopping') {
    renderShopping();
  } else if (state.activePage === 'glossary') {
    renderGlossary();
  } else if (state.activePage === 'bench') {
    if (typeof renderWorkbench === 'function') renderWorkbench();
  } else {
    renderGrid();
  }
}

function _getShoppingGroupLabel(it, mode) {
  if (mode === 'store') {
    if (it.retailer) return it.retailer;
    if (it.url && /^https?:\/\//i.test(it.url)) {
      try {
        return new URL(it.url).hostname.replace(/^www\./, '');
      } catch (_) {}
    }
    return 'Other / Unassigned Store';
  }
  if (mode === 'project') {
    const links = it.project_links || [];
    if (links.length > 0) {
      const first = links[0];
      return first.variant_name
        ? `${first.project_name} · ${first.variant_name}`
        : `${first.project_name} · Core`;
    }
    if (it.tag && it.tag.trim()) return it.tag.trim();
    return 'General / Untagged';
  }
  return '';
}

function _getShoppingTopTag(it) {
  const links = it.project_links || [];
  if (links.length > 0) return links[0].project_name;
  if (it.tag && it.tag.trim()) return it.tag.trim();
  return 'General';
}

function _formatCostMap(costMap) {
  if (!costMap) return '';
  const entries = Object.entries(costMap).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return '';
  return entries
    .map(([cur, val]) => `${Number(val).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`)
    .join(' + ');
}

function _formatMoney(val, currency) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '';
  const n = Number(val).toFixed(2);
  if (currency === 'TRY') return `${n} TL`;
  if (currency === 'USD') return `$${n}`;
  if (currency === 'EUR') return `€${n}`;
  if (currency === 'GBP') return `£${n}`;
  return currency ? `${n} ${currency}` : n;
}

async function refreshConsolidatePlan() {
  const panel = document.getElementById('shoppingConsolidatePanel');
  if (!panel || !state.consolidateOpen) return;
  try {
    state.consolidatePlan = await apiFetch('/api/shopping/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag: state.shoppingTagFilter !== 'All' ? state.shoppingTagFilter : null,
        mode: state.consolidateMode,
        include_inactive_variants: state.shoppingShowOtherBuilds,
        apply: false,
      }),
    });
    renderConsolidatePanel();
  } catch (err) {
    panel.innerHTML = `<p class="text-xs text-stop">${escapeHTML(err.message)}</p>`;
  }
}

function renderConsolidatePanel() {
  const panel = document.getElementById('shoppingConsolidatePanel');
  if (!panel || !state.consolidateOpen) return;
  const plan = state.consolidatePlan;
  if (!plan) {
    panel.innerHTML = `<p class="text-xs text-muted">Checking store options...</p>`;
    return;
  }
  const cur = plan.current || { store_count: 0, carts: [] };
  const rec = plan.recommended || { store_count: 0, carts: [] };
  const currency = rec.currency || cur.currency || '';
  const scopeLabel = state.shoppingTagFilter !== 'All' ? state.shoppingTagFilter : 'All items';

  const retailersByDomain = new Map((state.retailers || []).map((r) => [r.domain, r]));
  const seenDomains = new Set();
  (cur.carts || []).forEach((c) => seenDomains.add(c.retailer));
  (rec.carts || []).forEach((c) => seenDomains.add(c.retailer));
  const storeDomains = [...seenDomains].filter(Boolean).sort();

  const summaryText =
    rec.store_count === 0
      ? 'No items with store links in this view yet.'
      : plan.changes_count > 0
      ? `Can switch ${plan.changes_count} ${plan.changes_count === 1 ? 'item' : 'items'}: ${cur.store_count} ${cur.store_count === 1 ? 'store' : 'stores'} &rarr; ${rec.store_count} ${rec.store_count === 1 ? 'store' : 'stores'}${rec.total !== null ? ` (${escapeHTML(_formatMoney(rec.total, currency))})` : ''}`
      : `Already optimal: ${rec.store_count} ${rec.store_count === 1 ? 'store' : 'stores'}${rec.total !== null ? ` · Est. total ${escapeHTML(_formatMoney(rec.total, currency))}` : ''}`;

  const cartsHtml = (rec.carts || [])
    .map((c) => {
      const shipNote =
        c.shipping_cost === null
          ? ''
          : c.shipping_cost === 0 && c.free_shipping_threshold !== null
          ? `<span class="text-go">Free shipping</span>`
          : `<span>+ ${escapeHTML(_formatMoney(c.shipping_cost, currency))} shipping${c.free_shipping_remaining > 0 ? ` (${escapeHTML(_formatMoney(c.free_shipping_remaining, currency))} to free)` : ''}</span>`;
      return `
        <div class="pb-well rounded p-3 space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold text-ink">${escapeHTML(c.display_name || c.retailer)}</span>
            <span class="text-[11px] font-mono text-muted">${c.item_count} ${c.item_count === 1 ? 'item' : 'items'}${c.subtotal !== null ? ` · ${escapeHTML(_formatMoney(c.subtotal, currency))}` : ''}</span>
          </div>
          ${shipNote ? `<div class="text-[11px] text-muted">${shipNote}</div>` : ''}
          <ul class="space-y-0.5 text-xs text-ink-2">
            ${(c.items || [])
              .map(
                (x) => `<li class="flex items-center justify-between gap-2">
                  <button type="button" data-open-shop="${escapeHTML(x.item_id)}" class="hover:underline truncate text-left">${escapeHTML(x.name)}${x.quantity > 1 ? ` ×${x.quantity}` : ''}</button>
                  <span class="font-mono text-[11px] text-muted shrink-0">${escapeHTML(x.price || '')}</span>
                </li>`
              )
              .join('')}
          </ul>
        </div>
      `;
    })
    .join('');

  const stragglersHtml = (plan.stragglers || [])
    .map(
      (s) => `<div class="rounded border border-line px-3 py-2 text-xs text-ink-2 flex flex-wrap items-center justify-between gap-2">
        <span>${escapeHTML(s.suggestion)}</span>
        <span class="flex flex-wrap gap-1">${(s.items || [])
          .map(
            (x) => `<button type="button" data-open-shop="${escapeHTML(x.item_id)}" class="pb-badge pb-badge-neutral !text-[11px] hover:border-accent/50 cursor-pointer">${escapeHTML(x.name)}</button>`
          )
          .join('')}</span>
      </div>`
    )
    .join('');

  const shippingRowsHtml = storeDomains
    .map((dom) => {
      const meta = retailersByDomain.get(dom) || {};
      return `
        <div data-retailer-row class="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs">
          <span class="font-mono text-ink min-w-[10rem] truncate">${escapeHTML(dom)}</span>
          <input data-ret-ship type="number" min="0" step="any" placeholder="Shipping fee" value="${meta.shipping_cost ?? ''}" class="w-28 h-7 px-2 text-xs" />
          <input data-ret-free type="number" min="0" step="any" placeholder="Free over..." value="${meta.free_shipping_threshold ?? ''}" class="w-28 h-7 px-2 text-xs" />
          <button type="button" data-save-retailer="${escapeHTML(dom)}" class="btn-secondary h-7 px-2.5 text-xs shrink-0">Save</button>
        </div>
      `;
    })
    .join('');

  const prevDetails = panel.querySelector('details[data-cons-shipping]');
  const shippingWasOpen = Boolean(prevDetails && prevDetails.open);
  const currencyNote = rec.mixed_currencies
    ? `<p class="text-[11px] text-muted mb-2">Items use multiple currencies, so combined totals are omitted.</p>`
    : '';

  panel.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div>
        <div class="text-xs font-semibold text-ink">Consolidate stores <span class="font-normal text-muted">· ${escapeHTML(scopeLabel)}</span></div>
        <p class="text-xs text-muted mt-0.5">${summaryText}</p>
      </div>
      ${plan.changes_count > 0 ? `<button type="button" id="consApplyBtn" class="btn-primary h-7 px-3 text-xs shrink-0">Apply (${plan.changes_count})</button>` : ''}
    </div>
    ${currencyNote}
    ${cartsHtml ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">${cartsHtml}</div>` : ''}
    ${stragglersHtml ? `<div class="space-y-1.5 mb-3">${stragglersHtml}</div>` : ''}
    ${
      storeDomains.length > 0
        ? `<details data-cons-shipping ${shippingWasOpen ? 'open' : ''} class="pt-2 border-t border-line">
             <summary class="text-xs font-medium text-muted cursor-pointer select-none">Price &amp; shipping options</summary>
             <div class="mt-2.5 space-y-2.5">
               <div class="flex flex-wrap items-center gap-2 text-xs">
                 <span class="text-muted">Optimize for:</span>
                 <div class="pb-segmented inline-flex items-center rounded p-0.5" role="group" aria-label="Optimization mode">
                   <button type="button" data-cons-mode="fewest_orders" class="h-6 px-2.5 rounded-md text-xs font-medium ${state.consolidateMode === 'fewest_orders' ? 'pb-seg-active' : 'opacity-65'}">Fewest stores</button>
                   <button type="button" data-cons-mode="lowest_cost" class="h-6 px-2.5 rounded-md text-xs font-medium ${state.consolidateMode === 'lowest_cost' ? 'pb-seg-active' : 'opacity-65'}">Lowest total</button>
                 </div>
               </div>
               <div class="space-y-2">${shippingRowsHtml}</div>
             </div>
           </details>`
        : ''
    }
  `;
}

function renderShopping() {
  const q = state.search.trim().toLowerCase();
  const wishGrid = document.getElementById('shoppingWishlistGrid');
  const wishEmpty = document.getElementById('shoppingWishlistEmpty');
  const lowGrid = document.getElementById('shoppingLowStockGrid');
  const lowEmpty = document.getElementById('shoppingLowStockEmpty');
  const tagBar = document.getElementById('shoppingTagFilterBar');

  // Sync segmented group buttons
  document.querySelectorAll('button[data-shop-group]').forEach((btn) => {
    const isAct = btn.dataset.shopGroup === state.shoppingGroupBy;
    btn.classList.toggle('pb-seg-active', isAct);
    btn.classList.toggle('opacity-65', !isAct);
  });

  // Exclude items that only belong to unselected sub-builds unless user explicitly toggles them on
  const inactiveCount = state.shoppingItems.filter((it) => it.in_inactive_variant).length;
  const activePool = state.shoppingShowOtherBuilds
    ? state.shoppingItems
    : state.shoppingItems.filter((it) => !it.in_inactive_variant);

  // Tag/project filter pills
  const tagCounts = new Map();
  for (const it of activePool) {
    const topTag = _getShoppingTopTag(it);
    tagCounts.set(topTag, (tagCounts.get(topTag) || 0) + 1);
  }
  if (tagCounts.size > 1 || inactiveCount > 0) {
    tagBar.classList.remove('hidden');
    if (state.shoppingTagFilter !== 'All' && !tagCounts.has(state.shoppingTagFilter)) {
      state.shoppingTagFilter = 'All';
    }
    const chips =
      tagCounts.size > 1
        ? [['All', activePool.length], ...[...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))]
        : [];
    const tagHtml = chips
      .map(([lbl, cnt]) => {
        const active = state.shoppingTagFilter === lbl;
        return `<button type="button" data-shop-tag="${escapeHTML(lbl)}" aria-pressed="${active}" class="pb-toggle-chip h-7 px-2.5 text-xs font-medium inline-flex items-center gap-1.5">${escapeHTML(lbl)} <span class="pb-chip-count text-muted">${cnt}</span></button>`;
      })
      .join('');
    const otherBuildsChip =
      inactiveCount > 0
        ? `<button type="button" id="toggleOtherBuildsBtn" aria-pressed="${state.shoppingShowOtherBuilds}" class="pb-toggle-chip h-7 px-2.5 text-xs font-medium inline-flex items-center gap-1.5 ${chips.length ? 'ml-auto' : ''}" title="Show items from unselected project sub-builds">Other builds <span class="pb-chip-count text-muted">${inactiveCount}</span></button>`
        : '';
    tagBar.innerHTML = tagHtml + otherBuildsChip;
  } else {
    state.shoppingTagFilter = 'All';
    tagBar.classList.add('hidden');
    tagBar.innerHTML = '';
  }

  const smallThumb = (path, cat) =>
    path
      ? `<img src="${escapeHTML(imageUrl(path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" />`
      : categoryGlyph(cat, 'w-5 h-5 text-muted opacity-60');

  const wishItems = activePool.filter((it) => {
    if (state.shoppingTagFilter !== 'All' && _getShoppingTopTag(it) !== state.shoppingTagFilter) {
      return false;
    }
    if (!q) return true;
    const hay = `${it.name} ${it.why_needed || ''} ${it.notes || ''} ${it.price || ''} ${it.retailer || ''} ${it.tag || ''}`.toLowerCase();
    return hay.includes(q);
  });

  const renderItemCard = (it) => {
    let host = it.retailer || '';
    if (!host && it.url && /^https?:\/\//i.test(it.url)) {
      try {
        host = new URL(it.url).hostname.replace(/^www\./, '');
      } catch (_) {}
    }
    const reason = (it.why_needed || it.notes || '').trim();
    const stockBadge =
      it.in_stock === 'in_stock'
        ? `<span class="text-[11px] font-medium text-go">In stock</span>`
        : it.in_stock === 'out_of_stock'
        ? `<span class="text-[11px] font-medium text-stop">Out of stock</span>`
        : '';
    const links = it.project_links || [];
    const linkBadges = (state.shoppingGroupBy === 'project' && links.length === 1 ? [] : links)
      .map(
        (lk) =>
          `<span class="pb-badge pb-badge-neutral !text-[11px] !py-0 !px-1.5">${escapeHTML(lk.project_name)}${lk.variant_name ? ` · ${escapeHTML(lk.variant_name)}` : ' · Core'}</span>`
      )
      .join('');
    const safeUrl = it.url && /^https?:\/\//i.test(it.url);
    return `
      <div class="elevated-card rounded-md p-3 flex flex-wrap items-center gap-3 hover:border-accent/40 transition-colors">
        <button type="button" data-open-shop="${escapeHTML(it.id)}" class="pb-well w-12 h-12 rounded flex items-center justify-center overflow-hidden shrink-0 cursor-pointer" title="View details">${smallThumb(it.image_path, it.category)}</button>
        <div class="min-w-[11rem] flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" data-open-shop="${escapeHTML(it.id)}" class="pb-part-name !text-[15px] hover:underline truncate text-left max-w-full">${escapeHTML(it.name)}</button>
            ${linkBadges}
          </div>
          <div class="text-[13px] text-muted flex flex-wrap items-center gap-2 min-w-0 mt-0.5">
            ${it.price ? `<span class="font-semibold text-ink">${escapeHTML(it.price)}</span>` : ''}
            ${host && safeUrl ? `<a href="${escapeHTML(it.url)}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline truncate">${escapeHTML(host)}</a>` : host ? `<span>${escapeHTML(host)}</span>` : ''}
            ${(it.offers || []).length > 1 ? `<button type="button" data-open-shop="${escapeHTML(it.id)}" class="pb-badge pb-badge-neutral !text-[11px] !py-0 !px-1.5 hover:border-accent/50 cursor-pointer" title="Compare store options">+${it.offers.length - 1} ${it.offers.length - 1 === 1 ? 'store' : 'stores'}</button>` : ''}
            ${stockBadge}
          </div>
          ${reason ? `<p class="text-xs text-muted mt-1 line-clamp-2">${escapeHTML(reason)}</p>` : ''}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="pb-stepper">
            <button type="button" data-shop-step="-1" data-shop-id="${escapeHTML(it.id)}" class="w-7 h-7 text-sm" aria-label="Buy one less">&minus;</button>
            <span class="min-w-[28px] text-center text-sm font-semibold">${it.quantity}</span>
            <button type="button" data-shop-step="1" data-shop-id="${escapeHTML(it.id)}" class="w-7 h-7 text-sm" aria-label="Buy one more">+</button>
          </div>
          <button type="button" data-shop-bought="${escapeHTML(it.id)}" class="btn-primary h-8 px-3 text-[13px]" title="Add this to your inventory">Bought</button>
          <div class="inline-flex items-center gap-1.5" data-inline-confirm>
            <button type="button" data-confirm-init class="btn-icon h-8 w-8 flex items-center justify-center" title="Remove from list" aria-label="Remove from list">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
            <div class="hidden items-center gap-1.5" data-confirm-group>
              <button type="button" data-shop-del="${escapeHTML(it.id)}" class="btn-danger h-8 px-2.5 rounded text-xs font-medium">Remove</button>
              <button type="button" data-confirm-cancel class="btn-secondary h-8 px-2.5 rounded text-xs font-medium">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;
  };

  if (wishItems.length === 0) {
    wishGrid.innerHTML = '';
    wishEmpty.classList.remove('hidden');
  } else {
    wishEmpty.classList.add('hidden');
    if (state.shoppingGroupBy === 'flat') {
      wishGrid.innerHTML = `<div class="space-y-2">${wishItems.map(renderItemCard).join('')}</div>`;
    } else {
      const groups = new Map();
      for (const it of wishItems) {
        const gName = _getShoppingGroupLabel(it, state.shoppingGroupBy);
        if (!groups.has(gName)) groups.set(gName, []);
        groups.get(gName).push(it);
      }
      const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      wishGrid.innerHTML = sortedGroups
        .map(([gName, items]) => {
          return `
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2 px-1">
                <span class="text-xs font-semibold text-ink">${escapeHTML(gName)}</span>
                <span class="text-[11px] font-mono text-muted">${items.length} ${items.length === 1 ? 'item' : 'items'}</span>
              </div>
              <div class="space-y-2">${items.map(renderItemCard).join('')}</div>
            </div>
          `;
        })
        .join('');
    }
  }

  const lowParts = state.parts.filter(
    (p) => (Number(p.quantity) === 0 || isLowStock(p)) && (!q || `${p.name} ${p.subtitle} ${p.location}`.toLowerCase().includes(q))
  );
  if (lowParts.length === 0) {
    lowGrid.innerHTML = '';
    lowEmpty.classList.remove('hidden');
  } else {
    lowEmpty.classList.add('hidden');
    lowGrid.innerHTML = lowParts
      .map((p) => {
        const left = Number(p.quantity) === 0 ? 'Empty' : `${p.quantity} left`;
        return `
          <div class="elevated-card rounded-md p-3 flex flex-wrap items-center gap-3">
            <div class="pb-well w-12 h-12 rounded flex items-center justify-center overflow-hidden shrink-0">${smallThumb(p.image_path, p.category)}</div>
            <div class="min-w-[11rem] flex-1">
              <button type="button" data-open-part="${escapeHTML(p.id)}" class="pb-part-name !text-[15px] hover:underline truncate block text-left max-w-full">${escapeHTML(p.name)}</button>
              <div class="text-[13px] flex items-center gap-2 mt-0.5">
                ${p.location ? `<span class="pb-bin-tag !h-5 !text-[12px]">${escapeHTML(p.location)}</span>` : ''}
                <span class="text-stop font-semibold">${left}</span>
                ${p.low_stock_threshold != null ? `<span class="text-muted">limit ${escapeHTML(p.low_stock_threshold)}</span>` : ''}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${
                p.source_url && /^https?:\/\//i.test(p.source_url)
                  ? `<a href="${escapeHTML(p.source_url)}" target="_blank" rel="noopener noreferrer" class="btn-secondary h-8 px-3 text-[13px] inline-flex items-center gap-1">Reorder
                       <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 17 17 7M8 7h9v9"/></svg></a>`
                  : ''
              }
              <button type="button" data-restock-id="${escapeHTML(p.id)}" class="btn-secondary h-8 px-3 text-[13px]">Add 1</button>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

const PROJECT_STATUS_META = {
  active: { label: 'Active on bench', dot: 'is-go' },
  planning: { label: 'Planning', dot: 'is-idle' },
  completed: { label: 'Completed', dot: '' },
  archived: { label: 'Archived', dot: '' },
};

function renderProjects() {
  const grid = document.getElementById('projectsGrid');
  const empty = document.getElementById('projectsEmptyState');
  const q = state.search.trim().toLowerCase();

  let list = state.projects.slice();
  if (q) {
    list = list.filter((proj) => {
      if (`${proj.name} ${proj.description || ''} ${proj.notes || ''}`.toLowerCase().includes(q)) return true;
      return (proj.items || []).some((it) => `${it.name} ${it.project_notes || ''}`.toLowerCase().includes(q));
    });
  }

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = list
    .map((proj) => {
      const st = PROJECT_STATUS_META[proj.status] || PROJECT_STATUS_META.planning;
      const variants = proj.variants || [];
      const activeTab = state.projectActiveTab[proj.id] || (proj.selected_variant_id || 'all');
      const allItems = proj.items || [];

      let visibleItems = allItems;
      if (activeTab === 'core') {
        visibleItems = allItems.filter((it) => !it.variant_id);
      } else if (activeTab !== 'all') {
        visibleItems = allItems.filter((it) => !it.variant_id || it.variant_id === activeTab);
      }

      const ownedItems = visibleItems.filter((it) => it.item_type === 'part');
      const shopItems = visibleItems.filter((it) => it.item_type === 'shopping');

      const readiness = proj.readiness || { owned_count: ownedItems.length, to_buy_count: shopItems.length, total_count: visibleItems.length, spares_count: 0, remaining_cost: {}, remaining_cost_base: {} };
      const pct = readiness.total_count > 0 ? Math.round((readiness.owned_count / readiness.total_count) * 100) : 0;
      const costStr = _formatCostMap(readiness.remaining_cost);
      const baseCostStr = _formatCostMap(readiness.remaining_cost_base);
      const hasSpares = Number(readiness.spares_count || 0) > 0 && baseCostStr && baseCostStr !== costStr;

      const renderProjectRow = (it) => {
        const thumb = it.image_path
          ? `<img src="${escapeHTML(imageUrl(it.image_path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" />`
          : categoryGlyph(it.category || 'Sensors', 'w-4 h-4 text-muted opacity-60');
        const varObj = it.variant_id ? variants.find((v) => v.id === it.variant_id) : null;
        const isShop = it.item_type === 'shopping';
        const openAttr = isShop
          ? `data-open-shop="${escapeHTML(it.shopping_item_id)}" data-ctx-proj="${escapeHTML(proj.id)}" data-ctx-pitem="${escapeHTML(it.id)}"`
          : `data-open-pitem="${escapeHTML(it.id)}" data-ctx-proj="${escapeHTML(proj.id)}"`;
        const notePreview = markdownToPlain(it.project_notes || it.why_needed || '');
        return `
          <button type="button" ${openAttr} class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-ink/[0.035] transition-colors">
            <div class="pb-well w-9 h-9 rounded flex items-center justify-center overflow-hidden shrink-0">${thumb}</div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium truncate">${escapeHTML(it.name)}</p>
              ${
                varObj || notePreview
                  ? `<div class="flex items-center gap-1.5 min-w-0 mt-0.5">
                       ${varObj ? `<span class="pb-badge pb-badge-neutral !text-[10px] !py-0 !px-1.5 shrink-0">${escapeHTML(varObj.name)}</span>` : ''}
                       ${notePreview ? `<p class="text-[12px] text-muted truncate">${escapeHTML(notePreview)}</p>` : ''}
                     </div>`
                  : ''
              }
            </div>
            ${
              isShop
                ? (() => {
                    const buyQty = Math.max(1, Number(it.buy_quantity || it.shopping_quantity || it.quantity_needed || 1));
                    const spares = Math.max(0, buyQty - 1);
                    const qtyBadge = spares > 0
                      ? `<span class="pb-badge pb-badge-neutral !text-[10px] !py-0 !px-1.5 font-mono" title="Buying ${buyQty} (${spares} ${spares === 1 ? 'spare' : 'spares'})">&times;${buyQty} (${spares} ${spares === 1 ? 'spare' : 'spares'})</span>`
                      : '';
                    return `<div class="flex items-center gap-1.5 shrink-0">${qtyBadge}${it.price ? `<span class="text-xs font-mono text-ink-2">${escapeHTML(it.price)}</span>` : ''}</div>`;
                  })()
                : `<div class="flex items-center gap-2 shrink-0">
                     ${it.location ? `<span class="pb-bin-tag !h-5 !text-[11px]">${escapeHTML(it.location)}</span>` : ''}
                     <span class="text-xs font-mono text-muted" title="Need ${it.quantity_needed}, have ${it.owned_quantity}">${it.quantity_needed}/${it.owned_quantity}</span>
                   </div>`
            }
          </button>
        `;
      };

      const variantTabsHtml =
        variants.length > 0
          ? `<div class="px-4 pt-2 border-b border-line flex items-center gap-1 overflow-x-auto no-scrollbar">
               <button type="button" data-proj-tab="all" data-proj-id="${escapeHTML(proj.id)}" class="pb-tab !py-2 !text-xs ${activeTab === 'all' ? 'pb-tab-active' : ''}">All</button>
               <button type="button" data-proj-tab="core" data-proj-id="${escapeHTML(proj.id)}" class="pb-tab !py-2 !text-xs ${activeTab === 'core' ? 'pb-tab-active' : ''}">Core</button>
               ${variants
                 .map(
                   (v) =>
                     `<button type="button" data-proj-tab="${escapeHTML(v.id)}" data-proj-id="${escapeHTML(proj.id)}" class="pb-tab !py-2 !text-xs inline-flex items-center gap-1 ${activeTab === v.id ? 'pb-tab-active' : ''}">
                        ${v.is_selected ? '<span class="w-1.5 h-1.5 rounded-full bg-go inline-block"></span>' : ''}
                        <span>${escapeHTML(v.name)}</span>
                      </button>`
                 )
                 .join('')}
             </div>`
          : '';

      const selectedVariantObj = variants.find((v) => v.id === activeTab);
      const variantBanner =
        selectedVariantObj
          ? `<div class="px-4 py-2.5 bg-ink/[0.025] border-b border-line space-y-2 text-xs">
               <p class="text-muted leading-relaxed">${escapeHTML(selectedVariantObj.description || `Showing Core + ${selectedVariantObj.name}`)}</p>
               <div class="flex items-center justify-between gap-2">
                 <div>
                   ${
                     selectedVariantObj.is_selected
                       ? `<span class="inline-flex items-center gap-1.5 text-go font-medium"><span class="w-1.5 h-1.5 rounded-full bg-go"></span>Selected build</span>`
                       : `<button type="button" data-select-variant="${escapeHTML(selectedVariantObj.id)}" data-proj-id="${escapeHTML(proj.id)}" class="btn-secondary h-6 px-2 text-[11px]">Use this option</button>`
                   }
                 </div>
                 <div class="inline-flex items-center gap-1.5 shrink-0" data-inline-confirm>
                   <button type="button" data-confirm-init class="btn-danger-outline h-6 px-2 text-[11px] rounded" title="Delete this sub-build">Delete</button>
                   <div class="hidden items-center gap-1.5" data-confirm-group>
                     <button type="button" data-delete-variant="${escapeHTML(selectedVariantObj.id)}" data-proj-id="${escapeHTML(proj.id)}" data-variant-name="${escapeHTML(selectedVariantObj.name)}" class="btn-danger h-6 px-2 text-[11px] rounded" title="Parts linked only to this sub-build will be unlinked">Confirm</button>
                     <button type="button" data-confirm-cancel class="btn-secondary h-6 px-2 text-[11px] rounded">Cancel</button>
                   </div>
                 </div>
               </div>
             </div>`
          : '';

      let activeNotesHtml = '';
      let activeNotesLabel = 'Build notes';
      if (selectedVariantObj) {
        const vNotes = (selectedVariantObj.notes || '').trim();
        if (vNotes) activeNotesHtml = `<div class="pb-md">${renderMarkdown(vNotes)}</div>`;
        activeNotesLabel = `Build notes · ${selectedVariantObj.name}`;
      } else if (activeTab === 'all') {
        const blocks = [];
        if ((proj.notes || '').trim()) {
          blocks.push(`<div class="pb-md">${renderMarkdown(proj.notes.trim())}</div>`);
        }
        for (const v of variants) {
          if ((v.notes || '').trim()) {
            const hasPrev = blocks.length > 0;
            blocks.push(`
              <div class="${hasPrev ? 'mt-4 pt-3.5 border-t border-line' : ''}">
                <div class="pb-section-label !text-[12px] mb-2 flex items-center gap-1.5">
                  ${v.is_selected ? '<span class="w-1.5 h-1.5 rounded-full bg-go shrink-0"></span>' : ''}
                  <span>${escapeHTML(v.name)}</span>
                </div>
                <div class="pb-md">${renderMarkdown(v.notes.trim())}</div>
              </div>
            `);
          }
        }
        activeNotesHtml = blocks.join('');
      } else {
        const pNotes = (proj.notes || '').trim();
        if (pNotes) activeNotesHtml = `<div class="pb-md">${renderMarkdown(pNotes)}</div>`;
        activeNotesLabel = 'Build notes · Core';
      }

      return `
        <div class="elevated-card rounded-md overflow-hidden flex flex-col">
          <div class="px-4 py-3.5 border-b border-line">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 class="pb-display text-xl flex items-center gap-2 min-w-0 max-w-full">
                  <span class="pb-status ${st.dot}"></span>
                  <span class="truncate">${escapeHTML(proj.name)}</span>
                </h2>
                <span class="pb-badge pb-badge-neutral !text-[11px]">${escapeHTML(st.label)}</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
              ${
                proj.status === 'active'
                  ? `<button type="button" data-proj-status="planning" data-proj-id="${escapeHTML(proj.id)}" class="btn-secondary h-8 px-2.5 text-xs" title="Move back to planning and free parts">Tear down</button>`
                  : `<button type="button" data-proj-status="active" data-proj-id="${escapeHTML(proj.id)}" class="btn-secondary h-8 px-2.5 text-xs" title="Mark active on bench">Start build</button>`
              }
              <button type="button" data-edit-project="${escapeHTML(proj.id)}" class="btn-icon h-8 w-8 flex items-center justify-center" title="Edit project" aria-label="Edit project">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              </button>
              </div>
            </div>
            ${proj.description ? `<p class="text-[13px] text-muted mt-1">${escapeHTML(proj.description)}</p>` : ''}
            <div class="mt-2.5 space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-x-3 text-[12px] text-muted">
                <span><strong class="text-ink">${readiness.owned_count}/${readiness.total_count}</strong> parts on hand${readiness.to_buy_count > 0 ? ` · ${readiness.to_buy_count} to buy` : ''}</span>
                ${
                  costStr
                    ? `<span class="font-mono text-ink whitespace-nowrap">~${escapeHTML(costStr)} left${hasSpares ? ` <span class="text-muted font-normal">(~${escapeHTML(baseCostStr)} without spares)</span>` : ''}</span>`
                    : ''
                }
              </div>
              <div class="h-1.5 w-full rounded-full bg-ink/10 overflow-hidden">
                <div class="h-full bg-go rounded-full transition-all" style="width:${pct}%"></div>
              </div>
            </div>
          </div>

          ${variantTabsHtml}
          ${variantBanner}

          <div class="flex-1 divide-y divide-[var(--pb-divider)]">
            ${
              visibleItems.length === 0
                ? `<p class="px-4 py-6 text-xs text-muted text-center">No parts in this view yet.</p>`
                : `
                  ${
                    ownedItems.length > 0
                      ? `<div class="px-4 py-1.5 bg-ink/[0.02] pb-section-label !text-[12px]">On hand <span class="font-normal text-muted">${ownedItems.length}</span></div>
                         ${ownedItems.map(renderProjectRow).join('')}`
                      : ''
                  }
                  ${
                    shopItems.length > 0
                      ? `<div class="px-4 py-1.5 bg-ink/[0.02] pb-section-label !text-[12px]">To buy <span class="font-normal text-muted">${shopItems.length}</span></div>
                         ${shopItems.map(renderProjectRow).join('')}`
                      : ''
                  }
                `
            }
          </div>

          ${
            activeNotesHtml
              ? `<details class="border-t border-line bg-ink/[0.015] group">
                   <summary class="px-4 py-2 text-xs font-medium text-muted hover:text-ink cursor-pointer flex items-center justify-between list-none">
                     <span>${escapeHTML(activeNotesLabel)}</span>
                     <span class="text-[11px] opacity-70 group-open:hidden">Show</span>
                     <span class="text-[11px] opacity-70 hidden group-open:inline">Hide</span>
                   </summary>
                   <div class="px-4 pb-3.5 pt-1">${activeNotesHtml}</div>
                 </details>`
              : ''
          }

          <div class="px-4 py-2.5 border-t border-line bg-ink/[0.015] flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <button type="button" data-add-proj-item="${escapeHTML(proj.id)}" class="btn-secondary h-7 px-2.5 text-xs">+ Add part</button>
              <button type="button" data-add-proj-variant="${escapeHTML(proj.id)}" class="btn-secondary h-7 px-2.5 text-xs">+ Sub-project</button>
            </div>
            ${
              selectedVariantObj
                ? `<button type="button" data-edit-variant="${escapeHTML(selectedVariantObj.id)}" data-proj-id="${escapeHTML(proj.id)}" class="text-[11px] text-muted hover:text-ink">Edit ${escapeHTML(selectedVariantObj.name)} notes</button>`
                : `<button type="button" data-edit-project="${escapeHTML(proj.id)}" class="text-[11px] text-muted hover:text-ink">Edit notes</button>`
            }
          </div>
        </div>
      `;
    })
    .join('');
}

// =============================================================================
// CONTEXT SLIDE-OVER DRAWER (Shopping Item & Project-Scoped Part Details)
// Opens in Preview (read) mode, like the inventory drawer. The footer has the
// same Preview / Edit switch.
// =============================================================================
function openContextDrawer(ctx) {
  state.contextDrawer = { mode: 'view', ...ctx };
  const root = document.getElementById('contextDrawerRoot');
  root.classList.remove('drawer-closed', 'pointer-events-none');
  root.classList.add('drawer-open');
  root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  renderContextDrawer();
}

function closeContextDrawer() {
  state.contextDrawer = null;
  const root = document.getElementById('contextDrawerRoot');
  root.classList.add('drawer-closed', 'pointer-events-none');
  root.classList.remove('drawer-open');
  root.setAttribute('aria-hidden', 'true');
  if (!state.drawerMode) document.body.style.overflow = '';
}

function setContextDrawerMode(mode) {
  if (!state.contextDrawer || state.contextDrawer.mode === mode) return;
  state.contextDrawer.mode = mode;
  renderContextDrawer();
  document.getElementById('contextDrawerBody').scrollTop = 0;
}

// Footer: Preview/Edit switch on the left (plus the remove action in edit mode),
// one action on the right. Same layout as the inventory drawer footer.
function contextFooterHtml(mode, dangerHtml, saveId) {
  const seg = (m, label) =>
    `<button type="button" data-ctx-mode="${m}" class="h-7 px-3 rounded-md text-xs font-medium transition-colors ${mode === m ? 'pb-seg-active' : 'opacity-70'}">${label}</button>`;
  return `
    <div class="flex items-center gap-2.5 min-w-0">
      <div class="pb-segmented inline-flex items-center rounded p-0.5 shrink-0" role="group" aria-label="Drawer mode">
        ${seg('view', 'Preview')}${seg('edit', 'Edit')}
      </div>
      ${mode === 'edit' ? dangerHtml : ''}
    </div>
    <div class="flex items-center gap-2 shrink-0">
      ${
        mode === 'edit'
          ? `<button type="button" id="${saveId}" class="btn-primary h-9 px-4 rounded text-xs font-medium">Save</button>`
          : `<button type="button" id="ctxCloseFooterBtn" class="btn-secondary h-9 px-3.5 rounded text-xs font-medium">Close</button>`
      }
    </div>
  `;
}

function contextPhotoHtml(imagePath, alt, category) {
  if (imagePath) {
    const src = escapeHTML(imageUrl(imagePath));
    return `<button type="button" data-lightbox-src="${src}" class="block w-full h-48 sm:h-56 rounded-md overflow-hidden bg-white border border-line cursor-zoom-in" title="Show full size">
              <img src="${src}" alt="${escapeHTML(alt)}" class="w-full h-full object-contain p-3" />
            </button>`;
  }
  return `<div class="w-full h-24 rounded-md border border-dashed border-line flex items-center justify-center gap-4 text-muted">
            ${categoryGlyph(category || 'Sensors', 'w-9 h-9 opacity-60')}
            <span class="text-sm">No photo</span>
          </div>`;
}

function contextNotesHtml(label, text, emptyText, emptyAction) {
  return `
    <section>
      <h4 class="pb-section-label mb-1.5">${label}</h4>
      ${
        text && text.trim()
          ? `<div class="pb-md">${renderMarkdown(text)}</div>`
          : `<div class="py-6 text-center space-y-3 border border-dashed border-line rounded-md">
               <p class="text-sm text-muted">${emptyText}</p>
               <button type="button" data-ctx-mode="edit" class="btn-secondary h-8 px-3.5 text-[13px]">${emptyAction}</button>
             </div>`
      }
    </section>`;
}

function renderContextDrawer() {
  const ctx = state.contextDrawer;
  if (!ctx) return;
  const badge = document.getElementById('contextDrawerBadge');
  const heading = document.getElementById('contextDrawerHeading');
  const body = document.getElementById('contextDrawerBody');
  const footer = document.getElementById('contextDrawerFooter');
  const ext = `<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

  if (ctx.type === 'shopping') {
    const it = state.shoppingItems.find((x) => x.id === ctx.id);
    if (!it) {
      closeContextDrawer();
      return;
    }
    heading.textContent = 'To buy';
    const linkNames = (it.project_links || []).map((lk) => lk.project_name);
    const badgeText = linkNames.length === 1 ? linkNames[0] : linkNames.length > 1 ? `${linkNames.length} projects` : '';
    badge.innerHTML = `<span class="truncate min-w-0">${escapeHTML(badgeText)}</span>`;
    badge.classList.toggle('hidden', linkNames.length === 0);

    const linksHtml = (it.project_links || [])
      .map(
        (lk) =>
          `<span class="pb-badge pb-badge-neutral">${escapeHTML(lk.project_name)}${lk.variant_name ? ` · ${escapeHTML(lk.variant_name)}` : ' · Core'}</span>`
      )
      .join('');
    const hasStoreUrl = it.url && /^https?:\/\//i.test(it.url);
    const dangerHtml =
      ctx.projectId && ctx.projectItemId
        ? `<div class="inline-flex items-center gap-1.5" data-inline-confirm>
             <button type="button" data-confirm-init class="btn-danger-outline h-8 px-2.5 rounded text-xs font-medium" title="Remove from this project. The item stays on the shopping list.">Unlink</button>
             <div class="hidden items-center gap-1.5" data-confirm-group>
               <button type="button" id="ctxUnlinkShopBtn" class="btn-danger h-8 px-2.5 rounded text-xs font-medium">Confirm</button>
               <button type="button" data-confirm-cancel class="btn-secondary h-8 px-2.5 rounded text-xs font-medium">Cancel</button>
             </div>
           </div>`
        : `<div class="inline-flex items-center gap-1.5" data-inline-confirm>
             <button type="button" data-confirm-init class="btn-danger-outline h-8 px-2.5 rounded text-xs font-medium">Delete</button>
             <div class="hidden items-center gap-1.5" data-confirm-group>
               <button type="button" id="ctxDeleteShopBtn" class="btn-danger h-8 px-2.5 rounded text-xs font-medium">Confirm</button>
               <button type="button" data-confirm-cancel class="btn-secondary h-8 px-2.5 rounded text-xs font-medium">Cancel</button>
             </div>
           </div>`;

    if (ctx.mode !== 'edit') {
      const specsEntries = Object.entries(it.specs || {});
      body.innerHTML = `
        ${contextPhotoHtml(it.image_path, it.name, it.category)}

        <div>
          <h3 class="pb-display text-[1.75rem]">${escapeHTML(it.name)}</h3>
          ${it.retailer ? `<p class="text-[15px] text-ink-2 mt-1">${escapeHTML(it.retailer)}</p>` : ''}
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          ${it.price ? `<span class="text-lg font-semibold font-mono text-ink">${escapeHTML(it.price)}</span>` : ''}
          <span class="text-[15px]"><strong class="font-semibold">${escapeHTML(it.quantity || 1)}</strong> <span class="text-muted">to buy</span></span>
          ${it.in_stock === 'in_stock' ? `<span class="pb-status is-go">In stock at store</span>` : it.in_stock === 'out_of_stock' ? `<span class="pb-status is-stop">Out of stock at store</span>` : ''}
        </div>

        ${linksHtml ? `<div class="flex flex-wrap gap-1.5">${linksHtml}</div>` : ''}

        <div class="flex flex-wrap gap-2">
          <button type="button" id="ctxShopBoughtBtn" class="btn-primary h-9 px-3.5 text-[13px]">Bought &rarr; Inventory</button>
          ${hasStoreUrl ? `<a href="${escapeHTML(it.url)}" target="_blank" rel="noopener noreferrer" class="btn-secondary h-9 px-3 text-[13px] inline-flex items-center gap-1.5">Store page ${ext}</a>` : ''}
          ${it.url ? `<button type="button" id="ctxFetchShopMetaBtn" class="btn-secondary h-9 px-3 text-[13px]">Fetch photo &amp; info</button>` : ''}
        </div>

        <section>
          <h4 class="pb-section-label mb-2">Store options</h4>
          ${
            (it.offers || []).length > 0
              ? `<div class="space-y-1.5 mb-2.5">
                   ${(it.offers || [])
                     .map((off) => {
                       const offHost = off.retailer || (off.url ? (() => { try { return new URL(off.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })() : 'Store');
                       const offUrlOk = off.url && /^https?:\/\//i.test(off.url);
                       const offStock = off.in_stock === 'in_stock'
                         ? '<span class="text-[11px] text-go font-medium">In stock</span>'
                         : off.in_stock === 'out_of_stock'
                         ? '<span class="text-[11px] text-stop font-medium">Out of stock</span>'
                         : '';
                       return `<div class="pb-well rounded px-2.5 py-2 flex flex-wrap items-center justify-between gap-2 ${off.is_selected ? 'border border-accent/60' : 'border border-transparent'}">
                         <div class="min-w-0 flex-1">
                           <div class="flex flex-wrap items-center gap-2 text-[13px]">
                             ${offUrlOk ? `<a href="${escapeHTML(off.url)}" target="_blank" rel="noopener noreferrer" class="font-medium text-accent hover:underline truncate">${escapeHTML(offHost)}</a>` : `<span class="font-medium text-ink truncate">${escapeHTML(offHost)}</span>`}
                             ${off.price ? `<span class="font-mono font-semibold text-ink">${escapeHTML(off.price)}</span>` : ''}
                             ${offStock}
                           </div>
                         </div>
                         <div class="flex items-center gap-1.5 shrink-0">
                           ${
                             off.is_selected
                               ? '<span class="pb-badge pb-badge-neutral !text-[11px] text-go font-medium">Selected</span>'
                               : `<button type="button" data-select-offer="${escapeHTML(off.id)}" class="btn-secondary h-7 px-2.5 text-xs">Use this</button>`
                           }
                           ${
                             (it.offers || []).length > 1
                               ? `<div class="inline-flex items-center gap-1.5" data-inline-confirm>
                                    <button type="button" data-confirm-init class="btn-icon h-7 w-7 flex items-center justify-center" title="Remove store option" aria-label="Remove store option"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                                    <div class="hidden items-center gap-1.5" data-confirm-group>
                                      <button type="button" data-delete-offer="${escapeHTML(off.id)}" class="btn-danger h-7 px-2 rounded text-[11px] font-medium">Remove</button>
                                      <button type="button" data-confirm-cancel class="btn-secondary h-7 px-2 rounded text-[11px] font-medium">Cancel</button>
                                    </div>
                                  </div>`
                               : ''
                           }
                         </div>
                       </div>`;
                     })
                     .join('')}
                 </div>`
              : `<p class="text-xs text-muted mb-2">No store links saved yet.</p>`
          }
          <div class="flex flex-wrap sm:flex-nowrap items-center gap-1.5">
            <input id="ctxAddOfferUrl" type="url" placeholder="Add another store link (https://...)" class="basis-full sm:basis-auto flex-1 min-w-0 h-8 px-2.5 text-xs" />
            <input id="ctxAddOfferPrice" type="text" placeholder="Price (opt)" aria-label="Optional price" class="flex-1 sm:flex-none sm:w-24 min-w-0 h-8 px-2 text-xs" />
            <button type="button" id="ctxAddOfferBtn" class="btn-secondary h-8 px-3 text-xs shrink-0">Add store</button>
          </div>
        </section>

        ${contextNotesHtml('Why it is on the list', it.why_needed || it.notes || '', 'No reason written yet.', 'Write a reason')}

        ${
          specsEntries.length > 0
            ? `<section>
                 <h4 class="pb-section-label mb-1">Specs</h4>
                 <table class="w-full text-sm"><tbody>
                   ${specsEntries
                     .map(
                       ([k, v]) => `<tr class="border-b border-line last:border-0">
                         <th scope="row" class="py-2 pr-4 text-left font-normal text-muted align-top w-[42%]">${escapeHTML(k)}</th>
                         <td class="py-2 font-mono text-[13px] text-ink">${escapeHTML(v)}</td>
                       </tr>`
                     )
                     .join('')}
                 </tbody></table>
               </section>`
            : ''
        }
      `;
      footer.innerHTML = contextFooterHtml('view', dangerHtml, 'ctxSaveShopBtn');
      return;
    }

    body.innerHTML = `
      <form id="ctxShopForm" class="space-y-3.5 text-xs">
        <div>
          <label class="block text-[11px] font-medium text-muted mb-1">Name</label>
          <input id="ctxShopName" type="text" value="${escapeHTML(it.name)}" class="w-full h-9 px-3 text-sm rounded bg-canvas-light border border-hairline-light" />
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Price</label>
            <input id="ctxShopPrice" type="text" value="${escapeHTML(it.price || '')}" class="w-full h-9 px-2.5 text-sm rounded bg-canvas-light border border-hairline-light" />
          </div>
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Quantity</label>
            <input id="ctxShopQty" type="number" min="1" inputmode="numeric" value="${it.quantity || 1}" class="w-full h-9 px-2.5 font-mono text-sm rounded bg-canvas-light border border-hairline-light" />
          </div>
          <div class="col-span-2 sm:col-span-1">
            <label class="block text-[11px] font-medium text-muted mb-1">Tag / Group</label>
            <input id="ctxShopTag" type="text" value="${escapeHTML(it.tag || '')}" placeholder="e.g., Smartwatch" class="w-full h-9 px-2.5 text-sm rounded bg-canvas-light border border-hairline-light" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2.5">
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Category (when bought)</label>
            <select id="ctxShopCategory" class="w-full h-9 px-2.5 text-xs rounded bg-canvas-light border border-hairline-light">
              <option value="">Default (Sensors)</option>
              ${DEFAULT_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}" ${it.category === c ? 'selected' : ''}>${escapeHTML(c)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Stock status</label>
            <select id="ctxShopStock" class="w-full h-9 px-2.5 text-xs rounded bg-canvas-light border border-hairline-light">
              <option value="" ${!it.in_stock ? 'selected' : ''}>Unknown</option>
              <option value="in_stock" ${it.in_stock === 'in_stock' ? 'selected' : ''}>In stock</option>
              <option value="out_of_stock" ${it.in_stock === 'out_of_stock' ? 'selected' : ''}>Out of stock</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-[11px] font-medium text-muted mb-1">Store URL</label>
          <input id="ctxShopUrl" type="url" value="${escapeHTML(it.url || '')}" class="w-full h-9 px-3 text-sm rounded bg-canvas-light border border-hairline-light" />
        </div>
        <div data-md-editor>
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="block text-[11px] font-medium text-muted">Why it is on the list (Markdown)</label>
            <div class="pb-segmented inline-flex rounded p-0.5" role="group" aria-label="Reason notes mode">
              <button type="button" data-md-mode="edit" class="h-6 px-2 rounded text-[11px] font-medium pb-seg-active">Edit</button>
              <button type="button" data-md-mode="preview" class="h-6 px-2 rounded text-[11px] font-medium opacity-65">Preview</button>
            </div>
          </div>
          <textarea id="ctxShopWhy" data-md-input rows="4" placeholder="Explain why this part is needed or which build option it belongs to (supports Markdown)..." class="w-full p-2.5 text-sm rounded bg-canvas-light border border-hairline-light resize-y">${escapeHTML(it.why_needed || it.notes || '')}</textarea>
          <div data-md-preview class="hidden pb-well rounded p-3 min-h-[84px] max-h-56 overflow-y-auto pb-md"></div>
        </div>
      </form>
    `;
    footer.innerHTML = contextFooterHtml('edit', dangerHtml, 'ctxSaveShopBtn');
    return;
  }

  if (ctx.type === 'project_part') {
    const proj = state.projects.find((p) => p.id === ctx.projectId);
    const pItem = proj && (proj.items || []).find((x) => x.id === ctx.projectItemId);
    if (!proj || !pItem) {
      closeContextDrawer();
      return;
    }
    heading.textContent = 'Project part';
    badge.innerHTML = `<span class="truncate min-w-0">${escapeHTML(proj.name)}</span>`;
    badge.classList.remove('hidden');

    const variants = proj.variants || [];
    const varObj = pItem.variant_id ? variants.find((v) => v.id === pItem.variant_id) : null;
    const dangerHtml = `<div class="inline-flex items-center gap-1.5" data-inline-confirm>
      <button type="button" data-confirm-init class="btn-danger-outline h-8 px-2.5 rounded text-xs font-medium" title="Remove from this project. The part stays in inventory.">Remove</button>
      <div class="hidden items-center gap-1.5" data-confirm-group>
        <button type="button" id="ctxRemoveProjItemBtn" class="btn-danger h-8 px-2.5 rounded text-xs font-medium">Confirm</button>
        <button type="button" data-confirm-cancel class="btn-secondary h-8 px-2.5 rounded text-xs font-medium">Cancel</button>
      </div>
    </div>`;
    const short = Number(pItem.owned_quantity) < Number(pItem.quantity_needed || 1);

    if (ctx.mode !== 'edit') {
      body.innerHTML = `
        ${contextPhotoHtml(pItem.image_path, pItem.name, pItem.category)}

        <div>
          <h3 class="pb-display text-[1.75rem]">${escapeHTML(pItem.name)}</h3>
          <p class="text-[15px] text-ink-2 mt-1">In <strong class="font-semibold text-ink">${escapeHTML(proj.name)}</strong> · ${varObj ? escapeHTML(varObj.name) : 'Core (all options)'}</p>
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          ${
            pItem.location
              ? `<span class="pb-bin-tag !h-7 !text-[15px] !px-2.5">${escapeHTML(pItem.location)}</span>`
              : `<span class="pb-bin-tag is-empty !h-7">No bin</span>`
          }
          <span class="text-[15px]"><span class="text-muted">Need</span> <strong class="font-semibold">${escapeHTML(pItem.quantity_needed || 1)}</strong></span>
          <span class="text-[15px] ${short ? 'text-stop' : ''}"><span class="${short ? '' : 'text-muted'}">Have</span> <strong class="font-semibold">${escapeHTML(pItem.owned_quantity)}</strong></span>
        </div>

        <div>
          <button type="button" id="ctxOpenInventorySheetBtn" class="btn-secondary h-9 px-3.5 text-[13px]">Open inventory sheet &rarr;</button>
        </div>

        ${contextNotesHtml('Project notes', pItem.project_notes || '', 'No notes for this project yet.', 'Write a note')}
      `;
      footer.innerHTML = contextFooterHtml('view', dangerHtml, 'ctxSaveProjItemBtn');
      return;
    }

    body.innerHTML = `
      <div class="space-y-3.5 text-xs">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Quantity needed for this project</label>
            <input id="ctxProjQty" type="number" min="1" inputmode="numeric" value="${pItem.quantity_needed || 1}" class="w-full h-9 px-3 font-mono text-sm rounded bg-canvas-light border border-hairline-light" />
          </div>
          <div>
            <label class="block text-[11px] font-medium text-muted mb-1">Sub-project / Option</label>
            <select id="ctxProjVariant" class="w-full h-9 px-2.5 text-xs rounded bg-canvas-light border border-hairline-light">
              <option value="" ${!pItem.variant_id ? 'selected' : ''}>Core (all options)</option>
              ${variants.map((v) => `<option value="${escapeHTML(v.id)}" ${pItem.variant_id === v.id ? 'selected' : ''}>${escapeHTML(v.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div data-md-editor>
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="block text-[11px] font-medium text-muted">Project notes (Markdown)</label>
            <div class="pb-segmented inline-flex rounded p-0.5" role="group" aria-label="Project item notes mode">
              <button type="button" data-md-mode="edit" class="h-6 px-2 rounded text-[11px] font-medium pb-seg-active">Edit</button>
              <button type="button" data-md-mode="preview" class="h-6 px-2 rounded text-[11px] font-medium opacity-65">Preview</button>
            </div>
          </div>
          <p class="text-[12px] text-muted mb-1.5">Saved only for <strong class="text-ink">${escapeHTML(proj.name)}</strong>. Does not change this part's general inventory notes.</p>
          <textarea id="ctxProjNotes" data-md-input rows="6" placeholder="e.g., Wire tilt switch to GPIO4 with INPUT_PULLUP (supports Markdown)..." class="w-full p-2.5 text-sm leading-relaxed rounded bg-canvas-light border border-hairline-light resize-y">${escapeHTML(pItem.project_notes || '')}</textarea>
          <div data-md-preview class="hidden pb-well rounded p-3 min-h-[120px] max-h-64 overflow-y-auto pb-md"></div>
        </div>
      </div>
    `;
    footer.innerHTML = contextFooterHtml('edit', dangerHtml, 'ctxSaveProjItemBtn');
  }
}

// =============================================================================
// PROJECT & ACTION MODALS
// =============================================================================
function openProjectModal(projectId) {
  state.editingProjectId = projectId || null;
  const proj = projectId ? state.projects.find((p) => p.id === projectId) : null;
  document.getElementById('projectModalHeading').textContent = proj ? 'Edit Project' : 'New Project';
  document.getElementById('pName').value = proj ? proj.name : '';
  document.getElementById('pStatus').value = proj ? proj.status : 'planning';
  document.getElementById('pDescription').value = proj ? proj.description || '' : '';
  document.getElementById('pNotes').value = proj ? proj.notes || '' : '';
  const pNotesEd = document.getElementById('pNotes')?.closest('[data-md-editor]');
  if (pNotesEd) setMdEditorMode(pNotesEd, 'edit');

  const delArea = document.getElementById('projectDeleteArea');
  delArea.classList.toggle('hidden', !proj);
  delArea.classList.toggle('flex', Boolean(proj));
  document.getElementById('projectDeleteInitBtn').classList.remove('hidden');
  document.getElementById('projectDeleteConfirmGroup').classList.add('hidden');
  document.getElementById('projectDeleteConfirmGroup').classList.remove('flex');

  document.getElementById('projectModal').classList.remove('hidden');
  document.getElementById('pName').focus();
}

function closeProjectModal() {
  state.editingProjectId = null;
  document.getElementById('projectModal').classList.add('hidden');
}

async function saveProjectModal() {
  const name = document.getElementById('pName').value.trim();
  if (!name) {
    document.getElementById('pName').focus();
    return;
  }
  const payload = {
    name,
    status: document.getElementById('pStatus').value,
    description: document.getElementById('pDescription').value.trim(),
    notes: document.getElementById('pNotes').value.trim(),
  };
  try {
    if (state.editingProjectId) {
      await apiFetch(`/api/projects/${encodeURIComponent(state.editingProjectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Project updated');
    } else {
      await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Project created');
    }
    closeProjectModal();
    await Promise.all([loadProjects(), loadParts()]);
  } catch (err) {
    showToast(err.message);
  }
}

function openProjectActionModal(mode, projectId, variantId = null) {
  const proj = state.projects.find((p) => p.id === projectId);
  if (!proj) return;
  const existingVar = variantId ? (proj.variants || []).find((v) => v.id === variantId) : null;
  if (mode === 'edit_variant' && !existingVar) return;
  state.projectAction = { mode, projectId, variantId };
  const heading = document.getElementById('projectActionModalHeading');
  const body = document.getElementById('projectActionModalBody');
  const saveBtn = document.getElementById('saveProjectActionModalBtn');

  if (mode === 'variant' || mode === 'edit_variant') {
    const isEdit = mode === 'edit_variant';
    heading.textContent = isEdit ? `Edit ${existingVar.name} · ${proj.name}` : `Add Sub-project · ${proj.name}`;
    saveBtn.textContent = isEdit ? 'Save changes' : 'Add option';
    body.innerHTML = `
      <div>
        <label class="block text-[11px] font-medium text-muted mb-1">Option name</label>
        <input id="paVarName" type="text" value="${escapeHTML(isEdit ? existingVar.name : '')}" placeholder="e.g., Option A: Color IPS Build" class="w-full h-9 px-3 text-sm rounded bg-canvas-light border border-hairline-light" />
      </div>
      <div>
        <label class="block text-[11px] font-medium text-muted mb-1">Description</label>
        <textarea id="paVarDesc" rows="2" placeholder="What makes this build option different..." class="w-full p-2.5 text-sm rounded bg-canvas-light border border-hairline-light resize-y">${escapeHTML(isEdit ? (existingVar.description || '') : '')}</textarea>
      </div>
      <div data-md-editor>
        <div class="flex items-center justify-between gap-2 mb-1">
          <label class="block text-[11px] font-medium text-muted">Sub-build notes (Markdown &amp; tables)</label>
          <div class="pb-segmented inline-flex rounded p-0.5" role="group" aria-label="Sub-build notes mode">
            <button type="button" data-md-mode="edit" class="h-6 px-2 rounded text-[11px] font-medium pb-seg-active">Edit</button>
            <button type="button" data-md-mode="preview" class="h-6 px-2 rounded text-[11px] font-medium opacity-65">Preview</button>
          </div>
        </div>
        <textarea id="paVarNotes" data-md-input rows="6" placeholder="Wiring table, pinout notes, build steps for this option..." class="w-full p-2.5 text-sm font-mono rounded bg-canvas-light border border-hairline-light resize-y">${escapeHTML(isEdit ? (existingVar.notes || '') : '')}</textarea>
        <div data-md-preview class="hidden pb-well rounded p-3 min-h-[112px] max-h-64 overflow-y-auto pb-md"></div>
      </div>
    `;
  } else {
    heading.textContent = `Add Part · ${proj.name}`;
    saveBtn.textContent = 'Add to project';
    const variants = proj.variants || [];
    const partOpts = state.parts
      .map((p) => `<option value="part:${escapeHTML(p.id)}">[Owned · qty ${p.quantity}] ${escapeHTML(p.name)}</option>`)
      .join('');
    const shopOpts = state.shoppingItems
      .map((s) => `<option value="shop:${escapeHTML(s.id)}">[To buy] ${escapeHTML(s.name)}</option>`)
      .join('');
    body.innerHTML = `
      <div>
        <label class="block text-[11px] font-medium text-muted mb-1">Choose owned part or shopping item</label>
        <select id="paTarget" class="w-full h-9 px-2.5 text-xs rounded bg-canvas-light border border-hairline-light">
          <optgroup label="Owned Inventory">${partOpts}</optgroup>
          ${shopOpts ? `<optgroup label="Shopping List (To Buy)">${shopOpts}</optgroup>` : ''}
        </select>
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label class="block text-[11px] font-medium text-muted mb-1">Sub-project / Option</label>
          <select id="paVariant" class="w-full h-9 px-2.5 text-xs rounded bg-canvas-light border border-hairline-light">
            <option value="">Core (all options)</option>
            ${variants.map((v) => `<option value="${escapeHTML(v.id)}">${escapeHTML(v.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-[11px] font-medium text-muted mb-1">Quantity needed</label>
          <input id="paQty" type="number" min="1" value="1" class="w-full h-9 px-3 font-mono text-sm rounded bg-canvas-light border border-hairline-light" />
        </div>
      </div>
      <div>
        <label class="block text-[11px] font-medium text-muted mb-1">Project-specific note (optional)</label>
        <textarea id="paNotes" rows="2" placeholder="Only shown in this project..." class="w-full p-2.5 text-sm rounded bg-canvas-light border border-hairline-light resize-y"></textarea>
      </div>
    `;
  }
  document.getElementById('projectActionModal').classList.remove('hidden');
}

function closeProjectActionModal() {
  state.projectAction = null;
  document.getElementById('projectActionModal').classList.add('hidden');
}

async function saveProjectActionModal() {
  const act = state.projectAction;
  if (!act) return;
  try {
    if (act.mode === 'variant' || act.mode === 'edit_variant') {
      const name = document.getElementById('paVarName').value.trim();
      if (!name) return;
      const desc = document.getElementById('paVarDesc').value.trim();
      const notes = (document.getElementById('paVarNotes')?.value || '').trim();
      if (act.mode === 'edit_variant' && act.variantId) {
        await apiFetch(
          `/api/projects/${encodeURIComponent(act.projectId)}/variants/${encodeURIComponent(act.variantId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: desc, notes }),
          }
        );
        showToast('Sub-project updated');
      } else {
        await apiFetch(`/api/projects/${encodeURIComponent(act.projectId)}/variants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description: desc, notes }),
        });
        showToast('Sub-project option added');
      }
    } else {
      const target = document.getElementById('paTarget').value;
      if (!target) return;
      const [kind, id] = target.split(':');
      const variantId = document.getElementById('paVariant').value || null;
      const qty = Math.max(1, parseInt(document.getElementById('paQty').value, 10) || 1);
      const notes = document.getElementById('paNotes').value.trim();
      await apiFetch(`/api/projects/${encodeURIComponent(act.projectId)}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          part_id: kind === 'part' ? id : null,
          shopping_item_id: kind === 'shop' ? id : null,
          variant_id: variantId,
          quantity_needed: qty,
          project_notes: notes,
        }),
      });
      showToast('Added to project');
    }
    closeProjectActionModal();
    await Promise.all([loadProjects(), loadShopping(), loadParts()]);
  } catch (err) {
    showToast(err.message);
  }
}

function getMatchingPartsForTerm(entry) {
  const rawKeys = (entry.keywords || entry.term || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2);
  if (rawKeys.length === 0) return [];

  return state.parts.filter((p) => {
    const specsText = p.specs ? Object.entries(p.specs).map(([k, v]) => `${k} ${v}`).join(' ') : '';
    const hay = [
      p.name,
      p.subtitle,
      p.what_it_does,
      p.visual_tell,
      p.warning,
      p.notes,
      specsText,
    ]
      .join(' ')
      .toLowerCase();
    return rawKeys.some((kw) => hay.includes(kw));
  });
}

function renderGlossary() {
  const strip = document.getElementById('glossaryCategoryStrip');
  strip.innerHTML = state.glossaryCategories
    .map((cat) => {
      const act = state.glossaryCategory === cat;
      return `<button type="button" data-gcat="${escapeHTML(cat)}" class="pb-tab ${act ? 'pb-tab-active' : ''}">${escapeHTML(cat)}</button>`;
    })
    .join('');

  const matchMap = new Map();
  let inInvTotal = 0;
  for (const g of state.glossary) {
    const m = getMatchingPartsForTerm(g);
    matchMap.set(g.id, m);
    if (m.length > 0) inInvTotal++;
  }

  document.getElementById('glossaryInInventoryCount').textContent = inInvTotal;
  styleToggleChip(document.getElementById('glossaryInInventoryBtn'), state.glossaryInInventoryOnly);

  const q = state.search.trim().toLowerCase();
  const items = state.glossary.filter((g) => {
    if (state.glossaryCategory !== 'All' && g.category !== state.glossaryCategory) return false;
    if (state.glossaryInInventoryOnly && (matchMap.get(g.id) || []).length === 0) return false;
    if (q) {
      const hay = [g.term, g.category, g.summary, g.rule_of_thumb, g.keywords].join(' ').toLowerCase();
      return hay.includes(q);
    }
    return true;
  });

  const layout = document.getElementById('glossaryLayout');
  const listEl = document.getElementById('glossaryList');
  const detailEl = document.getElementById('glossaryDetailPane');
  const empty = document.getElementById('glossaryEmptyState');

  if (items.length === 0) {
    layout.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  layout.classList.remove('hidden');

  if (!state.selectedGlossaryId || !items.some((x) => x.id === state.selectedGlossaryId)) {
    state.selectedGlossaryId = items[0].id;
  }

  listEl.innerHTML = items
    .map((g) => {
      const active = g.id === state.selectedGlossaryId;
      const cnt = (matchMap.get(g.id) || []).length;
      return `
        <button type="button" data-select-glossary="${escapeHTML(g.id)}" class="pb-gloss-item ${active ? 'is-active' : ''}">
          <span class="min-w-0">
            <span class="block text-sm font-medium ${active ? 'text-ink' : 'text-ink-2'} truncate">${escapeHTML(g.term)}</span>
            <span class="block text-[12px] text-muted truncate">${escapeHTML(g.category)}</span>
          </span>
          ${cnt > 0 ? `<span class="shrink-0 text-[12px] text-muted" title="${cnt} of your parts use this term">${cnt}</span>` : ''}
        </button>
      `;
    })
    .join('');

  const selected = items.find((x) => x.id === state.selectedGlossaryId) || items[0];
  const matchedParts = matchMap.get(selected.id) || [];

  const partsHtml =
    matchedParts.length > 0
      ? `<div class="pt-6 mt-6 border-t border-line">
           <h3 class="pb-section-label mb-3">In your bins (${matchedParts.length})</h3>
           <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
             ${matchedParts
               .map((p) => {
                 const thumb = p.image_path
                   ? `<img src="${escapeHTML(imageUrl(p.image_path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" />`
                   : categoryGlyph(p.category, 'w-4 h-4 text-muted opacity-60');
                 return `
                   <button type="button" data-open-part="${escapeHTML(p.id)}" class="pb-row-link flex items-center gap-2.5 p-2 rounded text-left min-w-0">
                     <div class="pb-well w-9 h-9 rounded flex items-center justify-center overflow-hidden shrink-0">${thumb}</div>
                     <div class="min-w-0 flex-1 text-sm font-medium truncate">${escapeHTML(p.name)}</div>
                     ${p.location ? `<span class="pb-bin-tag !h-5 !text-[12px] shrink-0">${escapeHTML(p.location)}</span>` : ''}
                   </button>
                 `;
               })
               .join('')}
           </div>
         </div>`
      : `<p class="pt-6 mt-6 border-t border-line text-[13px] text-muted">None of your parts use this term yet. When you add a part that uses it, the part shows here.</p>`;

  layout.classList.toggle('is-detail', Boolean(state.glossaryMobileDetail));
  detailEl.innerHTML = `
    <button type="button" data-glossary-back class="lg:hidden -ml-1 mb-4 h-8 pl-1 pr-2.5 inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      All terms
    </button>
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-[13px] text-muted mb-1">${escapeHTML(selected.category)}</p>
        <h2 class="pb-display text-[2.25rem] sm:text-[2.75rem]">${escapeHTML(selected.term)}</h2>
      </div>
      <button type="button" data-edit-glossary="${escapeHTML(selected.id)}" class="btn-secondary h-8 px-3 text-[13px] shrink-0">Edit</button>
    </div>

    <p class="mt-4 text-[17px] leading-[1.6] text-ink max-w-[62ch]">${escapeHTML(selected.summary)}</p>

    ${
      selected.rule_of_thumb
        ? `<div class="mt-5 pb-well rounded-md px-4 py-3.5 max-w-[62ch]">
             <h3 class="pb-section-label mb-1">Bench rule</h3>
             <p class="text-[15px] leading-relaxed">${escapeHTML(selected.rule_of_thumb)}</p>
           </div>`
        : ''
    }

    ${partsHtml}
  `;
}

function renderWithGlossaryTooltips(rawText) {
  const safe = escapeHTML(rawText || '');
  if (!state.uiSettings.inline_tooltips || !state.glossary.length || !safe) {
    return safe;
  }

  // Match distinct glossary terms (longest first to avoid partial collisions)
  const termMatchers = state.glossary
    .map((g) => ({ id: g.id, label: (g.term || '').split('(')[0].trim() }))
    .filter((m) => m.label.length >= 3)
    .sort((a, b) => b.label.length - a.label.length);

  if (!termMatchers.length) return safe;

  const escapedTerms = termMatchers.map((m) => m.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Skip HTML entities like &amp; so terms such as "Amp" don't corrupt escaped ampersands
  const re = new RegExp(`(&(?:amp|lt|gt|quot|#\\d+);)|\\b(${escapedTerms.join('|')})\\b`, 'gi');
  const seen = new Set();

  return safe.replace(re, (match, entity, termMatch) => {
    if (entity) return entity;
    const low = termMatch.toLowerCase();
    const hit = termMatchers.find((m) => m.label.toLowerCase() === low);
    if (!hit || seen.has(hit.id)) return match;
    seen.add(hit.id);
    return `<button type="button" data-glossary-peek="${escapeHTML(hit.id)}" class="pb-term">${termMatch}</button>`;
  });
}

function openGlossaryPopover(termId) {
  const g = state.glossary.find((x) => x.id === termId);
  if (!g) return;
  state.popoverTermId = termId;
  document.getElementById('popoverTermTitle').textContent = g.term;
  document.getElementById('popoverTermCat').textContent = g.category;
  document.getElementById('popoverTermSummary').textContent = g.summary;
  const ruleWrap = document.getElementById('popoverTermRuleWrap');
  if (g.rule_of_thumb) {
    document.getElementById('popoverTermRule').textContent = g.rule_of_thumb;
    ruleWrap.classList.remove('hidden');
  } else {
    ruleWrap.classList.add('hidden');
  }
  document.getElementById('glossaryPopover').classList.remove('hidden');
}

function closeGlossaryPopover() {
  document.getElementById('glossaryPopover').classList.add('hidden');
  state.popoverTermId = null;
}

function openGlossaryModal(termId = null) {
  state.editingGlossaryId = termId;
  document.getElementById('glossaryDeleteConfirmGroup').classList.add('hidden');
  document.getElementById('glossaryDeleteConfirmGroup').classList.remove('flex');
  document.getElementById('glossaryDeleteInitBtn').classList.remove('hidden');

  if (termId) {
    const g = state.glossary.find((x) => x.id === termId);
    if (!g) return;
    document.getElementById('glossaryModalHeading').textContent = 'Edit Glossary Term';
    document.getElementById('glossaryDeleteArea').classList.remove('invisible');
    document.getElementById('gTerm').value = g.term || '';
    document.getElementById('gCategory').value = g.category || 'Circuit Basics';
    document.getElementById('gSummary').value = g.summary || '';
    document.getElementById('gRule').value = g.rule_of_thumb || '';
    document.getElementById('gKeywords').value = g.keywords || '';
  } else {
    document.getElementById('glossaryModalHeading').textContent = 'Add Glossary Term';
    document.getElementById('glossaryDeleteArea').classList.add('invisible');
    document.getElementById('gTerm').value = '';
    document.getElementById('gCategory').value =
      state.glossaryCategory !== 'All' ? state.glossaryCategory : 'Circuit Basics';
    document.getElementById('gSummary').value = '';
    document.getElementById('gRule').value = '';
    document.getElementById('gKeywords').value = '';
  }
  document.getElementById('glossaryModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('gTerm').focus(), 60);
}

function closeGlossaryModal() {
  document.getElementById('glossaryModal').classList.add('hidden');
  state.editingGlossaryId = null;
}

async function saveGlossaryModal() {
  const term = document.getElementById('gTerm').value.trim();
  if (!term) {
    document.getElementById('gTerm').focus();
    showToast('Enter a term name');
    return;
  }
  const payload = {
    term,
    category: document.getElementById('gCategory').value,
    summary: document.getElementById('gSummary').value.trim(),
    rule_of_thumb: document.getElementById('gRule').value.trim(),
    keywords: document.getElementById('gKeywords').value.trim(),
  };

  try {
    if (state.editingGlossaryId) {
      const updated = await apiFetch(`/api/glossary/${encodeURIComponent(state.editingGlossaryId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const idx = state.glossary.findIndex((x) => x.id === updated.id);
      if (idx !== -1) state.glossary[idx] = updated;
      showToast('Glossary term updated');
    } else {
      const created = await apiFetch('/api/glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      state.glossary.push(created);
      state.glossary.sort((a, b) => a.term.localeCompare(b.term));
      showToast('Glossary term added');
    }
    closeGlossaryModal();
    renderGlossary();
  } catch (err) {
    showToast(err.message);
  }
}

async function handleExplainGlossaryAi() {
  const term = document.getElementById('gTerm').value.trim();
  if (!term) {
    document.getElementById('gTerm').focus();
    showToast('Enter a term first');
    return;
  }
  const btn = document.getElementById('explainTermAiBtn');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/glossary/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    if (res.term) document.getElementById('gTerm').value = res.term;
    if (res.category) document.getElementById('gCategory').value = res.category;
    if (res.summary) document.getElementById('gSummary').value = res.summary;
    if (res.rule_of_thumb) document.getElementById('gRule').value = res.rule_of_thumb;
    if (res.keywords) document.getElementById('gKeywords').value = res.keywords;
    showToast('Drafted in ASD-STE100 — review and save');
    loadConfig();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// =============================================================================
// TECH SPECS EDITOR HELPERS
// =============================================================================
function addSpecEditorRow(key = '', val = '') {
  const container = document.getElementById('specsEditorRows');
  const row = document.createElement('div');
  row.className = 'flex items-center gap-1.5';
  row.innerHTML = `
    <input type="text" data-spec-key value="${escapeHTML(key)}" placeholder="Label (e.g. Voltage)" class="w-2/5 h-8 px-2.5 text-xs rounded-md bg-surface-light border border-hairline-light focus:outline-none focus:border-accent" />
    <input type="text" data-spec-val value="${escapeHTML(val)}" placeholder="Value (e.g. 3.3V)" class="flex-1 h-8 px-2.5 font-mono text-xs rounded-md bg-surface-light border border-hairline-light focus:outline-none focus:border-accent" />
    <button type="button" data-remove-spec class="h-8 w-7 rounded-md text-muted hover:text-stop flex items-center justify-center shrink-0" aria-label="Remove spec">&times;</button>
  `;
  container.appendChild(row);
}

function populateSpecsEditor(specsObj) {
  const container = document.getElementById('specsEditorRows');
  container.innerHTML = '';
  const entries = Object.entries(specsObj || {});
  if (entries.length === 0) {
    addSpecEditorRow('', '');
  } else {
    entries.forEach(([k, v]) => addSpecEditorRow(k, v));
  }
}

function collectSpecsFromEditor() {
  const specs = {};
  document.querySelectorAll('#specsEditorRows > div').forEach((row) => {
    const k = (row.querySelector('[data-spec-key]')?.value || '').trim();
    const v = (row.querySelector('[data-spec-val]')?.value || '').trim();
    if (k && v) specs[k] = v;
  });
  return specs;
}

// =============================================================================
// LIGHTBOX & SETTINGS MODAL
// =============================================================================
function openLightbox(src) {
  if (!src) return;
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxModal').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightboxModal').classList.add('hidden');
  document.getElementById('lightboxImg').src = '';
}

function openSettingsModal() {
  syncSettingsModalUi();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.add('hidden');
}

// =============================================================================
// DRAWER: PREVIEW (COMPACT SPEC SHEET) & 3-TAB EDIT MODE
// =============================================================================
function switchEditTab(tabName) {
  state.activeEditTab = tabName;
  const map = {
    basics: 'editTabBasics',
    media: 'editTabMedia',
    details: 'editTabDetails',
    specs: 'editTabSpecs',
  };
  Object.entries(map).forEach(([key, elId]) => {
    document.getElementById(elId).classList.toggle('hidden', key !== tabName);
  });

  document.querySelectorAll('button[data-edit-tab]').forEach((btn) => {
    const isAct = btn.dataset.editTab === tabName;
    btn.classList.toggle('pb-tab-active', isAct);
  });
}

function resetInlineConfirm(wrap) {
  if (!wrap) return;
  wrap.classList.remove('is-confirming');
  const init = wrap.querySelector('[data-confirm-init]');
  const grp = wrap.querySelector('[data-confirm-group]');
  if (init) init.classList.remove('hidden');
  if (grp) {
    grp.classList.add('hidden');
    grp.classList.remove('flex', 'inline-flex');
  }
}

function resetAllInlineConfirms(exceptWrap = null) {
  document.querySelectorAll('[data-inline-confirm].is-confirming').forEach((wrap) => {
    if (wrap !== exceptWrap) resetInlineConfirm(wrap);
  });
}

function openInlineConfirm(wrap) {
  if (!wrap) return;
  resetAllInlineConfirms(wrap);
  wrap.classList.add('is-confirming');
  const init = wrap.querySelector('[data-confirm-init]');
  const grp = wrap.querySelector('[data-confirm-group]');
  if (init) init.classList.add('hidden');
  if (grp) {
    grp.classList.remove('hidden');
    grp.classList.add('inline-flex');
  }
}

function renderDrawerPhoto() {
  const frame = document.getElementById('drawerPhotoFrame');
  const removeArea = document.getElementById('removePhotoArea');
  resetInlineConfirm(removeArea);

  if (state.draftImagePath) {
    const src = imageUrl(state.draftImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Part photo" class="w-full h-full object-contain p-3 bg-white cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeArea.classList.remove('hidden');
  } else {
    frame.innerHTML = `
      <div class="text-center px-4 text-muted">
        ${categoryGlyph(document.getElementById('fCategory').value, 'w-10 h-10 mx-auto mb-2 opacity-50')}
        <p class="text-[13px]">No photo. Upload one, or paste with Ctrl+V.</p>
      </div>
    `;
    removeArea.classList.add('hidden');
  }
}

function renderDrawerPinout() {
  const frame = document.getElementById('drawerPinoutFrame');
  const removeArea = document.getElementById('removePinoutArea');
  resetInlineConfirm(removeArea);

  if (state.draftPinoutImagePath) {
    const src = imageUrl(state.draftPinoutImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Pinout diagram" class="w-full h-full object-contain p-2.5 bg-white cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeArea.classList.remove('hidden');
  } else {
    frame.innerHTML = `<span class="text-[13px] text-muted text-center px-4">No pinout diagram</span>`;
    removeArea.classList.add('hidden');
  }
}

function updateWarningCallout(text) {
  const box = document.getElementById('drawerWarningCallout');
  const preview = document.getElementById('drawerWarningPreview');
  if (text && text.trim()) {
    preview.textContent = text.trim();
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function syncGoogleImagesLink() {
  const link = document.getElementById('googleImagesSearchLink');
  if (!link) return;
  const q = (document.getElementById('fName').value || '').trim() || 'electronics component';
  link.href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}

function syncExternalLink(inputId, linkId) {
  const raw = document.getElementById(inputId).value.trim();
  const link = document.getElementById(linkId);
  if (raw && /^https?:\/\//i.test(raw)) {
    link.href = raw;
    link.classList.remove('hidden');
    link.classList.add('flex');
  } else {
    link.classList.add('hidden');
    link.classList.remove('flex');
  }
}

function setUrlFetchStatus(type, msg) {
  const el = document.getElementById('urlFetchStatus');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.className = 'text-[13px] leading-relaxed px-3 py-2 rounded border';
  if (type === 'info') {
    el.classList.add('bg-well', 'border-line', 'text-ink-2');
  } else if (type === 'success') {
    el.classList.add('bg-go/10', 'border-go/30', 'text-go');
  } else {
    el.classList.add('bg-stop/10', 'border-stop/30', 'text-stop');
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function syncPinoutPasteBtn() {
  const btn = document.getElementById('pinoutPasteToggleBtn');
  btn.setAttribute('aria-pressed', String(Boolean(state.pinoutPasteTarget)));
  btn.textContent = state.pinoutPasteTarget ? 'Ctrl+V pastes here' : 'Paste here with Ctrl+V';
}

function renderDrawerPreview(part) {
  const container = document.getElementById('drawerPreviewBody');
  const low = isLowStock(part);
  const ext = `<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

  const photoHtml = part.image_path
    ? `<button type="button" data-lightbox-src="${escapeHTML(imageUrl(part.image_path))}" class="block w-full h-56 rounded-md overflow-hidden bg-white border border-line cursor-zoom-in" title="Show full size">
         <img src="${escapeHTML(imageUrl(part.image_path))}" alt="${escapeHTML(part.name)}" class="w-full h-full object-contain p-3" />
       </button>`
    : `<button type="button" data-action="add-photo" class="w-full h-24 rounded-md border border-dashed border-line hover:border-ink/50 flex items-center justify-center gap-4 text-muted hover:text-ink transition-colors">
         ${categoryGlyph(part.category, 'w-9 h-9 opacity-60')}
         <span class="text-sm font-medium">Add a photo</span>
       </button>`;

  const specCount = part.specs ? Object.keys(part.specs).length : 0;
  const hasSpecsOrPinout = specCount > 0 || Boolean(part.pinout_image_path || part.pinout_url || part.source_url);
  const tab = state.activePreviewTab || 'overview';
  const tabBtnCls = (name) => (tab === name ? 'pb-tab pb-tab-active' : 'pb-tab');

  const prose = (label, text) => `
    <section>
      <h4 class="pb-section-label mb-1">${label}</h4>
      <p class="text-[15px] leading-[1.6]">${renderWithGlossaryTooltips(text)}</p>
    </section>`;

  const overviewTabHtml = `
    <div class="space-y-5">
      ${
        part.warning
          ? `<div class="pb-alert-warn px-4 py-3 text-[15px] leading-[1.55]">
               <div class="pb-alert-warn-title flex items-center gap-1.5 text-[13px] font-semibold mb-1">
                 <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                 Caution
               </div>
               <p>${renderWithGlossaryTooltips(part.warning)}</p>
             </div>`
          : ''
      }
      ${part.what_it_does ? prose('What it does', part.what_it_does) : ''}
      ${part.visual_tell ? prose('How to recognise it', part.visual_tell) : ''}
      ${
        !part.warning && !part.what_it_does && !part.visual_tell
          ? `<div class="text-center py-10 space-y-3">
               <p class="text-sm text-muted">This part has no description.</p>
               <button type="button" data-action="edit-details" class="btn-secondary h-8 px-3.5 text-[13px]">Write a description</button>
             </div>`
          : ''
      }
    </div>
  `;

  const specsTabHtml = `
    <div class="space-y-6">
      ${
        specCount > 0
          ? `<table class="w-full text-sm">
               <tbody>
                 ${Object.entries(part.specs)
                   .map(
                     ([k, v]) => `<tr class="border-b border-line last:border-0">
                       <th scope="row" class="py-2 pr-4 text-left font-normal text-muted align-top w-[42%]">${escapeHTML(k)}</th>
                       <td class="py-2 font-mono text-[13px] text-ink">${escapeHTML(v)}</td>
                     </tr>`
                   )
                   .join('')}
               </tbody>
             </table>`
          : ''
      }
      ${
        part.pinout_image_path
          ? `<section>
               <h4 class="pb-section-label mb-2">Pinout</h4>
               <button type="button" data-lightbox-src="${escapeHTML(imageUrl(part.pinout_image_path))}" class="block w-full h-52 rounded-md overflow-hidden bg-white border border-line cursor-zoom-in">
                 <img src="${escapeHTML(imageUrl(part.pinout_image_path))}" alt="Pinout diagram" class="w-full h-full object-contain p-2.5" />
               </button>
             </section>`
          : ''
      }
      ${
        (part.pinout_url && /^https?:\/\//i.test(part.pinout_url)) || (part.source_url && /^https?:\/\//i.test(part.source_url))
          ? `<div class="flex flex-wrap gap-2">
               ${part.pinout_url && /^https?:\/\//i.test(part.pinout_url) ? `<a href="${escapeHTML(part.pinout_url)}" target="_blank" rel="noopener noreferrer" class="btn-secondary h-8 px-3 text-[13px] inline-flex items-center gap-1.5">Datasheet ${ext}</a>` : ''}
               ${part.source_url && /^https?:\/\//i.test(part.source_url) ? `<a href="${escapeHTML(part.source_url)}" target="_blank" rel="noopener noreferrer" class="btn-secondary h-8 px-3 text-[13px] inline-flex items-center gap-1.5">Store page ${ext}</a>` : ''}
             </div>`
          : ''
      }
      ${
        !hasSpecsOrPinout
          ? `<div class="text-center py-10 space-y-3">
               <p class="text-sm text-muted">This part has no specs or pinout.</p>
               <button type="button" data-action="edit-specs" class="btn-secondary h-8 px-3.5 text-[13px]">Add specs</button>
             </div>`
          : ''
      }
    </div>
  `;

  const notesTabHtml = part.notes
    ? `<div class="pb-md">${renderMarkdown(part.notes)}</div>`
    : `<div class="text-center py-10 space-y-3">
         <p class="text-sm text-muted">This part has no notes.</p>
         <button type="button" data-action="edit-details" class="btn-secondary h-8 px-3.5 text-[13px]">Write a note</button>
       </div>`;

  container.innerHTML = `
    ${photoHtml}

    <div>
      <h3 class="pb-display text-[1.75rem]">${escapeHTML(part.name)}</h3>
      ${part.subtitle ? `<p class="text-[15px] text-ink-2 mt-1">${escapeHTML(part.subtitle)}</p>` : ''}
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      ${
        part.location
          ? `<button type="button" data-preview-bin="${escapeHTML(part.location)}" class="pb-bin-tag !h-7 !text-[15px] !px-2.5" title="Show all parts in this bin">${escapeHTML(part.location)}</button>`
          : `<span class="pb-bin-tag is-empty !h-7">No bin</span>`
      }
      <div class="flex items-center gap-2">
        ${qtyStepper(part, 'data-preview-step', 'w-8 h-8', false)}
        <span class="text-[13px] text-muted">in stock</span>
      </div>
      ${part.in_use_project ? `<span class="pb-status is-go">Used in ${escapeHTML(part.in_use_project)}</span>` : ''}
      ${low ? `<span class="pb-status is-stop">Low stock (limit ${escapeHTML(part.low_stock_threshold)})</span>` : ''}
    </div>

    <div>
      <div class="pb-tabs mb-5">
        <button type="button" data-preview-tab="overview" class="${tabBtnCls('overview')}">Overview</button>
        <button type="button" data-preview-tab="specs" class="${tabBtnCls('specs')}">Specs${specCount ? ` <span class="text-muted font-normal">${specCount}</span>` : ''}</button>
        <button type="button" data-preview-tab="notes" class="${tabBtnCls('notes')}">Notes</button>
      </div>
      ${tab === 'specs' ? specsTabHtml : tab === 'notes' ? notesTabHtml : overviewTabHtml}
    </div>
  `;
}

function renderImagePicker() {
  const box = document.getElementById('imagePickerBox');
  const grid = document.getElementById('imagePickerGrid');
  if (!state.imageCandidates || state.imageCandidates.length === 0) {
    box.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  grid.innerHTML = state.imageCandidates
    .map(
      (c, idx) => `
      <div class="group relative rounded border border-hairline-light bg-matte-light overflow-hidden flex flex-col hover:border-accent transition-colors" data-candidate-card="${idx}">
        <button
          type="button"
          data-pick-url="${escapeHTML(c.url)}"
          data-pick-slot="main"
          class="aspect-[4/3] w-full flex items-center justify-center p-1.5 cursor-pointer"
          title="Set as main photo (${escapeHTML(c.source || 'web')})"
        >
          <img
            src="${escapeHTML(c.url)}"
            alt="${escapeHTML(c.title || 'Candidate photo')}"
            referrerpolicy="no-referrer"
            loading="lazy"
            class="w-full h-full object-contain"
            onerror="this.closest('[data-candidate-card]').classList.add('hidden')"
          />
        </button>
        <div class="px-1.5 py-1 border-t border-hairline-light/70 bg-surface-light/90 flex items-center justify-between gap-1">
          <span class="text-[9px] font-mono text-muted truncate">${escapeHTML(c.source || 'web')}</span>
          <button
            type="button"
            data-pick-url="${escapeHTML(c.url)}"
            data-pick-slot="pinout"
            class="btn-secondary shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded"
            title="Set as Pinout diagram"
          >Pinout</button>
        </div>
      </div>
    `
    )
    .join('');
}

function syncFooterModeSwitch(mode) {
  const modeSwitch = document.getElementById('drawerModeSwitch');
  const prevBtn = document.getElementById('modePreviewBtn');
  const editBtn = document.getElementById('modeEditBtn');
  const deleteArea = document.getElementById('deleteArea');
  const cancelCreateBtn = document.getElementById('cancelCreateBtn');
  const closePreviewBtn = document.getElementById('closePreviewFooterBtn');
  const saveBtn = document.getElementById('saveDrawerBtn');

  if (mode === 'view') {
    modeSwitch.classList.remove('hidden');
    prevBtn.classList.add('pb-seg-active');
    prevBtn.classList.remove('opacity-70');
    editBtn.classList.remove('pb-seg-active');
    editBtn.classList.add('opacity-70');

    deleteArea.classList.add('hidden');
    cancelCreateBtn.classList.add('hidden');
    closePreviewBtn.classList.remove('hidden');
    saveBtn.classList.add('hidden');
  } else if (mode === 'edit') {
    modeSwitch.classList.remove('hidden');
    editBtn.classList.add('pb-seg-active');
    editBtn.classList.remove('opacity-70');
    prevBtn.classList.remove('pb-seg-active');
    prevBtn.classList.add('opacity-70');

    deleteArea.classList.remove('hidden');
    cancelCreateBtn.classList.add('hidden');
    closePreviewBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Save';
  } else {
    modeSwitch.classList.add('hidden');
    deleteArea.classList.add('hidden');
    cancelCreateBtn.classList.remove('hidden');
    closePreviewBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    saveBtn.textContent = 'Add part';
  }
}

function openDrawer(mode, partId = null, initialTab = 'basics') {
  state.drawerMode = mode;
  state.activePartId = partId;
  state.pendingMainFile = null;
  state.pendingPinoutFile = null;
  state.pinoutPasteTarget = false;
  state.lastScraped = { title: '', description: '' };
  state.imageCandidates = [];
  renderImagePicker();

  const previewBody = document.getElementById('drawerPreviewBody');
  const editTabBar = document.getElementById('editTabBar');
  const editBody = document.getElementById('drawerEditBody');
  const categoryPill = document.getElementById('drawerCategoryPill');

  syncFooterModeSwitch(mode);

  if (mode === 'view') {
    const part = state.parts.find((p) => p.id === partId);
    if (!part) return;
    state.activePreviewTab = 'overview';

    document.getElementById('drawerHeading').textContent = 'Part';
    categoryPill.textContent = part.category || '';
    categoryPill.classList.toggle('hidden', !part.category);

    previewBody.classList.remove('hidden');
    editTabBar.classList.add('hidden');
    editBody.classList.add('hidden');

    renderDrawerPreview(part);
  } else {
    previewBody.classList.add('hidden');
    editTabBar.classList.remove('hidden');
    editBody.classList.remove('hidden');
    categoryPill.classList.add('hidden');

    refreshLocationDatalist();
    setUrlFetchStatus(null, '');
    syncPinoutPasteBtn();
    switchEditTab(initialTab);

    document.getElementById('photoUrlInput').value = '';
    document.getElementById('photoFileInput').value = '';
    document.getElementById('pinoutFileInput').value = '';

    document.getElementById('deleteConfirmGroup').classList.add('hidden');
    document.getElementById('deleteConfirmGroup').classList.remove('flex');
    document.getElementById('deleteInitBtn').classList.remove('hidden');

    if (mode === 'edit') {
      const part = state.parts.find((p) => p.id === partId);
      if (!part) return;
      document.getElementById('drawerHeading').textContent = 'Edit part';

      document.getElementById('fName').value = part.name || '';
      document.getElementById('fSubtitle').value = part.subtitle || '';
      document.getElementById('fCategory').value = part.category || 'Sensors';
      document.getElementById('fQuantity').value = part.quantity ?? 1;
      document.getElementById('fLowStock').value =
        part.low_stock_threshold !== null && part.low_stock_threshold !== undefined
          ? part.low_stock_threshold
          : '';
      document.getElementById('fLocation').value = part.location || '';
      document.getElementById('fInUseProject').value = part.in_use_project || '';
      document.getElementById('fWhatItDoes').value = part.what_it_does || '';
      document.getElementById('fVisualTell').value = part.visual_tell || '';
      document.getElementById('fWarning').value = part.warning || '';
      document.getElementById('fNotes').value = part.notes || '';
      const fNotesEd = document.getElementById('fNotes')?.closest('[data-md-editor]');
      if (fNotesEd) setMdEditorMode(fNotesEd, 'edit');
      document.getElementById('fSourceUrl').value = part.source_url || '';
      document.getElementById('fPinoutUrl').value = part.pinout_url || '';

      state.draftImagePath = part.image_path || '';
      state.draftPinoutImagePath = part.pinout_image_path || '';
      populateSpecsEditor(part.specs || {});
      updateWarningCallout(part.warning);
    } else {
      document.getElementById('drawerHeading').textContent = 'New part';

      document.getElementById('partForm').reset();
      const fNotesEd = document.getElementById('fNotes')?.closest('[data-md-editor]');
      if (fNotesEd) setMdEditorMode(fNotesEd, 'edit');
      document.getElementById('fCategory').value = state.category !== 'All' ? state.category : 'Sensors';
      document.getElementById('fQuantity').value = 1;
      document.getElementById('fLowStock').value = '';
      document.getElementById('fPinoutUrl').value = '';

      state.draftImagePath = '';
      state.draftPinoutImagePath = '';
      populateSpecsEditor({});
      updateWarningCallout('');
    }

    syncExternalLink('fSourceUrl', 'openSourceUrlLink');
    syncExternalLink('fPinoutUrl', 'openPinoutUrlLink');
    syncGoogleImagesLink();
    renderDrawerPhoto();
    renderDrawerPinout();
  }

  const root = document.getElementById('drawerRoot');
  root.classList.remove('pointer-events-none', 'drawer-closed');
  root.classList.add('drawer-open');
  root.setAttribute('aria-hidden', 'false');
  document.getElementById('drawerBackdrop').classList.remove('opacity-0');
  document.body.style.overflow = 'hidden';

  if (mode === 'create' && initialTab === 'basics') {
    setTimeout(() => document.getElementById('fName').focus(), 180);
  }
}

function closeDrawer() {
  const root = document.getElementById('drawerRoot');
  root.classList.remove('drawer-open');
  root.classList.add('drawer-closed', 'pointer-events-none');
  root.setAttribute('aria-hidden', 'true');
  document.getElementById('drawerBackdrop').classList.add('opacity-0');
  document.body.style.overflow = '';
  state.drawerMode = null;
  state.activePartId = null;
  state.pendingMainFile = null;
  state.pendingPinoutFile = null;
  state.pinoutPasteTarget = false;
}

// =============================================================================
// PHOTO UPLOAD / SCRAPE / ENRICH / CANDIDATE PICKER
// =============================================================================
async function uploadPhotoForPart(partId, file, slot = 'main') {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('slot', slot);
  return apiFetch(`/api/parts/${encodeURIComponent(partId)}/photo`, {
    method: 'POST',
    body: formData,
  });
}

async function handleImageFileSelected(file, slot = 'main') {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Select a valid image file');
    return;
  }

  if (state.drawerMode === 'edit' && state.activePartId) {
    try {
      showToast(slot === 'pinout' ? 'Uploading pinout...' : 'Uploading photo...');
      const updated = await uploadPhotoForPart(state.activePartId, file, slot);
      upsertLocalPart(updated);
      if (slot === 'pinout') {
        state.draftPinoutImagePath = updated.pinout_image_path || '';
        renderDrawerPinout();
      } else {
        state.draftImagePath = updated.image_path || '';
        renderDrawerPhoto();
      }
      renderGrid();
      showToast(slot === 'pinout' ? 'Pinout saved as WebP' : 'Photo saved as WebP');
    } catch (err) {
      showToast(err.message);
    }
  } else {
    const previewUrl = URL.createObjectURL(file);
    if (slot === 'pinout') {
      state.pendingPinoutFile = file;
      state.draftPinoutImagePath = previewUrl;
      renderDrawerPinout();
    } else {
      state.pendingMainFile = file;
      state.draftImagePath = previewUrl;
      renderDrawerPhoto();
    }
    showToast('Image ready — saves with part');
  }
}

async function handleRemovePhoto(slot = 'main') {
  if (state.drawerMode === 'edit' && state.activePartId) {
    try {
      const updated = await apiFetch(
        `/api/parts/${encodeURIComponent(state.activePartId)}/photo?slot=${encodeURIComponent(slot)}`,
        { method: 'DELETE' }
      );
      upsertLocalPart(updated);
      if (slot === 'pinout') {
        state.draftPinoutImagePath = '';
        renderDrawerPinout();
      } else {
        state.draftImagePath = '';
        renderDrawerPhoto();
      }
      renderGrid();
      showToast(slot === 'pinout' ? 'Pinout removed' : 'Photo removed');
    } catch (err) {
      showToast(err.message);
    }
  } else {
    if (slot === 'pinout') {
      state.pendingPinoutFile = null;
      state.draftPinoutImagePath = '';
      renderDrawerPinout();
    } else {
      state.pendingMainFile = null;
      state.draftImagePath = '';
      renderDrawerPhoto();
    }
  }
}

async function handlePickCandidateImage(url, slot = 'main') {
  if (!url) return;
  setUrlFetchStatus('info', slot === 'pinout' ? 'Saving pinout image as WebP...' : 'Saving photo as WebP...');

  try {
    const payload = { url, slot };
    if (state.drawerMode === 'edit' && state.activePartId) {
      payload.part_id = state.activePartId;
    }

    const res = await apiFetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.image_path) {
      setUrlFetchStatus('error', 'Could not download that image. Try another thumbnail.');
      return;
    }

    if (slot === 'pinout') {
      state.pendingPinoutFile = null;
      state.draftPinoutImagePath = res.image_path;
      renderDrawerPinout();
      if (state.drawerMode === 'edit' && state.activePartId) {
        const part = state.parts.find((p) => p.id === state.activePartId);
        if (part) {
          part.pinout_image_path = res.image_path;
          renderGrid();
        }
      }
      setUrlFetchStatus('success', 'Pinout image saved locally as WebP.');
    } else {
      state.pendingMainFile = null;
      state.draftImagePath = res.image_path;
      renderDrawerPhoto();
      if (state.drawerMode === 'edit' && state.activePartId) {
        const part = state.parts.find((p) => p.id === state.activePartId);
        if (part) {
          part.image_path = res.image_path;
          renderGrid();
        }
      }
      setUrlFetchStatus('success', 'Photo saved locally as WebP.');
    }
    showToast(slot === 'pinout' ? 'Pinout photo attached' : 'Photo attached');
  } catch (err) {
    setUrlFetchStatus('error', err.message);
  }
}

async function handleFetchUrl() {
  const raw = document.getElementById('photoUrlInput').value.trim();
  if (!raw) return;

  const btn = document.getElementById('fetchUrlBtn');
  btn.disabled = true;
  setUrlFetchStatus('info', 'Fetching URL safely on server...');

  try {
    const payload = { url: raw };
    if (state.drawerMode === 'edit' && state.activePartId) {
      payload.part_id = state.activePartId;
    }

    const res = await apiFetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    state.lastScraped = {
      title: res.title || '',
      description: res.description || '',
    };

    if (!document.getElementById('fSourceUrl').value.trim() && res.source_url) {
      document.getElementById('fSourceUrl').value = res.source_url;
      syncExternalLink('fSourceUrl', 'openSourceUrlLink');
    }

    if (!document.getElementById('fName').value.trim() && res.title) {
      document.getElementById('fName').value = res.title;
      syncGoogleImagesLink();
    }

    if (res.image_path) {
      state.pendingMainFile = null;
      state.draftImagePath = res.image_path;
      renderDrawerPhoto();

      if (state.drawerMode === 'edit' && state.activePartId) {
        const part = state.parts.find((p) => p.id === state.activePartId);
        if (part) {
          part.image_path = res.image_path;
          renderGrid();
        }
      }
      setUrlFetchStatus(
        'success',
        res.title
          ? `Fetched photo & metadata ("${res.title.slice(0, 60)}").`
          : 'Image downloaded and saved locally as WebP.'
      );
    } else if (res.title || res.description) {
      setUrlFetchStatus('info', 'Fetched page text, but no product image was found.');
    } else {
      setUrlFetchStatus('info', 'Page fetched, but no image or metadata was found.');
    }
  } catch (err) {
    setUrlFetchStatus('error', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function handleSmartAutofill() {
  const nameVal = document.getElementById('fName').value.trim();
  const query = nameVal || state.lastScraped.title || document.getElementById('photoUrlInput').value.trim();
  if (!query && !state.lastScraped.title && !state.lastScraped.description) {
    showToast('Enter a part name or fetch a URL first');
    return;
  }

  const btn = document.getElementById('smartAutofillBtn');
  btn.disabled = true;
  setUrlFetchStatus('info', 'Searching web & running AI Smart Autofill...');

  try {
    const reqBody = {
      query,
      scraped_title: state.lastScraped.title,
      scraped_description: state.lastScraped.description,
      fetch_image: true,
    };
    if (state.drawerMode === 'edit' && state.activePartId) {
      reqBody.part_id = state.activePartId;
    }

    const data = await apiFetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });

    if (data.name) {
      document.getElementById('fName').value = data.name;
      syncGoogleImagesLink();
    }
    if (data.subtitle) document.getElementById('fSubtitle').value = data.subtitle;
    if (data.category) document.getElementById('fCategory').value = data.category;
    if (data.what_it_does) document.getElementById('fWhatItDoes').value = data.what_it_does;
    if (data.visual_tell) document.getElementById('fVisualTell').value = data.visual_tell;
    if (data.warning) {
      document.getElementById('fWarning').value = data.warning;
      updateWarningCallout(data.warning);
    }
    if (data.notes && !document.getElementById('fNotes').value.trim()) {
      document.getElementById('fNotes').value = data.notes;
    }
    if (data.pinout_url) {
      document.getElementById('fPinoutUrl').value = data.pinout_url;
      syncExternalLink('fPinoutUrl', 'openPinoutUrlLink');
    }
    if (data.specs && typeof data.specs === 'object' && Object.keys(data.specs).length > 0) {
      const merged = { ...data.specs, ...collectSpecsFromEditor() };
      populateSpecsEditor(merged);
    }

    state.imageCandidates = Array.isArray(data.image_candidates) ? data.image_candidates : [];
    renderImagePicker();

    const addedTerms = Array.isArray(data.added_glossary_terms) ? data.added_glossary_terms : [];
    if (addedTerms.length > 0) {
      loadGlossary();
      showToast(`Added to Glossary: ${addedTerms.join(', ')}`);
    }

    setUrlFetchStatus(
      'success',
      state.imageCandidates.length > 0
        ? `Autofill done — found ${state.imageCandidates.length} photo candidate${state.imageCandidates.length > 1 ? 's' : ''}. Pick one below or click Save.`
        : 'Smart Autofill populated Details & Tech Specs. Review and click Save.'
    );
    loadConfig();
  } catch (err) {
    setUrlFetchStatus('error', err.message);
  } finally {
    btn.disabled = false;
  }
}

// =============================================================================
// CRUD SAVE / DELETE / STEPPER
// =============================================================================
function upsertLocalPart(updated) {
  const idx = state.parts.findIndex((p) => p.id === updated.id);
  if (idx !== -1) {
    state.parts[idx] = updated;
  } else {
    state.parts.unshift(updated);
  }
}

async function saveDrawer() {
  const name = document.getElementById('fName').value.trim();
  if (!name) {
    switchEditTab('basics');
    document.getElementById('fName').focus();
    showToast('Enter a part name');
    return;
  }

  const rawLowStock = document.getElementById('fLowStock').value.trim();
  const payload = {
    name,
    subtitle: document.getElementById('fSubtitle').value.trim(),
    category: document.getElementById('fCategory').value,
    quantity: Math.max(0, parseInt(document.getElementById('fQuantity').value, 10) || 0),
    low_stock_threshold: rawLowStock === '' ? null : Math.max(0, parseInt(rawLowStock, 10) || 0),
    location: document.getElementById('fLocation').value.trim(),
    in_use_project: document.getElementById('fInUseProject').value.trim(),
    what_it_does: document.getElementById('fWhatItDoes').value.trim(),
    visual_tell: document.getElementById('fVisualTell').value.trim(),
    warning: document.getElementById('fWarning').value.trim(),
    notes: document.getElementById('fNotes').value.trim(),
    source_url: document.getElementById('fSourceUrl').value.trim(),
    pinout_url: document.getElementById('fPinoutUrl').value.trim(),
    specs: collectSpecsFromEditor(),
  };

  if (state.drawerMode === 'create') {
    if (state.draftImagePath && !state.draftImagePath.startsWith('blob:')) {
      payload.image_path = state.draftImagePath;
    }
    if (state.draftPinoutImagePath && !state.draftPinoutImagePath.startsWith('blob:')) {
      payload.pinout_image_path = state.draftPinoutImagePath;
    }
  }

  const saveBtn = document.getElementById('saveDrawerBtn');
  saveBtn.disabled = true;

  try {
    let savedPart;
    if (state.drawerMode === 'edit' && state.activePartId) {
      savedPart = await apiFetch(`/api/parts/${encodeURIComponent(state.activePartId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      upsertLocalPart(savedPart);
      renderGrid();
      openDrawer('view', savedPart.id);
      showToast('Changes saved');
    } else {
      savedPart = await apiFetch('/api/parts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (state.pendingMainFile) {
        savedPart = await uploadPhotoForPart(savedPart.id, state.pendingMainFile, 'main');
      }
      if (state.pendingPinoutFile) {
        savedPart = await uploadPhotoForPart(savedPart.id, state.pendingPinoutFile, 'pinout');
      }
      upsertLocalPart(savedPart);
      renderGrid();
      closeDrawer();
      showToast('Part added to Pinbin');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

function updateCardQuantityInPlace(part) {
  const needsFullRerender =
    state.lowStockOnly ||
    state.uiSettings.sort_by === 'qty_asc' ||
    state.uiSettings.sort_by === 'qty_desc';

  if (needsFullRerender) {
    renderGrid();
    return;
  }

  const qtyEl = document.getElementById(`qty-${part.id}`);
  if (qtyEl) {
    qtyEl.textContent = part.quantity;
    qtyEl.classList.toggle('pb-qty-low', isLowStock(part));
  }
  const lowStockCount = state.parts.filter((p) => isLowStock(p)).length;
  const lowEl = document.getElementById('lowStockCount');
  if (lowEl) lowEl.textContent = lowStockCount;
  updateNavBadges();
}

async function handleStepQuantity(partId, delta) {
  const part = state.parts.find((p) => p.id === partId);
  if (!part) return;
  const nextQty = Math.max(0, Number(part.quantity || 0) + delta);
  if (nextQty === part.quantity) return;

  const prevQty = part.quantity;
  const wasLow = isLowStock(part);
  part.quantity = nextQty;
  const nowLow = isLowStock(part);

  if (wasLow !== nowLow) {
    renderGrid();
  } else {
    updateCardQuantityInPlace(part);
  }
  if (state.drawerMode === 'view' && state.activePartId === partId) {
    renderDrawerPreview(part);
  }

  try {
    const updated = await apiFetch(`/api/parts/${encodeURIComponent(partId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: nextQty }),
    });
    upsertLocalPart(updated);
    if (wasLow !== isLowStock(updated)) {
      renderGrid();
    } else {
      updateCardQuantityInPlace(updated);
    }
    if (state.drawerMode === 'view' && state.activePartId === partId) {
      renderDrawerPreview(updated);
    }
  } catch (err) {
    part.quantity = prevQty;
    renderGrid();
    if (state.drawerMode === 'view' && state.activePartId === partId) {
      renderDrawerPreview(part);
    }
    showToast(err.message);
  }
}

// =============================================================================
// BACKUP & RESTORE
// =============================================================================
async function handleRestoreConfirm() {
  if (!state.pendingRestoreFile) return;
  const btn = document.getElementById('confirmRestoreBtn');
  btn.disabled = true;
  btn.textContent = 'Restoring...';

  try {
    const fd = new FormData();
    fd.append('file', state.pendingRestoreFile);
    const res = await apiFetch('/api/restore', {
      method: 'POST',
      body: fd,
    });
    document.getElementById('restoreModal').classList.add('hidden');
    closeSettingsModal();
    state.pendingRestoreFile = null;
    await Promise.all([loadConfig(), loadParts(), loadProjects(), loadGlossary(), loadShopping()]);
    showToast(`Restored ${res.parts_count} parts & ${res.images_count} photos`);
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore Backup';
  }
}

// =============================================================================
// EVENT WIRING
// =============================================================================
function bindEvents() {
  // Settings Modal
  document.getElementById('openSettingsBtn').addEventListener('click', openSettingsModal);
  document.getElementById('settingLogoColors').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-setting-logo]');
    if (btn && btn.dataset.settingLogo !== state.uiSettings.logo_color) saveUiSettings({ logo_color: btn.dataset.settingLogo });
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') closeSettingsModal();
  });

  document.querySelectorAll('button[data-setting-theme]').forEach((btn) => {
    btn.addEventListener('click', () => saveUiSettings({ theme: btn.dataset.settingTheme }));
  });
  document.querySelectorAll('button[data-setting-view]').forEach((btn) => {
    btn.addEventListener('click', () => saveUiSettings({ view_mode: btn.dataset.settingView }));
  });
  document.getElementById('settingShowCaution').addEventListener('change', (e) => {
    saveUiSettings({ show_caution_badge: e.target.checked });
  });
  document.getElementById('settingInlineTooltips').addEventListener('change', (e) => {
    saveUiSettings({ inline_tooltips: e.target.checked });
  });

  // Backup / Restore / CSV inside Settings
  document.getElementById('downloadBackupBtn').addEventListener('click', () => {
    window.location.href = '/api/backup';
  });
  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    window.location.href = '/api/export/csv';
  });
  document.getElementById('importCsvFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/import/csv', { method: 'POST', body: fd });
      await loadParts();
      closeSettingsModal();
      showToast(`Imported ${res.imported} part${res.imported === 1 ? '' : 's'} from CSV`);
    } catch (err) {
      showToast(err.message);
    }
  });

  // Shopping View Events
  document.getElementById('shopFetchAddBtn').addEventListener('click', async () => {
    const urlInput = document.getElementById('shopUrlInput');
    const url = urlInput.value.trim();
    if (!url) return;
    const btn = document.getElementById('shopFetchAddBtn');
    const status = document.getElementById('shopAddStatus');
    btn.disabled = true;
    status.textContent = 'Fetching product details & photo...';
    status.classList.remove('hidden');
    try {
      const scraped = await apiFetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const created = await apiFetch('/api/shopping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scraped.title || url,
          url: scraped.source_url || url,
          price: scraped.price || '',
          quantity: 1,
          image_path: scraped.image_path || '',
          retailer: scraped.retailer || '',
          in_stock: scraped.in_stock || '',
          tag: (document.getElementById('shopTagInput')?.value || '').trim(),
        }),
      });
      state.shoppingItems.unshift(created);
      urlInput.value = '';
      status.classList.add('hidden');
      updateNavBadges();
      renderShopping();
      if (state.consolidateOpen) refreshConsolidatePlan();
      showToast('Added to shopping list');
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('shopManualAddBtn').addEventListener('click', async () => {
    const nameEl = document.getElementById('shopManualName');
    const name = nameEl.value.trim();
    if (!name) {
      nameEl.focus();
      return;
    }
    try {
      const created = await apiFetch('/api/shopping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          price: document.getElementById('shopManualPrice').value.trim(),
          quantity: Math.max(1, parseInt(document.getElementById('shopManualQty').value, 10) || 1),
          tag: (document.getElementById('shopTagInput')?.value || '').trim(),
        }),
      });
      state.shoppingItems.unshift(created);
      nameEl.value = '';
      document.getElementById('shopManualPrice').value = '';
      document.getElementById('shopManualQty').value = 1;
      updateNavBadges();
      renderShopping();
      if (state.consolidateOpen) refreshConsolidatePlan();
      showToast('Added to shopping list');
    } catch (err) {
      showToast(err.message);
    }
  });

  document.querySelectorAll('button[data-shop-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.shoppingGroupBy = btn.dataset.shopGroup;
      renderShopping();
    });
  });

  document.getElementById('shoppingTagFilterBar').addEventListener('click', (e) => {
    if (e.target.closest('#toggleOtherBuildsBtn')) {
      state.shoppingShowOtherBuilds = !state.shoppingShowOtherBuilds;
      renderShopping();
      if (state.consolidateOpen) refreshConsolidatePlan();
      return;
    }
    const btn = e.target.closest('button[data-shop-tag]');
    if (!btn) return;
    state.shoppingTagFilter = btn.dataset.shopTag;
    renderShopping();
    if (state.consolidateOpen) refreshConsolidatePlan();
  });

  const consolidateBtn = document.getElementById('toggleConsolidateBtn');
  if (consolidateBtn) {
    consolidateBtn.addEventListener('click', () => {
      state.consolidateOpen = !state.consolidateOpen;
      const panel = document.getElementById('shoppingConsolidatePanel');
      if (panel) panel.classList.toggle('hidden', !state.consolidateOpen);
      if (state.consolidateOpen) {
        renderConsolidatePanel();
        refreshConsolidatePlan();
      }
    });
  }

  const consolidatePanel = document.getElementById('shoppingConsolidatePanel');
  if (consolidatePanel) {
    consolidatePanel.addEventListener('click', async (e) => {
      const modeBtn = e.target.closest('button[data-cons-mode]');
      if (modeBtn) {
        state.consolidateMode = modeBtn.dataset.consMode;
        await refreshConsolidatePlan();
        return;
      }
      if (e.target.closest('#consApplyBtn')) {
        const btn = e.target.closest('#consApplyBtn');
        btn.disabled = true;
        btn.textContent = 'Applying...';
        try {
          const res = await apiFetch('/api/shopping/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tag: state.shoppingTagFilter !== 'All' ? state.shoppingTagFilter : null,
              mode: state.consolidateMode,
              include_inactive_variants: state.shoppingShowOtherBuilds,
              apply: true,
            }),
          });
          await loadShopping();
          await loadProjects();
          showToast(`Updated ${res.changes_count} ${res.changes_count === 1 ? 'item' : 'items'}`);
        } catch (err) {
          showToast(err.message);
          renderConsolidatePanel();
        }
        return;
      }
      const saveShipBtn = e.target.closest('button[data-save-retailer]');
      if (saveShipBtn) {
        const domain = saveShipBtn.dataset.saveRetailer;
        const existingMeta = (state.retailers || []).find((r) => r.domain === domain);
        const row = saveShipBtn.closest('[data-retailer-row]');
        const shipRaw = row.querySelector('[data-ret-ship]').value.trim();
        const freeRaw = row.querySelector('[data-ret-free]').value.trim();
        try {
          await apiFetch(`/api/retailers/${encodeURIComponent(domain)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: (existingMeta && existingMeta.name) || domain,
              shipping_cost: shipRaw === '' ? null : parseFloat(shipRaw),
              free_shipping_threshold: freeRaw === '' ? null : parseFloat(freeRaw),
              currency: (existingMeta && existingMeta.currency) || '',
              notes: (existingMeta && existingMeta.notes) || '',
            }),
          });
          state.retailers = await apiFetch('/api/retailers');
          await refreshConsolidatePlan();
          showToast(`Saved shipping for ${domain}`);
        } catch (err) {
          showToast(err.message);
        }
        return;
      }
      const openShopBtn = e.target.closest('button[data-open-shop]');
      if (openShopBtn) {
        openContextDrawer({ type: 'shopping', id: openShopBtn.dataset.openShop });
      }
    });
  }

  document.getElementById('copyShoppingChecklistBtn').addEventListener('click', async () => {
    const lines = [];
    state.shoppingItems.forEach((it) => {
      lines.push(`- [ ] ${it.name} (x${it.quantity})${it.price ? ` — ${it.price}` : ''}${it.url ? ` ${it.url}` : ''}`);
    });
    state.parts
      .filter((p) => Number(p.quantity) === 0 || isLowStock(p))
      .forEach((p) => {
        lines.push(`- [ ] [Restock] ${p.name} (have ${p.quantity})${p.source_url ? ` ${p.source_url}` : ''}`);
      });
    if (lines.length === 0) {
      showToast('Shopping list is empty');
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('Checklist copied to clipboard');
    } catch (_) {
      showToast('Could not access clipboard');
    }
  });

  document.getElementById('shoppingWishlistGrid').addEventListener('click', async (e) => {
    const openShopBtn = e.target.closest('button[data-open-shop]');
    if (openShopBtn) {
      openContextDrawer({ type: 'shopping', id: openShopBtn.dataset.openShop });
      return;
    }
    const stepBtn = e.target.closest('button[data-shop-step]');
    if (stepBtn) {
      const id = stepBtn.dataset.shopId;
      const item = state.shoppingItems.find((x) => x.id === id);
      if (!item) return;
      const curQty = Number(item.quantity || 1);
      const next = Math.max(1, curQty + parseInt(stepBtn.dataset.shopStep, 10));
      if (next === curQty) return;
      try {
        const updated = await apiFetch(`/api/shopping/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: next }),
        });
        Object.assign(item, updated);
        renderShopping();
        loadProjects();
        if (state.consolidateOpen) refreshConsolidatePlan();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const boughtBtn = e.target.closest('button[data-shop-bought]');
    if (boughtBtn) {
      const id = boughtBtn.dataset.shopBought;
      try {
        const newPart = await apiFetch(`/api/shopping/${encodeURIComponent(id)}/move-to-inventory`, { method: 'POST' });
        state.shoppingItems = state.shoppingItems.filter((x) => x.id !== id);
        state.parts.unshift(newPart);
        await loadProjects();
        updateNavBadges();
        renderShopping();
        if (state.consolidateOpen) refreshConsolidatePlan();
        showToast('Moved to Inventory');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const delBtn = e.target.closest('button[data-shop-del]');
    if (delBtn) {
      const id = delBtn.dataset.shopDel;
      try {
        await apiFetch(`/api/shopping/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.shoppingItems = state.shoppingItems.filter((x) => x.id !== id);
        await loadProjects();
        updateNavBadges();
        renderShopping();
        if (state.consolidateOpen) refreshConsolidatePlan();
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  document.getElementById('shoppingLowStockGrid').addEventListener('click', (e) => {
    const openBtn = e.target.closest('button[data-open-part]');
    if (openBtn) {
      openDrawer('view', openBtn.dataset.openPart);
      return;
    }
    const restockBtn = e.target.closest('button[data-restock-id]');
    if (restockBtn) {
      handleStepQuantity(restockBtn.dataset.restockId, 1).then(() => renderShopping());
    }
  });
  document.getElementById('restoreFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    state.pendingRestoreFile = file;
    document.getElementById('restoreFilename').textContent = file.name;
    document.getElementById('restoreModal').classList.remove('hidden');
  });
  document.getElementById('cancelRestoreBtn').addEventListener('click', () => {
    state.pendingRestoreFile = null;
    document.getElementById('restoreModal').classList.add('hidden');
  });
  document.getElementById('confirmRestoreBtn').addEventListener('click', handleRestoreConfirm);

  // Toolbar View & Sort controls
  document.getElementById('viewGridBtn').addEventListener('click', () => saveUiSettings({ view_mode: 'grid' }));
  document.getElementById('viewListBtn').addEventListener('click', () => saveUiSettings({ view_mode: 'list' }));
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    saveUiSettings({ sort_by: e.target.value });
  });

  // Search Input
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  const hint = document.getElementById('searchShortcutHint');

  function syncSearchUi() {
    const hasText = Boolean(state.search);
    clearBtn.classList.toggle('hidden', !hasText);
    hint.classList.toggle('sm:inline-flex', !hasText);
  }

  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    state.glossaryMobileDetail = false;
    syncSearchUi();
    renderCurrentPage();
  });

  clearBtn.addEventListener('click', () => {
    state.search = '';
    searchInput.value = '';
    syncSearchUi();
    renderCurrentPage();
    searchInput.focus();
  });

  // Page Navigation (Inventory / Projects / Glossary)
  document.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // Projects View delegations
  document.getElementById('newProjectBtn').addEventListener('click', () => openProjectModal(null));
  document.getElementById('emptyNewProjectBtn').addEventListener('click', () => openProjectModal(null));

  document.getElementById('projectsGrid').addEventListener('click', async (e) => {
    const pItemBtn = e.target.closest('button[data-open-pitem]');
    if (pItemBtn) {
      openContextDrawer({
        type: 'project_part',
        projectId: pItemBtn.dataset.ctxProj,
        projectItemId: pItemBtn.dataset.openPitem,
      });
      return;
    }
    const shopBtn = e.target.closest('button[data-open-shop]');
    if (shopBtn) {
      openContextDrawer({
        type: 'shopping',
        id: shopBtn.dataset.openShop,
        projectId: shopBtn.dataset.ctxProj || null,
        projectItemId: shopBtn.dataset.ctxPitem || null,
      });
      return;
    }
    const tabBtn = e.target.closest('button[data-proj-tab]');
    if (tabBtn) {
      state.projectActiveTab[tabBtn.dataset.projId] = tabBtn.dataset.projTab;
      renderProjects();
      return;
    }
    const selVarBtn = e.target.closest('button[data-select-variant]');
    if (selVarBtn) {
      try {
        await apiFetch(
          `/api/projects/${encodeURIComponent(selVarBtn.dataset.projId)}/variants/${encodeURIComponent(selVarBtn.dataset.selectVariant)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_selected: true }),
          }
        );
        await Promise.all([loadProjects(), loadParts(), loadShopping()]);
        showToast('Active build option updated');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const delVarBtn = e.target.closest('button[data-delete-variant]');
    if (delVarBtn) {
      const vName = delVarBtn.dataset.variantName || 'this sub-build';
      try {
        await apiFetch(
          `/api/projects/${encodeURIComponent(delVarBtn.dataset.projId)}/variants/${encodeURIComponent(delVarBtn.dataset.deleteVariant)}`,
          { method: 'DELETE' }
        );
        delete state.projectActiveTab[delVarBtn.dataset.projId];
        await Promise.all([loadProjects(), loadParts(), loadShopping()]);
        showToast(`Deleted "${vName}"`);
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const statusBtn = e.target.closest('button[data-proj-status]');
    if (statusBtn) {
      try {
        await apiFetch(`/api/projects/${encodeURIComponent(statusBtn.dataset.projId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: statusBtn.dataset.projStatus }),
        });
        await Promise.all([loadProjects(), loadParts()]);
        showToast(statusBtn.dataset.projStatus === 'active' ? 'Project marked active on bench' : 'Project moved to planning');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const editProjBtn = e.target.closest('button[data-edit-project]');
    if (editProjBtn) {
      openProjectModal(editProjBtn.dataset.editProject);
      return;
    }
    const editVarBtn = e.target.closest('button[data-edit-variant]');
    if (editVarBtn) {
      openProjectActionModal('edit_variant', editVarBtn.dataset.projId, editVarBtn.dataset.editVariant);
      return;
    }
    const addItemBtn = e.target.closest('button[data-add-proj-item]');
    if (addItemBtn) {
      openProjectActionModal('item', addItemBtn.dataset.addProjItem);
      return;
    }
    const addVarBtn = e.target.closest('button[data-add-proj-variant]');
    if (addVarBtn) {
      openProjectActionModal('variant', addVarBtn.dataset.addProjVariant);
      return;
    }
  });

  // Context Drawer Events (Shopping & Project Item)
  document.getElementById('closeContextDrawerBtn').addEventListener('click', closeContextDrawer);
  document.getElementById('contextDrawerBackdrop').addEventListener('click', closeContextDrawer);
  document.getElementById('contextDrawerPanel').addEventListener('click', async (e) => {
    const ctx = state.contextDrawer;
    if (!ctx) return;
    const lightboxTarget = e.target.closest('[data-lightbox-src]');
    if (lightboxTarget) {
      openLightbox(lightboxTarget.dataset.lightboxSrc);
      return;
    }
    const modeBtn = e.target.closest('button[data-ctx-mode]');
    if (modeBtn) {
      setContextDrawerMode(modeBtn.dataset.ctxMode);
      return;
    }
    if (e.target.closest('#ctxCloseFooterBtn')) {
      closeContextDrawer();
      return;
    }
    if (e.target.closest('#ctxOpenInventorySheetBtn') && ctx.type === 'project_part') {
      const proj = state.projects.find((p) => p.id === ctx.projectId);
      const pItem = proj && (proj.items || []).find((x) => x.id === ctx.projectItemId);
      if (pItem && pItem.part_id) {
        closeContextDrawer();
        openDrawer('view', pItem.part_id);
      }
      return;
    }
    if (e.target.closest('#ctxAddOfferBtn') && ctx.type === 'shopping') {
      const urlInput = document.getElementById('ctxAddOfferUrl');
      const priceInput = document.getElementById('ctxAddOfferPrice');
      const btn = e.target.closest('#ctxAddOfferBtn');
      const url = (urlInput ? urlInput.value : '').trim();
      const price = (priceInput ? priceInput.value : '').trim();
      if (!url) {
        showToast('Paste a store link first');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Adding...';
      try {
        const updated = await apiFetch(`/api/shopping/${encodeURIComponent(ctx.id)}/offers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, price, fetch_metadata: true }),
        });
        const idx = state.shoppingItems.findIndex((x) => x.id === ctx.id);
        if (idx >= 0) state.shoppingItems[idx] = updated;
        await loadProjects();
        renderContextDrawer();
        if (state.activePage === 'shopping') {
          renderShopping();
          if (state.consolidateOpen) refreshConsolidatePlan();
        }
        showToast('Store option added');
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = 'Add store';
      }
      return;
    }
    const selOfferBtn = e.target.closest('button[data-select-offer]');
    if (selOfferBtn && ctx.type === 'shopping') {
      const offerId = selOfferBtn.dataset.selectOffer;
      try {
        const updated = await apiFetch(
          `/api/shopping/${encodeURIComponent(ctx.id)}/offers/${encodeURIComponent(offerId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_selected: true }),
          }
        );
        const idx = state.shoppingItems.findIndex((x) => x.id === ctx.id);
        if (idx >= 0) state.shoppingItems[idx] = updated;
        await loadProjects();
        renderContextDrawer();
        if (state.activePage === 'shopping') {
          renderShopping();
          if (state.consolidateOpen) refreshConsolidatePlan();
        }
        showToast('Switched active store');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const delOfferBtn = e.target.closest('button[data-delete-offer]');
    if (delOfferBtn && ctx.type === 'shopping') {
      const offerId = delOfferBtn.dataset.deleteOffer;
      try {
        const updated = await apiFetch(
          `/api/shopping/${encodeURIComponent(ctx.id)}/offers/${encodeURIComponent(offerId)}`,
          { method: 'DELETE' }
        );
        const idx = state.shoppingItems.findIndex((x) => x.id === ctx.id);
        if (idx >= 0) state.shoppingItems[idx] = updated;
        await loadProjects();
        renderContextDrawer();
        if (state.activePage === 'shopping') {
          renderShopping();
          if (state.consolidateOpen) refreshConsolidatePlan();
        }
        showToast('Store option removed');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxFetchShopMetaBtn') && ctx.type === 'shopping') {
      const btn = e.target.closest('#ctxFetchShopMetaBtn');
      btn.disabled = true;
      btn.textContent = 'Fetching...';
      try {
        const updated = await apiFetch(`/api/shopping/${encodeURIComponent(ctx.id)}/fetch`, { method: 'POST' });
        const idx = state.shoppingItems.findIndex((x) => x.id === ctx.id);
        if (idx >= 0) state.shoppingItems[idx] = updated;
        await loadProjects();
        renderContextDrawer();
        if (state.activePage === 'shopping') {
          renderShopping();
          if (state.consolidateOpen) refreshConsolidatePlan();
        }
        showToast('Product photo and info updated');
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
        btn.textContent = 'Fetch photo & info';
      }
      return;
    }
    if (e.target.closest('#ctxSaveShopBtn') && ctx.type === 'shopping') {
      const nameVal = document.getElementById('ctxShopName').value.trim();
      if (!nameVal) {
        showToast('Item name cannot be empty');
        return;
      }
      const whyVal = document.getElementById('ctxShopWhy').value.trim();
      try {
        const updated = await apiFetch(`/api/shopping/${encodeURIComponent(ctx.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: nameVal,
            price: document.getElementById('ctxShopPrice').value.trim(),
            quantity: Math.max(1, parseInt(document.getElementById('ctxShopQty').value, 10) || 1),
            tag: document.getElementById('ctxShopTag').value.trim(),
            category: document.getElementById('ctxShopCategory').value,
            in_stock: document.getElementById('ctxShopStock').value,
            url: document.getElementById('ctxShopUrl').value.trim(),
            why_needed: whyVal,
            notes: whyVal,
          }),
        });
        const idx = state.shoppingItems.findIndex((x) => x.id === ctx.id);
        if (idx >= 0) state.shoppingItems[idx] = updated;
        await loadProjects();
        renderCurrentPage();
        if (state.activePage === 'shopping' && state.consolidateOpen) refreshConsolidatePlan();
        if (state.contextDrawer && state.contextDrawer.id === ctx.id) {
          state.contextDrawer.mode = 'view';
          renderContextDrawer();
        }
        showToast('Shopping item saved');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxShopBoughtBtn') && ctx.type === 'shopping') {
      try {
        const newPart = await apiFetch(`/api/shopping/${encodeURIComponent(ctx.id)}/move-to-inventory`, { method: 'POST' });
        state.shoppingItems = state.shoppingItems.filter((x) => x.id !== ctx.id);
        state.parts.unshift(newPart);
        closeContextDrawer();
        await loadProjects();
        renderCurrentPage();
        if (state.activePage === 'shopping' && state.consolidateOpen) refreshConsolidatePlan();
        showToast('Moved to Inventory and linked in project');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxDeleteShopBtn') && ctx.type === 'shopping') {
      try {
        await apiFetch(`/api/shopping/${encodeURIComponent(ctx.id)}`, { method: 'DELETE' });
        state.shoppingItems = state.shoppingItems.filter((x) => x.id !== ctx.id);
        closeContextDrawer();
        await loadProjects();
        renderCurrentPage();
        if (state.activePage === 'shopping' && state.consolidateOpen) refreshConsolidatePlan();
        showToast('Removed from shopping list');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxUnlinkShopBtn') && ctx.projectId && ctx.projectItemId) {
      try {
        await apiFetch(`/api/projects/${encodeURIComponent(ctx.projectId)}/items/${encodeURIComponent(ctx.projectItemId)}`, {
          method: 'DELETE',
        });
        closeContextDrawer();
        await Promise.all([loadProjects(), loadShopping()]);
        showToast('Unlinked from project');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxSaveProjItemBtn') && ctx.type === 'project_part') {
      try {
        await apiFetch(`/api/projects/${encodeURIComponent(ctx.projectId)}/items/${encodeURIComponent(ctx.projectItemId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quantity_needed: Math.max(1, parseInt(document.getElementById('ctxProjQty').value, 10) || 1),
            variant_id: document.getElementById('ctxProjVariant').value || null,
            project_notes: document.getElementById('ctxProjNotes').value.trim(),
          }),
        });
        await Promise.all([loadProjects(), loadParts()]);
        if (state.contextDrawer) {
          state.contextDrawer.mode = 'view';
          renderContextDrawer();
        }
        showToast('Project part saved');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (e.target.closest('#ctxRemoveProjItemBtn') && ctx.type === 'project_part') {
      try {
        await apiFetch(`/api/projects/${encodeURIComponent(ctx.projectId)}/items/${encodeURIComponent(ctx.projectItemId)}`, {
          method: 'DELETE',
        });
        closeContextDrawer();
        await Promise.all([loadProjects(), loadParts()]);
        showToast('Removed from project');
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  // Project Create / Edit Modal Events
  document.getElementById('closeProjectModalBtn').addEventListener('click', closeProjectModal);
  document.getElementById('cancelProjectModalBtn').addEventListener('click', closeProjectModal);
  document.getElementById('projectModal').addEventListener('click', (e) => {
    if (e.target.id === 'projectModal') closeProjectModal();
  });
  document.getElementById('saveProjectModalBtn').addEventListener('click', saveProjectModal);
  document.getElementById('projectDeleteInitBtn').addEventListener('click', () => {
    document.getElementById('projectDeleteInitBtn').classList.add('hidden');
    const grp = document.getElementById('projectDeleteConfirmGroup');
    grp.classList.remove('hidden');
    grp.classList.add('flex');
  });
  document.getElementById('projectDeleteCancelBtn').addEventListener('click', () => {
    document.getElementById('projectDeleteConfirmGroup').classList.add('hidden');
    document.getElementById('projectDeleteConfirmGroup').classList.remove('flex');
    document.getElementById('projectDeleteInitBtn').classList.remove('hidden');
  });
  document.getElementById('projectDeleteConfirmBtn').addEventListener('click', async () => {
    if (!state.editingProjectId) return;
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(state.editingProjectId)}`, { method: 'DELETE' });
      closeProjectModal();
      await Promise.all([loadProjects(), loadShopping(), loadParts()]);
      showToast('Project deleted');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Project Action Modal Events
  document.getElementById('closeProjectActionModalBtn').addEventListener('click', closeProjectActionModal);
  document.getElementById('cancelProjectActionModalBtn').addEventListener('click', closeProjectActionModal);
  document.getElementById('projectActionModal').addEventListener('click', (e) => {
    if (e.target.id === 'projectActionModal') closeProjectActionModal();
  });
  document.getElementById('saveProjectActionModalBtn').addEventListener('click', saveProjectActionModal);

  // Global Markdown Edit / Preview toggle for all notes panels
  document.addEventListener('click', (e) => {
    const mdBtn = e.target.closest('button[data-md-mode]');
    if (!mdBtn) return;
    const editor = mdBtn.closest('[data-md-editor]');
    if (editor) setMdEditorMode(editor, mdBtn.dataset.mdMode);
  });

  // Browser Back / Forward URL Sync
  window.addEventListener('popstate', () => {
    const route = parseRouteFromLocation();
    switchPage(route.page, { pushState: false, benchSub: route.benchSub });
  });

  // Glossary View delegations & Modal
  document.getElementById('glossaryCategoryStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-gcat]');
    if (!btn) return;
    state.glossaryCategory = btn.dataset.gcat;
    state.glossaryMobileDetail = false;
    renderGlossary();
  });
  document.getElementById('glossaryInInventoryBtn').addEventListener('click', () => {
    state.glossaryInInventoryOnly = !state.glossaryInInventoryOnly;
    state.glossaryMobileDetail = false;
    renderGlossary();
  });
  document.getElementById('glossaryList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-select-glossary]');
    if (!btn) return;
    state.selectedGlossaryId = btn.dataset.selectGlossary;
    state.glossaryMobileDetail = true;
    renderGlossary();
    if (window.matchMedia('(max-width: 1023px)').matches) {
      document.getElementById('glossaryLayout').scrollIntoView({ block: 'start' });
    }
  });
  document.getElementById('glossaryDetailPane').addEventListener('click', (e) => {
    if (e.target.closest('button[data-glossary-back]')) {
      state.glossaryMobileDetail = false;
      renderGlossary();
      const active = document.querySelector('#glossaryList .is-active');
      if (active) active.scrollIntoView({ block: 'center' });
      return;
    }
    const editBtn = e.target.closest('button[data-edit-glossary]');
    if (editBtn) {
      openGlossaryModal(editBtn.dataset.editGlossary);
      return;
    }
    const partBtn = e.target.closest('button[data-open-part]');
    if (partBtn) {
      openDrawer('view', partBtn.dataset.openPart);
    }
  });
  document.getElementById('addGlossaryBtn').addEventListener('click', () => openGlossaryModal(null));
  document.getElementById('closeGlossaryModalBtn').addEventListener('click', closeGlossaryModal);
  document.getElementById('cancelGlossaryModalBtn').addEventListener('click', closeGlossaryModal);
  document.getElementById('glossaryModal').addEventListener('click', (e) => {
    if (e.target.id === 'glossaryModal') closeGlossaryModal();
  });
  document.getElementById('saveGlossaryModalBtn').addEventListener('click', saveGlossaryModal);
  document.getElementById('explainTermAiBtn').addEventListener('click', handleExplainGlossaryAi);
  document.getElementById('glossaryDeleteInitBtn').addEventListener('click', () => {
    document.getElementById('glossaryDeleteInitBtn').classList.add('hidden');
    const grp = document.getElementById('glossaryDeleteConfirmGroup');
    grp.classList.remove('hidden');
    grp.classList.add('flex');
  });
  document.getElementById('glossaryDeleteCancelBtn').addEventListener('click', () => {
    document.getElementById('glossaryDeleteConfirmGroup').classList.add('hidden');
    document.getElementById('glossaryDeleteConfirmGroup').classList.remove('flex');
    document.getElementById('glossaryDeleteInitBtn').classList.remove('hidden');
  });
  document.getElementById('glossaryDeleteConfirmBtn').addEventListener('click', async () => {
    if (!state.editingGlossaryId) return;
    try {
      await apiFetch(`/api/glossary/${encodeURIComponent(state.editingGlossaryId)}`, { method: 'DELETE' });
      state.glossary = state.glossary.filter((x) => x.id !== state.editingGlossaryId);
      closeGlossaryModal();
      renderGlossary();
      showToast('Glossary term deleted');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Inline Glossary Tooltip Popover
  document.getElementById('closeGlossaryPopoverBtn').addEventListener('click', closeGlossaryPopover);
  document.getElementById('glossaryPopover').addEventListener('click', (e) => {
    if (e.target.id === 'glossaryPopover') closeGlossaryPopover();
  });
  document.getElementById('popoverOpenGlossaryBtn').addEventListener('click', () => {
    const g = state.glossary.find((x) => x.id === state.popoverTermId);
    closeGlossaryPopover();
    closeDrawer();
    switchPage('glossary');
    if (g) {
      state.search = g.term;
      searchInput.value = g.term;
      state.selectedGlossaryId = g.id;
      state.glossaryMobileDetail = true;
      syncSearchUi();
      renderGlossary();
    }
  });

  // Tech Specs Editor buttons
  document.getElementById('addSpecRowBtn').addEventListener('click', () => addSpecEditorRow('', ''));
  document.getElementById('specsEditorRows').addEventListener('click', (e) => {
    const rm = e.target.closest('button[data-remove-spec]');
    if (rm) rm.closest('div').remove();
  });

  // Category & Filter Chips
  document.getElementById('categoryStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    state.category = btn.dataset.cat;
    renderGrid();
  });
  document.getElementById('activeLocationPill').addEventListener('click', () => {
    state.locationFilter = '';
    renderGrid();
  });
  document.getElementById('needsPhotoBtn').addEventListener('click', () => {
    state.needsPhotoOnly = !state.needsPhotoOnly;
    renderGrid();
  });
  document.getElementById('inUseBtn').addEventListener('click', () => {
    state.inUseOnly = !state.inUseOnly;
    renderGrid();
  });
  document.getElementById('lowStockBtn').addEventListener('click', () => {
    state.lowStockOnly = !state.lowStockOnly;
    renderGrid();
  });
  document.getElementById('clearAllFiltersBtn').addEventListener('click', () => {
    state.search = '';
    state.category = 'All';
    state.locationFilter = '';
    state.needsPhotoOnly = false;
    state.inUseOnly = false;
    state.lowStockOnly = false;
    searchInput.value = '';
    syncSearchUi();
    renderGrid();
  });

  // Grid / List Interactions
  document.getElementById('partsGrid').addEventListener('click', (e) => {
    const stepBtn = e.target.closest('button[data-step]');
    if (stepBtn) {
      e.stopPropagation();
      handleStepQuantity(stepBtn.dataset.id, parseInt(stepBtn.dataset.step, 10));
      return;
    }
    if (e.target.closest('[data-stepper]')) {
      e.stopPropagation();
      return;
    }
    const binBtn = e.target.closest('button[data-bin]');
    if (binBtn) {
      e.stopPropagation();
      const clickedBin = binBtn.dataset.bin;
      state.locationFilter = state.locationFilter === clickedBin ? '' : clickedBin;
      renderGrid();
      return;
    }
    const card = e.target.closest('article[data-id], tr[data-id]');
    if (card) {
      openDrawer('view', card.dataset.id);
    }
  });

  // Add Part & Unified Drawer Footer Mode Switching
  document.getElementById('addPartBtn').addEventListener('click', () => openDrawer('create'));
  document.getElementById('modeEditBtn').addEventListener('click', () => {
    if (state.activePartId && state.drawerMode !== 'edit') {
      openDrawer('edit', state.activePartId, 'basics');
    }
  });
  document.getElementById('modePreviewBtn').addEventListener('click', () => {
    if (state.activePartId && state.drawerMode !== 'view') {
      openDrawer('view', state.activePartId);
    }
  });
  document.getElementById('closePreviewFooterBtn').addEventListener('click', closeDrawer);
  document.getElementById('cancelCreateBtn').addEventListener('click', closeDrawer);
  document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
  document.getElementById('saveDrawerBtn').addEventListener('click', saveDrawer);

  // Edit Tab Bar
  document.querySelectorAll('button[data-edit-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchEditTab(btn.dataset.editTab));
  });

  // Preview Body Interactive Delegations
  document.getElementById('drawerPreviewBody').addEventListener('click', (e) => {
    const tabBtn = e.target.closest('button[data-preview-tab]');
    if (tabBtn) {
      state.activePreviewTab = tabBtn.dataset.previewTab;
      const part = state.parts.find((p) => p.id === state.activePartId);
      if (part) renderDrawerPreview(part);
      return;
    }
    const peekBtn = e.target.closest('button[data-glossary-peek]');
    if (peekBtn) {
      openGlossaryPopover(peekBtn.dataset.glossaryPeek);
      return;
    }
    const lightboxTarget = e.target.closest('[data-lightbox-src]');
    if (lightboxTarget) {
      openLightbox(lightboxTarget.dataset.lightboxSrc);
      return;
    }
    const stepBtn = e.target.closest('button[data-preview-step]');
    if (stepBtn) {
      handleStepQuantity(stepBtn.dataset.id, parseInt(stepBtn.dataset.previewStep, 10));
      return;
    }
    const binBtn = e.target.closest('button[data-preview-bin]');
    if (binBtn) {
      state.locationFilter = binBtn.dataset.previewBin;
      switchPage('inventory');
      closeDrawer();
      return;
    }
    if (e.target.closest('button[data-action="add-photo"]')) {
      if (state.activePartId) openDrawer('edit', state.activePartId, 'media');
      return;
    }
    if (e.target.closest('button[data-action="edit-specs"]')) {
      if (state.activePartId) openDrawer('edit', state.activePartId, 'specs');
      return;
    }
    if (e.target.closest('button[data-action="edit-details"]')) {
      if (state.activePartId) openDrawer('edit', state.activePartId, 'details');
    }
  });

  // Live form updates
  document.getElementById('fName').addEventListener('input', syncGoogleImagesLink);
  document.getElementById('fWarning').addEventListener('input', (e) => updateWarningCallout(e.target.value));
  document.getElementById('fSourceUrl').addEventListener('input', () => syncExternalLink('fSourceUrl', 'openSourceUrlLink'));
  document.getElementById('fPinoutUrl').addEventListener('input', () => syncExternalLink('fPinoutUrl', 'openPinoutUrlLink'));

  // Lightbox triggers inside Edit Media tab
  document.getElementById('drawerPhotoFrame').addEventListener('click', (e) => {
    const img = e.target.closest('img[data-lightbox-src]');
    if (img) openLightbox(img.dataset.lightboxSrc);
  });
  document.getElementById('drawerPinoutFrame').addEventListener('click', (e) => {
    const img = e.target.closest('img[data-lightbox-src]');
    if (img) openLightbox(img.dataset.lightboxSrc);
  });
  document.getElementById('closeLightboxBtn').addEventListener('click', closeLightbox);
  document.getElementById('lightboxModal').addEventListener('click', (e) => {
    if (e.target.id === 'lightboxModal') closeLightbox();
  });

  // Photo Uploads, Paste, Scrape, Autofill, Picker
  document.getElementById('photoFileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleImageFileSelected(e.target.files[0], 'main');
      e.target.value = '';
    }
  });
  document.getElementById('pinoutFileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleImageFileSelected(e.target.files[0], 'pinout');
      e.target.value = '';
    }
  });
  document.getElementById('pinoutPasteToggleBtn').addEventListener('click', () => {
    state.pinoutPasteTarget = !state.pinoutPasteTarget;
    syncPinoutPasteBtn();
  });
  document.addEventListener('paste', (e) => {
    if (state.drawerMode !== 'edit' && state.drawerMode !== 'create') return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const slot = state.pinoutPasteTarget ? 'pinout' : 'main';
        handleImageFileSelected(item.getAsFile(), slot);
        return;
      }
    }
  });
  document.getElementById('fetchUrlBtn').addEventListener('click', handleFetchUrl);
  document.getElementById('photoUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFetchUrl();
    }
  });
  document.getElementById('smartAutofillBtn').addEventListener('click', handleSmartAutofill);
  document.getElementById('dismissImagePickerBtn').addEventListener('click', () => {
    state.imageCandidates = [];
    renderImagePicker();
  });
  document.getElementById('imagePickerGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pick-url]');
    if (!btn) return;
    handlePickCandidateImage(btn.dataset.pickUrl, btn.dataset.pickSlot || 'main');
  });
  document.getElementById('removePhotoBtn').addEventListener('click', () => handleRemovePhoto('main'));
  document.getElementById('removePinoutBtn').addEventListener('click', () => handleRemovePhoto('pinout'));

  // Generic inline destructive confirmation (swaps trigger button -> Confirm / Cancel in place)
  document.addEventListener('click', (e) => {
    const initBtn = e.target.closest('[data-confirm-init]');
    if (initBtn) {
      const wrap = initBtn.closest('[data-inline-confirm]');
      if (wrap) {
        e.stopPropagation();
        openInlineConfirm(wrap);
      }
      return;
    }
    const cancelBtn = e.target.closest('[data-confirm-cancel]');
    if (cancelBtn) {
      const wrap = cancelBtn.closest('[data-inline-confirm]');
      if (wrap) {
        e.stopPropagation();
        resetInlineConfirm(wrap);
      }
      return;
    }
    if (!e.target.closest('[data-inline-confirm]')) {
      resetAllInlineConfirms();
    }
  });

  // Inline Delete Confirmation
  document.getElementById('deleteInitBtn').addEventListener('click', () => {
    document.getElementById('deleteInitBtn').classList.add('hidden');
    const grp = document.getElementById('deleteConfirmGroup');
    grp.classList.remove('hidden');
    grp.classList.add('flex');
  });
  document.getElementById('deleteCancelBtn').addEventListener('click', () => {
    document.getElementById('deleteConfirmGroup').classList.add('hidden');
    document.getElementById('deleteConfirmGroup').classList.remove('flex');
    document.getElementById('deleteInitBtn').classList.remove('hidden');
  });
  document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
    if (!state.activePartId) return;
    try {
      await apiFetch(`/api/parts/${encodeURIComponent(state.activePartId)}`, { method: 'DELETE' });
      state.parts = state.parts.filter((p) => p.id !== state.activePartId);
      closeDrawer();
      await loadProjects();
      updateNavBadges();
      renderCurrentPage();
      showToast('Part deleted');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    const anyModalOpen = [
      'settingsModal',
      'projectModal',
      'projectActionModal',
      'glossaryModal',
      'lightboxModal',
      'restoreModal',
      'glossaryPopover',
    ].some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });

    if (e.key === '/' && !isTyping && !state.drawerMode && !state.contextDrawer && !anyModalOpen) {
      e.preventDefault();
      searchInput.focus();
      return;
    }

    if ((e.key === 'e' || e.key === 'E') && !isTyping && state.drawerMode === 'view' && state.activePartId) {
      e.preventDefault();
      openDrawer('edit', state.activePartId, 'basics');
      return;
    }
    if ((e.key === 'e' || e.key === 'E') && !isTyping && state.contextDrawer && state.contextDrawer.mode === 'view') {
      e.preventDefault();
      setContextDrawerMode('edit');
      return;
    }

    if (e.key === 'Escape') {
      if (document.querySelector('[data-inline-confirm].is-confirming')) {
        resetAllInlineConfirms();
        return;
      }
      if (!document.getElementById('glossaryPopover').classList.contains('hidden')) {
        closeGlossaryPopover();
        return;
      }
      if (!document.getElementById('glossaryModal').classList.contains('hidden')) {
        closeGlossaryModal();
        return;
      }
      if (!document.getElementById('lightboxModal').classList.contains('hidden')) {
        closeLightbox();
        return;
      }
      if (!document.getElementById('restoreModal').classList.contains('hidden')) {
        state.pendingRestoreFile = null;
        document.getElementById('restoreModal').classList.add('hidden');
        return;
      }
      if (!document.getElementById('settingsModal').classList.contains('hidden')) {
        closeSettingsModal();
        return;
      }
      if (!document.getElementById('projectActionModal').classList.contains('hidden')) {
        closeProjectActionModal();
        return;
      }
      if (!document.getElementById('projectModal').classList.contains('hidden')) {
        closeProjectModal();
        return;
      }
      if (state.contextDrawer) {
        closeContextDrawer();
        return;
      }
      if (state.drawerMode) {
        closeDrawer();
      } else if (document.activeElement === searchInput || state.search) {
        state.search = '';
        searchInput.value = '';
        syncSearchUi();
        renderCurrentPage();
        searchInput.blur();
      }
    }
  });
}

// Popups fit the visible part of the screen. On a phone, the on-screen
// keyboard covers the bottom of the window. Without this, it hides the Save
// button of a bottom sheet, and the browser pushes the close button off the top.
// styles.css reads --vv-top and --vv-h (see .pb-overlay and #drawerRoot).
function trackVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const rootStyle = document.documentElement.style;
  let frame = 0;
  let resized = false;
  const apply = () => {
    frame = 0;
    rootStyle.setProperty('--vv-top', `${Math.max(0, vv.offsetTop)}px`);
    rootStyle.setProperty('--vv-h', `${vv.height}px`);
    // Keep the field the user types in visible inside the popup's scroll area.
    // Only after a resize (the keyboard opened), not on every scroll.
    const active = document.activeElement;
    if (resized && active && active.matches('input, textarea, select') && active.closest('[role="dialog"]')) {
      active.scrollIntoView({ block: 'nearest' });
    }
    resized = false;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', () => {
    resized = true;
    schedule();
  });
  vv.addEventListener('scroll', schedule);
  apply();
}

// No zoom on phones. iOS Safari ignores user-scalable=no in the viewport
// meta, so pinch gestures are stopped here (gesture* events exist only there).
function blockPinchZoom() {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
}

// Boot
window.addEventListener('DOMContentLoaded', async () => {
  trackVisibleViewport();
  blockPinchZoom();
  renderBrand();
  loadCachedTheme();
  const binParam = new URLSearchParams(window.location.search).get('bin');
  if (binParam && binParam.trim()) {
    state.locationFilter = binParam.trim();
  }
  bindEvents();
  const shopAddPanel = document.getElementById('shopAddPanel');
  const phoneQuery = window.matchMedia('(max-width: 639px)');
  const syncShopAddPanel = () => {
    shopAddPanel.open = !phoneQuery.matches;
  };
  syncShopAddPanel();
  phoneQuery.addEventListener('change', syncShopAddPanel);
  const initialRoute = parseRouteFromLocation();
  switchPage(initialRoute.page, { pushState: false, benchSub: initialRoute.benchSub });
  await Promise.all([loadConfig(), loadParts(), loadProjects(), loadGlossary(), loadShopping()]);
});
