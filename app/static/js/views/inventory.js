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
import { projectUseMap, openChecksOfProject } from '../rules.js';
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
  const filtered = sortParts(
    state.parts.filter((p) => {
      if (f.cat !== 'All' && p.category !== f.cat) return false;
      if (f.binFilter && String(p.location || '').trim().toLowerCase() !== f.binFilter.toLowerCase()) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.subtitle} ${p.location} ${p.category} ${p.what_it_does}`.toLowerCase();
      return hay.includes(q);
    })
  );

  const cardHtml = (p) => {
    const u = use ? use[`p:${p.id}`] : null;
    const cls = use ? (u ? 'used' : 'dimmed') : '';
    const isSel = state.sel === `part:${p.id}`;
    return `<button type="button" class="card ${cls} ${isSel ? 'sel' : ''}" data-sel="part:${esc(p.id)}">${
      u ? `<span class="role">${esc(u.role)}</span>` : ''
    }${u ? flagHtml(u.warn) : ''}${phPart(p)}<div class="b">
      <div>
        <div class="n">${esc(p.name)}</div>
        <div class="sub2">${esc(p.subtitle || p.category)}</div>
      </div>
      <div class="tags">${tagChips(tagsFromFacts(p))}</div>
      <div class="f">
        <span class="qty">×${p.quantity}</span>
        ${p.location ? `<span class="bin">${esc(p.location)}</span>` : '<span class="faint mono">no bin</span>'}
      </div>
    </div></button>`;
  };

  const rowHtml = (p) => {
    const u = use ? use[`p:${p.id}`] : null;
    const ui = usedInProjects(p.id);
    const dc = dangerCount(p);
    const careCnt = (p.care_notes || []).length;
    const isSel = state.sel === `part:${p.id}`;
    return `<div class="prt ${use ? (u ? 'used' : 'dimmed') : ''} ${isSel ? 'sel' : ''}" data-sel="part:${esc(p.id)}" role="button" tabindex="0">
      ${phPart(p)}
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
      <div class="c-qty">${guest ? `<span class="mono">×${p.quantity}</span>` : stepHtml('data-qty', p.id, p.quantity, 'Quantity')}</div>
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

  const sel = state.sel;
  let inspHtml = '';
  if (sel && sel.startsWith('part:')) inspHtml = renderPartInspector(sel.slice(5));

  return `<div class="screen full">
    <div class="work">
      <div class="pagehead">
        <h1>Inventory</h1>
        <span class="sub num">${state.parts.length} parts · ${binCount} bin${binCount === 1 ? '' : 's'}</span>
        ${
          f.binFilter
            ? `<button type="button" class="tag f" aria-pressed="true" data-act="clearbin">Bin ${esc(f.binFilter)} ×</button>`
            : ''
        }
        <span style="flex:1"></span>
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
      ${bodyHtml}
    </div>
    ${
      inspHtml
        ? `<aside class="insp open float ${state.panelWasOpen ? '' : 'enter'}" id="insp" aria-label="Details">${inspHtml}</aside>`
        : ''
    }
  </div>`;
}
