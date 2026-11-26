// Full-page Add / Edit Shopping Item screen (Basics, Stores/Offers, Electrical facts, Handle with care, Remove).
import { api } from '../api.js';
import {
  state,
  CATEGORIES,
  CATG,
  esc,
  sv,
  caret,
  ph,
  tagChips,
  stepHtml,
  menuHtml,
  shoppingById,
  parsePriceNumber,
  currencyLabel,
  toast,
  appHref,
  navigate,
} from '../state.js';
import { computeRelations, relHtml, careHtml } from '../rules.js';
import { secBarHtml } from '../secbar.js';
import { IFACES, buildElectricalFacts } from './edit-part.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

const SEVS = [
  ['danger', '!', 'Can damage parts'],
  ['check', '?', 'Check first'],
  ['info', 'i', 'Good to know'],
];

const SECT_MAP = {
  name: 'basics',
  cat: 'basics',
  buy: 'basics',
  status: 'basics',
  why: 'basics',
  offers: 'stores',
  sel: 'stores',
  logic: 'facts',
  ifaces: 'facts',
  vmin: 'facts',
  vmax: 'facts',
  io: 'facts',
  i2c: 'facts',
  outs: 'facts',
  care: 'care',
};

export function clearItemDraft() {
  state.itemDraft = null;
  state.itemOrig = null;
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
}

export function startItemEdit(itemId) {
  const it = itemId ? shoppingById(itemId) : null;
  const f = (it && it.electrical_facts) || {};

  let offers = [];
  let selIdx = 0;
  if (it && Array.isArray(it.offers) && it.offers.length) {
    offers = it.offers.map((o) => {
      const pNum = parsePriceNumber(o.price);
      return [o.id || null, o.retailer || '', pNum !== null ? String(pNum) : '', o.url || ''];
    });
    const foundSel = it.offers.findIndex((o) => o.is_selected);
    selIdx = foundSel >= 0 ? foundSel : 0;
  } else if (it && (it.retailer || it.price || it.url)) {
    const pNum = parsePriceNumber(it.price);
    offers = [[null, it.retailer || '', pNum !== null ? String(pNum) : '', it.url || '']];
  } else {
    offers = [[null, '', '', '']];
  }

  state.itemDraft = {
    id: it ? it.id : '',
    name: it ? it.name || '' : '',
    cat: it ? it.category || 'Sensors' : 'Sensors',
    buy: it ? Number(it.quantity ?? 1) : 1,
    status: it ? it.status || 'order' : 'order',
    why: it ? it.why_needed || '' : '',
    photoPreview: it && it.image_path ? `/images/${encodeURIComponent(it.image_path)}` : '',
    offers,
    sel: selIdx,
    logic: f.logic || '',
    ifaces: Array.isArray(f.interfaces) ? [...f.interfaces] : [],
    vmin: Array.isArray(f.vin) ? String(f.vin[0]) : '',
    vmax: Array.isArray(f.vin) ? String(f.vin[1]) : '',
    io: f.io != null ? String(f.io) : '',
    i2c: f.i2c || '',
    outs: f.out ? Object.entries(f.out).map(([k, v]) => [k, String(v)]) : [],
    care: it && Array.isArray(it.care_notes) ? it.care_notes.map((c) => [c.severity || 'info', c.text || '']) : [],
    _origFacts: clone(f),
  };
  state.itemOrig = JSON.stringify(state.itemDraft);
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
}

