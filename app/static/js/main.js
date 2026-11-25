// Main Pinbin application shell, routing, theme/font syncing, and event handling.
import { api } from './api.js';
import {
  state,
  esc,
  sv,
  normalizeSort,
  partById,
  shoppingById,
  toast,
} from './state.js';
import { closePanel } from './inspectors.js';
import { renderInventoryView } from './views/inventory.js';
import { sbStick, sbOpen, jumpToSection, initEditScrollSpy } from './secbar.js';
import {
  renderPartEditView,
  clearPartDraft,
  dirtyPartCount,
  refreshPartEditBits,
  autosizeTextarea,
  setPendingPhoto,
  clearPhotoSlot,
  scrapeStoreIntoDraft,
  savePartEdit,
  removePartWithUndo,
} from './views/edit-part.js';
import {
  renderProjectsListView,
  renderProjectDetailView,
  applyMapFocus,
  toggleProjectArchive,
  toggleProjectCheck,
} from './views/projects.js';
import {
  renderProjectEditView,
  clearProjectDraft,
  dirtyProjectCount,
  refreshProjectEditBits,
  addOwnedPartToProjectDraft,
  addNewBuyItemToProjectDraft,
  addNetToProjectDraft,
  saveProjectEdit,
  deleteProjectWithUndo,
} from './views/edit-project.js';
import {
  renderShoppingView,
  advanceStoreStatus,
  runStoreOptimizer,
} from './views/shopping.js';
import {
  renderItemEditView,
  clearItemDraft,
  dirtyItemCount,
  refreshItemEditBits,
  saveItemEdit,
  removeItemWithUndo,
} from './views/edit-item.js';
import { renderGlossaryView } from './views/glossary.js';
import { renderBenchView, computeCalcOutputs } from './views/bench.js';
import {
  renderSettingsView,
  loadSettingsExtras,
  renameBinWithUndo,
  saveRetailerShipping,
  patchMcpSetting,
  rotateMcpTokenNow,
  uploadRestoreZip,
  uploadImportCsv,
  wipeEverythingNow,
} from './views/settings.js';

function route() {
  const hash = location.hash.slice(1);
  if (hash) return hash;
  const path = location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path || path === 'inventory') return 'inventory';
  if (path.startsWith('projects/')) return `p-${path.slice(9)}`;
  if (['projects', 'shopping', 'glossary', 'bench', 'settings'].includes(path)) return path;
  return 'inventory';
}

