// Inventory (Home) screen: category tabs, search, sort, project lens, grid & list views, floating inspector.
import {
  state,
  CATEGORIES,
  SORTS,
  esc,
  sv,
  phPart,
  tagsFromFacts,
  tagChips,
  stepHtml,
  menuHtml,
  ago,
  sevGlyph,
  projectById,
  isGuest,
  appHref,
} from '../state.js';
import { projectUseMap, openChecksOfProject, reservedStockOfPart } from '../rules.js';
import { renderPartInspector } from '../inspectors.js';

function dangerCount(p) {
  return (p.care_notes || []).filter((c) => c.severity === 'danger').length;
}

function sortParts(list) {
  const k = state.inv.sort || 'recent';
  const a = [...list];
  const nm = (x, y) => String(x.name || '').localeCompare(String(y.name || ''));
  a.sort((x, y) => {
    if (k === 'name') return nm(x, y);
    if (k === 'fewest') return (x.quantity || 0) - (y.quantity || 0) || nm(x, y);
    if (k === 'most') return (y.quantity || 0) - (x.quantity || 0) || nm(x, y);
    if (k === 'bin') return (x.location || '~').localeCompare(y.location || '~', undefined, { numeric: true }) || nm(x, y);
    if (k === 'category') return String(x.category || '').localeCompare(String(y.category || '')) || nm(x, y);
    if (k === 'care') return dangerCount(y) - dangerCount(x) || (y.care_notes || []).length - (x.care_notes || []).length || nm(x, y);
    return String(y.created_at || '').localeCompare(String(x.created_at || '')) || nm(x, y);
  });
  return a;
}

function groupParts(list) {
  const k = state.inv.sort || 'recent';
  if (k === 'bin') {
    const groups = new Map();
    for (const p of list) {
      const key = p.location ? `Bin ${p.location}` : 'No bin';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.entries()];
  }
  if (k === 'category') {
    const groups = new Map();
    for (const p of list) {
      const key = p.category || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.entries()];
  }
  return [[null, list]];
}

function usedInProjects(partId) {
  return state.projects
    .filter((pr) => !pr.archived && (pr.items || []).some((q) => q.part_id === partId))
    .map((pr) => [pr.id, pr.name]);
}

function flagHtml(warns) {
  if (!state.config.ui_settings.show_caution_badge || !warns || !warns.length) return '';
  const sevs = [...new Set(warns.map((w) => w.sev))];
  return `<span class="flag">${sevs.map((s) => `<span class="sev ${esc(s)}">${sevGlyph(s)}</span>`).join('')}</span>`;
}