export function dirtyItemCount() {
  if (!state.itemDraft || !state.itemOrig) return 0;
  const a = JSON.parse(state.itemOrig);
  const b = state.itemDraft;
  return Object.keys(b).filter((k) => !k.startsWith('_') && JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
}

function dirtySections() {
  if (!state.itemDraft || !state.itemOrig) return new Set();
  const a = JSON.parse(state.itemOrig);
  const b = state.itemDraft;
  const out = new Set();
  for (const k of Object.keys(b)) {
    if (SECT_MAP[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.add(SECT_MAP[k]);
  }
  return out;
}

export function validateItemDraft(d) {
  const e = {};
  if (!d) return e;
  if (!String(d.name || '').trim()) e.name = 'Needs a name.';
  if (d.logic !== 'none') {
    const a = d.vmin === '' ? null : Number(d.vmin);
    const b = d.vmax === '' ? null : Number(d.vmax);
    if ((a === null) !== (b === null)) e[a === null ? 'vmin' : 'vmax'] = 'Fill in both ends of the range.';
    else if (a !== null && a > b) e.vmin = '“From” is higher than “to”.';
    if (a !== null && (a < 0 || a > 48)) e.vmin = 'Between 0 and 48 V.';
    if (b !== null && (b < 0 || b > 48)) e.vmax = 'Between 0 and 48 V.';
    if (d.cat === 'Microcontrollers' && d.io !== '' && (Number(d.io) <= 0 || Number(d.io) > 12)) {
      e.io = 'Usually 3.6 or 5.5 V.';
    }
    if (d.i2c && !/^0x[0-9a-f]{2}$/i.test(String(d.i2c).trim())) {
      e.i2c = 'Write it like 0x3C.';
    }
  }
  return e;
}

function previewObj(d) {
  const ef = buildElectricalFacts(d);
  const tags = [];
  if (ef.logic && ef.logic !== 'none') tags.push(ef.logic);
  if (Array.isArray(ef.interfaces)) tags.push(...ef.interfaces);
  return {
    name: d.name || 'New item',
    category: d.cat,
    electrical_facts: ef,
    tags,
  };
}

function renderItemFactsSummary() {
  const d = state.itemDraft;
  if (!d) return '';
  const o = previewObj(d);
  const f = o.electrical_facts;
  const rels =
    f.vin || f.out || f.i2c || o.category === 'Microcontrollers'
      ? computeRelations(o, d.id || '__newitem')
      : [];
  return rels.length ? `<span class="k">With your other parts</span>${relHtml(rels.slice(0, 4))}` : '';
}

function renderItemSidebar() {
  const d = state.itemDraft;
  if (!d) return '';
  const o = previewObj(d);
  const f = o.electrical_facts;
  const rels =
    f.vin || f.out || f.i2c || o.category === 'Microcontrollers'
      ? computeRelations(o, d.id || '__newitem')
      : [];
  const careList = (d.care || [])
    .filter((c) => String(c[1] || '').trim())
    .map(([severity, text]) => ({ severity, text }));

  const activeOffer = d.offers[Math.min(d.sel, Math.max(0, d.offers.length - 1))] || [null, '', '', ''];
  const storeSub = activeOffer[1] ? `to buy · ${activeOffer[1]}` : 'to buy';
  const unitPrice = activeOffer[2] !== '' && Number.isFinite(Number(activeOffer[2])) ? Number(activeOffer[2]) : null;

  return `<div class="pv">
      <span class="k">Card preview</span>
      <div class="card buy">
        ${d.photoPreview ? `<div class="ph"><img src="${esc(d.photoPreview)}" alt=""></div>` : ph(CATG[d.cat] || 'proto')}
        <div class="b">
          <div>
            <div class="n">${esc(d.name || 'New item')}</div>
            <div class="sub2">${esc(storeSub)}</div>
          </div>
          <div class="tags">${tagChips(o.tags)}</div>
          <div class="f">
            <span class="qty">${d.buy}×</span>
            ${unitPrice !== null ? `<span class="mono">${unitPrice.toFixed(0)} ${esc(currencyLabel())}</span>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="pv">
      <span class="k">With your other parts</span>
      ${
        rels.length
          ? relHtml(rels)
          : '<p class="faint">Add the supply range or a signal voltage to see how it works with your boards.</p>'
      }
    </div>
    ${careList.length ? `<div class="pv"><span class="k">Handle with care</span>${careHtml(careList)}</div>` : ''}`;
}

const fIn = (path, label, val, placeholder = '', hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><input class="ei" type="text" data-if="${esc(path)}" value="${esc(
    val ?? ''
  )}" placeholder="${esc(placeholder)}">${hint ? `<em>${esc(hint)}</em>` : ''}<em class="err" data-err="${esc(
    path
  )}"></em></label>`;

const fNum = (path, label, val, unit, placeholder = '', hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><span class="inu"><input type="number" inputmode="decimal" step="any" data-if="${esc(
    path
  )}" value="${esc(val ?? '')}" placeholder="${esc(placeholder)}"><em>${esc(unit)}</em></span>${
    hint ? `<em>${esc(hint)}</em>` : ''
  }<em class="err" data-err="${esc(path)}"></em></label>`;

const fArea = (path, label, val, placeholder = '', rows = 3) =>
  `<label class="ef"><span>${esc(label)}</span><textarea class="ei" data-if="${esc(path)}" rows="${rows}" placeholder="${esc(
    placeholder
  )}">${esc(val || '')}</textarea></label>`;

