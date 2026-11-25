// Full-page Add / Edit Project screen (Basics, Parts, Wiring, Notes, Delete).
import { api } from '../api.js';
import {
  state,
  esc,
  sv,
  ph,
  phPart,
  glyphFor,
  menuHtml,
  partById,
  shoppingById,
  projectById,
  currencyLabel,
  toast,
} from '../state.js';
import { secBarHtml } from '../secbar.js';
import { mdLite } from './projects.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

const ROLES = [
  ['power', 'Power'],
  ['mcu', 'Brain'],
  ['periph', 'Part'],
  ['material', 'Material'],
];

const NET_KINDS = [
  ['sig', 'Signal'],
  ['i2c', 'I2C'],
  ['spi', 'SPI'],
  ['v33', '3.3 V'],
  ['v5', '5 V'],
  ['bat', 'Battery'],
];

const SECT_MAP = {
  name: 'basics',
  desc: 'basics',
  option: 'basics',
  tags: 'basics',
  parts: 'parts',
  nets: 'wiring',
  notes: 'notes',
};

const IGNORED_KEYS = new Set(['newNet', 'adding', 'q', 'newItems', 'buyName', 'buyPrice']);

export function clearProjectDraft() {
  state.projDraft = null;
  state.projOrig = null;
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
}

export function startProjectEdit(projectId) {
  const p = projectId ? projectById(projectId) : null;
  state.projDraft = {
    id: p ? p.id : '',
    name: p ? p.name || '' : '',
    desc: p ? p.description || '' : '',
    option: p ? p.option || p.option_label || '' : '',
    tags: p && Array.isArray(p.tags) ? [...p.tags] : [],
    notes: p ? p.notes || '' : '',
    parts: p
      ? (p.items || []).map((q) => ({
          item_id: q.id,
          ref: q.ref,
          part_id: q.part_id || null,
          shopping_item_id: q.shopping_item_id || null,
          role: q.role || 'periph',
          label: q.label || '',
          note: q.project_notes || '',
          quantity_needed: q.quantity_needed || 1,
        }))
      : [],
    nets: p ? clone(p.nets || []) : [],
    newNet: { kind: 'sig', a: '', ap: '', b: '', bp: '' },
    adding: null,
    q: '',
    buyName: '',
    buyPrice: '',
    newItems: {},
  };
  state.projOrig = JSON.stringify(state.projDraft);
  state.leaveTo = null;
  state.touched = {};
  state.triedSave = false;
}