function applyAppearance() {
  const ui = state.config.ui_settings;
  const th = ui.theme || 'system';
  if (th === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  try { localStorage.setItem('pb-theme', th === 'system' ? '' : th); } catch (_) {}

  const font = ui.font || 'plex';
  if (font === 'instrument') document.documentElement.setAttribute('data-font', 'instrument');
  else document.documentElement.removeAttribute('data-font');
  try { localStorage.setItem('pb-font', font === 'instrument' ? 'instrument' : ''); } catch (_) {}

  document.documentElement.classList.toggle('reduce', ui.motion === 'reduced');

  const dark =
    th === 'dark' ||
    (th === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', dark ? '#1E1D1B' : '#ECEDEA');
}

function renderNav() {
  const r = route();
  const sec =
    r.startsWith('p-') || r.startsWith('edit-proj-') || r === 'new-proj'
      ? 'projects'
      : r.startsWith('edit-part-') || r === 'new-part'
      ? 'inventory'
      : r.startsWith('edit-item-') || r === 'new-item'
      ? 'shopping'
      : r;

  const activeProjects = state.projects.filter((p) => !p.archived).length;
  const toOrderCount = state.shopping.filter((s) => (s.status || 'order') === 'order').length;
  const links = [
    ['inventory', 'Inventory', state.parts.length],
    ['projects', 'Projects', activeProjects],
    ['shopping', 'Shopping', toOrderCount],
    ['glossary', 'Glossary', ''],
    ['bench', 'Bench', ''],
  ];

  const navEl = document.getElementById('nav');
  if (navEl) {
    navEl.innerHTML = links
      .map(
        ([k, t, c]) =>
          `<a href="#${k}" ${sec === k ? 'aria-current="page"' : ''}>${t}${
            c !== '' ? `<span class="c">${c}</span>` : ''
          }</a>`
      )
      .join('');
  }

  const th = document.documentElement.getAttribute('data-theme');
  const dark = th === 'dark' || (!th && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.innerHTML = dark
      ? sv('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')
      : sv('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>');
  }
}

function lockScroll(on) {
  const b = document.body;
  const is = b.classList.contains('locked');
  if (on && !is) {
    const y = window.scrollY;
    b.dataset.y = String(y);
    b.style.top = `${-y}px`;
    b.classList.add('locked');
  } else if (!on && is) {
    const y = Number(b.dataset.y) || 0;
    b.classList.remove('locked');
    b.style.top = '';
    window.scrollTo(0, y);
  }
}

function placeholderScreen(title, stepNote) {
  return `<div class="screen full"><div class="work">
    <div class="pagehead"><h1>${esc(title)}</h1></div>
    <p class="dim" style="max-width:60ch">${esc(stepNote)}</p>
    <p style="margin-top:14px"><a class="btn" href="#inventory">← Back to Inventory</a></p>
  </div></div>`;
}

function renderLightbox() {
  const root = document.getElementById('lightboxRoot');
  if (!root) return;
  if (!state.lightboxSrc) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = `<div class="lightbox" data-act="close-lightbox" role="dialog" aria-modal="true" aria-label="Full-size image">
    <button type="button" class="lb-close" data-act="close-lightbox" aria-label="Close">${sv('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    <img src="${esc(state.lightboxSrc)}" alt="Full-size preview">
  </div>`;
}

export function render() {
  renderNav();
  const r = route();
  const app = document.getElementById('app');
  if (!app) return;

  if (!state.loaded) {
    app.innerHTML = '<div class="screen full"><div class="work"><p class="faint">Loading workbench…</p></div></div>';
    return;
  }

  let html = '';
  const curPid = r.startsWith('p-') ? r.slice(2) : null;
  if (r === 'inventory') {
    html = renderInventoryView();
  } else if (r === 'new-part') {
    html = renderPartEditView('');
  } else if (r.startsWith('edit-part-')) {
    html = renderPartEditView(r.slice(10));
  } else if (r === 'projects') {
    html = renderProjectsListView();
  } else if (curPid) {
    html = renderProjectDetailView(curPid);
  } else if (r === 'new-proj') {
    html = renderProjectEditView('');
  } else if (r.startsWith('edit-proj-')) {
    html = renderProjectEditView(r.slice(10));
  } else if (r === 'shopping') {
    html = renderShoppingView();
  } else if (r === 'new-item') {
    html = renderItemEditView('');
  } else if (r.startsWith('edit-item-')) {
    html = renderItemEditView(r.slice(10));
  } else if (r === 'glossary') {
    html = renderGlossaryView();
  } else if (r === 'bench') {
    html = renderBenchView();
  } else if (r === 'settings') {
    if (!state.set.loaded && !state.set.loading) loadSettingsExtras(render);
    html = renderSettingsView();
  } else {
    html = renderInventoryView();
  }

  app.innerHTML = html;
  renderLightbox();
  if (curPid) applyMapFocus(curPid);
  state.panelWasOpen = Boolean(document.querySelector('.insp.float'));
  lockScroll(window.matchMedia('(max-width: 980px)').matches && Boolean(document.querySelector('.insp.open')));

  sbStick();
  const tb = document.querySelector('.bar');
  if (tb) document.documentElement.style.setProperty('--hdr', `${tb.getBoundingClientRect().height}px`);

  if (document.querySelector('.edit') && (state.partDraft || state.projDraft || state.itemDraft)) {
    const sizeAll = () => document.querySelectorAll('textarea.grow').forEach(autosizeTextarea);
    sizeAll();
    requestAnimationFrame(sizeAll);
    if (document.fonts) document.fonts.ready.then(sizeAll);
    if (state.partDraft) refreshPartEditBits();
    if (state.projDraft) refreshProjectEditBits();
    if (state.itemDraft) refreshItemEditBits();
    initEditScrollSpy();
  }
}

async function loadAllData() {
  const [config, parts, projects, shopping, retailers, glossary] = await Promise.all([
    api.getConfig(),
    api.listParts(),
    api.listProjects(),
    api.listShopping(),
    api.listRetailers(),
    api.listGlossary(),
  ]);
  state.config = config;
  state.parts = parts;
  state.projects = projects;
  state.shopping = shopping;
  state.retailers = retailers;
  state.glossary = glossary;
  state.inv.sort = normalizeSort(config.ui_settings?.sort_by || 'recent');
  state.inv.view = config.ui_settings?.view_mode === 'list' ? 'list' : 'grid';

  // Support /?bin=<BinName> deep link from printed QR labels
  const params = new URLSearchParams(location.search);
  const binParam = (params.get('bin') || '').trim();
  if (binParam) state.inv.binFilter = binParam;

  state.loaded = true;
  applyAppearance();
  render();
}

async function persistUiSetting(patch) {
  Object.assign(state.config.ui_settings, patch);
  applyAppearance();
  try {
    const updated = await api.patchSettings(patch);
    state.config.ui_settings = { ...state.config.ui_settings, ...updated };
  } catch (err) {
    toast(err.message);
  }
}

async function stepPartQty(id, delta) {
  const p = partById(id);
  if (!p) return;
  const prev = p.quantity;
  const next = Math.max(0, prev + delta);
  if (next === prev) return;
  p.quantity = next;
  render();
  try {
    const updated = await api.patchPart(id, { quantity: next });
    Object.assign(p, updated);
    render();
  } catch (err) {
    p.quantity = prev;
    render();
    toast(err.message);
  }
}

async function stepShoppingQty(id, delta) {
  const it = shoppingById(id);
  if (!it) return;
  const prev = it.quantity;
  const next = Math.max(1, prev + delta);
  if (next === prev) return;
  it.quantity = next;
  render();
  try {
    const updated = await api.patchShoppingItem(id, { quantity: next });
    Object.assign(it, updated);
    render();
  } catch (err) {
    it.quantity = prev;
    render();
    toast(err.message);
  }
}

async function selectOffer(itemId, offerId) {
  try {
    const updated = await api.patchShoppingOffer(itemId, offerId, { is_selected: true });
    const idx = state.shopping.findIndex((s) => s.id === itemId);
    if (idx >= 0) state.shopping[idx] = updated;
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function moveToInventory(itemId) {
  try {
    const createdPart = await api.moveShoppingToInventory(itemId);
    state.shopping = state.shopping.filter((s) => s.id !== itemId);
    state.parts.unshift(createdPart);
    state.projects = await api.listProjects();
    state.sel = `part:${createdPart.id}`;
    render();
    toast(`Moved ${createdPart.name} to Inventory`);
  } catch (err) {
    toast(err.message);
  }
}

// Click delegation
document.addEventListener('click', (e) => {
  const tgt = e.target;
  const pop = document.getElementById('popRoot');

  // Mobile sticky section picker (.secbar)
  const sbTog = tgt.closest('[data-sbtoggle]');
  if (sbTog) {
    const bar = sbTog.closest('.secbar');
    sbOpen(!bar.classList.contains('open'));
    return;
  }
  const sbGo = tgt.closest('[data-sbgo]');
  if (sbGo) {
    const key = sbGo.dataset.sbgo;
    const kind = sbGo.closest('.secbar')?.dataset.secbar;
    sbOpen(false);
    if (kind === 'edit') {
      jumpToSection(key);
    } else if (kind === 'bench') {
      state.bench.tool = key;
      state.bench.pin = '';
      render();
      window.scrollTo(0, 0);
    } else if (kind === 'set') {
      state.set.sec = key;
      state.set.confirm = null;
      state.set.renaming = null;
      render();
      window.scrollTo(0, 0);
    }
    return;
  }

  // Inline glossary popover
  const termEl = tgt.closest('[data-term]');
  if (termEl) {
    e.preventDefault();
    e.stopPropagation();
    const g = state.glossary.find((x) => x.id === termEl.dataset.term);
    if (g && pop) {
      const r = termEl.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 276));
      const top = Math.min(r.bottom + 6, window.innerHeight - 130);
      pop.innerHTML = `<div class="pop" style="left:${left}px;top:${top}px"><b>${esc(g.term)}</b>${esc(g.summary)}</div>`;
    }
    return;
  }
  if (pop && !tgt.closest('.pop')) pop.innerHTML = '';

  // Close open dropdown menu if clicked outside
  if (state.menu && !tgt.closest('.mn')) {
    state.menu = null;
    render();
  }

  // Section anchor jump on desktop edit pages
  const jp = tgt.closest('[data-jump]');
  if (jp) {
    e.preventDefault();
    const el = document.getElementById(jp.dataset.jump);
    if (el) {
      const reduce =
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        document.documentElement.classList.contains('reduce');
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    return;
  }

  // Edit Part interactions & unsaved leave guard
  if (state.partDraft && document.querySelector('.edit')) {
    const lk = tgt.closest('a[href^="#"]');
    if (lk && !lk.dataset.jump && dirtyPartCount() > 0) {
      e.preventDefault();
      state.leaveTo = lk.getAttribute('href').slice(1);
      render();
      const sb = document.querySelector('.savebar');
      if (sb) sb.scrollIntoView({ block: 'end' });
      return;
    }
    if (tgt.closest('[data-stay]')) {
      state.leaveTo = null;
      render();
      return;
    }
    if (tgt.closest('[data-discard]')) {
      const to = state.leaveTo || 'inventory';
      clearPartDraft();
      location.hash = to;
      return;
    }
    if (tgt.closest('[data-esave]')) {
      savePartEdit(render);
      return;
    }
    const d = state.partDraft;
    const dr = tgt.closest('[data-delrow]');
    if (dr) {
      const [k, i] = dr.dataset.delrow.split('|');
      d[k].splice(Number(i), 1);
      render();
      return;
    }
    const ar = tgt.closest('[data-addrow]');
    if (ar) {
      const k = ar.dataset.addrow;
      d[k].push(k === 'care' ? ['info', ''] : ['', '']);
      render();
      const ins = document.querySelectorAll(`[data-row^="${k}|${d[k].length - 1}|"]`);
      if (ins.length) ins[0].focus();
      return;
    }
    const ds = tgt.closest('[data-dset]');
    if (ds) {
      const [k, v] = ds.dataset.dset.split('|');
      d[k] = v;
      render();
      return;
    }
    const dt = tgt.closest('[data-dtoggle]');
    if (dt) {
      const [k, v] = dt.dataset.dtoggle.split('|');
      d[k] = d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v];
      render();
      return;
    }
    const dq = tgt.closest('[data-dqty]');
    if (dq) {
      const [k, v] = dq.dataset.dqty.split('|');
      d[k] = Math.max(0, Number(d[k] || 0) + Number(v));
      render();
      return;
    }
    const bs = tgt.closest('[data-binset]');
    if (bs) {
      d.bin = bs.dataset.binset;
      render();
      return;
    }
    const up = tgt.closest('[data-unphoto]');
    if (up) {
      clearPhotoSlot(up.dataset.unphoto || 'photo');
      render();
      return;
    }
    if (tgt.closest('[data-fetchstore]')) {
      scrapeStoreIntoDraft(render);
      return;
    }
    const pr = tgt.closest('[data-premove]');
    if (pr) {
      removePartWithUndo(pr.dataset.premove, render);
      return;
    }
  }

  // Edit Project interactions & unsaved leave guard
  if (state.projDraft && document.querySelector('.edit')) {
    const lk = tgt.closest('a[href^="#"]');
    if (lk && !lk.dataset.jump && dirtyProjectCount() > 0) {
      e.preventDefault();
      state.leaveTo = lk.getAttribute('href').slice(1);
      render();
      const sb = document.querySelector('.savebar');
      if (sb) sb.scrollIntoView({ block: 'end' });
      return;
    }
    if (tgt.closest('[data-stay]')) {
      state.leaveTo = null;
      render();
      return;
    }
    if (tgt.closest('[data-discard]')) {
      const to = state.leaveTo || (state.projDraft.id ? `p-${state.projDraft.id}` : 'projects');
      clearProjectDraft();
      location.hash = to;
      return;
    }
    if (tgt.closest('[data-psave]')) {
      saveProjectEdit(render);
      return;
    }
    const delProj = tgt.closest('[data-projdelete]');
    if (delProj) {
      deleteProjectWithUndo(delProj.dataset.projdelete, render);
      return;
    }
    const d = state.projDraft;
    const pdr = tgt.closest('[data-pdelrow]');
    if (pdr) {
      const [k, i] = pdr.dataset.pdelrow.split('|');
      d[k].splice(Number(i), 1);
      render();
      return;
    }
    const addMode = tgt.closest('[data-adding]');
    if (addMode) {
      const m = addMode.dataset.adding;
      d.adding = d.adding === m ? null : m;
      render();
      const focusInp = document.querySelector(d.adding === 'buy' ? '[data-pf="buyName"]' : '[data-pf="q"]');
      if (focusInp) focusInp.focus();
      return;
    }
    const padd = tgt.closest('[data-padd]');
    if (padd) {
      addOwnedPartToProjectDraft(padd.dataset.padd);
      render();
      return;
    }
    if (tgt.closest('[data-buyadd]')) {
      addNewBuyItemToProjectDraft();
      render();
      return;
    }
    if (tgt.closest('[data-netadd]')) {
      addNetToProjectDraft();
      render();
      return;
    }
    const tagDel = tgt.closest('[data-dtagdel]');
    if (tagDel) {
      d.tags = d.tags.filter((t) => t !== tagDel.dataset.dtagdel);
      render();
      return;
    }
  }

  // Edit Shopping Item interactions & unsaved leave guard
  if (state.itemDraft && document.querySelector('.edit')) {
    const lk = tgt.closest('a[href^="#"]');
    if (lk && !lk.dataset.jump && dirtyItemCount() > 0) {
      e.preventDefault();
      state.leaveTo = lk.getAttribute('href').slice(1);
      render();
      const sb = document.querySelector('.savebar');
      if (sb) sb.scrollIntoView({ block: 'end' });
      return;
    }
    if (tgt.closest('[data-stay]')) {
      state.leaveTo = null;
      render();
      return;
    }
    if (tgt.closest('[data-discard]')) {
      const to = state.leaveTo || 'shopping';
      clearItemDraft();
      location.hash = to;
      return;
    }
    if (tgt.closest('[data-isave]')) {
      saveItemEdit(render);
      return;
    }
    const irem = tgt.closest('[data-iremove]');
    if (irem) {
      removeItemWithUndo(irem.dataset.iremove, render);
      return;
    }
    const d = state.itemDraft;
    const osel = tgt.closest('[data-osel]');
    if (osel) {
      d.sel = Number(osel.dataset.osel);
      render();
      return;
    }
    const idr = tgt.closest('[data-idelrow]');
    if (idr) {
      const [k, i] = idr.dataset.idelrow.split('|');
      const idx = Number(i);
      if (k === 'offers' && d.offers.length <= 1) {
        d.offers[0] = [null, '', '', ''];
      } else {
        d[k].splice(idx, 1);
        if (k === 'offers' && d.sel >= d.offers.length) d.sel = Math.max(0, d.offers.length - 1);
      }
      render();
      return;
    }
    const iar = tgt.closest('[data-iaddrow]');
    if (iar) {
      const k = iar.dataset.iaddrow;
      if (k === 'offers') d.offers.push([null, '', '', '']);
      else if (k === 'care') d.care.push(['info', '']);
      else d[k].push(['', '']);
      render();
      const ins = document.querySelectorAll(`[data-irow^="${k}|${d[k].length - 1}|"]`);
      if (ins.length) ins[0].focus();
      return;
    }
    const iset = tgt.closest('[data-iset]');
    if (iset) {
      const [k, v] = iset.dataset.iset.split('|');
      d[k] = v;
      render();
      return;
    }
    const itog = tgt.closest('[data-itoggle]');
    if (itog) {
      const [k, v] = itog.dataset.itoggle.split('|');
      d[k] = d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v];
      render();
      return;
    }
    const iqty = tgt.closest('[data-iqty]');
    if (iqty) {
      const [k, v] = iqty.dataset.iqty.split('|');
      d[k] = Math.max(1, Number(d[k] || 1) + Number(v));
      render();
      return;
    }
  }

  // Shopping screen actions (store order button + store consolidation helper)
  const storeAct = tgt.closest('[data-store-act]');
  if (storeAct) {
    const [storeKey, curState] = storeAct.dataset.storeAct.split('|');
    advanceStoreStatus(storeKey, curState, render);
    return;
  }
  if (tgt.closest('[data-opt-toggle]')) {
    state.shopOpt.open = !state.shopOpt.open;
    if (state.shopOpt.open) {
      runStoreOptimizer(state.shopOpt.mode, false, render);
    } else {
      render();
    }
    return;
  }
  const optMode = tgt.closest('[data-opt-mode]');
  if (optMode) {
    runStoreOptimizer(optMode.dataset.optMode, false, render);
    return;
  }
  if (tgt.closest('[data-opt-apply]')) {
    runStoreOptimizer(state.shopOpt.mode, true, render);
    return;
  }

  // Stop checkbox click inside check-row from opening warn inspector (change event handles toggle)
  if (tgt.matches('input[data-done]')) {
    e.stopPropagation();
    return;
  }

  // Projects list & detail interactions
  const ptab = tgt.closest('[data-ptab]');
  if (ptab) {
    state.ptab = ptab.dataset.ptab;
    render();
    return;
  }
  const tagf = tgt.closest('[data-tagf]');
  if (tagf) {
    const t = tagf.dataset.tagf;
    state.tagf = state.tagf === t ? null : t;
    render();
    return;
  }
  const archBtn = tgt.closest('[data-archive]');
  if (archBtn) {
    toggleProjectArchive(archBtn.dataset.archive, render);
    return;
  }
  const lensGo = tgt.closest('[data-lens-go]');
  if (lensGo) {
    state.lens = lensGo.dataset.lensGo;
    state.sel = null;
    location.hash = 'inventory';
    return;
  }
  const viewBtn = tgt.closest('[data-view]');
  if (viewBtn) {
    const r = route();
    const pid = r.startsWith('p-') ? r.slice(2) : null;
    if (pid) {
      state.projView[pid] = viewBtn.dataset.view;
      render();
    }
    return;
  }
  const zoomBtn = tgt.closest('[data-zoom]');
  if (zoomBtn) {
    const z = zoomBtn.dataset.zoom;
    state.zoom = z === 'fit' ? 1 : Math.max(0.7, Math.min(2, +(state.zoom + (z === 'in' ? 0.25 : -0.25)).toFixed(2)));
    render();
    return;
  }
  const focBtn = tgt.closest('[data-focus]');
  if (focBtn) {
    const r = route();
    const pid = r.startsWith('p-') ? r.slice(2) : null;
    if (pid) {
      const nextRef = focBtn.dataset.focus;
      const curRef = state.focusRef[pid];
      if (focBtn.dataset.viewTo) {
        state.projView[pid] = focBtn.dataset.viewTo;
        state.sel = null;
      }
      if (curRef && curRef !== nextRef) {
        const tr = state.trail[pid] || [];
        const existingIdx = tr.indexOf(nextRef);
        state.trail[pid] = existingIdx >= 0 ? tr.slice(0, existingIdx) : [...tr, curRef].slice(-6);
      } else if (!curRef) {
        state.trail[pid] = [];
      }
      state.focusRef[pid] = nextRef;
      render();
    }
    return;
  }

  // Lightbox
  const lbOpen = tgt.closest('[data-lightbox]');
  if (lbOpen) {
    e.stopPropagation();
    state.lightboxSrc = lbOpen.dataset.lightbox;
    renderLightbox();
    return;
  }
  if (tgt.closest('[data-act="close-lightbox"]')) {
    if (tgt.tagName === 'IMG') return;
    state.lightboxSrc = null;
    renderLightbox();
    return;
  }

  // Dropdown toggle & selection
  const mb = tgt.closest('[data-menu]');
  if (mb) {
    state.menu = state.menu === mb.dataset.menu ? null : mb.dataset.menu;
    render();
    return;
  }
  const mp = tgt.closest('[data-mpick]');
  if (mp) {
    const [m, v] = mp.dataset.mpick.split('|');
    state.menu = null;
    if (m === 'sort' || m === 'defsort') {
      state.inv.sort = v;
      persistUiSetting({ sort_by: v });
    }
    if (m === 'cur') {
      persistUiSetting({ currency: v });
    }
    if (m === 'lens') {
      state.lens = v || null;
      state.sel = null;
    }
    if (state.partDraft) {
      if (m === 'dcat') state.partDraft.cat = v;
      if (m.startsWith('sev-')) {
        const [, k, i] = m.split('-');
        state.partDraft[k][Number(i)][0] = v;
      }
    }
    if (state.projDraft) {
      if (m.startsWith('prole-')) {
        const idx = Number(m.slice(6));
        if (state.projDraft.parts[idx]) state.projDraft.parts[idx].role = v;
      }
      if (m === 'nnk') state.projDraft.newNet.kind = v;
      if (m === 'nna') state.projDraft.newNet.a = v;
      if (m === 'nnb') state.projDraft.newNet.b = v;
    }
    if (state.itemDraft) {
      if (m === 'icat') state.itemDraft.cat = v;
      if (m.startsWith('isev-')) {
        const [, k, i] = m.split('-');
        state.itemDraft[k][Number(i)][0] = v;
      }
    }
    render();
    return;
  }

  // Category underline tabs
  const catBtn = tgt.closest('[data-cat]');
  if (catBtn) {
    state.inv.cat = catBtn.dataset.cat;
    render();
    return;
  }

  // Grid / List view toggle
  const ivBtn = tgt.closest('[data-iview]');
  if (ivBtn) {
    state.inv.view = ivBtn.dataset.iview;
    persistUiSetting({ view_mode: ivBtn.dataset.iview });
    render();
    return;
  }

  // Project lens toggle
  const lnBtn = tgt.closest('[data-lens]');
  if (lnBtn) {
    state.lens = state.lens === lnBtn.dataset.lens ? null : lnBtn.dataset.lens;
    state.sel = null;
    render();
    return;
  }

  // Quantity steppers (stop propagation so card/row doesn't toggle)
  const qtyBtn = tgt.closest('[data-qty]');
  if (qtyBtn) {
    e.stopPropagation();
    const [id, d] = qtyBtn.dataset.qty.split('|');
    stepPartQty(id, Number(d));
    return;
  }
  const buyBtn = tgt.closest('[data-buy]');
  if (buyBtn) {
    e.stopPropagation();
    const [id, d] = buyBtn.dataset.buy.split('|');
    stepShoppingQty(id, Number(d));
    return;
  }

  // Shopping offer switcher & Move to inventory inside inspector
  const pickBtn = tgt.closest('[data-pick]');
  if (pickBtn) {
    const [itemId, offerId] = pickBtn.dataset.pick.split(':');
    selectOffer(itemId, offerId);
    return;
  }
  const moveBtn = tgt.closest('[data-move-inv]');
  if (moveBtn) {
    e.stopPropagation();
    moveToInventory(moveBtn.dataset.moveInv);
    return;
  }

  // Select part, shopping item, or project map node/net/warn
  const selEl = tgt.closest('[data-sel]');
  if (selEl) {
    const val = selEl.dataset.sel;
    if (state.sel === val && document.querySelector('.insp.float')) {
      closePanel(render);
      return;
    }
    state.sel = val;
    render();
    return;
  }

  // Clicking empty background of wiring map clears selection
  if (tgt.closest('#mapwrap') && !tgt.closest('[data-sel]') && !tgt.closest('.zoom') && state.sel) {
    state.sel = null;
    render();
    return;
  }

  // Generic actions
  const actEl = tgt.closest('[data-act]');
  if (actEl) {
    const act = actEl.dataset.act;
    if (act === 'clear') {
      if (document.querySelector('.insp.float')) closePanel(render);
      else {
        state.sel = null;
        render();
      }
      return;
    }
    if (act === 'theme') {
      const th = document.documentElement.getAttribute('data-theme');
      const dark = th === 'dark' || (!th && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const next = dark ? 'light' : 'dark';
      persistUiSetting({ theme: next });
      renderNav();
      return;
    }
    if (act === 'clearq') {
      state.inv.q = '';
      state.inv.cat = 'All';
      state.inv.binFilter = '';
      render();
      return;
    }
    if (act === 'clearbin') {
      state.inv.binFilter = '';
      if (location.search) history.replaceState(null, '', location.pathname + location.hash);
      render();
      return;
    }
    if (act === 'add') {
      location.hash = 'new-part';
      return;
    }
    if (act === 'undo') {
      const root = document.getElementById('toastRoot');
      const fn = root && root._undo;
      if (root) {
        root.innerHTML = '';
        root._undo = null;
      }
      if (fn) fn();
      return;
    }
  }

  // Glossary interactions
  const gf = tgt.closest('[data-gf]');
  if (gf) {
    state.gl.filter = gf.dataset.gf;
    render();
    return;
  }
  const gt = tgt.closest('[data-gterm]');
  if (gt) {
    state.gl.termId = gt.dataset.gterm;
    state.gl.detail = true;
    state.sel = null;
    render();
    if (window.matchMedia('(max-width: 860px)').matches) window.scrollTo(0, 0);
    return;
  }
  if (tgt.closest('[data-gback]')) {
    e.preventDefault();
    state.gl.detail = false;
    state.sel = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const gto = tgt.closest('[data-goto]');
  if (gto) {
    const [pid, wid] = gto.dataset.goto.split('|');
    location.hash = `p-${pid}`;
    setTimeout(() => {
      state.sel = `warn:${wid}`;
      render();
    }, 60);
    return;
  }
  const op = tgt.closest('[data-openpart]');
  if (op) {
    const val = `part:${op.dataset.openpart}`;
    if (state.sel === val && document.querySelector('.insp.float')) {
      closePanel(render);
    } else {
      state.sel = val;
      render();
    }
    return;
  }

  const goTool = tgt.closest('[data-gotool]');
  if (goTool) {
    state.bench.tool = goTool.dataset.gotool;
    state.bench.pin = '';
    location.hash = 'bench';
    return;
  }

  // Bench tool interactions
  const toolBtn = tgt.closest('[data-tool]');
  if (toolBtn) {
    state.bench.tool = toolBtn.dataset.tool;
    state.bench.pin = '';
    render();
    return;
  }
  const pinEl = tgt.closest('[data-pin]');
  if (pinEl) {
    state.bench.pin = state.bench.pin === pinEl.dataset.pin ? '' : pinEl.dataset.pin;
    render();
    return;
  }
  const bbk = tgt.closest('[data-bbk]');
  if (bbk) {
    state.bench.bb = bbk.dataset.bbk;
    state.bench.bbHot = '';
    render();
    return;
  }
  const bb = tgt.closest('[data-bb]');
  if (bb) {
    state.bench.bbHot = state.bench.bbHot === bb.dataset.bb ? '' : bb.dataset.bb;
    render();
    return;
  }
  const band = tgt.closest('[data-band]');
  if (band) {
    const [bi, ci] = band.dataset.band.split(':').map(Number);
    state.bench.res[bi] = ci;
    render();
    return;
  }
  const rpre = tgt.closest('[data-rpre]');
  if (rpre) {
    state.bench.res = rpre.dataset.rpre.split(',').map(Number);
    render();
    return;
  }
  const dialEl = tgt.closest('[data-dial]');
  if (dialEl) {
    state.bench.dial = dialEl.dataset.dial;
    state.bench.dtask = dialEl.dataset.dtask != null ? Number(dialEl.dataset.dtask) : null;
    render();
    return;
  }
  const cset = tgt.closest('[data-cset]');
  if (cset) {
    cset.dataset.cset.split(',').forEach((pair) => {
      const [k, v] = pair.split(':');
      state.bench.calc[k] = Number(v);
    });
    render();
    return;
  }
  const osolve = tgt.closest('[data-osolve]');
  if (osolve) {
    state.bench.calc.oSolve = osolve.dataset.osolve;
    render();
    return;
  }
  if (tgt.closest('[data-print-qr]')) {
    window.print();
    return;
  }

  // Settings screen interactions
  const setSec = tgt.closest('[data-setsec]');
  if (setSec) {
    e.preventDefault();
    state.set.sec = setSec.dataset.setsec;
    state.set.confirm = null;
    state.set.renaming = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const uiSet = tgt.closest('[data-ui-set]');
  if (uiSet) {
    const [k, v] = uiSet.dataset.uiSet.split('|');
    if (k === 'view_mode') state.inv.view = v;
    persistUiSetting({ [k]: v }).then(() => render());
    render();
    return;
  }
  const uiTog = tgt.closest('[data-ui-tog]');
  if (uiTog) {
    const k = uiTog.dataset.uiTog;
    const curVal = state.config.ui_settings[k] !== false;
    persistUiSetting({ [k]: !curVal }).then(() => render());
    render();
    return;
  }
  const renBtn = tgt.closest('[data-rename-bin]');
  if (renBtn) {
    state.set.renaming = renBtn.dataset.renameBin;
    render();
    const inp = document.querySelector('[data-renform] input');
    if (inp) {
      inp.focus();
      inp.select();
    }
    return;
  }
  const copyBtn = tgt.closest('[data-copy]');
  if (copyBtn) {
    const txt = copyBtn.dataset.copy;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        () => toast('Copied to clipboard'),
        () => toast('Copy failed')
      );
    } else {
      toast(txt);
    }
    return;
  }
  const mcpSet = tgt.closest('[data-mcp-set]');
  if (mcpSet) {
    const [k, v] = mcpSet.dataset.mcpSet.split('|');
    patchMcpSetting({ [k]: v }, render);
    return;
  }
  const mcpTog = tgt.closest('[data-mcp-tog]');
  if (mcpTog) {
    const k = mcpTog.dataset.mcpTog;
    const curVal = Boolean(state.set.mcp && state.set.mcp[k]);
    patchMcpSetting({ [k]: !curVal }, render);
    return;
  }
  if (tgt.closest('[data-tok-tog]')) {
    state.set.tokenShown = !state.set.tokenShown;
    render();
    return;
  }
  const confOpen = tgt.closest('[data-confirm]');
  if (confOpen) {
    const id = confOpen.dataset.confirm;
    state.set.confirm = state.set.confirm === id ? null : id;
    state.set.wipeText = '';
    render();
    if (state.set.confirm === 'wipe') {
      const inp = document.getElementById('wipeIn');
      if (inp) inp.focus();
    }
    return;
  }
  if (tgt.closest('[data-confirm-cancel]')) {
    state.set.confirm = null;
    state.set.wipeText = '';
    render();
    return;
  }
  const confDo = tgt.closest('[data-confirm-do]');
  if (confDo) {
    const id = confDo.dataset.confirmDo;
    if (id === 'token') rotateMcpTokenNow(render);
    else if (id === 'restore') {
      const inp = document.getElementById('restoreZipInput');
      if (inp) inp.click();
    } else if (id === 'wipe' && state.set.wipeText === 'delete') {
      wipeEverythingNow(loadAllData);
    }
    return;
  }
  if (tgt.closest('[data-backup-dl]')) {
    setTimeout(() => {
      api.getConfig().then((cfg) => {
        state.config = cfg;
        render();
      }).catch(() => {});
    }, 1000);
  }
});

// Helper to set nested dot paths like parts.0.label or newNet.ap
function setNestedPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[k] == null) return;
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  cur[last] = val;
}