export function renderInventoryView() {
  const guest = isGuest();
  const f = state.inv;
  const q = (f.q || '').trim().toLowerCase();
  const view = f.view || 'grid';

  if (state.lens) {
    const lp = projectById(state.lens);
    if (!lp || lp.archived) state.lens = null;
  }

  const lensId = state.lens;
  const lensProj = lensId ? projectById(lensId) : null;
  const use = lensProj ? projectUseMap(lensProj) : null;

  const cats = ['All', ...CATEGORIES];
  const binMode = !guest && Boolean(f.binMode);
  const pickedSet = new Set(binMode ? f.picked || [] : []);
  const unassignedCount = state.parts.filter((p) => !(p.location || '').trim()).length;
  const allBins = [...new Set(state.parts.map((p) => (p.location || '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  const filtered = sortParts(
    state.parts.filter((p) => {
      if (f.cat !== 'All' && p.category !== f.cat) return false;
      if (f.binFilter && String(p.location || '').trim().toLowerCase() !== f.binFilter.toLowerCase()) return false;
      if (f.noBin && (p.location || '').trim()) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.subtitle} ${p.location} ${p.category} ${p.what_it_does}`.toLowerCase();
      return hay.includes(q);
    })
  );

  const cardHtml = (p) => {
    const u = use ? use[`p:${p.id}`] : null;
    const cls = use ? (u ? 'used' : 'dimmed') : '';
    const isSel = !binMode && state.sel === `part:${p.id}`;
    const isPicked = binMode && pickedSet.has(p.id);
    const st = reservedStockOfPart(p.id);
    const qtyHtml =
      st.reserved > 0
        ? `<span class="qty-wrap"><span class="qty">×${p.quantity}</span><span class="free${st.free === 0 ? ' zero' : ''}">${st.free} free</span></span>`
        : `<span class="qty">×${p.quantity}</span>`;
    const attr = binMode
      ? `data-pickpart="${esc(p.id)}" aria-pressed="${isPicked}"`
      : `data-sel="part:${esc(p.id)}"`;
    return `<button type="button" class="card ${cls} ${isSel ? 'sel' : ''} ${binMode ? 'pickmode' : ''} ${
      isPicked ? 'picked' : ''
    }" ${attr}>${
      binMode ? `<span class="pickbox" aria-hidden="true">${isPicked ? '✓' : ''}</span>` : ''
    }${u ? `<span class="role">${esc(u.role)}</span>` : ''}${
      !binMode && u ? flagHtml(u.warn) : ''
    }${phPart(p)}<div class="b">
      <div>
        <div class="n">${esc(p.name)}</div>
        <div class="sub2">${esc(p.subtitle || p.category)}</div>
      </div>
      <div class="tags">${tagChips(tagsFromFacts(p))}</div>
      <div class="f">
        ${qtyHtml}
        ${p.location ? `<span class="bin">${esc(p.location)}</span>` : '<span class="faint mono">no bin</span>'}
      </div>
    </div></button>`;
  };

  const rowHtml = (p) => {
    const u = use ? use[`p:${p.id}`] : null;
    const ui = usedInProjects(p.id);
    const dc = dangerCount(p);
    const careCnt = (p.care_notes || []).length;
    const isSel = !binMode && state.sel === `part:${p.id}`;
    const isPicked = binMode && pickedSet.has(p.id);
    const st = reservedStockOfPart(p.id);
    const attr = binMode
      ? `data-pickpart="${esc(p.id)}" aria-pressed="${isPicked}"`
      : `data-sel="part:${esc(p.id)}"`;
    return `<div class="prt ${use ? (u ? 'used' : 'dimmed') : ''} ${isSel ? 'sel' : ''} ${
      binMode ? 'pickmode' : ''
    } ${isPicked ? 'picked' : ''}" ${attr} role="button" tabindex="0">
      <div class="prt-thumb">${
        binMode ? `<span class="pickbox" aria-hidden="true">${isPicked ? '✓' : ''}</span>` : ''
      }${phPart(p)}</div>
      <div class="n">
        <b>${esc(p.name)}</b>
        <span class="dim">${esc(p.subtitle || p.what_it_does || '')}</span>
        <span class="tags">${tagChips(tagsFromFacts(p))}</span>
      </div>
      <div class="c-info">
        <span class="dim">${esc(p.category)}</span>
        ${ui.length ? `<span>● ${ui.map(([, nm]) => esc(nm)).join(', ')}</span>` : '<span class="faint">No project</span>'}
      </div>
      <div class="c-care">
        ${
          careCnt
            ? `<span class="status"><i style="background:${dc ? 'var(--danger)' : 'var(--ink-3)'}"></i>${careCnt} care note${careCnt === 1 ? '' : 's'}</span>`
            : '<span class="faint">—</span>'
        }
        <span class="faint">Added ${esc(ago(p.created_at))}</span>
      </div>
      <div class="c-bin">${p.location ? `<span class="bin">${esc(p.location)}</span>` : '<span class="faint">no bin</span>'}</div>
      <div class="c-qty">
        ${guest || binMode ? `<span class="mono">×${p.quantity}</span>` : stepHtml('data-qty', p.id, p.quantity, 'Quantity')}
        ${st.reserved > 0 ? `<span class="free${st.free === 0 ? ' zero' : ''}">${st.free} free</span>` : ''}
      </div>
    </div>`;
  };

  const renderGroupBody = (items) =>
    view === 'list'
      ? `<div class="plst"><div class="plh"><span></span><span>Part</span><span class="c-info">Category · project</span><span class="c-care">Care · added</span><span class="c-bin">Bin</span><span class="c-qty">Quantity</span></div>${items
          .map(rowHtml)
          .join('')}</div>`
      : `<div class="cards">${items.map(cardHtml).join('')}</div>`;

  let bodyHtml = '';
  if (lensProj) {
    const usedParts = filtered.filter((p) => use[`p:${p.id}`]);
    const restParts = filtered.filter((p) => !use[`p:${p.id}`]);

    bodyHtml = `
      <div class="sh"><h2>In ${esc(lensProj.name)}</h2><span class="cnt">${usedParts.length}</span></div>
      ${usedParts.length ? renderGroupBody(usedParts) : '<p class="faint">No matching owned parts in this project.</p>'}
      <div class="sh"><h2>Everything else</h2><span class="cnt">${restParts.length}</span></div>
      ${restParts.length ? renderGroupBody(restParts) : '<p class="faint">Nothing else matches.</p>'}
    `;
  } else {
    const groups = groupParts(filtered);
    bodyHtml = groups
      .map(
        ([gName, items]) =>
          `${gName ? `<div class="sh"><h2>${esc(gName)}</h2><span class="cnt">${items.length}</span></div>` : ''}${renderGroupBody(items)}`
      )
      .join('');
  }

  if (!filtered.length && !lensProj) {
    bodyHtml = `<p class="faint" style="padding:24px 0">No parts match${q ? ` “${esc(f.q)}”` : ''}. <button class="btn" type="button" data-act="clearq" style="margin-left:8px">Clear filters</button></p>`;
  }

  const activeProjects = state.projects.filter((p) => !p.archived);
  const binCount = new Set(state.parts.map((p) => p.location).filter(Boolean)).size;
  const sortLabel = (SORTS.find(([k]) => k === (f.sort || 'recent')) || SORTS[0])[1];

  let lensBanner = '';
  if (lensProj) {
    const ownedInProj = (lensProj.items || []).filter((x) => x.item_type === 'part').length;
    const openCnt = openChecksOfProject(lensProj).length;
    lensBanner = `<div class="lensbar">
      <b>${esc(lensProj.name)}</b>
      <span class="dim">${ownedInProj} owned part${ownedInProj === 1 ? '' : 's'} from your bins${
      openCnt ? ` · ${openCnt} open check${openCnt === 1 ? '' : 's'}` : ''
    }</span>
      <span style="flex:1"></span>
      <a class="btn" href="${appHref(`/projects/${encodeURIComponent(lensProj.id)}`)}">Open project</a>
      <button class="btn" type="button" data-lens="${esc(lensProj.id)}">Show all parts</button>
    </div>`;
  }

  let batchBanner = '';
  if (binMode) {
    const visIds = filtered.map((p) => p.id);
    const selCount = pickedSet.size;
    const allVisPicked = visIds.length > 0 && visIds.every((id) => pickedSet.has(id));
    batchBanner = `<div class="batchbar">
      <div class="batch-top">
        <b>${selCount ? `${selCount} selected` : 'Pick parts to assign a bin'}</b>
        ${
          visIds.length
            ? `<button type="button" class="btn quiet" data-act="${allVisPicked ? 'pick-none' : 'pick-all'}">${
                allVisPicked ? 'Clear selection' : `Select visible (${visIds.length})`
              }</button>`
            : ''
        }
        ${selCount && !allVisPicked ? '<button type="button" class="btn quiet" data-act="pick-none">Clear</button>' : ''}
        <button type="button" class="btn batch-done" data-act="binmode">Done</button>
      </div>
      <div class="batch-row">
        ${
          allBins.length
            ? `<div class="batch-bins"><span class="k">Move to</span>${allBins
                .slice(0, 14)
                .map(
                  (b) =>
                    `<button type="button" class="bin" data-batchbin="${esc(b)}" ${selCount ? '' : 'disabled'}>${esc(b)}</button>`
                )
                .join('')}</div>`
            : ''
        }
        <form class="batch-form" data-batchbin-form>
          <input class="ei" name="bin" placeholder="New bin (e.g. A4)" maxlength="32" aria-label="Bin name" ${
            selCount ? '' : 'disabled'
          }>
          <button class="btn ink" type="submit" ${selCount ? '' : 'disabled'}>Assign</button>
          <button class="btn quiet" type="button" data-batchbin="" ${selCount ? '' : 'disabled'}>Clear bin</button>
        </form>
      </div>
    </div>`;
  }

  const sel = state.sel;
  let inspHtml = '';
  if (!binMode && sel && sel.startsWith('part:')) inspHtml = renderPartInspector(sel.slice(5));

  return `<div class="screen full">
    <div class="work">
      <div class="pagehead">
        <div class="ph-title">
          <h1>Inventory</h1>
          <span class="sub num">${state.parts.length} parts · ${binCount} bin${binCount === 1 ? '' : 's'}</span>
          ${
            f.binFilter
              ? `<button type="button" class="tag f" aria-pressed="true" data-act="clearbin">Bin ${esc(f.binFilter)} ×</button>`
              : ''
          }
        </div>
        ${guest ? '' : '<button class="btn ink" type="button" data-act="add">+ Add part</button>'}
      </div>

      <nav class="cattabs" aria-label="Category">
        ${cats
          .map((c) => {
            const cnt = c === 'All' ? state.parts.length : state.parts.filter((p) => p.category === c).length;
            return `<button type="button" data-cat="${esc(c)}" aria-pressed="${f.cat === c}">${esc(c)}<span class="fc">${cnt}</span></button>`;
          })
          .join('')}
      </nav>

      <div class="ctl">
        <label class="search big">
          ${sv('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}
          <input id="invq" placeholder="Search parts, bins, descriptions" value="${esc(f.q)}" aria-label="Search inventory">
        </label>
        ${menuHtml('sort', 'Sort', sortLabel, SORTS.map(([k, t]) => [k, t, (f.sort || 'recent') === k]))}
        ${menuHtml(
          'lens',
          'For project',
          lensProj ? lensProj.name : 'Any',
          [['', 'Any project', !lensProj], ...activeProjects.map((p) => [p.id, p.name, lensId === p.id])]
        )}
        ${
          unassignedCount > 0 || f.noBin
            ? `<button type="button" class="btn togbtn" data-act="toggle-nobin" aria-pressed="${Boolean(f.noBin)}">No bin<span class="fc">${unassignedCount}</span></button>`
            : ''
        }
        ${
          !guest && state.parts.length > 0
            ? `<button type="button" class="btn togbtn" data-act="binmode" aria-pressed="${binMode}">Assign bins</button>`
            : ''
        }
        <div class="vtog" role="group" aria-label="View">
          <button type="button" data-iview="grid" aria-pressed="${view === 'grid'}" title="Grid" aria-label="Grid view">
            ${sv('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>')}
          </button>
          <button type="button" data-iview="list" aria-pressed="${view === 'list'}" title="List" aria-label="List view">
            ${sv('<path d="M9 6h11M9 12h11M9 18h11"/><rect x="3.5" y="4.5" width="3" height="3" rx=".6"/><rect x="3.5" y="10.5" width="3" height="3" rx=".6"/><rect x="3.5" y="16.5" width="3" height="3" rx=".6"/>')}
          </button>
        </div>
      </div>

      ${lensBanner}
      ${batchBanner}
      ${bodyHtml}
    </div>
    ${
      inspHtml
        ? `<aside class="insp open float ${state.panelWasOpen ? '' : 'enter'}" id="insp" aria-label="Details">${inspHtml}</aside>`
        : ''
    }
  </div>`;
}
