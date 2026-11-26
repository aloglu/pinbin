// Full-page Add / Edit Part screen (3-column desktop + live preview, sticky phone section picker).
import { api } from '../api.js';
import {
  state,
  CATEGORIES,
  G,
  CATG,
  esc,
  sv,
  caret,
  ph,
  tagChips,
  stepHtml,
  menuHtml,
  partById,
  toast,
  appHref,
  navigate,
} from '../state.js';
import { computeRelations, relHtml, careHtml } from '../rules.js';
import { secBarHtml } from '../secbar.js';

export const IFACES = ['I2C', 'SPI', 'UART', 'Analog', 'PWM', '1-Wire', 'Wi-Fi', 'BLE'];
const SEVS = [
  ['danger', '!', 'Can damage parts'],
  ['check', '?', 'Check first'],
  ['info', 'i', 'Good to know'],
];

const SECT_MAP = {
  photoPreview: 'photo',
  pinoutPreview: 'photo',
  image_path: 'photo',
  pinout_image_path: 'photo',
  url: 'photo',
  name: 'basics',
  sub: 'basics',
  cat: 'basics',
  qty: 'basics',
  bin: 'basics',
  logic: 'facts',
  ifaces: 'facts',
  vmin: 'facts',
  vmax: 'facts',
  io: 'facts',
  i2c: 'facts',
  outs: 'facts',
  what: 'about',
  visual_tell: 'about',
  care: 'care',
  specs: 'specs',
  notes: 'notes',
  sheet: 'notes',
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Keep pending uploaded File objects out of JSON.stringify snapshot
let pendingFiles = { photo: null, pinout: null };

export function clearPartDraft() {
  state.partDraft = null;
  state.partOrig = null;
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
  pendingFiles = { photo: null, pinout: null };
}

export function startPartEdit(partId) {
  const p = partId ? partById(partId) : null;
  const f = (p && p.electrical_facts) || {};
  pendingFiles = { photo: null, pinout: null };
  state.partDraft = {
    id: p ? p.id : '',
    name: p ? p.name || '' : '',
    sub: p ? p.subtitle || '' : '',
    cat: p ? p.category || 'Sensors' : 'Sensors',
    qty: p ? Number(p.quantity ?? 1) : 1,
    bin: p ? p.location || '' : '',
    image_path: p ? p.image_path || '' : '',
    pinout_image_path: p ? p.pinout_image_path || '' : '',
    pinout_svg: p ? p.pinout_svg || '' : '',
    photoPreview: p && p.image_path ? `/images/${encodeURIComponent(p.image_path)}` : '',
    pinoutPreview: p && p.pinout_image_path ? `/images/${encodeURIComponent(p.pinout_image_path)}` : '',
    removePhoto: false,
    removePinout: false,
    url: p ? p.source_url || '' : '',
    logic: f.logic || '',
    ifaces: Array.isArray(f.interfaces) ? [...f.interfaces] : [],
    vmin: Array.isArray(f.vin) ? String(f.vin[0]) : '',
    vmax: Array.isArray(f.vin) ? String(f.vin[1]) : '',
    io: f.io != null ? String(f.io) : '',
    i2c: f.i2c || '',
    outs: f.out ? Object.entries(f.out).map(([k, v]) => [k, String(v)]) : [],
    what: p ? p.what_it_does || '' : '',
    visual_tell: p ? p.visual_tell || '' : '',
    care: p && Array.isArray(p.care_notes) ? p.care_notes.map((c) => [c.severity || 'info', c.text || '']) : [],
    specs: p && p.specs ? Object.entries(p.specs).map(([k, v]) => [k, String(v)]) : [],
    notes: p ? p.notes || '' : '',
    sheet: p ? p.pinout_url || '' : '',
    _origFacts: clone(f),
  };
  state.partOrig = JSON.stringify(state.partDraft);
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
  state.fetchingStore = false;
}

export function setPendingPhoto(slot, file, previewUrl) {
  if (!state.partDraft) return;
  pendingFiles[slot] = file;
  if (slot === 'photo') {
    state.partDraft.photoPreview = previewUrl;
    state.partDraft.removePhoto = false;
  } else {
    state.partDraft.pinoutPreview = previewUrl;
    state.partDraft.removePinout = false;
  }
}

export function clearPhotoSlot(slot) {
  if (!state.partDraft) return;
  pendingFiles[slot] = null;
  if (slot === 'photo') {
    state.partDraft.photoPreview = '';
    state.partDraft.image_path = '';
    state.partDraft.removePhoto = true;
  } else {
    state.partDraft.pinoutPreview = '';
    state.partDraft.pinout_image_path = '';
    state.partDraft.pinout_svg = '';
    state.partDraft.removePinout = true;
  }
}

export function dirtyPartCount() {
  if (!state.partDraft || !state.partOrig) return 0;
  const orig = JSON.parse(state.partOrig);
  const cur = state.partDraft;
  return Object.keys(cur).filter(
    (k) => !k.startsWith('_') && k !== 'removePhoto' && k !== 'removePinout' && JSON.stringify(orig[k]) !== JSON.stringify(cur[k])
  ).length;
}

function dirtySections() {
  if (!state.partDraft || !state.partOrig) return new Set();
  const orig = JSON.parse(state.partOrig);
  const cur = state.partDraft;
  const out = new Set();
  for (const k of Object.keys(cur)) {
    if (SECT_MAP[k] && JSON.stringify(orig[k]) !== JSON.stringify(cur[k])) {
      out.add(SECT_MAP[k]);
    }
  }
  return out;
}

export function buildElectricalFacts(d) {
  if (d.logic === 'none') {
    const keepIf = (d.ifaces || []).filter((t) => !['I2C', 'SPI', 'UART', 'Analog', 'PWM', '1-Wire'].includes(t));
    return keepIf.length ? { logic: 'none', interfaces: keepIf } : { logic: 'none' };
  }
  const base = clone(d._origFacts || {});
  delete base.logic;
  delete base.interfaces;
  delete base.vin;
  delete base.io;
  delete base.i2c;
  delete base.out;

  if (d.logic) base.logic = d.logic;
  if (d.ifaces && d.ifaces.length) base.interfaces = [...d.ifaces];
  if (d.vmin !== '' && d.vmax !== '') {
    const a = Number(d.vmin);
    const b = Number(d.vmax);
    if (Number.isFinite(a) && Number.isFinite(b) && a <= b) base.vin = [a, b];
  }
  if (d.cat === 'Microcontrollers' && d.io !== '') {
    const io = Number(d.io);
    if (Number.isFinite(io) && io > 0) base.io = io;
  }
  const cleanI2c = String(d.i2c || '').trim();
  if (cleanI2c && /^0x[0-9a-f]{2}$/i.test(cleanI2c)) {
    base.i2c = `0x${cleanI2c.slice(2).toUpperCase()}`;
  }
  const outs = (d.outs || []).filter(([pin, v]) => String(pin || '').trim() && v !== '' && Number.isFinite(Number(v)));
  if (outs.length) {
    base.out = Object.fromEntries(outs.map(([pin, v]) => [String(pin).trim(), Number(v)]));
  }
  return base;
}

export function validatePartDraft(d) {
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

function dupHint(d) {
  if (!d || d.id || !d.name || d.name.trim().length < 3) return '';
  const q = d.name.trim().toLowerCase();
  const hit = state.parts.find(
    (p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase().split(' (')[0])
  );
  if (!hit) return '';
  return `You already have <b>${esc(hit.name)}</b>${hit.location ? ` in bin ${esc(hit.location)}` : ''}. <a href="${appHref(`/parts/${encodeURIComponent(hit.id)}/edit`)}">Edit that one instead</a>`;
}

function previewObj(d) {
  const ef = buildElectricalFacts(d);
  const tags = [];
  if (ef.logic && ef.logic !== 'none') tags.push(ef.logic);
  if (Array.isArray(ef.interfaces)) tags.push(...ef.interfaces);
  return {
    name: d.name || 'New part',
    category: d.cat,
    electrical_facts: ef,
    tags,
  };
}

export function renderFactsSummary() {
  const d = state.partDraft;
  if (!d) return '';
  const o = previewObj(d);
  const f = o.electrical_facts;
  const rels =
    f.vin || f.out || f.i2c || o.category === 'Microcontrollers'
      ? computeRelations(o, d.id || '__new')
      : [];
  return rels.length ? `<span class="k">With your other parts</span>${relHtml(rels.slice(0, 4))}` : '';
}

export function renderEditSidebar() {
  const d = state.partDraft;
  if (!d) return '';
  const o = previewObj(d);
  const f = o.electrical_facts;
  const rels =
    f.vin || f.out || f.i2c || o.category === 'Microcontrollers'
      ? computeRelations(o, d.id || '__new')
      : [];
  const careList = (d.care || [])
    .filter((c) => String(c[1] || '').trim())
    .map(([severity, text]) => ({ severity, text }));

  return `<div class="pv">
      <span class="k">Card preview</span>
      <div class="card">
        ${d.photoPreview ? `<div class="ph"><img src="${esc(d.photoPreview)}" alt=""></div>` : ph(CATG[d.cat] || 'proto')}
        <div class="b">
          <div>
            <div class="n">${esc(d.name || 'New part')}</div>
            <div class="sub2">${esc(d.sub || d.cat)}</div>
          </div>
          <div class="tags">${tagChips(o.tags)}</div>
          <div class="f">
            <span class="qty">×${d.qty}</span>
            ${d.bin ? `<span class="bin">${esc(d.bin.toUpperCase())}</span>` : '<span class="faint mono">no bin</span>'}
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

const fIn = (path, label, val, placeholder = '', hint = '', type = 'text') =>
  `<label class="ef"><span>${esc(label)}</span><input class="ei" type="${type}" data-f="${esc(path)}" value="${esc(val ?? '')}" placeholder="${esc(placeholder)}" ${
    type === 'number' ? 'inputmode="decimal" step="any"' : ''
  }>${hint ? `<em>${esc(hint)}</em>` : ''}<em class="err" data-err="${esc(path)}"></em></label>`;

const fNum = (path, label, val, unit, placeholder = '', hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><span class="inu"><input type="number" inputmode="decimal" step="any" data-f="${esc(path)}" value="${esc(val ?? '')}" placeholder="${esc(placeholder)}"><em>${esc(unit)}</em></span>${
    hint ? `<em>${esc(hint)}</em>` : ''
  }<em class="err" data-err="${esc(path)}"></em></label>`;

const fArea = (path, label, val, placeholder = '', rows = 3, hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><textarea class="ei" data-f="${esc(path)}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(val || '')}</textarea>${
    hint ? `<em>${esc(hint)}</em>` : ''
  }</label>`;

const esec = (id, title, desc, body) =>
  `<section class="esec" id="e-${esc(id)}"><div class="esh"><h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>${body}</section>`;

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
            if (typ === 'sev') return sevMenu(`sev-${key}-${i}`, r[ci]);
            if (typ === 'area') {
              return `<textarea class="ei grow" rows="1" style="flex:${flex}" data-row="${esc(key)}|${i}|${ci}" placeholder="${esc(placeholder)}">${esc(r[ci] ?? '')}</textarea>`;
            }
            if (typ === 'num') {
              return `<span class="inu" style="flex:${flex}"><input type="number" inputmode="decimal" step="any" data-row="${esc(key)}|${i}|${ci}" value="${esc(r[ci] ?? '')}" placeholder="${esc(placeholder)}"><em>V</em></span>`;
            }
            return `<input class="ei" style="flex:${flex}" data-row="${esc(key)}|${i}|${ci}" value="${esc(r[ci] ?? '')}" placeholder="${esc(placeholder)}">`;
          })
          .join('')}<button class="btn quiet xbtn" type="button" data-delrow="${esc(key)}|${i}" aria-label="Remove">${sv('<path d="M18 6 6 18M6 6l12 12"/>')}</button></div>`
    )
    .join('')}<button class="addrow" type="button" data-addrow="${esc(key)}">+ ${esc(addLabel)}</button></div>`;
}

export function renderPartEditView(partId) {
  if (!state.partDraft || state.partDraft.id !== (partId || '')) {
    startPartEdit(partId || '');
  }
  const d = state.partDraft;
  const n = dirtyPartCount();
  const isEdit = Boolean(d.id);
  const title = isEdit ? 'Edit part' : 'Add a part';
  const navs = [
    ['photo', 'Photos'],
    ['basics', 'Basics'],
    ['facts', 'Electrical facts'],
    ['about', 'What it is for'],
    ['care', 'Handle with care'],
    ['specs', 'Specs'],
    ['notes', 'Notes and links'],
    ['danger', isEdit ? 'Remove' : ''],
  ].filter(([, label]) => Boolean(label));

  // Bins grouped into same-category suggestions + other bins
  const allBins = [...new Set(state.parts.map((p) => (p.location || '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const sugBins = [
    ...new Set(
      state.parts
        .filter((p) => p.category === d.cat && p.id !== d.id && (p.location || '').trim())
        .map((p) => p.location.trim())
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const restBins = allBins.filter((b) => !sugBins.includes(b));
  const binChip = (b) =>
    `<button type="button" class="bin ${d.bin.trim().toLowerCase() === b.toLowerCase() ? 'on' : ''}" data-binset="${esc(b)}">${esc(b)}</button>`;

  const hasPinoutPreview = Boolean(d.pinoutPreview || d.pinout_svg);
  const pinoutBox = d.pinoutPreview
    ? `<div class="ph big"><img src="${esc(d.pinoutPreview)}" alt="Pinout photo"></div>`
    : d.pinout_svg
    ? `<div class="ph big" style="padding:8px;background:var(--raised);border:1px solid var(--line)">${d.pinout_svg}</div>`
    : `<label class="ph big drop"><span>Optional. The pin labels, or the seller’s pinout image. Your assistant can find it for you.</span><input type="file" accept="image/*" data-photo="pinout" hidden></label>`;

  const usedIn = isEdit
    ? state.projects.filter((pr) => !pr.archived && (pr.items || []).some((q) => q.part_id === d.id))
    : [];

  let body = '';

  body += esec(
    'photo',
    'Photos',
    'A clear photo of the part on your bench is the fastest way to find it again.',
    `<div class="photos2">
      <div class="photoed">
        <span class="k">Photo</span>
        ${
          d.photoPreview
            ? `<div class="ph big"><img src="${esc(d.photoPreview)}" alt="Part photo"></div>`
            : `<label class="ph big drop">${sv(G[CATG[d.cat]] || G.proto)}<span>Tap to add a photo, or paste one</span><input type="file" accept="image/*" capture="environment" data-photo="photo" hidden></label>`
        }
        <div class="pacts">
          <label class="btn">${d.photoPreview ? 'Replace' : 'Upload or take photo'}<input type="file" accept="image/*" capture="environment" data-photo="photo" hidden></label>
          ${d.photoPreview ? '<button class="btn quiet" type="button" data-unphoto="photo">Remove</button>' : ''}
        </div>
      </div>
      <div class="photoed">
        <span class="k">Pinout or label</span>
        ${pinoutBox}
        <div class="pacts">
          <label class="btn">${hasPinoutPreview ? 'Replace' : 'Upload'}<input type="file" accept="image/*" data-photo="pinout" hidden></label>
          ${hasPinoutPreview ? '<button class="btn quiet" type="button" data-unphoto="pinout">Remove</button>' : ''}
        </div>
      </div>
    </div>
    <div class="ef">
      <span>Store page</span>
      <div class="urlrow">
        <input class="ei" data-f="url" value="${esc(d.url)}" placeholder="https://www.direnc.net/…" inputmode="url">
        <button class="btn" type="button" data-fetchstore ${state.fetchingStore ? 'disabled' : ''}>${
          state.fetchingStore ? 'Reading page…' : 'Get photo and details'
        }</button>
      </div>
      <em>Pinbin reads the photo and name from it. Your assistant can fill in the rest: electrical facts, care notes and the pinout image.</em>
    </div>`
  );

  body += esec(
    'basics',
    'Basics',
    '',
    `${fIn('name', 'Name', d.name, 'e.g. BME280 sensor board')}
     <p class="duphint" data-hint="name">${dupHint(d)}</p>
     ${fIn('sub', 'Short description', d.sub, 'e.g. Temperature, humidity and pressure')}
     <div class="egrid2">
       <div class="ef"><span>Category</span>${menuHtml('dcat', '', d.cat, CATEGORIES.map((c) => [c, c, d.cat === c]))}</div>
       <div class="ef"><span>How many you own</span>${stepHtml('data-dqty', 'qty', d.qty, 'Quantity')}</div>
     </div>
     <div class="ef">
       <span>Bin</span>
       <div class="binpick">
         <input class="ei" data-f="bin" value="${esc(d.bin)}" placeholder="New bin" style="width:140px" aria-label="Bin">
         ${
           allBins.length
             ? `<span class="brk"></span>${
                 sugBins.length
                   ? `<span class="bgl">${esc(d.cat)} live in</span>${sugBins.map(binChip).join('')}${
                       restBins.length ? '<span class="bgl">Other bins</span>' : ''
                     }`
                   : ''
               }${restBins.map(binChip).join('')}`
             : ''
         }
       </div>
       <em>Pick a bin, or type a new one.</em>
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
           .map(([v, t]) => `<button type="button" data-dset="logic|${v}" aria-pressed="${d.logic === v}">${t}</button>`)
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
                (t) => `<button type="button" class="tag f" data-dtoggle="ifaces|${esc(t)}" aria-pressed="${d.ifaces.includes(t)}">${esc(t)}</button>`
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
            <div class="factsum" aria-live="polite">${renderFactsSummary()}</div>`
     }`
  );

  body += esec(
    'about',
    'What it is for',
    'One or two plain sentences.',
    `${fArea('what', 'Description', d.what, 'e.g. Measures distance by timing the echo of a sound pulse.', 3)}
     ${fIn('visual_tell', 'How to spot it in a bin', d.visual_tell, 'e.g. Tiny black half-cylinder with 3 legs')}`
  );

  body += esec(
    'care',
    'Handle with care',
    'Warnings shown on the part and in every project that uses it.',
    rowsEditor(
      'care',
      d.care,
      [[0, '', 0, 'sev'], [1, 'e.g. ECHO sends back 5 V. Use a divider on 3.3 V boards.', 1, 'area']],
      'Add a care note'
    )
  );

  body += esec(
    'specs',
    'Specs',
    'Anything else worth knowing at a glance.',
    rowsEditor('specs', d.specs, [[0, 'Name, e.g. Range', 1], [1, 'Value, e.g. 2–400 cm', 2]], 'Add a spec')
  );

  body += esec(
    'notes',
    'Notes and links',
    '',
    `${fArea('notes', 'Notes', d.notes, 'Anything you learned while using it.', 4, '### heading · - list · `code` · **bold**')}
     ${fIn('sheet', 'Datasheet or pinout link', d.sheet, 'https://…', '', 'url')}`
  );

  if (isEdit) {
    body += esec(
      'danger',
      'Remove this part',
      '',
      `<div class="dz">
        <p>${
          usedIn.length
            ? `It is used in <b>${usedIn.map((pr) => esc(pr.name)).join(', ')}</b>. Removing it unlinks it from those projects.`
            : 'It is not used in any project.'
        } You can undo for a few seconds.</p>
        <button class="btn dangerout" type="button" data-premove="${esc(d.id)}">Remove from inventory</button>
      </div>`
    );
  }

  return `<div class="screen full"><div class="work edit">
    <div class="ehead">
      <a class="eback" href="${appHref('/inventory')}" data-leave="/inventory" title="Back to Inventory">← Inventory</a>
      <h1>${esc(title)}</h1>
    </div>
    ${secBarHtml('edit', navs, navs[0][0])}
    <div class="egrid">
      <nav class="enav" aria-label="Sections">
        ${navs.map(([k, label]) => `<a href="${esc(location.pathname)}" data-jump="e-${esc(k)}">${esc(label)}</a>`).join('')}
      </nav>
      <div class="eform">${body}</div>
      <aside class="eside">${renderEditSidebar()}</aside>
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
              : `<a class="btn" href="${appHref('/inventory')}" data-leave="/inventory">Cancel</a>
                 <button class="btn ink" type="button" data-esave ${n || !isEdit ? '' : 'disabled'}>${
                  isEdit ? 'Save changes' : 'Add part'
                }</button>`
          }
        </div>
      </div>
    </div>
  </div></div>`;
}