export function dirtyProjectCount() {
  if (!state.projDraft || !state.projOrig) return 0;
  const a = JSON.parse(state.projOrig);
  const b = state.projDraft;
  return Object.keys(b).filter((k) => !IGNORED_KEYS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
}

function dirtySections() {
  if (!state.projDraft || !state.projOrig) return new Set();
  const a = JSON.parse(state.projOrig);
  const b = state.projDraft;
  const out = new Set();
  for (const k of Object.keys(b)) {
    if (SECT_MAP[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.add(SECT_MAP[k]);
  }
  return out;
}

export function validateProjectDraft(d) {
  const e = {};
  if (!d) return e;
  if (!String(d.name || '').trim()) e.name = 'Needs a name.';
  return e;
}

function itemRecord(d, q) {
  if (q.part_id) {
    const pt = partById(q.part_id);
    return {
      name: pt ? pt.name : 'Unknown part',
      owned: true,
      obj: pt,
    };
  }
  const pending = q.shopping_item_id && d.newItems ? d.newItems[q.shopping_item_id] : null;
  const it = pending || shoppingById(q.shopping_item_id);
  return {
    name: it ? it.name : 'Item to buy',
    owned: false,
    obj: it,
  };
}

function nextFreeRef(parts) {
  const used = new Set((parts || []).map((p) => p.ref));
  let i = (parts || []).length + 1;
  while (used.has(`n${i}`)) i += 1;
  return `n${i}`;
}

export function addOwnedPartToProjectDraft(partId) {
  const d = state.projDraft;
  const pt = partById(partId);
  if (!d || !pt) return;
  if (d.parts.some((q) => q.part_id === partId)) return;
  const role =
    pt.category === 'Microcontrollers'
      ? 'mcu'
      : pt.category === 'Prototyping' || pt.category === 'Tools'
      ? 'material'
      : 'periph';
  d.parts.push({
    item_id: null,
    ref: nextFreeRef(d.parts),
    part_id: partId,
    shopping_item_id: null,
    role,
    label: '',
    note: '',
    quantity_needed: 1,
  });
  d.adding = null;
  d.q = '';
}

export function addNewBuyItemToProjectDraft() {
  const d = state.projDraft;
  if (!d) return;
  const name = String(d.buyName || '').trim();
  if (!name) return;
  const rawPrice = String(d.buyPrice || '').trim();
  const priceText = rawPrice ? `${rawPrice} ${currencyLabel()}` : '';
  const tempId = `newbuy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  d.newItems[tempId] = {
    id: tempId,
    name,
    price: priceText,
    quantity: 1,
    category: 'Sensors',
    status: 'order',
  };
  d.parts.push({
    item_id: null,
    ref: nextFreeRef(d.parts),
    part_id: null,
    shopping_item_id: tempId,
    role: 'periph',
    label: '',
    note: '',
    quantity_needed: 1,
  });
  d.buyName = '';
  d.buyPrice = '';
  d.adding = null;
}

export function addNetToProjectDraft() {
  const d = state.projDraft;
  if (!d || !d.newNet.a || !d.newNet.b) return;
  const { kind, a, ap, b, bp } = d.newNet;
  const refs = d.parts.map((q) => [q.ref, q.label || itemRecord(d, q).name]);
  const nameOf = (ref) => (refs.find((x) => x[0] === ref) || [ref, ref])[1];
  const netName =
    kind === 'v33'
      ? '3.3 V power'
      : kind === 'v5'
      ? '5 V power'
      : kind === 'bat'
      ? 'Battery power'
      : kind === 'i2c'
      ? 'I2C bus'
      : kind === 'spi'
      ? 'SPI bus'
      : `${nameOf(a)} → ${nameOf(b)}`;

  d.nets.push({
    id: `net-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    name: netName,
    kind,
    rail: kind === 'v33' ? 3.3 : kind === 'v5' ? 5 : null,
    wake: false,
    conns: [
      [a, String(ap || '').trim()],
      [b, String(bp || '').trim()],
    ],
  });
  d.newNet = { kind, a: '', ap: '', b: '', bp: '' };
}

const fIn = (path, label, val, placeholder = '', hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><input class="ei" type="text" data-pf="${esc(path)}" value="${esc(
    val ?? ''
  )}" placeholder="${esc(placeholder)}">${hint ? `<em>${esc(hint)}</em>` : ''}<em class="err" data-err="${esc(
    path
  )}"></em></label>`;

