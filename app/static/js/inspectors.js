// Floating Part Inspector & Shopping Item Inspector (desktop right panel / phone bottom sheet).
import {
  state,
  esc,
  sv,
  phPart,
  tagsFromFacts,
  tagChips,
  stepHtml,
  partById,
  shoppingById,
  storeDisplayName,
  termButton,
  parsePriceNumber,
  money,
  currencyLabel,
  sevGlyph,
  isGuest,
  appHref,
  apiUrl,
} from './state.js';
import { computeRelations, relHtml, careHtml, glossaryTermsFor, warningsOfProject } from './rules.js';

export function closePanel(renderFn) {
  const el = document.querySelector('.insp.float');
  const motion = state.config.ui_settings.motion || 'system';
  const reduce =
    motion === 'reduced' || (motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!el || reduce) {
    state.sel = null;
    renderFn();
    return;
  }
  if (state.panelClosing) return;
  state.panelClosing = true;
  el.classList.remove('enter');
  el.classList.add('leave');
  const done = () => {
    state.panelClosing = false;
    state.sel = null;
    renderFn();
  };
  el.addEventListener('animationend', done, { once: true });
  setTimeout(() => {
    if (state.panelClosing) done();
  }, 400);
}

function benchToolForPart(p) {
  const nm = `${p.name || ''} ${p.subtitle || ''}`.toLowerCase();
  if (p.pinout_svg) return `part:${p.id}`;
  if (nm.includes('esp32-c3')) return 'c3';
  if (nm.includes('esp32') || nm.includes('esp-32')) return 'esp32';
  if (nm.includes('pico') || nm.includes('rp2350') || nm.includes('rp2040')) return 'pico2';
  if (nm.includes('uno') || nm.includes('atmega328')) return 'uno';
  return '';
}