// Live search & edit form inputs
document.addEventListener('input', (e) => {
  if (state.partDraft && e.target.dataset && e.target.dataset.f) {
    const path = e.target.dataset.f;
    state.partDraft[path] = e.target.value;
    state.touched = state.touched || {};
    state.touched[path] = true;
    if (path === 'bin') {
      const low = e.target.value.trim().toLowerCase();
      document.querySelectorAll('[data-binset]').forEach((b) => {
        b.classList.toggle('on', b.dataset.binset.toLowerCase() === low);
      });
    }
    refreshPartEditBits();
    return;
  }
  if (state.partDraft && e.target.dataset && e.target.dataset.row) {
    const [k, i, ci] = e.target.dataset.row.split('|');
    state.partDraft[k][Number(i)][Number(ci)] = e.target.value;
    if (e.target.classList.contains('grow')) autosizeTextarea(e.target);
    refreshPartEditBits();
    return;
  }
  if (state.projDraft && e.target.dataset && e.target.dataset.pf) {
    const path = e.target.dataset.pf;
    setNestedPath(state.projDraft, path, e.target.value);
    state.touched = state.touched || {};
    state.touched[path] = true;
    if (path === 'q') {
      const pos = e.target.selectionStart;
      render();
      const inp = document.querySelector('[data-pf="q"]');
      if (inp) {
        inp.focus();
        if (pos !== null) inp.setSelectionRange(pos, pos);
      }
      return;
    }
    refreshProjectEditBits();
    return;
  }
  if (state.itemDraft && e.target.dataset && e.target.dataset.if) {
    const path = e.target.dataset.if;
    state.itemDraft[path] = e.target.value;
    state.touched = state.touched || {};
    state.touched[path] = true;
    refreshItemEditBits();
    return;
  }
  if (state.itemDraft && e.target.dataset && e.target.dataset.irow) {
    const [k, i, ci] = e.target.dataset.irow.split('|');
    state.itemDraft[k][Number(i)][Number(ci)] = e.target.value;
    if (e.target.classList.contains('grow')) autosizeTextarea(e.target);
    refreshItemEditBits();
    return;
  }
  if (e.target.id === 'wipeIn') {
    state.set.wipeText = e.target.value;
    const btn = document.querySelector('[data-confirm-do="wipe"]');
    if (btn) btn.disabled = e.target.value !== 'delete';
    return;
  }
  if (e.target.dataset && e.target.dataset.calc) {
    const k = e.target.dataset.calc;
    const num = Number(e.target.value);
    if (Number.isFinite(num)) {
      state.bench.calc[k] = num;
      const [out1, out2] = computeCalcOutputs(state.bench.tool);
      const el1 = document.getElementById('calcOut');
      const el2 = document.getElementById('calcOut2');
      if (el1) el1.textContent = out1;
      if (el2) el2.innerHTML = out2;
    }
    return;
  }
  if (e.target.id === 'gq') {
    state.gl.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = document.getElementById('gq');
    if (inp) {
      inp.focus();
      if (pos !== null) inp.setSelectionRange(pos, pos);
    }
    return;
  }
  if (e.target.id === 'invq') {
    state.inv.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = document.getElementById('invq');
    if (inp) {
      inp.focus();
      if (pos !== null) inp.setSelectionRange(pos, pos);
    }
  }
});