const fArea = (path, label, val, placeholder = '', rows = 3, hint = '') =>
  `<label class="ef"><span>${esc(label)}</span><textarea class="ei" data-pf="${esc(path)}" rows="${rows}" placeholder="${esc(
    placeholder
  )}">${esc(val || '')}</textarea>${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;

const esec = (id, title, desc, body) =>
  `<section class="esec" id="e-${esc(id)}"><div class="esh"><h2>${esc(title)}</h2>${
    desc ? `<p>${esc(desc)}</p>` : ''
  }</div>${body}</section>`;

export function renderProjectEditView(projectId) {
  if (!state.projDraft || state.projDraft.id !== (projectId || '')) {
    startProjectEdit(projectId || '');
  }
  const d = state.projDraft;
  const isEdit = Boolean(d.id);
  const proj = isEdit ? projectById(d.id) : null;
  const n = dirtyProjectCount();
  const backHref = isEdit ? `p-${d.id}` : 'projects';
  const backLabel = isEdit && proj ? proj.name : 'Projects';
  const title = isEdit ? 'Edit project' : 'New project';

  const navs = [
    ['basics', 'Basics'],
    ['parts', 'Parts'],
    ['wiring', 'Wiring'],
    ['notes', 'Notes'],
    ['danger', isEdit ? 'Delete' : ''],
  ].filter(([, label]) => Boolean(label));

  const refs = d.parts.map((q) => [q.ref, q.label || itemRecord(d, q).name]);
  const curLabel = currencyLabel();

  let body = '';

  // Basics
  body += esec(
    'basics',
    'Basics',
    '',
    `${fIn('name', 'Name', d.name, 'e.g. Desk weather station')}
     ${fArea('desc', 'What it is', d.desc, 'One or two sentences about what you are building.', 2)}
     ${fIn('option', 'Build option', d.option, 'e.g. Color IPS screen', 'Leave empty if there is only one way to build it.')}
     <div class="ef">
       <span>Tags</span>
       <div class="chips">
         ${d.tags
           .map(
             (t) =>
               `<span class="tag">${esc(t)}<button type="button" data-dtagdel="${esc(t)}" aria-label="Remove ${esc(
                 t
               )}">×</button></span>`
           )
           .join('')}
         <form class="tagadd" data-dtagform><input name="tag" placeholder="+ tag" autocomplete="off" aria-label="Add a tag"></form>
       </div>
     </div>`
  );

  // Parts
  const qSearch = String(d.q || '').trim().toLowerCase();
  const pickParts = state.parts
    .filter(
      (x) =>
        !d.parts.some((q) => q.part_id === x.id) &&
        (!qSearch || `${x.name} ${x.subtitle || ''} ${x.location || ''}`.toLowerCase().includes(qSearch))
    )
    .slice(0, 10);

  body += esec(
    'parts',
    'Parts',
    'Rename a part for this project, change its role, or add a note on how it is used here.',
    `<div class="rows">
      ${d.parts
        .map((q, i) => {
          const rec = itemRecord(d, q);
          const roleText = (ROLES.find(([v]) => v === q.role) || ROLES[2])[1];
          return `<div class="prow2">
            <div class="pr-top">
              ${rec.obj && rec.obj.image_path ? phPart(rec.obj) : ph(glyphFor(rec.obj || {}))}
              <div>
                <b>${esc(rec.name)}</b>
                <span class="faint">${rec.owned ? 'from your bins' : 'to buy'}</span>
              </div>
              <span class="rolem">${menuHtml(
                `prole-${i}`,
                'Role',
                roleText,
                ROLES.map(([v, t]) => [v, t, q.role === v])
              )}</span>
              <button class="btn quiet xbtn" type="button" data-pdelrow="parts|${i}" aria-label="Remove from project">${sv(
            '<path d="M18 6 6 18M6 6l12 12"/>'
          )}</button>
            </div>
            <div class="egrid2">
              ${fIn(`parts.${i}.label`, 'Name in this project', q.label, rec.name)}
              ${fIn(`parts.${i}.note`, 'How it is used here', q.note, '')}
            </div>
          </div>`;
        })
        .join('')}

      <div class="addpart">
        ${
          d.adding === 'buy'
            ? `<div class="buyadd">
                <label class="ef"><span>Name</span><input class="ei" data-pf="buyName" value="${esc(
                  d.buyName
                )}" placeholder="e.g. 1N5817 diode" autocomplete="off"></label>
                <label class="ef"><span>Price</span><span class="inu"><input type="number" inputmode="decimal" step="any" data-pf="buyPrice" value="${esc(
                  d.buyPrice
                )}" placeholder="0"><em>${esc(curLabel)}</em></span></label>
                <button class="btn ink" type="button" data-buyadd ${
                  String(d.buyName).trim() ? '' : 'disabled'
                }>Add to project</button>
                <p class="faint">It also goes on your shopping list. Add more stores there.</p>
              </div>`
            : ''
        }
        ${
          d.adding === 'own'
            ? `<input class="ei" data-pf="q" value="${esc(d.q || '')}" placeholder="Search your parts" autocomplete="off">
               <div class="picklist">${
                 pickParts.length
                   ? pickParts
                       .map(
                         (x) =>
                           `<button type="button" class="mini" data-padd="${esc(x.id)}">${phPart(x)}<span><b>${esc(
                             x.name
                           )}</b><span class="faint">You own ${x.quantity}${
                             x.location ? ` · ${esc(x.location)}` : ''
                           }</span></span></button>`
                       )
                       .join('')
                   : '<p class="faint">No matching parts left to add.</p>'
               }</div>`
            : ''
        }
        <div class="addsplit">
          <button class="addrow" type="button" data-adding="own" aria-pressed="${d.adding === 'own'}">+ From your parts</button>
          <button class="addrow" type="button" data-adding="buy" aria-pressed="${d.adding === 'buy'}">+ Something to buy</button>
        </div>
      </div>
    </div>`
  );

  // Wiring
  const nnKindText = (NET_KINDS.find(([v]) => v === d.newNet.kind) || NET_KINDS[0])[1];
  const nnAText = d.newNet.a ? (refs.find((x) => x[0] === d.newNet.a) || [null, 'Choose'])[1] : 'Choose';
  const nnBText = d.newNet.b ? (refs.find((x) => x[0] === d.newNet.b) || [null, 'Choose'])[1] : 'Choose';

  body += esec(
    'wiring',
    'Wiring',
    'Which pins connect to which. Add connections yourself, or let your assistant write them. The built-in checks run on them when you save.',
    `<div class="rows">
      ${d.nets
        .map(
          (nt, i) =>
            `<div class="erow wire">
              <i class="wsw" style="background:var(--${esc(nt.kind || 'sig')})"></i>
              <div style="flex:1;min-width:0">
                <b>${esc(nt.name)}</b>
                <span class="faint mono">${(nt.conns || [])
                  .map(([r, pin]) => `${esc((refs.find((x) => x[0] === r) || [r, r])[1])} ${esc(pin || '')}`)
                  .join(' → ')}</span>
              </div>
              <button class="btn quiet xbtn" type="button" data-pdelrow="nets|${i}" aria-label="Remove connection">${sv(
              '<path d="M18 6 6 18M6 6l12 12"/>'
            )}</button>
            </div>`
        )
        .join('')}

      <div class="newnet">
        <span class="nnl">Add a connection</span>
        <div class="nn">
          ${menuHtml('nnk', 'Carries', nnKindText, NET_KINDS.map(([v, t]) => [v, t, d.newNet.kind === v]))}
          ${menuHtml('nna', 'From', nnAText, refs.map(([r, nm]) => [r, nm, d.newNet.a === r]))}
          <input class="ei" data-pf="newNet.ap" value="${esc(d.newNet.ap)}" placeholder="Pin" aria-label="From pin">
          ${menuHtml('nnb', 'To', nnBText, refs.map(([r, nm]) => [r, nm, d.newNet.b === r]))}
          <input class="ei" data-pf="newNet.bp" value="${esc(d.newNet.bp)}" placeholder="Pin" aria-label="To pin">
          <button class="btn" type="button" data-netadd ${d.newNet.a && d.newNet.b ? '' : 'disabled'}>Add</button>
        </div>
      </div>
    </div>`
  );

  // Notes
  body += esec(
    'notes',
    'Notes',
    'Layout, power saving, anything you want to remember. Safety warnings live on the map, not here.',
    `${fArea('notes', 'Notes', d.notes, '### Layout\n- Write project notes here…', 8, '### heading · - list · `code` · **bold**')}
     <div class="mdprev"><span class="k">Preview</span><div class="notes" id="mdPreview">${mdLite(d.notes)}</div></div>`
  );

  // Delete
  if (isEdit && proj) {
    body += esec(
      'danger',
      'Delete project',
      '',
      `<div class="dz">
        <p>The project, its wiring and notes go. <b>Parts you own stay in Inventory.</b> Items you have not bought stay in Shopping. You can undo for a few seconds. Archiving keeps it instead.</p>
        <div class="chips">
          <button class="btn" type="button" data-archive="${esc(d.id)}">${proj.archived ? 'Restore' : 'Archive instead'}</button>
          <button class="btn dangerout" type="button" data-projdelete="${esc(d.id)}">Delete project</button>
        </div>
      </div>`
    );
  }

  return `<div class="screen full"><div class="work edit">
    <div class="ehead noside">
      <a class="eback" href="#${esc(backHref)}" data-leave="${esc(backHref)}" title="Back to ${esc(backLabel)}">← ${esc(backLabel)}</a>
      <h1>${esc(title)}</h1>
    </div>
    ${secBarHtml('edit', navs, navs[0][0])}
    <div class="egrid noside">
      <nav class="enav" aria-label="Sections">
        ${navs.map(([k, label]) => `<a href="#e-${esc(k)}" data-jump="e-${esc(k)}">${esc(label)}</a>`).join('')}
      </nav>
      <div class="eform">${body}</div>
    </div>
    <div class="savebar ${n || state.leaveTo ? '' : 'idle'}">
      <div class="sb-grid noside">
        <span></span>
        <div class="sb-in">
          <span id="dirty" class="${n ? '' : 'faint'}">${n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes yet'}</span>
          <span style="flex:1"></span>
          ${
            state.leaveTo
              ? `<span class="leaveq">Leave without saving?</span>
                 <button class="btn" type="button" data-stay>Keep editing</button>
                 <button class="btn dangerout" type="button" data-discard>Discard changes</button>`
              : `<a class="btn" href="#${esc(backHref)}" data-leave="${esc(backHref)}">Cancel</a>
                 <button class="btn ink" type="button" data-psave ${n || !isEdit ? '' : 'disabled'}>${
                  isEdit ? 'Save changes' : 'Create project'
                }</button>`
          }
        </div>
      </div>
    </div>
  </div></div>`;
}

export function refreshProjectEditBits() {
  const d = state.projDraft;
  if (!d) return;
  const n = dirtyProjectCount();
  const allErrs = validateProjectDraft(d);
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
  const saveBtn = document.querySelector('[data-psave]');
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

  const mdPrev = document.getElementById('mdPreview');
  if (mdPrev) mdPrev.innerHTML = mdLite(d.notes);

  const buyBtn = document.querySelector('[data-buyadd]');
  if (buyBtn) buyBtn.disabled = !String(d.buyName || '').trim();
}

export async function saveProjectEdit(renderFn) {
  const d = state.projDraft;
  if (!d) return;
  const errs = validateProjectDraft(d);
  if (Object.keys(errs).length) {
    state.triedSave = true;
    refreshProjectEditBits();
    const firstBad = document.querySelector('[aria-invalid="true"]');
    if (firstBad) {
      firstBad.focus();
      firstBad.scrollIntoView({ block: 'center' });
    }
    return;
  }

  const isNew = !d.id;
  try {
    // 1. Create or update the project itself
    const metaPayload = {
      name: d.name.trim(),
      description: d.desc.trim(),
      option: d.option.trim(),
      tags: d.tags,
      notes: d.notes.trim(),
    };
    const proj = isNew ? await api.createProject(metaPayload) : await api.patchProject(d.id, metaPayload);
    const pid = proj.id;

    // 2. Create any new "Something to buy" shopping items
    const tempToRealShopId = {};
    for (const [tempId, item] of Object.entries(d.newItems || {})) {
      if (!d.parts.some((q) => q.shopping_item_id === tempId)) continue;
      const created = await api.createShoppingItem({
        name: item.name,
        category: item.category || 'Sensors',
        quantity: item.quantity || 1,
        price: item.price || '',
        status: 'order',
        why_needed: `Needed for ${d.name.trim()}`,
      });
      tempToRealShopId[tempId] = created.id;
    }

    // 3. Diff project items: delete removed, update existing, add new
    const origItems = isNew ? [] : (projectById(pid)?.items || []);
    const keptItemIds = new Set(d.parts.map((q) => q.item_id).filter(Boolean));
    for (const old of origItems) {
      if (!keptItemIds.has(old.id)) {
        await api.deleteProjectItem(pid, old.id);
      }
    }

    for (const q of d.parts) {
      const realShopId = q.shopping_item_id ? tempToRealShopId[q.shopping_item_id] || q.shopping_item_id : null;
      if (q.item_id) {
        const old = origItems.find((x) => x.id === q.item_id);
        if (
          !old ||
          old.role !== q.role ||
          (old.label || '') !== (q.label || '') ||
          (old.project_notes || '') !== (q.note || '') ||
          old.ref !== q.ref
        ) {
          await api.patchProjectItem(pid, q.item_id, {
            ref: q.ref,
            role: q.role,
            label: q.label.trim(),
            project_notes: q.note.trim(),
          });
        }
      } else {
        await api.addProjectItem(pid, {
          part_id: q.part_id || null,
          shopping_item_id: realShopId,
          ref: q.ref,
          role: q.role,
          label: q.label.trim(),
          quantity_needed: q.quantity_needed || 1,
          project_notes: q.note.trim(),
        });
      }
    }

    // 4. Replace wiring nets (filtering out refs that were removed)
    const keepRefs = new Set(d.parts.map((q) => q.ref));
    const cleanNets = (d.nets || [])
      .map((nt) => ({
        id: nt.id,
        name: nt.name || 'Signal',
        kind: nt.kind || 'sig',
        rail: nt.rail ?? null,
        wake: Boolean(nt.wake),
        conns: (nt.conns || []).filter(([r]) => keepRefs.has(r)),
      }))
      .filter((nt) => nt.conns.length > 1);
    await api.replaceProjectNets(pid, cleanNets);

    // 5. Refresh projects & shopping from backend
    const [projects, shopping] = await Promise.all([api.listProjects(), api.listShopping()]);
    state.projects = projects;
    state.shopping = shopping;

    clearProjectDraft();
    state.sel = null;
    location.hash = `p-${pid}`;
    setTimeout(() => {
      renderFn();
      toast(isNew ? `${metaPayload.name} created` : 'Saved · checks updated');
    }, 60);
  } catch (err) {
    toast(err.message);
  }
}

export async function deleteProjectWithUndo(pid, renderFn) {
  const existing = projectById(pid);
  if (!existing) return;
  const snap = clone(existing);
  try {
    await api.deleteProject(pid);
    state.projects = state.projects.filter((p) => p.id !== pid);
    if (state.lens === pid) state.lens = null;
    clearProjectDraft();
    state.sel = null;
    location.hash = 'projects';
    setTimeout(() => {
      renderFn();
      toast(`${snap.name} deleted`, async () => {
        try {
          const restored = await api.createProject({
            name: snap.name,
            description: snap.description || '',
            option: snap.option || snap.option_label || '',
            tags: snap.tags || [],
            status: snap.status || 'planning',
            notes: snap.notes || '',
          });
          for (const it of snap.items || []) {
            await api.addProjectItem(restored.id, {
              part_id: it.part_id || null,
              shopping_item_id: it.shopping_item_id || null,
              ref: it.ref,
              role: it.role || 'periph',
              label: it.label || '',
              quantity_needed: it.quantity_needed || 1,
              project_notes: it.project_notes || '',
            });
          }
          if ((snap.nets || []).length) {
            await api.replaceProjectNets(restored.id, snap.nets);
          }
          if ((snap.checks || []).length) {
            await api.replaceProjectChecks(restored.id, snap.checks);
          }
          state.projects = await api.listProjects();
          renderFn();
          toast(`${snap.name} restored`);
        } catch (err) {
          toast(err.message);
        }
      });
    }, 60);
  } catch (err) {
    toast(err.message);
  }
}
