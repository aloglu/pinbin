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
  categories: ['All', ...DEFAULT_CATEGORIES],
  config: {
    ai_enabled: false,
    ai_remaining_today: 0,
    local_dev_mode: false,
  },
  search: '',
  category: 'All',
  locationFilter: '',
  needsPhotoOnly: false,
  inUseOnly: false,
  lowStockOnly: false,

  drawerMode: null, // 'view' | 'edit' | 'create' | null
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
// DATA LOADING
// =============================================================================
async function loadConfig() {
  try {
    const cfg = await apiFetch('/api/config');
    state.config = cfg;
    if (Array.isArray(cfg.categories) && cfg.categories.length > 0) {
      state.categories = ['All', ...cfg.categories];
    }
    syncAiUi();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadParts() {
  try {
    state.parts = await apiFetch('/api/parts');
    renderGrid();
  } catch (err) {
    showToast(err.message);
  }
}

function syncAiUi() {
  const btn = document.getElementById('smartAutofillBtn');
  if (state.config.ai_enabled) {
    btn.classList.remove('hidden');
    btn.title = `Smart Autofill (${state.config.ai_remaining_today} left today)`;
  } else {
    btn.classList.add('hidden');
  }
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  } catch (_) {}
}

// =============================================================================
// FILTERING & RENDERING
// =============================================================================
function getFilteredParts() {
  const q = state.search.trim().toLowerCase();
  const loc = state.locationFilter.trim().toLowerCase();

  return state.parts.filter((p) => {
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
}

function styleToggleChip(btn, active) {
  btn.setAttribute('aria-pressed', String(active));
  if (active) {
    btn.classList.add('border-accent', 'text-accent', 'dark:text-blue-400', 'bg-blue-500/[0.08]');
    btn.classList.remove(
      'border-hairline-light',
      'dark:border-hairline-dark',
      'bg-surface-light',
      'dark:bg-surface-dark',
      'text-[#5F6672]',
      'dark:text-[#9CA3AF]'
    );
  } else {
    btn.classList.remove('border-accent', 'text-accent', 'dark:text-blue-400', 'bg-blue-500/[0.08]');
    btn.classList.add(
      'border-hairline-light',
      'dark:border-hairline-dark',
      'bg-surface-light',
      'dark:bg-surface-dark',
      'text-[#5F6672]',
      'dark:text-[#9CA3AF]'
    );
  }
}

function renderFilterStrip() {
  const strip = document.getElementById('categoryStrip');
  strip.innerHTML = state.categories
    .map((cat) => {
      const active = state.category === cat;
      const cls = active
        ? 'bg-[#111318] text-white dark:bg-[#E6E8EC] dark:text-[#0F1115] border-transparent'
        : 'bg-transparent text-[#5F6672] dark:text-[#8B92A0] border-transparent hover:text-[#111318] dark:hover:text-[#E6E8EC] hover:bg-matte-light dark:hover:bg-[#1C2029]';
      return `<button type="button" data-cat="${escapeHTML(cat)}" class="h-7 px-2.5 rounded-md border text-xs font-medium whitespace-nowrap transition-colors ${cls}">${escapeHTML(cat)}</button>`;
    })
    .join('');

  // Active bin pill
  const locPill = document.getElementById('activeLocationPill');
  if (state.locationFilter) {
    document.getElementById('activeLocationLabel').textContent = `Bin: ${state.locationFilter}`;
    locPill.classList.remove('hidden');
  } else {
    locPill.classList.add('hidden');
  }

  // Counts
  const needsPhotoCount = state.parts.filter((p) => !p.image_path).length;
  const inUseCount = state.parts.filter((p) => p.in_use_project && p.in_use_project.trim()).length;
  const lowStockCount = state.parts.filter((p) => isLowStock(p)).length;

  document.getElementById('totalCountBadge').textContent = state.parts.length;
  document.getElementById('needsPhotoCount').textContent = needsPhotoCount;
  document.getElementById('inUseCount').textContent = inUseCount;
  document.getElementById('lowStockCount').textContent = lowStockCount;

  styleToggleChip(document.getElementById('needsPhotoBtn'), state.needsPhotoOnly);
  styleToggleChip(document.getElementById('inUseBtn'), state.inUseOnly);
  styleToggleChip(document.getElementById('lowStockBtn'), state.lowStockOnly);
}

function renderGrid() {
  const grid = document.getElementById('partsGrid');
  const empty = document.getElementById('emptyState');
  const items = getFilteredParts();

  renderFilterStrip();

  if (items.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = items
    .map((p) => {
      const hasImg = Boolean(p.image_path);
      const mediaHtml = hasImg
        ? `<img src="${escapeHTML(imageUrl(p.image_path))}" alt="${escapeHTML(p.name)}" class="w-full h-full object-contain p-3 transition-transform duration-200 group-hover:scale-[1.02]" loading="lazy" />`
        : `
          <div class="flex flex-col items-center justify-center text-center px-4 text-[#8A919E] dark:text-[#666E7D] group-hover:text-[#5F6672] dark:group-hover:text-[#9CA3AF] transition-colors">
            <svg class="w-5 h-5 mb-1.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
              <circle cx="12" cy="13" r="3"/>
            </svg>
            <span class="text-[11px] font-medium">No photo yet</span>
          </div>
        `;

      const low = isLowStock(p);

      return `
        <article
          data-id="${escapeHTML(p.id)}"
          class="group bg-surface-light dark:bg-surface-dark border border-hairline-light dark:border-hairline-dark hover:border-[#C5CAD3] dark:hover:border-[#3A404F] rounded-xl overflow-hidden flex flex-col cursor-pointer transition-colors"
        >
          <!-- Top 4:3 Matte Photo Area -->
          <div class="relative aspect-[4/3] w-full bg-matte-light dark:bg-matte-dark border-b border-hairline-light dark:border-hairline-dark flex items-center justify-center overflow-hidden">
            ${mediaHtml}

            <!-- Top-left Warning Overlay -->
            ${
              p.warning
                ? `<span class="absolute top-2.5 left-2.5 h-5 px-1.5 rounded bg-surface-light/90 dark:bg-surface-dark/90 border border-amber-500/30 text-[10px] font-medium text-amber-700 dark:text-amber-400 inline-flex items-center gap-1" title="${escapeHTML(p.warning)}">
                     <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                     Caution
                   </span>`
                : ''
            }

            <!-- Top-right In Use Overlay -->
            ${
              p.in_use_project
                ? `<span class="absolute top-2.5 right-2.5 max-w-[60%] truncate h-5 px-1.5 rounded bg-surface-light/90 dark:bg-surface-dark/90 border border-emerald-500/30 text-[10px] font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1" title="In use: ${escapeHTML(p.in_use_project)}">
                     <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                     <span class="truncate">In use: ${escapeHTML(p.in_use_project)}</span>
                   </span>`
                : ''
            }

            <!-- Bottom-right Low Stock Badge -->
            ${
              low
                ? `<span class="absolute bottom-2 right-2 h-5 px-1.5 rounded bg-amber-500/15 border border-amber-500/35 text-[10px] font-mono font-medium text-amber-700 dark:text-amber-300">Low stock</span>`
                : ''
            }
          </div>

          <!-- Middle: Name + Subtitle + Clickable Bin Tag -->
          <div class="p-3.5 flex-1 flex flex-col">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h3 class="text-sm font-medium leading-snug line-clamp-2 text-[#111318] dark:text-[#E6E8EC]">
                  ${escapeHTML(p.name)}
                </h3>
                <p class="text-xs text-[#6B7280] dark:text-[#7A8291] truncate mt-0.5">
                  ${escapeHTML(p.subtitle || p.category)}
                </p>
              </div>
              ${
                p.location
                  ? `<button
                       type="button"
                       data-bin="${escapeHTML(p.location)}"
                       title="Filter by bin ${escapeHTML(p.location)}"
                       class="shrink-0 font-mono text-[11px] px-1.5 py-0.5 rounded bg-matte-light dark:bg-[#20242E] border border-hairline-light dark:border-hairline-dark text-[#4B5563] dark:text-[#9CA3AF] hover:border-accent hover:text-accent dark:hover:text-blue-400 transition-colors"
                     >${escapeHTML(p.location)}</button>`
                  : ''
              }
            </div>

            <!-- Footer: 1-line Visual Tell + Inline Qty Stepper -->
            <div class="mt-auto pt-3 mt-3 border-t border-hairline-light/70 dark:border-hairline-dark/70 flex items-center justify-between gap-2">
              <p class="text-[11px] text-[#6B7280] dark:text-[#8B92A0] truncate" title="${escapeHTML(p.visual_tell)}">
                ${escapeHTML(p.visual_tell || 'Add a 1-line physical clue...')}
              </p>

              <div class="shrink-0 inline-flex items-center rounded-md border border-hairline-light dark:border-hairline-dark bg-canvas-light dark:bg-canvas-dark" data-stepper>
                <button
                  type="button"
                  data-step="-1"
                  data-id="${escapeHTML(p.id)}"
                  class="w-6 h-6 flex items-center justify-center text-xs text-[#6B7280] hover:text-[#111318] dark:hover:text-white transition-colors"
                  aria-label="Decrease quantity"
                >&minus;</button>
                <span id="qty-${escapeHTML(p.id)}" class="min-w-[24px] text-center font-mono text-xs font-medium ${low ? 'text-amber-600 dark:text-amber-400' : 'text-[#111318] dark:text-[#E6E8EC]'}">${p.quantity}</span>
                <button
                  type="button"
                  data-step="1"
                  data-id="${escapeHTML(p.id)}"
                  class="w-6 h-6 flex items-center justify-center text-xs text-[#6B7280] hover:text-[#111318] dark:hover:text-white transition-colors"
                  aria-label="Increase quantity"
                >+</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function refreshLocationDatalist() {
  const locs = [...new Set(state.parts.map((p) => (p.location || '').trim()).filter(Boolean))].sort();
  document.getElementById('locationSuggestions').innerHTML = locs
    .map((l) => `<option value="${escapeHTML(l)}"></option>`)
    .join('');
}

// =============================================================================
// LIGHTBOX
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

// =============================================================================
// DRAWER (EDIT & CREATE)
// =============================================================================
function renderDrawerPhoto() {
  const frame = document.getElementById('drawerPhotoFrame');
  const removeBtn = document.getElementById('removePhotoBtn');

  if (state.draftImagePath) {
    const src = imageUrl(state.draftImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Part preview" class="w-full h-full object-contain p-3 cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeBtn.classList.remove('hidden');
  } else {
    frame.innerHTML = `
      <div class="text-center px-6 text-[#8A919E] dark:text-[#666E7D]">
        <svg class="w-6 h-6 mx-auto mb-1.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
          <circle cx="12" cy="13" r="3"/>
        </svg>
        <p class="text-xs font-medium">No photo attached</p>
        <p class="text-[11px] opacity-80 mt-0.5">Upload, snap on phone, paste with Ctrl+V, or fetch a URL</p>
      </div>
    `;
    removeBtn.classList.add('hidden');
  }
}

function renderDrawerPinout() {
  const frame = document.getElementById('drawerPinoutFrame');
  const removeBtn = document.getElementById('removePinoutBtn');
  const badge = document.getElementById('pinoutBadge');

  if (state.draftPinoutImagePath) {
    const src = imageUrl(state.draftPinoutImagePath);
    frame.innerHTML = `<img src="${escapeHTML(src)}" alt="Pinout diagram" class="w-full h-full object-contain p-2 cursor-zoom-in" data-lightbox-src="${escapeHTML(src)}" />`;
    removeBtn.classList.remove('hidden');
    badge.textContent = 'Attached (click to zoom)';
  } else {
    frame.innerHTML = `
      <div class="text-center px-4 text-[#8A919E] dark:text-[#666E7D]">
        <p class="text-[11px] font-medium">No pinout image yet</p>
        <p class="text-[10px] opacity-80 mt-0.5">Upload a wiring diagram or toggle Paste Target</p>
      </div>
    `;
    removeBtn.classList.add('hidden');
    badge.textContent = document.getElementById('fPinoutUrl').value.trim() ? 'Link set' : 'Optional';
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

function updateWhatItDoesCallout(text) {
  const box = document.getElementById('drawerWhatItDoesCallout');
  const preview = document.getElementById('drawerWhatItDoesPreview');
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
  el.className = 'text-[11px] leading-relaxed px-2.5 py-2 rounded-md border';
  if (type === 'info') {
    el.classList.add('bg-blue-500/[0.08]', 'border-blue-500/25', 'text-blue-700', 'dark:text-blue-300');
  } else if (type === 'success') {
    el.classList.add('bg-emerald-500/[0.08]', 'border-emerald-500/25', 'text-emerald-700', 'dark:text-emerald-300');
  } else {
    el.classList.add('bg-red-500/[0.08]', 'border-red-500/25', 'text-red-700', 'dark:text-red-300');
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function syncPinoutPasteBtn() {
  const btn = document.getElementById('pinoutPasteToggleBtn');
  if (state.pinoutPasteTarget) {
    btn.textContent = 'Paste Target: Pinout (Ctrl+V)';
    btn.classList.add('border-accent', 'text-accent', 'dark:text-blue-400', 'bg-blue-500/[0.08]');
  } else {
    btn.textContent = 'Paste Target: Off';
    btn.classList.remove('border-accent', 'text-accent', 'dark:text-blue-400', 'bg-blue-500/[0.08]');
  }
}

function renderDrawerPreview(part) {
  const container = document.getElementById('drawerPreviewBody');
  const low = isLowStock(part);

  const mainPhotoHtml = part.image_path
    ? `<div class="relative aspect-[16/10] w-full rounded-xl bg-matte-light dark:bg-matte-dark border border-hairline-light dark:border-hairline-dark overflow-hidden flex items-center justify-center">
         <img src="${escapeHTML(imageUrl(part.image_path))}" alt="${escapeHTML(part.name)}" class="w-full h-full object-contain p-3 cursor-zoom-in" data-lightbox-src="${escapeHTML(imageUrl(part.image_path))}" />
       </div>`
    : `<div class="relative aspect-[16/10] w-full rounded-xl bg-matte-light dark:bg-matte-dark border border-hairline-light dark:border-hairline-dark overflow-hidden flex flex-col items-center justify-center text-center px-6 text-[#8A919E] dark:text-[#666E7D]">
         <svg class="w-6 h-6 mb-1.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
           <circle cx="12" cy="13" r="3"/>
         </svg>
         <p class="text-xs font-medium">No photo attached</p>
         <button type="button" data-action="edit-part" class="mt-2 text-[11px] text-accent dark:text-blue-400 hover:underline">Click Edit to upload, paste, or fetch</button>
       </div>`;

  const pinoutBlockHtml =
    part.pinout_image_path || part.pinout_url
      ? `<section class="rounded-xl border border-hairline-light dark:border-hairline-dark bg-canvas-light/60 dark:bg-canvas-dark/60 p-3.5 space-y-2.5">
           <div class="flex items-center justify-between gap-2">
             <h4 class="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280] dark:text-[#8B92A0]">Pinout / Wiring Reference</h4>
             ${
               part.pinout_url && /^https?:\/\//i.test(part.pinout_url)
                 ? `<a href="${escapeHTML(part.pinout_url)}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-medium text-accent dark:text-blue-400 hover:underline inline-flex items-center gap-1">
                      <span>Open Datasheet</span>
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>`
                 : ''
             }
           </div>
           ${
             part.pinout_image_path
               ? `<div class="aspect-[16/9] w-full rounded-lg bg-matte-light dark:bg-matte-dark border border-hairline-light dark:border-hairline-dark overflow-hidden flex items-center justify-center">
                    <img src="${escapeHTML(imageUrl(part.pinout_image_path))}" alt="Pinout diagram" class="w-full h-full object-contain p-2 cursor-zoom-in" data-lightbox-src="${escapeHTML(imageUrl(part.pinout_image_path))}" />
                  </div>`
               : ''
           }
         </section>`
      : '';

  container.innerHTML = `
    ${mainPhotoHtml}

    <!-- Title, Subtitle & Quick Meta -->
    <div class="space-y-3">
      <div>
        <h3 class="text-base font-semibold leading-snug text-[#111318] dark:text-[#E6E8EC]">${escapeHTML(part.name)}</h3>
        ${part.subtitle ? `<p class="text-xs text-[#6B7280] dark:text-[#8B92A0] mt-0.5">${escapeHTML(part.subtitle)}</p>` : ''}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div class="flex flex-wrap items-center gap-1.5">
          ${
            part.location
              ? `<button type="button" data-preview-bin="${escapeHTML(part.location)}" class="h-6 px-2 rounded-md font-mono text-[11px] bg-matte-light dark:bg-[#20242E] border border-hairline-light dark:border-hairline-dark text-[#4B5563] dark:text-[#CBD5E1] hover:border-accent hover:text-accent dark:hover:text-blue-400 transition-colors" title="Filter grid by bin">
                   Bin: ${escapeHTML(part.location)}
                 </button>`
              : `<span class="h-6 px-2 rounded-md font-mono text-[11px] bg-matte-light/70 dark:bg-[#1C2029] text-[#8A919E] inline-flex items-center">Unassigned bin</span>`
          }
          ${
            part.in_use_project
              ? `<span class="h-6 px-2 rounded-md bg-emerald-500/[0.10] border border-emerald-500/30 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                   <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                   In use: ${escapeHTML(part.in_use_project)}
                 </span>`
              : ''
          }
          ${
            low
              ? `<span class="h-6 px-2 rounded-md bg-amber-500/[0.12] border border-amber-500/35 text-[11px] font-mono font-medium text-amber-700 dark:text-amber-300 inline-flex items-center">
                   Low stock (&le; ${escapeHTML(part.low_stock_threshold)})
                 </span>`
              : ''
          }
        </div>

        <!-- Inline Quantity Stepper in Preview -->
        <div class="inline-flex items-center rounded-md border border-hairline-light dark:border-hairline-dark bg-canvas-light dark:bg-canvas-dark">
          <button type="button" data-preview-step="-1" data-id="${escapeHTML(part.id)}" class="w-7 h-7 flex items-center justify-center text-xs text-[#6B7280] hover:text-[#111318] dark:hover:text-white transition-colors" aria-label="Decrease quantity">&minus;</button>
          <span class="min-w-[28px] text-center font-mono text-xs font-medium ${low ? 'text-amber-600 dark:text-amber-400' : 'text-[#111318] dark:text-[#E6E8EC]'}">${part.quantity}</span>
          <button type="button" data-preview-step="1" data-id="${escapeHTML(part.id)}" class="w-7 h-7 flex items-center justify-center text-xs text-[#6B7280] hover:text-[#111318] dark:hover:text-white transition-colors" aria-label="Increase quantity">+</button>
        </div>
      </div>
    </div>

    ${
      part.warning
        ? `<div class="p-3 rounded-lg bg-amber-500/[0.08] border border-amber-500/25 text-xs text-amber-800 dark:text-amber-300/90 leading-relaxed">
             <div class="font-medium flex items-center gap-1.5 mb-0.5">
               <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>
               <span>Warning / Caution</span>
             </div>
             <p class="opacity-90">${escapeHTML(part.warning)}</p>
           </div>`
        : ''
    }

    ${
      part.what_it_does
        ? `<div class="p-3 rounded-lg bg-blue-500/[0.06] border border-blue-500/20 text-xs text-[#1E293B] dark:text-[#CBD5E1] leading-relaxed">
             <div class="font-medium text-accent dark:text-blue-400 mb-0.5">What it does</div>
             <p>${escapeHTML(part.what_it_does)}</p>
           </div>`
        : ''
    }

    ${
      part.visual_tell
        ? `<div class="space-y-1">
             <h4 class="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280] dark:text-[#8B92A0]">Visual Tell</h4>
             <p class="text-xs leading-relaxed text-[#111318] dark:text-[#E6E8EC]">${escapeHTML(part.visual_tell)}</p>
           </div>`
        : ''
    }

    ${pinoutBlockHtml}

    ${
      part.notes
        ? `<div class="space-y-1">
             <h4 class="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280] dark:text-[#8B92A0]">Notes</h4>
             <p class="text-xs leading-relaxed text-[#374151] dark:text-[#CBD5E1] whitespace-pre-line">${escapeHTML(part.notes)}</p>
           </div>`
        : ''
    }

    ${
      part.source_url && /^https?:\/\//i.test(part.source_url)
        ? `<div class="pt-1">
             <a href="${escapeHTML(part.source_url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-hairline-light dark:border-hairline-dark bg-canvas-light dark:bg-canvas-dark hover:border-accent text-xs font-medium text-[#111318] dark:text-[#E6E8EC] transition-colors">
               <span>Open Store / Reorder Page</span>
               <svg class="w-3.5 h-3.5 text-[#6B7280]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
             </a>
           </div>`
        : ''
    }
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
      <div class="group relative rounded-lg border border-hairline-light dark:border-hairline-dark bg-matte-light dark:bg-matte-dark overflow-hidden flex flex-col hover:border-accent transition-colors" data-candidate-card="${idx}">
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
        <div class="px-1.5 py-1 border-t border-hairline-light/70 dark:border-hairline-dark/70 bg-surface-light/90 dark:bg-surface-dark/90 flex items-center justify-between gap-1">
          <span class="text-[9px] font-mono text-[#6B7280] dark:text-[#8B92A0] truncate">${escapeHTML(c.source || 'web')}</span>
          <button
            type="button"
            data-pick-url="${escapeHTML(c.url)}"
            data-pick-slot="pinout"
            class="shrink-0 text-[9px] font-medium px-1 py-0.5 rounded bg-matte-light dark:bg-[#20242E] text-[#6B7280] dark:text-[#9CA3AF] hover:text-accent dark:hover:text-blue-400 transition-colors"
            title="Set as Pinout diagram"
          >Pinout</button>
        </div>
      </div>
    `
    )
    .join('');
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
      document.getElementById('pinoutSection').open = true;
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

function openDrawer(mode, partId = null) {
  state.drawerMode = mode;
  state.activePartId = partId;
  state.pendingMainFile = null;
  state.pendingPinoutFile = null;
  state.pinoutPasteTarget = false;
  state.lastScraped = { title: '', description: '' };
  state.imageCandidates = [];
  renderImagePicker();

  const previewBody = document.getElementById('drawerPreviewBody');
  const editBody = document.getElementById('drawerEditBody');
  const previewFooter = document.getElementById('drawerPreviewFooter');
  const editFooter = document.getElementById('drawerEditFooter');
  const switchToEditBtn = document.getElementById('switchToEditBtn');
  const switchToPreviewBtn = document.getElementById('switchToPreviewBtn');
  const categoryPill = document.getElementById('drawerCategoryPill');

  if (mode === 'view') {
    const part = state.parts.find((p) => p.id === partId);
    if (!part) return;

    document.getElementById('drawerHeading').textContent = 'Part Details';
    categoryPill.textContent = part.category || '';
    categoryPill.classList.toggle('hidden', !part.category);

    previewBody.classList.remove('hidden');
    editBody.classList.add('hidden');
    previewFooter.classList.remove('hidden');
    editFooter.classList.add('hidden');
    switchToEditBtn.classList.remove('hidden');
    switchToPreviewBtn.classList.add('hidden');

    renderDrawerPreview(part);
  } else {
    previewBody.classList.add('hidden');
    editBody.classList.remove('hidden');
    previewFooter.classList.add('hidden');
    editFooter.classList.remove('hidden');
    switchToEditBtn.classList.add('hidden');
    categoryPill.classList.add('hidden');
    switchToPreviewBtn.classList.toggle('hidden', mode !== 'edit');

    refreshLocationDatalist();
    setUrlFetchStatus(null, '');
    syncPinoutPasteBtn();

    document.getElementById('photoUrlInput').value = '';
    document.getElementById('photoFileInput').value = '';
    document.getElementById('pinoutFileInput').value = '';

    // Reset inline delete confirmation
    document.getElementById('deleteConfirmGroup').classList.add('hidden');
    document.getElementById('deleteConfirmGroup').classList.remove('flex');
    document.getElementById('deleteInitBtn').classList.remove('hidden');

    const pinoutDetails = document.getElementById('pinoutSection');

    if (mode === 'edit') {
      const part = state.parts.find((p) => p.id === partId);
      if (!part) return;
      document.getElementById('drawerHeading').textContent = 'Edit Part';
      document.getElementById('saveDrawerBtn').textContent = 'Save Changes';
      document.getElementById('deleteArea').classList.remove('invisible');

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

      pinoutDetails.open = Boolean(part.pinout_image_path || part.pinout_url);
      updateWarningCallout(part.warning);
      updateWhatItDoesCallout(part.what_it_does);
    } else {
      document.getElementById('drawerHeading').textContent = 'Add New Part';
      document.getElementById('saveDrawerBtn').textContent = 'Add Part';
      document.getElementById('deleteArea').classList.add('invisible');

      document.getElementById('partForm').reset();
      document.getElementById('fCategory').value = state.category !== 'All' ? state.category : 'Sensors';
      document.getElementById('fQuantity').value = 1;
      document.getElementById('fLowStock').value = '';
      document.getElementById('fPinoutUrl').value = '';

      state.draftImagePath = '';
      state.draftPinoutImagePath = '';
      pinoutDetails.open = false;
      updateWarningCallout('');
      updateWhatItDoesCallout('');
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

  if (mode === 'create') {
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
// PHOTO UPLOAD / SCRAPE / ENRICH
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
    showToast('Please select a valid image file');
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
    // Create mode: preview locally, upload right after part is created
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
    showToast('Image ready — will upload when saved');
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

    if (data.name) document.getElementById('fName').value = data.name;
    if (data.subtitle) document.getElementById('fSubtitle').value = data.subtitle;
    if (data.category) document.getElementById('fCategory').value = data.category;
    if (data.what_it_does) {
      document.getElementById('fWhatItDoes').value = data.what_it_does;
      updateWhatItDoesCallout(data.what_it_does);
    }
    if (data.visual_tell) document.getElementById('fVisualTell').value = data.visual_tell;
    if (data.warning) {
      document.getElementById('fWarning').value = data.warning;
      updateWarningCallout(data.warning);
    }
    if (data.notes) document.getElementById('fNotes').value = data.notes;
    if (data.pinout_url) {
      document.getElementById('fPinoutUrl').value = data.pinout_url;
      syncExternalLink('fPinoutUrl', 'openPinoutUrlLink');
      document.getElementById('pinoutSection').open = true;
      renderDrawerPinout();
    }

    state.imageCandidates = Array.isArray(data.image_candidates) ? data.image_candidates : [];
    renderImagePicker();

    setUrlFetchStatus(
      'success',
      state.imageCandidates.length > 0
        ? `Smart Autofill populated details and found ${state.imageCandidates.length} photo candidate${state.imageCandidates.length > 1 ? 's' : ''}. Pick one below or click Save.`
        : 'Smart Autofill populated part details. Review and click Save.'
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
    document.getElementById('fName').focus();
    showToast('Please enter a part name');
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
  };

  // In create mode, include scraped image_path if not a blob preview
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

async function handleStepQuantity(partId, delta) {
  const part = state.parts.find((p) => p.id === partId);
  if (!part) return;
  const nextQty = Math.max(0, Number(part.quantity || 0) + delta);
  if (nextQty === part.quantity) return;

  // Optimistic update
  const prevQty = part.quantity;
  part.quantity = nextQty;
  renderGrid();
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
    renderGrid();
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
    state.pendingRestoreFile = null;
    await loadParts();
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
  // Theme Toggle
  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    } catch (_) {}
  });

  // Backup/Restore Dropdown
  const backupBtn = document.getElementById('backupMenuBtn');
  const backupDropdown = document.getElementById('backupDropdown');

  backupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !backupDropdown.classList.contains('hidden');
    backupDropdown.classList.toggle('hidden', isOpen);
    backupBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#backupMenuWrapper')) {
      backupDropdown.classList.add('hidden');
      backupBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.getElementById('downloadBackupBtn').addEventListener('click', () => {
    backupDropdown.classList.add('hidden');
    window.location.href = '/api/backup';
  });

  document.getElementById('restoreFileInput').addEventListener('change', (e) => {
    backupDropdown.classList.add('hidden');
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
    renderGrid();
  });

  clearBtn.addEventListener('click', () => {
    state.search = '';
    searchInput.value = '';
    syncSearchUi();
    renderGrid();
    searchInput.focus();
  });

  // Category Strip
  document.getElementById('categoryStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    state.category = btn.dataset.cat;
    renderGrid();
  });

  // Active Location Pill dismiss
  document.getElementById('activeLocationPill').addEventListener('click', () => {
    state.locationFilter = '';
    renderGrid();
  });

  // Quick Toggle Chips
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

  // Empty State Reset
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

  // Grid Interactions (Stepper, Bin Tag Filter, Open Drawer)
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
    const card = e.target.closest('article[data-id]');
    if (card) {
      openDrawer('view', card.dataset.id);
    }
  });

  // Add Part Button
  document.getElementById('addPartBtn').addEventListener('click', () => openDrawer('create'));

  // Drawer Mode Switching & Close / Save
  document.getElementById('switchToEditBtn').addEventListener('click', () => {
    if (state.activePartId) openDrawer('edit', state.activePartId);
  });
  document.getElementById('editFromPreviewFooterBtn').addEventListener('click', () => {
    if (state.activePartId) openDrawer('edit', state.activePartId);
  });
  document.getElementById('switchToPreviewBtn').addEventListener('click', () => {
    if (state.activePartId) openDrawer('view', state.activePartId);
  });
  document.getElementById('closePreviewFooterBtn').addEventListener('click', closeDrawer);
  document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
  document.getElementById('cancelDrawerBtn').addEventListener('click', () => {
    if (state.drawerMode === 'edit' && state.activePartId) {
      openDrawer('view', state.activePartId);
    } else {
      closeDrawer();
    }
  });
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
  document.getElementById('saveDrawerBtn').addEventListener('click', saveDrawer);

  // Preview Body Interactive Delegations (Lightbox, Stepper, Bin Filter, Edit CTA)
  document.getElementById('drawerPreviewBody').addEventListener('click', (e) => {
    const img = e.target.closest('img[data-lightbox-src]');
    if (img) {
      openLightbox(img.dataset.lightboxSrc);
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
      renderGrid();
      closeDrawer();
      return;
    }
    if (e.target.closest('button[data-action="edit-part"]')) {
      if (state.activePartId) openDrawer('edit', state.activePartId);
    }
  });

  // Live callout previews & external links inside drawer
  document.getElementById('fName').addEventListener('input', syncGoogleImagesLink);
  document.getElementById('fWarning').addEventListener('input', (e) => {
    updateWarningCallout(e.target.value);
  });
  document.getElementById('fWhatItDoes').addEventListener('input', (e) => {
    updateWhatItDoesCallout(e.target.value);
  });
  document.getElementById('fSourceUrl').addEventListener('input', () => {
    syncExternalLink('fSourceUrl', 'openSourceUrlLink');
  });
  document.getElementById('fPinoutUrl').addEventListener('input', () => {
    syncExternalLink('fPinoutUrl', 'openPinoutUrlLink');
    renderDrawerPinout();
  });

  // Lightbox triggers on drawer photo & pinout frames
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

  // Photo Method 1: File Upload / Phone Camera
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

  // Pinout Paste Target Toggle
  document.getElementById('pinoutPasteToggleBtn').addEventListener('click', () => {
    state.pinoutPasteTarget = !state.pinoutPasteTarget;
    syncPinoutPasteBtn();
  });

  // Photo Method 2: Clipboard Paste (Ctrl+V / Cmd+V when drawer is open in edit/create mode)
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

  // Photo Method 3: Fetch from Store URL + Smart Autofill
  document.getElementById('fetchUrlBtn').addEventListener('click', handleFetchUrl);
  document.getElementById('photoUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFetchUrl();
    }
  });
  document.getElementById('smartAutofillBtn').addEventListener('click', handleSmartAutofill);

  // Candidate Image Picker interactions
  document.getElementById('dismissImagePickerBtn').addEventListener('click', () => {
    state.imageCandidates = [];
    renderImagePicker();
  });
  document.getElementById('imagePickerGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pick-url]');
    if (!btn) return;
    handlePickCandidateImage(btn.dataset.pickUrl, btn.dataset.pickSlot || 'main');
  });

  // Remove Photo / Pinout
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
      await apiFetch(`/api/parts/${encodeURIComponent(state.activePartId)}`, {
        method: 'DELETE',
      });
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

    if (e.key === '/' && !isTyping && !state.drawerMode) {
      e.preventDefault();
      searchInput.focus();
      return;
    }

    if ((e.key === 'e' || e.key === 'E') && !isTyping && state.drawerMode === 'view' && state.activePartId) {
      e.preventDefault();
      openDrawer('edit', state.activePartId);
      return;
    }

    if (e.key === 'Escape') {
      if (!document.getElementById('lightboxModal').classList.contains('hidden')) {
        closeLightbox();
        return;
      }
      if (!document.getElementById('restoreModal').classList.contains('hidden')) {
        state.pendingRestoreFile = null;
        document.getElementById('restoreModal').classList.add('hidden');
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
  loadTheme();
  bindEvents();
  await Promise.all([loadConfig(), loadParts()]);
});
