'use strict';

const THEME_KEY = 'pinbin_theme_v1';
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
  glossary: [],
  shoppingItems: [],
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
}

function saveUiSettings(patch) {
  Object.assign(state.uiSettings, patch);
  if (patch.theme) applyTheme(patch.theme);
  syncSettingsModalUi();
  const keys = Object.keys(patch);
  if (!(keys.length === 1 && keys[0] === 'theme')) {
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
      syncSettingsModalUi();
    })
    .catch((err) => {
      showToast(err.message);
    });
}

function syncSettingsModalUi() {
  const { theme, view_mode, sort_by, inline_tooltips, show_caution_badge } = state.uiSettings;

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
    state.shoppingItems = await apiFetch('/api/shopping');
    updateNavBadges();
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
      <td class="min-w-0">
        <div class="pb-part-name !text-[15px] truncate max-w-[42ch]">${escapeHTML(p.name)}</div>
        <div class="text-[13px] text-muted truncate max-w-[52ch]">${escapeHTML(p.subtitle || '')}</div>
      </td>
      <td class="hidden md:table-cell text-[13px] text-ink-2 whitespace-nowrap">${escapeHTML(p.category)}</td>
      <td>${p.location ? binTag(p.location) : '<span class="text-muted">&ndash;</span>'}</td>
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
    container.className = 'overflow-x-auto';
    container.innerHTML = `
      <table class="pb-table">
        <thead><tr>
          <th class="w-14"><span class="sr-only">Photo</span></th>
          <th>Part</th>
          <th class="hidden md:table-cell">Category</th>
          <th>Bin</th>
          <th class="hidden lg:table-cell">Status</th>
          <th class="text-right">Quantity</th>
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
  const activeProjects = new Set(
    state.parts.map((p) => (p.in_use_project || '').trim()).filter(Boolean)
  );
  const pBadge = document.getElementById('navProjectsCount');
  if (pBadge) {
    if (activeProjects.size > 0) {
      pBadge.textContent = activeProjects.size;
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

function switchPage(page) {
  state.activePage = page;
  document.getElementById('inventoryView').classList.toggle('hidden', page !== 'inventory');
  document.getElementById('inventoryFilterBar').classList.toggle('hidden', page !== 'inventory');
  document.getElementById('projectsView').classList.toggle('hidden', page !== 'projects');
  document.getElementById('shoppingView').classList.toggle('hidden', page !== 'shopping');
  document.getElementById('glossaryView').classList.toggle('hidden', page !== 'glossary');
  document.getElementById('benchView').classList.toggle('hidden', page !== 'bench');

  document.querySelectorAll('button[data-page]').forEach((btn) => {
    const isAct = btn.dataset.page === page;
    btn.classList.toggle('pb-tab-active', isAct);
  });

  const searchInput = document.getElementById('searchInput');
  if (page === 'glossary') {
    searchInput.placeholder = 'Search the glossary';
  } else if (page === 'projects') {
    searchInput.placeholder = 'Search projects';
  } else if (page === 'shopping') {
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

function renderShopping() {
  const q = state.search.trim().toLowerCase();
  const wishGrid = document.getElementById('shoppingWishlistGrid');
  const wishEmpty = document.getElementById('shoppingWishlistEmpty');
  const lowGrid = document.getElementById('shoppingLowStockGrid');
  const lowEmpty = document.getElementById('shoppingLowStockEmpty');

  const smallThumb = (path, cat) =>
    path
      ? `<img src="${escapeHTML(imageUrl(path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" />`
      : categoryGlyph(cat, 'w-5 h-5 text-muted opacity-60');

  const wishItems = state.shoppingItems.filter((it) => !q || `${it.name} ${it.notes} ${it.price}`.toLowerCase().includes(q));
  if (wishItems.length === 0) {
    wishGrid.innerHTML = '';
    wishEmpty.classList.remove('hidden');
  } else {
    wishEmpty.classList.add('hidden');
    wishGrid.innerHTML = wishItems
      .map((it) => {
        let host = '';
        if (it.url && /^https?:\/\//i.test(it.url)) {
          try {
            host = new URL(it.url).hostname.replace(/^www\./, '');
          } catch (_) {}
        }
        return `
          <div class="elevated-card rounded-md p-3 flex flex-wrap items-center gap-3">
            <div class="pb-well w-12 h-12 rounded flex items-center justify-center overflow-hidden shrink-0">${smallThumb(it.image_path)}</div>
            <div class="min-w-[11rem] flex-1">
              <div class="pb-part-name !text-[15px] truncate">${escapeHTML(it.name)}</div>
              <div class="text-[13px] text-muted flex items-center gap-2 min-w-0">
                ${it.price ? `<span class="font-semibold text-ink">${escapeHTML(it.price)}</span>` : ''}
                ${host ? `<a href="${escapeHTML(it.url)}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline truncate">${escapeHTML(host)}</a>` : ''}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <div class="pb-stepper">
                <button type="button" data-shop-step="-1" data-shop-id="${escapeHTML(it.id)}" class="w-7 h-7 text-sm" aria-label="Buy one less">&minus;</button>
                <span class="min-w-[28px] text-center text-sm font-semibold">${it.quantity}</span>
                <button type="button" data-shop-step="1" data-shop-id="${escapeHTML(it.id)}" class="w-7 h-7 text-sm" aria-label="Buy one more">+</button>
              </div>
              <button type="button" data-shop-bought="${escapeHTML(it.id)}" class="btn-primary h-8 px-3 text-[13px]" title="Add this to your inventory">Bought</button>
              <button type="button" data-shop-del="${escapeHTML(it.id)}" class="btn-icon h-8 w-8 flex items-center justify-center" title="Remove from list" aria-label="Remove from list">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
        `;
      })
      .join('');
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

function renderProjects() {
  const grid = document.getElementById('projectsGrid');
  const empty = document.getElementById('projectsEmptyState');
  const q = state.search.trim().toLowerCase();

  const grouped = new Map();
  for (const p of state.parts) {
    const proj = (p.in_use_project || '').trim();
    if (!proj) continue;
    if (!grouped.has(proj)) grouped.set(proj, []);
    grouped.get(proj).push(p);
  }

  let entries = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (q) {
    entries = entries.filter(([name, parts]) => {
      if (name.toLowerCase().includes(q)) return true;
      return parts.some((p) => (p.name || '').toLowerCase().includes(q));
    });
  }

  if (entries.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = entries
    .map(([projName, parts]) => {
      const partRows = parts
        .map((p) => {
          const thumb = p.image_path
            ? `<img src="${escapeHTML(imageUrl(p.image_path))}" alt="" class="w-full h-full object-contain p-0.5 bg-white" />`
            : categoryGlyph(p.category, 'w-4 h-4 text-muted opacity-60');
          return `
            <button type="button" data-open-part="${escapeHTML(p.id)}" class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-ink/[0.035] transition-colors">
              <div class="pb-well w-9 h-9 rounded flex items-center justify-center overflow-hidden shrink-0">${thumb}</div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium truncate">${escapeHTML(p.name)}</p>
              </div>
              ${p.location ? `<span class="pb-bin-tag !h-5 !text-[12px] shrink-0">${escapeHTML(p.location)}</span>` : ''}
              <span class="text-sm font-semibold w-10 text-right shrink-0">${p.quantity}</span>
            </button>
          `;
        })
        .join('');

      const total = parts.reduce((n, p) => n + Number(p.quantity || 0), 0);
      return `
        <div class="elevated-card rounded-md overflow-hidden flex flex-col">
          <div class="px-4 py-3.5 flex items-start justify-between gap-3 border-b border-line">
            <div class="min-w-0">
              <h2 class="pb-display text-xl flex items-center gap-2.5"><span class="pb-status is-go"></span><span class="truncate">${escapeHTML(projName)}</span></h2>
              <p class="text-[13px] text-muted mt-0.5">${parts.length} ${parts.length === 1 ? 'part' : 'parts'}, ${total} pieces</p>
            </div>
            <div class="flex items-center gap-1.5 shrink-0" data-teardown-wrap>
              <button type="button" data-teardown-init class="btn-secondary h-8 px-3 text-[13px]">Tear down</button>
              <div data-teardown-confirm class="hidden items-center gap-1.5">
                <button type="button" data-teardown-do="${escapeHTML(projName)}" class="btn-danger h-8 px-3 text-[13px]">Put parts back</button>
                <button type="button" data-teardown-cancel class="btn-secondary h-8 px-3 text-[13px]">Cancel</button>
              </div>
            </div>
          </div>
          <div class="divide-y divide-[var(--pb-divider)]">${partRows}</div>
        </div>
      `;
    })
    .join('');
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

  detailEl.innerHTML = `
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
  const re = new RegExp(`\\b(${escapedTerms.join('|')})\\b`, 'gi');
  const seen = new Set();

  return safe.replace(re, (match) => {
    const low = match.toLowerCase();
    const hit = termMatchers.find((m) => m.label.toLowerCase() === low);
    if (!hit || seen.has(hit.id)) return match;
    seen.add(hit.id);
    return `<button type="button" data-glossary-peek="${escapeHTML(hit.id)}" class="pb-term">${match}</button>`;
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
    <button type="button" data-remove-spec class="h-8 w-7 rounded-md text-muted hover:text-red-500 flex items-center justify-center shrink-0" aria-label="Remove spec">&times;</button>
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

function renderDrawerPhoto() {
  const frame = document.getElementById('drawerPhotoFrame');
  const removeBtn = document.getElementById('removePhotoBtn');

  if (state.draftImagePath) {
    const src = imageUrl(state.draftImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Part photo" class="w-full h-full object-contain p-3 bg-white cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeBtn.classList.remove('hidden');
  } else {
    frame.innerHTML = `
      <div class="text-center px-4 text-muted">
        ${categoryGlyph(document.getElementById('fCategory').value, 'w-10 h-10 mx-auto mb-2 opacity-50')}
        <p class="text-[13px]">No photo. Upload one, or paste with Ctrl+V.</p>
      </div>
    `;
    removeBtn.classList.add('hidden');
  }
}

function renderDrawerPinout() {
  const frame = document.getElementById('drawerPinoutFrame');
  const removeBtn = document.getElementById('removePinoutBtn');

  if (state.draftPinoutImagePath) {
    const src = imageUrl(state.draftPinoutImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Pinout diagram" class="w-full h-full object-contain p-2.5 bg-white cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeBtn.classList.remove('hidden');
  } else {
    frame.innerHTML = `<span class="text-[13px] text-muted text-center px-4">No pinout diagram</span>`;
    removeBtn.classList.add('hidden');
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
    ? `<p class="text-[15px] leading-[1.6] whitespace-pre-line">${renderWithGlossaryTooltips(part.notes)}</p>`
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
      document.getElementById('fSourceUrl').value = part.source_url || '';
      document.getElementById('fPinoutUrl').value = part.pinout_url || '';

      state.draftImagePath = part.image_path || '';
      state.draftPinoutImagePath = part.pinout_image_path || '';
      populateSpecsEditor(part.specs || {});
      updateWarningCallout(part.warning);
    } else {
      document.getElementById('drawerHeading').textContent = 'New part';

      document.getElementById('partForm').reset();
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
    await Promise.all([loadConfig(), loadParts()]);
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
        }),
      });
      state.shoppingItems.unshift(created);
      urlInput.value = '';
      status.classList.add('hidden');
      updateNavBadges();
      renderShopping();
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
        }),
      });
      state.shoppingItems.unshift(created);
      nameEl.value = '';
      document.getElementById('shopManualPrice').value = '';
      document.getElementById('shopManualQty').value = 1;
      updateNavBadges();
      renderShopping();
      showToast('Added to shopping list');
    } catch (err) {
      showToast(err.message);
    }
  });

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
    const stepBtn = e.target.closest('button[data-shop-step]');
    if (stepBtn) {
      const id = stepBtn.dataset.shopId;
      const item = state.shoppingItems.find((x) => x.id === id);
      if (!item) return;
      const next = Math.max(1, Number(item.quantity || 1) + parseInt(stepBtn.dataset.shopStep, 10));
      const updated = await apiFetch(`/api/shopping/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: next }),
      });
      Object.assign(item, updated);
      renderShopping();
      return;
    }
    const boughtBtn = e.target.closest('button[data-shop-bought]');
    if (boughtBtn) {
      const id = boughtBtn.dataset.shopBought;
      try {
        const newPart = await apiFetch(`/api/shopping/${encodeURIComponent(id)}/move-to-inventory`, { method: 'POST' });
        state.shoppingItems = state.shoppingItems.filter((x) => x.id !== id);
        state.parts.unshift(newPart);
        updateNavBadges();
        renderShopping();
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
        updateNavBadges();
        renderShopping();
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
    hint.classList.toggle('hidden', hasText);
  }

  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
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
  document.getElementById('projectsGrid').addEventListener('click', async (e) => {
    const openBtn = e.target.closest('button[data-open-part]');
    if (openBtn) {
      openDrawer('view', openBtn.dataset.openPart);
      return;
    }
    const initBtn = e.target.closest('button[data-teardown-init]');
    if (initBtn) {
      const wrap = initBtn.closest('[data-teardown-wrap]');
      initBtn.classList.add('hidden');
      const grp = wrap.querySelector('[data-teardown-confirm]');
      grp.classList.remove('hidden');
      grp.classList.add('flex');
      return;
    }
    const cancelBtn = e.target.closest('button[data-teardown-cancel]');
    if (cancelBtn) {
      const wrap = cancelBtn.closest('[data-teardown-wrap]');
      const grp = wrap.querySelector('[data-teardown-confirm]');
      grp.classList.add('hidden');
      grp.classList.remove('flex');
      wrap.querySelector('[data-teardown-init]').classList.remove('hidden');
      return;
    }
    const doBtn = e.target.closest('button[data-teardown-do]');
    if (doBtn) {
      const proj = doBtn.dataset.teardownDo;
      try {
        const res = await apiFetch('/api/projects/teardown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: proj }),
        });
        await loadParts();
        showToast(`Returned ${res.parts_returned} part${res.parts_returned === 1 ? '' : 's'} to bins`);
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  // Glossary View delegations & Modal
  document.getElementById('glossaryCategoryStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-gcat]');
    if (!btn) return;
    state.glossaryCategory = btn.dataset.gcat;
    renderGlossary();
  });
  document.getElementById('glossaryInInventoryBtn').addEventListener('click', () => {
    state.glossaryInInventoryOnly = !state.glossaryInInventoryOnly;
    renderGlossary();
  });
  document.getElementById('glossaryList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-select-glossary]');
    if (!btn) return;
    state.selectedGlossaryId = btn.dataset.selectGlossary;
    renderGlossary();
  });
  document.getElementById('glossaryDetailPane').addEventListener('click', (e) => {
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
      renderGrid();
      closeDrawer();
      showToast('Part deleted');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === '/' && !isTyping && !state.drawerMode && document.getElementById('settingsModal').classList.contains('hidden')) {
      e.preventDefault();
      searchInput.focus();
      return;
    }

    if ((e.key === 'e' || e.key === 'E') && !isTyping && state.drawerMode === 'view' && state.activePartId) {
      e.preventDefault();
      openDrawer('edit', state.activePartId, 'basics');
      return;
    }

    if (e.key === 'Escape') {
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
      if (state.drawerMode) {
        closeDrawer();
      } else if (document.activeElement === searchInput || state.search) {
        state.search = '';
        searchInput.value = '';
        syncSearchUi();
        renderGrid();
        searchInput.blur();
      }
    }
  });
}

// Boot
window.addEventListener('DOMContentLoaded', async () => {
  loadCachedTheme();
  const binParam = new URLSearchParams(window.location.search).get('bin');
  if (binParam && binParam.trim()) {
    state.locationFilter = binParam.trim();
  }
  bindEvents();
  switchPage('inventory');
  await Promise.all([loadConfig(), loadParts(), loadGlossary(), loadShopping()]);
});