export function renderPartInspector(id) {
  const p = partById(id);
  if (!p) return '';

  const f = p.electrical_facts || {};
  const care = p.care_notes || [];
  const tags = tagsFromFacts(p);
  const rels = computeRelations(p, id);
  const terms = glossaryTermsFor(p);

  const uses = state.projects.flatMap((pr) =>
    (pr.items || [])
      .filter((q) => q.part_id === id)
      .map((q) => [pr, q])
  );

  const facts = [
    f.vin && ['Supply', `${f.vin[0]}–${f.vin[1]} V`],
    f.io && ['Pin limit', `${f.io} V`],
    f.i2c && ['I2C address', f.i2c],
    f.out && Object.keys(f.out).length && [
      'Signal out',
      Object.entries(f.out)
        .map(([k, v]) => `${k} ${v} V`)
        .join(', '),
    ],
    ...Object.entries(p.specs || {}).slice(0, 6),
    ['Category', p.category],
    ['In bin', p.location || '—'],
  ].filter(Boolean);

  // Deduplicate fact keys while preserving order
  const seenKeys = new Set();
  const uniqueFacts = facts.filter(([k]) => {
    const lk = String(k).toLowerCase();
    if (seenKeys.has(lk)) return false;
    seenKeys.add(lk);
    return true;
  });

  const showPinout =
    Boolean(p.pinout_image_path || p.pinout_svg) ||
    !['Passives', 'Prototyping', 'Tools'].includes(p.category);
  const benchTool = benchToolForPart(p);

  const guest = isGuest();
  let pinoutInner = '';
  if (p.pinout_svg) {
    pinoutInner = `<div class="pinimg">${p.pinout_svg}</div>`;
  } else if (p.pinout_image_path) {
    const pSrc = apiUrl(`/images/${encodeURIComponent(p.pinout_image_path)}`);
    pinoutInner = `<div class="pinimg zoomable" data-lightbox="${pSrc}"><img src="${pSrc}" alt="${esc(p.name)} pinout" loading="lazy"></div>`;
  } else {
    pinoutInner = guest
      ? `<div class="pinimg empty"><span>No pinout yet</span></div>`
      : `<div class="pinimg empty"><span>No pinout yet</span></div><p class="faint">Add the seller’s pinout image when you edit the part, or ask your assistant to find it.</p>`;
  }

  return `<div class="insp-in">
    <div class="insp-h" style="margin-bottom:0">
      <span></span>
      <button class="btn quiet close" type="button" data-act="clear" aria-label="Close">${sv('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    </div>

    <div class="hero">
      ${phPart(p, 'photo', Boolean(p.image_path))}
      <div>
        <h2>${esc(p.name)}</h2>
        ${p.subtitle ? `<div class="subt">${esc(p.subtitle)}</div>` : ''}
      </div>
      <div class="chips">
        ${tagChips(tags)}
        ${p.location ? `<span class="bin">${esc(p.location)}</span>` : ''}
      </div>
      <div class="qtyrow">
        <span class="dim">${guest ? 'In stock' : 'You own'}</span>
        ${guest ? `<span class="mono">×${p.quantity}</span>` : stepHtml('data-qty', p.id, p.quantity, 'You own')}
      </div>
    </div>

    <div class="sec">
      <h3>What it is for</h3>
      ${
        p.what_it_does
          ? `<p>${esc(p.what_it_does)}</p>`
          : guest
          ? '<p class="faint">Not written yet.</p>'
          : `<p class="faint">Not written yet. <a href="${appHref(`/parts/${encodeURIComponent(id)}/edit`)}">Add it</a>, or ask your assistant.</p>`
      }
      ${p.visual_tell ? `<p class="dim" style="margin-top:6px"><span class="k">Spot it:</span> ${esc(p.visual_tell)}</p>` : ''}
    </div>

    ${
      care.length
        ? `<div class="sec"><h3>Handle with care <span class="cnt">${care.length}</span></h3>${careHtml(care)}</div>`
        : ''
    }

    <div class="sec">
      <h3>Key facts</h3>
      <div class="specg">${uniqueFacts.map(([k, v]) => `<div><span class="k">${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    </div>

    ${
      showPinout
        ? `<div class="sec">
            <h3>Pinout</h3>
            ${pinoutInner}
            ${benchTool ? `<button class="btn" type="button" data-gotool="${esc(benchTool)}" style="margin-top:6px">Open on the Bench →</button>` : ''}
          </div>`
        : ''
    }

    ${
      rels.length
        ? `<div class="sec"><h3>With your other parts <span class="cnt">${rels.length}</span></h3>${relHtml(rels)}</div>`
        : ''
    }

    <div class="sec">
      <h3>Used in</h3>
      ${
        uses.length
          ? uses
              .map(([pr, q]) => {
                const ws = warningsOfProject(pr).filter(
                  (x) => (x.on.nodes || []).includes(q.ref) && x.sev !== 'ok' && !(x.src === 'assistant' && x.is_done)
                );
                return `<div class="rel"><span class="sev ok" style="background:var(--ink)">→</span><div><a href="${appHref(`/projects/${encodeURIComponent(pr.id)}`)}"><b>${esc(pr.name)}</b></a>${
                  pr.archived ? ' <span class="tag">archived</span>' : ''
                }${q.project_notes ? `<p>${esc(q.project_notes)}</p>` : ''}${ws
                  .map(
                    (x) =>
                      `<p><span class="sev ${esc(x.sev)}" style="width:14px;height:14px;font-size:9px">${sevGlyph(x.sev)}</span> ${x.t}</p>`
                  )
                  .join('')}</div></div>`;
              })
              .join('')
          : '<p class="faint">Not in a project yet.</p>'
      }
    </div>

    ${
      terms.length
        ? `<div class="sec"><h3>Words to know</h3><div class="chips">${terms.map((t) => termButton(t)).join(' · ')}</div></div>`
        : ''
    }

    <div class="sec" style="display:flex;gap:6px;flex-wrap:wrap">
      ${guest ? '' : `<a class="btn" href="${appHref(`/parts/${encodeURIComponent(id)}/edit`)}">Edit part</a>`}
      <button class="btn quiet" type="button" data-act="clear">Close</button>
    </div>
  </div>`;
}

export function renderShoppingInspector(id) {
  const it = shoppingById(id);
  if (!it) return '';

  const f = it.electrical_facts || {};
  const care = it.care_notes || [];
  const tags = tagsFromFacts(it);
  const rels = f.vin || f.i2c || f.out || it.category === 'Microcontrollers' ? computeRelations(it, id) : [];
  const uses = state.projects.flatMap((pr) =>
    (pr.items || [])
      .filter((q) => q.shopping_item_id === id)
      .map((q) => [pr, q])
  );
  const guest = isGuest();
  const unit = parsePriceNumber(it.price);
  const statusLabels = { order: 'to order', ordered: 'on the way', arrived: 'arrived' };
  const offers = it.offers || [];

  return `<div class="insp-in">
    <div class="insp-h" style="margin-bottom:0">
      <span></span>
      <button class="btn quiet close" type="button" data-act="clear" aria-label="Close">${sv('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    </div>

    <div class="hero">
      ${phPart(it, 'photo', Boolean(it.image_path))}
      <div>
        <h2>${esc(it.name)}</h2>
        <div class="subt">Not owned yet</div>
      </div>
      <div class="qtyrow">
        <span class="dim">To buy</span>
        ${guest ? `<span class="mono">×${it.quantity}</span>` : stepHtml('data-buy', it.id, it.quantity, 'To buy')}
        ${unit !== null ? `<span class="faint num">${money(unit * it.quantity)} ${currencyLabel()}</span>` : ''}
      </div>
      <div class="chips">
        ${tagChips(tags)}
        <span class="tag">${statusLabels[it.status || 'order'] || 'to order'}</span>
      </div>
    </div>

    ${it.why_needed ? `<div class="sec"><h3>Why buy it</h3><p>${esc(it.why_needed)}</p></div>` : ''}
    ${care.length ? `<div class="sec"><h3>Handle with care <span class="cnt">${care.length}</span></h3>${careHtml(care)}</div>` : ''}
    ${rels.length ? `<div class="sec"><h3>With your parts <span class="cnt">${rels.length}</span></h3>${relHtml(rels)}</div>` : ''}

    ${
      offers.length
        ? `<div class="sec">
            <h3>Stores <span class="cnt">${offers.length}</span></h3>
            ${offers
              .map(
                (o, i) =>
                  `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-top:${
                    i ? '1px solid var(--hair)' : '0'
                  }"><span>${esc(storeDisplayName(o.retailer || o.url))}${
                    o.is_selected ? ' <span class="tag">chosen</span>' : ''
                  }</span><span style="display:flex;gap:8px;align-items:center"><span class="mono">${esc(o.price || '—')}</span>${
                    o.is_selected || guest ? '' : `<button class="btn" type="button" data-pick="${esc(it.id)}:${esc(o.id)}">Use</button>`
                  }</span></div>`
              )
              .join('')}
          </div>`
        : ''
    }

    ${
      uses.length
        ? `<div class="sec"><h3>For</h3>${uses
            .map(
              ([pr, q]) =>
                `<p><a href="${appHref(`/projects/${encodeURIComponent(pr.id)}`)}"><b>${esc(pr.name)}</b></a>${
                  q.project_notes ? ` <span class="faint">· ${esc(q.project_notes)}</span>` : ''
                }</p>`
            )
            .join('')}</div>`
        : ''
    }

    <div class="sec" style="display:flex;gap:6px;flex-wrap:wrap">
      ${
        !guest && it.status === 'arrived'
          ? `<button class="btn ink" type="button" data-move-inv="${esc(it.id)}">Move to inventory</button>`
          : ''
      }
      ${guest ? '' : `<a class="btn" href="${appHref(`/shopping/${encodeURIComponent(id)}/edit`)}">Edit item</a>`}
      <a class="btn quiet" href="${appHref('/shopping')}">Shopping →</a>
      <button class="btn quiet" type="button" data-act="clear">Close</button>
    </div>
  </div>`;
}