// Project tag form & Bench QR bin label form submission
document.addEventListener('submit', (e) => {
  if (state.projDraft && e.target.matches('[data-dtagform]')) {
    e.preventDefault();
    const raw = (e.target.tag && e.target.tag.value ? e.target.tag.value : '').trim().toLowerCase();
    if (raw && !state.projDraft.tags.includes(raw)) {
      state.projDraft.tags.push(raw);
    }
    render();
    const inp = document.querySelector('[data-dtagform] input');
    if (inp) inp.focus();
    return;
  }
  if (e.target.matches('[data-qrform]')) {
    e.preventDefault();
    const raw = (e.target.bin && e.target.bin.value ? e.target.bin.value : '').trim().toUpperCase();
    if (raw && !state.bench.qrExtra.includes(raw)) {
      state.bench.qrExtra.push(raw);
    }
    render();
    return;
  }
  if (e.target.matches('[data-renform]')) {
    e.preventDefault();
    const oldBin = e.target.dataset.renform;
    const newBin = e.target.v ? e.target.v.value : '';
    renameBinWithUndo(oldBin, newBin, render);
  }
});

// File upload inputs for photo & pinout + Project assistant check ticks
document.addEventListener('change', (e) => {
  if (state.partDraft && e.target.matches('[data-photo]') && e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    const slot = e.target.dataset.photo || 'photo';
    const previewUrl = URL.createObjectURL(file);
    setPendingPhoto(slot, file, previewUrl);
    render();
    return;
  }
  if (e.target.matches('input[data-done]')) {
    const [pid, cid] = e.target.dataset.done.split('|');
    toggleProjectCheck(pid, cid, e.target.checked, render);
    return;
  }
  if (e.target.matches('input[data-ship]')) {
    const [dom, field] = e.target.dataset.ship.split('|');
    saveRetailerShipping(dom, field, e.target.value, render);
    return;
  }
  if (e.target.id === 'restoreZipInput' && e.target.files && e.target.files[0]) {
    uploadRestoreZip(e.target.files[0], loadAllData);
    e.target.value = '';
    return;
  }
  if (e.target.id === 'importCsvInput' && e.target.files && e.target.files[0]) {
    uploadImportCsv(e.target.files[0], loadAllData);
    e.target.value = '';
  }
});