export function autosizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

export function refreshPartEditBits() {
  const d = state.partDraft;
  if (!d) return;
  const n = dirtyPartCount();
  const allErrs = validatePartDraft(d);
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
  const saveBtn = document.querySelector('[data-esave]');
  if (saveBtn) saveBtn.disabled = Boolean(d.id) && !n && !ne;

  document.querySelectorAll('[data-err]').forEach((el) => {
    const key = el.dataset.err;
    el.textContent = shownErrs[key] || '';
    const inp = el.parentElement && el.parentElement.querySelector('input');
    if (inp) inp.setAttribute('aria-invalid', shownErrs[key] ? 'true' : 'false');
  });

  const dh = document.querySelector('[data-hint="name"]');
  if (dh) dh.innerHTML = dupHint(d);

  const ds = dirtySections();
  document.querySelectorAll('.enav a').forEach((a) => a.classList.toggle('chg', ds.has(a.dataset.jump.slice(2))));
  document.querySelectorAll('[data-sbgo]').forEach((b) => b.classList.toggle('chg', ds.has(b.dataset.sbgo)));
  document.querySelectorAll('[data-sbseg]').forEach((g) => g.classList.toggle('chg', ds.has(g.dataset.sbseg)));

  const side = document.querySelector('.eside');
  if (side) side.innerHTML = renderEditSidebar();
  const fs = document.querySelector('.factsum');
  if (fs) fs.innerHTML = renderFactsSummary();
}