const esec = (id, title, desc, body) =>
  `<section class="esec" id="e-${esc(id)}"><div class="esh"><h2>${esc(title)}</h2>${
    desc ? `<p>${esc(desc)}</p>` : ''
  }</div>${body}</section>`;

function sevMenu(id, cur) {
  const c = SEVS.find((x) => x[0] === cur) || SEVS[2];
  const open = state.menu === id;
  return `<div class="mn"><button type="button" class="btn mnb sevb" data-menu="${esc(id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="Severity: ${esc(c[2])}"><span class="sev ${esc(c[0])}">${c[1]}</span><span>${esc(c[2])}</span>${caret}</button><div class="mnp" role="menu"${open ? '' : ' hidden'}>${SEVS.map(
    ([v, g, t]) =>
      `<button type="button" role="menuitemradio" aria-checked="${v === cur}" data-mpick="${esc(id)}|${esc(v)}"><span class="sev ${esc(v)}">${g}</span><span>${esc(t)}</span></button>`
  ).join('')}</div></div>`;
}

function rowsEditor(key, rows, cols, addLabel) {
  const isCare = cols.some((c) => c[3] === 'sev');
  return `<div class="rows">${rows
    .map(
      (r, i) =>
        `<div class="erow ${isCare ? 'carerow' : ''}">${cols
          .map(([ci, placeholder, flex, typ]) => {
            if (typ === 'sev') return sevMenu(`isev-${key}-${i}`, r[ci]);
            if (typ === 'area') {
              return `<textarea class="ei grow" rows="1" style="flex:${flex}" data-irow="${esc(key)}|${i}|${ci}" placeholder="${esc(placeholder)}">${esc(r[ci] ?? '')}</textarea>`;
            }
            if (typ === 'num') {
              return `<span class="inu" style="flex:${flex}"><input type="number" inputmode="decimal" step="any" data-irow="${esc(key)}|${i}|${ci}" value="${esc(r[ci] ?? '')}" placeholder="${esc(placeholder)}"><em>V</em></span>`;
            }
            return `<input class="ei" style="flex:${flex}" data-irow="${esc(key)}|${i}|${ci}" value="${esc(r[ci] ?? '')}" placeholder="${esc(placeholder)}">`;
          })
          .join('')}<button class="btn quiet xbtn" type="button" data-idelrow="${esc(key)}|${i}" aria-label="Remove">${sv(
          '<path d="M18 6 6 18M6 6l12 12"/>'
        )}</button></div>`
    )
    .join('')}<button class="addrow" type="button" data-iaddrow="${esc(key)}">+ ${esc(addLabel)}</button></div>`;
}