// Map hover focus (nodes, nets, warning markers)
document.addEventListener('mouseover', (e) => {
  const g = e.target.closest && e.target.closest('#map [data-sel]');
  if (!g) return;
  const r = route();
  const pid = r.startsWith('p-') ? r.slice(2) : null;
  if (!pid) return;
  if (state.hot !== g.dataset.sel) {
    state.hot = g.dataset.sel;
    applyMapFocus(pid);
  }
});
document.addEventListener('mouseout', (e) => {
  const g = e.target.closest && e.target.closest('#map [data-sel]');
  if (!g) return;
  const r = route();
  const pid = r.startsWith('p-') ? r.slice(2) : null;
  if (!pid) return;
  if (state.hot === g.dataset.sel) {
    state.hot = null;
    applyMapFocus(pid);
  }
});

// Ctrl+V paste image into Part photo on edit page
document.addEventListener('paste', (e) => {
  if (!state.partDraft || !document.querySelector('.edit')) return;
  const item = [...((e.clipboardData && e.clipboardData.items) || [])].find(
    (x) => x.type && x.type.startsWith('image/')
  );
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  e.preventDefault();
  setPendingPhoto('photo', file, URL.createObjectURL(file));
  render();
  toast('Photo pasted');
});

// Tap outside phone bottom sheet or open section picker closes it cleanly
{
  let down = null;
  const sheetOpen = () =>
    window.matchMedia('(max-width: 980px)').matches && Boolean(document.querySelector('.insp.open'));
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (document.querySelector('.secbar.open') && !e.target.closest('.secbar')) {
        down = [e.clientX, e.clientY, 'sb'];
      } else if (
        sheetOpen() &&
        !e.target.closest('.insp') &&
        !e.target.closest('#toastRoot') &&
        !e.target.closest('#popRoot') &&
        !e.target.closest('#lightboxRoot')
      ) {
        down = [e.clientX, e.clientY, 'sheet'];
      } else {
        down = null;
      }
    },
    true
  );
  document.addEventListener(
    'pointerup',
    (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 10;
      const what = down[2];
      down = null;
      if (moved) return;
      if (what === 'sb') {
        if (!document.querySelector('.secbar.open')) return;
        sbOpen(false);
      } else {
        if (!sheetOpen()) return;
        if (document.querySelector('.insp.float')) closePanel(render);
        else {
          state.sel = null;
          render();
        }
      }
      const eat = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      document.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', eat, true), 400);
    },
    true
  );
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.querySelector('.edit')) {
    if (state.partDraft) {
      e.preventDefault();
      const saveBtn = document.querySelector('[data-esave]');
      if (saveBtn && !saveBtn.disabled) savePartEdit(render);
      else toast('Nothing to save yet');
      return;
    }
    if (state.projDraft) {
      e.preventDefault();
      const saveBtn = document.querySelector('[data-psave]');
      if (saveBtn && !saveBtn.disabled) saveProjectEdit(render);
      else toast('Nothing to save yet');
      return;
    }
    if (state.itemDraft) {
      e.preventDefault();
      const saveBtn = document.querySelector('[data-isave]');
      if (saveBtn && !saveBtn.disabled) saveItemEdit(render);
      else toast('Nothing to save yet');
      return;
    }
  }
  if (e.key === 'Escape') {
    if (state.lightboxSrc) {
      state.lightboxSrc = null;
      renderLightbox();
      return;
    }
    if (document.querySelector('.secbar.open')) {
      sbOpen(false);
      const tog = document.querySelector('[data-sbtoggle]');
      if (tog) tog.focus();
      return;
    }
    const pop = document.getElementById('popRoot');
    if (pop) pop.innerHTML = '';
    if (state.menu) {
      state.menu = null;
      render();
      return;
    }
    if (state.sel) {
      if (document.querySelector('.insp.float')) closePanel(render);
      else {
        state.sel = null;
        render();
      }
      return;
    }
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    const inp = document.getElementById('invq');
    if (inp) {
      e.preventDefault();
      inp.focus();
      inp.select();
    }
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-sel]')) {
    e.preventDefault();
    e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