export async function scrapeStoreIntoDraft(renderFn) {
  const d = state.partDraft;
  if (!d) return;
  const url = String(d.url || '').trim();
  if (!url) {
    toast('Paste the store page link first.');
    const f = document.querySelector('[data-f="url"]');
    if (f) f.focus();
    return;
  }
  state.fetchingStore = true;
  renderFn();
  try {
    const res = await api.scrapeUrl(url, null, 'main');
    if (res.image_path) {
      d.image_path = res.image_path;
      d.photoPreview = res.image_url || `/images/${encodeURIComponent(res.image_path)}`;
      d.removePhoto = false;
      pendingFiles.photo = null;
    }
    if (!d.name.trim() && res.title) d.name = res.title;
    if (!d.what.trim() && res.description) d.what = res.description.slice(0, 240);
    toast(res.image_path ? 'Got photo and details from store page' : 'Got page details (no photo found)');
  } catch (err) {
    toast(err.message);
  } finally {
    state.fetchingStore = false;
    renderFn();
  }
}

export async function savePartEdit(renderFn) {
  const d = state.partDraft;
  if (!d) return;
  const errs = validatePartDraft(d);
  if (Object.keys(errs).length) {
    state.triedSave = true;
    refreshPartEditBits();
    const firstBad = document.querySelector('[aria-invalid="true"]');
    if (firstBad) {
      firstBad.focus();
      firstBad.scrollIntoView({ block: 'center' });
    }
    return;
  }

  const careNotes = (d.care || [])
    .filter((c) => String(c[1] || '').trim())
    .map(([severity, text]) => ({ severity: severity || 'info', text: String(text).trim() }));
  const specsObj = Object.fromEntries(
    (d.specs || [])
      .filter(([k, v]) => String(k || '').trim() && String(v || '').trim())
      .map(([k, v]) => [String(k).trim(), String(v).trim()])
  );

  const payload = {
    name: d.name.trim(),
    subtitle: d.sub.trim(),
    category: d.cat,
    quantity: Math.max(0, Number(d.qty) || 0),
    location: d.bin.trim(),
    what_it_does: d.what.trim(),
    visual_tell: d.visual_tell.trim(),
    notes: d.notes.trim(),
    source_url: d.url.trim(),
    pinout_url: d.sheet.trim(),
    specs: specsObj,
    electrical_facts: buildElectricalFacts(d),
    care_notes: careNotes,
  };
  if (d.image_path && !pendingFiles.photo) payload.image_path = d.image_path;
  if (d.removePinout) payload.pinout_svg = '';

  const isNew = !d.id;
  try {
    let saved = isNew ? await api.createPart(payload) : await api.patchPart(d.id, payload);

    // Handle photo upload / removal cleanly after save
    if (pendingFiles.photo) {
      saved = await api.uploadPartPhoto(saved.id, pendingFiles.photo, 'main');
    } else if (!isNew && d.removePhoto && !d.image_path) {
      saved = await api.deletePartPhoto(saved.id, 'main');
    }

    if (pendingFiles.pinout) {
      saved = await api.uploadPartPhoto(saved.id, pendingFiles.pinout, 'pinout');
    } else if (!isNew && d.removePinout && !d.pinout_image_path) {
      saved = await api.deletePartPhoto(saved.id, 'pinout');
    }

    if (isNew) {
      state.parts.unshift(saved);
    } else {
      const idx = state.parts.findIndex((p) => p.id === saved.id);
      if (idx >= 0) state.parts[idx] = saved;
    }

    clearPartDraft();
    navigate('/inventory');
    state.sel = `part:${saved.id}`;
    renderFn();
    toast(isNew ? `${saved.name} added` : 'Saved');
  } catch (err) {
    toast(err.message);
  }
}

export async function removePartWithUndo(partId, renderFn) {
  const existing = partById(partId);
  if (!existing) return;
  const snapshot = clone(existing);
  try {
    await api.deletePart(partId);
    state.parts = state.parts.filter((p) => p.id !== partId);
    state.projects = await api.listProjects();
    clearPartDraft();
    navigate('/inventory');
    renderFn();
    toast(`${snapshot.name} removed`, async () => {
        try {
          const restored = await api.createPart({
            name: snapshot.name,
            subtitle: snapshot.subtitle,
            category: snapshot.category,
            quantity: snapshot.quantity,
            location: snapshot.location,
            what_it_does: snapshot.what_it_does,
            visual_tell: snapshot.visual_tell,
            notes: snapshot.notes,
            source_url: snapshot.source_url,
            pinout_url: snapshot.pinout_url,
            pinout_svg: snapshot.pinout_svg,
            specs: snapshot.specs,
            electrical_facts: snapshot.electrical_facts,
            care_notes: snapshot.care_notes,
          });
          state.parts.unshift(restored);
          renderFn();
          toast(`${restored.name} restored`);
        } catch (err) {
          toast(err.message);
        }
      });
  } catch (err) {
    toast(err.message);
  }
}