export function renderItemEditView(itemId) {
  if (!state.itemDraft || state.itemDraft.id !== (itemId || '')) {
    startItemEdit(itemId || '');
  }
  const d = state.itemDraft;
  const isEdit = Boolean(d.id);
  const n = dirtyItemCount();
  const title = isEdit ? 'Edit item to buy' : 'Add item to buy';
  const curLabel = currencyLabel();

  const navs = [
    ['basics', 'Basics'],
    ['stores', 'Stores'],
    ['facts', 'Electrical facts'],
    ['care', 'Handle with care'],
    ['danger', isEdit ? 'Remove' : ''],
  ].filter(([, label]) => Boolean(label));

  // Known store list for quick datalist suggestions (derived from existing stores & shopping items)
  const knownStores = [
    ...new Set([
      ...(state.retailers || []).map((r) => r.domain).filter(Boolean),
      ...(state.shopping || []).flatMap((it) => [it.retailer, ...(it.offers || []).map((o) => o.retailer)]).filter(Boolean),
    ]),
  ].sort();

  let body = '';

  body += esec(
    'basics',
    'Basics',
    '',
    `${fIn('name', 'Name', d.name, 'e.g. ESP32-C3 Mini Dev Board')}
     <div class="egrid2">
       <div class="ef"><span>Category</span>${menuHtml('icat', '', d.cat, CATEGORIES.map((c) => [c, c, d.cat === c]))}</div>
       <div class="ef"><span>How many to buy</span>${stepHtml('data-iqty', 'buy', d.buy, 'To buy')}</div>
     </div>
     <div class="ef">
       <span>Status</span>
       <div class="tabs" role="group">
         ${[
           ['order', 'To order'],
           ['ordered', 'On the way'],
           ['arrived', 'Arrived'],
         ]
           .map(([v, t]) => `<button type="button" data-iset="status|${v}" aria-pressed="${d.status === v}">${t}</button>`)
           .join('')}
       </div>
     </div>
     ${fArea('why', 'Why buy it', d.why, 'Which project needs it, or what you plan to build with it.', 3)}`
  );

  body += esec(
    'stores',
    'Stores',
    'The chosen store decides which order it joins.',
    `<datalist id="store-list">${knownStores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
     <div class="rows">
       ${d.offers
         .map(
           (o, i) =>
             `<div class="erow offrow">
               <button type="button" class="radio ${d.sel === i ? 'on' : ''}" data-osel="${i}" aria-pressed="${
               d.sel === i
             }" aria-label="Buy here"></button>
               <span class="ostm"><input class="ei" list="store-list" data-irow="offers|${i}|1" value="${esc(
               o[1] || ''
             )}" placeholder="Store (e.g. direnc.net)" aria-label="Store"></span>
               <span class="inu"><input type="number" inputmode="decimal" step="any" data-irow="offers|${i}|2" value="${esc(
               o[2] || ''
             )}" placeholder="0" aria-label="Price"><em>${esc(curLabel)}</em></span>
               <input class="ei" data-irow="offers|${i}|3" value="${esc(o[3] || '')}" placeholder="Product link" inputmode="url" aria-label="Product link">
               <button class="btn quiet xbtn" type="button" data-idelrow="offers|${i}" aria-label="Remove store">${sv(
               '<path d="M18 6 6 18M6 6l12 12"/>'
             )}</button>
             </div>`
         )
         .join('')}
       <button class="addrow" type="button" data-iaddrow="offers">+ Add a store</button>
     </div>`
  );

  const isBoard = d.cat === 'Microcontrollers';
  body += esec(
    'facts',
    'Electrical facts',
    'The built-in checks use these to warn you about clashes. Your assistant can fill them in.',
    `<div class="ef">
       <span>Works at</span>
       <div class="tabs" role="group">
         ${[
           ['v33', '3.3 V only'],
           ['vboth', '3.3 or 5 V'],
           ['v5', '5 V only'],
           ['none', 'Not electrical'],
         ]
           .map(([v, t]) => `<button type="button" data-iset="logic|${v}" aria-pressed="${d.logic === v}">${t}</button>`)
           .join('')}
       </div>
       ${d.logic ? '' : '<em>Not set yet.</em>'}
     </div>
     ${
       d.logic === 'none'
         ? '<p class="faint">Tools, tape, boxes and wires don’t need these. The built-in checks skip this part.</p>'
         : `<div class="ef">
              <span>Talks over</span>
              <div class="chips">${IFACES.map(
                (t) =>
                  `<button type="button" class="tag f" data-itoggle="ifaces|${esc(t)}" aria-pressed="${d.ifaces.includes(
                    t
                  )}">${esc(t)}</button>`
              ).join('')}</div>
            </div>
            <div class="egrid3">
              ${fNum('vmin', 'Supply from', d.vmin, 'V', 'e.g. 3.3')}
              ${fNum('vmax', 'Supply to', d.vmax, 'V', 'e.g. 5.5')}
              ${
                isBoard
                  ? fNum('io', 'Pin limit', d.io, 'V', 'e.g. 3.6', 'The most its pins take')
                  : fIn('i2c', 'I2C address', d.i2c, 'e.g. 0x3C', d.ifaces.includes('I2C') ? '' : 'Only for I2C parts')
              }
            </div>
            <div class="ef">
              <span>Signals it sends out</span>
              ${rowsEditor('outs', d.outs, [[0, 'Pin name, e.g. ECHO', 2], [1, 'e.g. 5', 1, 'num']], 'Add a signal')}
              <em>Only pins that output a voltage, like the HC-SR04’s ECHO.</em>
            </div>
            <div class="factsum" aria-live="polite">${renderItemFactsSummary()}</div>`
     }`
  );

  body += esec(
    'care',
    'Handle with care',
    'Warnings shown on the item and in every project that uses it.',
    rowsEditor(
      'care',
      d.care,
      [[0, '', 0, 'sev'], [1, 'Care note', 1, 'area']],
      'Add a care note'
    )
  );

  if (isEdit) {
    body += esec(
      'danger',
      'Remove from shopping',
      '',
      `<div class="dz">
        <p>It also leaves every project that needs it. You can undo for a few seconds.</p>
        <button class="btn dangerout" type="button" data-iremove="${esc(d.id)}">Remove item</button>
      </div>`
    );
  }

  return `<div class="screen full"><div class="work edit">
    <div class="ehead">
      <a class="eback" href="${appHref('/shopping')}" data-leave="/shopping" title="Back to Shopping">← Shopping</a>
      <h1>${esc(title)}</h1>
    </div>
    ${secBarHtml('edit', navs, navs[0][0])}
    <div class="egrid">
      <nav class="enav" aria-label="Sections">
        ${navs.map(([k, label]) => `<a href="${esc(location.pathname)}" data-jump="e-${esc(k)}">${esc(label)}</a>`).join('')}
      </nav>
      <div class="eform">${body}</div>
      <aside class="eside">${renderItemSidebar()}</aside>
    </div>
    <div class="savebar ${n || state.leaveTo ? '' : 'idle'}">
      <div class="sb-grid">
        <span></span>
        <div class="sb-in">
          <span id="dirty" class="${n ? '' : 'faint'}">${n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes yet'}</span>
          <span style="flex:1"></span>
          ${
            state.leaveTo
              ? `<span class="leaveq">Leave without saving?</span>
                 <button class="btn" type="button" data-stay>Keep editing</button>
                 <button class="btn dangerout" type="button" data-discard>Discard changes</button>`
              : `<a class="btn" href="${appHref('/shopping')}" data-leave="/shopping">Cancel</a>
                 <button class="btn ink" type="button" data-isave ${n || !isEdit ? '' : 'disabled'}>${
                  isEdit ? 'Save changes' : 'Add item'
                }</button>`
          }
        </div>
      </div>
    </div>
  </div></div>`;
}