window.addEventListener('hashchange', () => {
  const r = route();
  if (r !== 'new-part' && !r.startsWith('edit-part-')) {
    clearPartDraft();
  } else if (state.partDraft) {
    const targetId = r.startsWith('edit-part-') ? r.slice(10) : '';
    if (state.partDraft.id !== targetId) clearPartDraft();
  }
  if (r !== 'new-proj' && !r.startsWith('edit-proj-')) {
    clearProjectDraft();
  } else if (state.projDraft) {
    const targetId = r.startsWith('edit-proj-') ? r.slice(10) : '';
    if (state.projDraft.id !== targetId) clearProjectDraft();
  }
  if (r !== 'new-item' && !r.startsWith('edit-item-')) {
    clearItemDraft();
  } else if (state.itemDraft) {
    const targetId = r.startsWith('edit-item-') ? r.slice(10) : '';
    if (state.itemDraft.id !== targetId) clearItemDraft();
  }
  if (r === 'settings') {
    state.set.loaded = false;
  }
  state.menu = null;
  state.sel = null;
  state.hot = null;
  render();
  window.scrollTo(0, 0);
});

window.addEventListener('resize', () => {
  const tb = document.querySelector('.bar');
  if (tb) document.documentElement.style.setProperty('--hdr', `${tb.getBoundingClientRect().height}px`);
  document.querySelectorAll('textarea.grow').forEach(autosizeTextarea);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((state.config.ui_settings.theme || 'system') === 'system') {
    applyAppearance();
    renderNav();
  }
});

loadAllData().catch((err) => {
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<div class="screen full"><div class="work"><p class="dim">Could not load Pinbin: ${esc(err.message)}</p></div></div>`;
  }
});