export function refreshItemEditBits() {
  const d = state.itemDraft;
  if (!d) return;
  const n = dirtyItemCount();
  const allErrs = validateItemDraft(d);
  const shownErrs = Object.fromEntries(
    Object.entries(allErrs).filter(([k]) => state.triedSave || (state.touched && state.touched[k]))
  );
  const ne = Object.keys(shownErrs).length;

  const dirtyEl = document.getElementById('dirty');
  if (dirtyEl) {
    dirtyEl.innerHTML = ne
      ? `<span class="sev danger">!</span> Fix ${ne} problem${ne === 1 ? '' : 's'} before saving`
      : n
      ? `${n} unsaved change${n === 1 ? '' : 's'}`
      : 'No changes yet';
    dirtyEl.className = n || ne ? '' : 'faint';
  }
  const bar = document.querySelector('.savebar');
  if (bar) bar.classList.toggle('idle', !n && !ne && !state.leaveTo);
  const saveBtn = document.querySelector('[data-isave]');
  if (saveBtn) saveBtn.disabled = Boolean(d.id) && !n && !ne;

  document.querySelectorAll('[data-err]').forEach((el) => {
    const key = el.dataset.err;
    el.textContent = shownErrs[key] || '';
    const inp = el.parentElement && el.parentElement.querySelector('input');
    if (inp) inp.setAttribute('aria-invalid', shownErrs[key] ? 'true' : 'false');
  });

  const ds = dirtySections();
  document.querySelectorAll('.enav a').forEach((a) => a.classList.toggle('chg', ds.has(a.dataset.jump.slice(2))));
  document.querySelectorAll('[data-sbgo]').forEach((b) => b.classList.toggle('chg', ds.has(b.dataset.sbgo)));
  document.querySelectorAll('[data-sbseg]').forEach((g) => g.classList.toggle('chg', ds.has(g.dataset.sbseg)));

  const side = document.querySelector('.eside');
  if (side) side.innerHTML = renderItemSidebar();
  const fs = document.querySelector('.factsum');
  if (fs) fs.innerHTML = renderItemFactsSummary();
}

export async function saveItemEdit(renderFn) {
  const d = state.itemDraft;
  if (!d) return;
  const errs = validateItemDraft(d);
  if (Object.keys(errs).length) {
    state.triedSave = true;
    refreshItemEditBits();
    const firstBad = document.querySelector('[aria-invalid="true"]');
    if (firstBad) {
      firstBad.focus();
      firstBad.scrollIntoView({ block: 'center' });
    }
    return;
  }

  const cur = currencyLabel();
  const fmtPrice = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    return /[a-zA-Z₺€$]/.test(s) ? s : `${s} ${cur}`;
  };

  const validOffers = (d.offers || [])
    .map((o, idx) => ({
      id: o[0] || null,
      retailer: String(o[1] || '').trim(),
      price: fmtPrice(o[2]),
      url: String(o[3] || '').trim(),
      is_selected: idx === d.sel,
    }))
    .filter((o) => o.retailer || o.price || o.url);

  if (validOffers.length && !validOffers.some((o) => o.is_selected)) {
    validOffers[0].is_selected = true;
  }
  const activeOffer = validOffers.find((o) => o.is_selected) || validOffers[0] || null;

  const careNotes = (d.care || [])
    .filter((c) => String(c[1] || '').trim())
    .map(([severity, text]) => ({ severity: severity || 'info', text: String(text).trim() }));

  const payload = {
    name: d.name.trim(),
    category: d.cat,
    quantity: Math.max(1, Number(d.buy) || 1),
    status: d.status || 'order',
    why_needed: d.why.trim(),
    retailer: activeOffer ? activeOffer.retailer : '',
    price: activeOffer ? activeOffer.price : '',
    url: activeOffer ? activeOffer.url : '',
    electrical_facts: buildElectricalFacts(d),
    care_notes: careNotes,
  };

  const isNew = !d.id;
  try {
    let saved;
    if (isNew) {
      saved = await api.createShoppingItem({
        ...payload,
        offers: validOffers.map((o) => ({
          retailer: o.retailer,
          price: o.price,
          url: o.url,
          is_selected: o.is_selected,
          in_stock: 'in_stock',
        })),
      });
    } else {
      const existing = shoppingById(d.id);
      const origOffers = (existing && existing.offers) || [];
      saved = await api.patchShoppingItem(d.id, payload);

      const keptIds = new Set(validOffers.map((o) => o.id).filter(Boolean));
      for (const old of origOffers) {
        if (!keptIds.has(old.id)) {
          await api.deleteShoppingOffer(d.id, old.id);
        }
      }
      for (const o of validOffers) {
        if (o.id) {
          await api.patchShoppingOffer(d.id, o.id, {
            retailer: o.retailer,
            price: o.price,
            url: o.url,
            is_selected: o.is_selected,
          });
        } else {
          await api.addShoppingOffer(d.id, {
            retailer: o.retailer,
            price: o.price,
            url: o.url,
            is_selected: o.is_selected,
            in_stock: 'in_stock',
          });
        }
      }
    }

    const [shopping, projects] = await Promise.all([api.listShopping(), api.listProjects()]);
    state.shopping = shopping;
    state.projects = projects;

    const savedId = saved.id;
    clearItemDraft();
    navigate('/shopping');
    state.sel = `item:${savedId}`;
    renderFn();
    toast(isNew ? `${payload.name} added to Shopping` : 'Saved');
  } catch (err) {
    toast(err.message);
  }
}

export async function removeItemWithUndo(itemId, renderFn) {
  const existing = shoppingById(itemId);
  if (!existing) return;
  const snap = clone(existing);
  try {
    await api.deleteShoppingItem(itemId);
    state.shopping = state.shopping.filter((s) => s.id !== itemId);
    state.projects = await api.listProjects();
    clearItemDraft();
    state.sel = null;
    navigate('/shopping');
    renderFn();
    toast(`${snap.name} removed`, async () => {
        try {
          await api.createShoppingItem({
            name: snap.name,
            category: snap.category || 'Sensors',
            quantity: snap.quantity || 1,
            status: snap.status || 'order',
            why_needed: snap.why_needed || '',
            notes: snap.notes || '',
            retailer: snap.retailer || '',
            price: snap.price || '',
            url: snap.url || '',
            electrical_facts: snap.electrical_facts || {},
            care_notes: snap.care_notes || [],
            offers: (snap.offers || []).map((o) => ({
              retailer: o.retailer,
              price: o.price,
              url: o.url,
              is_selected: o.is_selected,
              in_stock: o.in_stock || 'in_stock',
            })),
          });
          state.shopping = await api.listShopping();
          renderFn();
          toast(`${snap.name} restored`);
        } catch (err) {
          toast(err.message);
        }
      });
  } catch (err) {
    toast(err.message);
  }
}
