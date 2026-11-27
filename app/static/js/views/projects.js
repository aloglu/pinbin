// Projects list, Project detail (Map / One part / Lines / Parts / Notes), and Project Inspector.
import { api } from '../api.js';
import {
  state,
  G,
  esc,
  sv,
  ph,
  phPart,
  glyphFor,
  stepHtml,
  menuHtml,
  sevGlyph,
  projectById,
  projectHref,
  storeDisplayName,
  toast,
  isGuest,
  appHref,
  plainWarningText,
} from '../state.js';
import {
  resolveProjectItem,
  warningsOfProject,
  openChecksOfProject,
  nextStepOfProject,
  computePowerBudget,
} from '../rules.js';
import { builtinBoardUsbSide } from './bench.js';
import { renderProjectCodeView } from './project-code.js';

const STATUS_META = {
  danger: ['var(--danger)', 'Wiring problem'],
  buy: ['var(--spi)', 'Parts to buy'],
  check: ['var(--check)', 'Checks open'],
  ok: ['var(--ok)', 'Ready to build'],
  arch: ['var(--ink-3)', 'Archived'],
};

const isPhone = () => window.matchMedia('(max-width: 820px)').matches;

export function mdLite(text) {
  const raw = String(text || '').trim();
  if (!raw) return '<p class="faint">No notes yet.</p>';
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  return raw
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.length === 1 && lines[0].startsWith('### ')) {
        return `<h3>${inline(lines[0].slice(4))}</h3>`;
      }
      if (lines[0].startsWith('### ')) {
        const head = `<h3>${inline(lines[0].slice(4))}</h3>`;
        const rest = lines.slice(1);
        if (rest.every((l) => l.trim().startsWith('- '))) {
          return (
            head +
            `<ul>${rest
              .map((l) => {
                const body = l.trim().slice(2);
                if (body.startsWith('[ ] ')) return `<li class="chk"><span>☐</span><span>${inline(body.slice(4))}</span></li>`;
                if (body.startsWith('[x] ') || body.startsWith('[X] '))
                  return `<li class="chk"><span>☑</span><span>${inline(body.slice(4))}</span></li>`;
                return `<li>${inline(body)}</li>`;
              })
              .join('')}</ul>`
          );
        }
        return head + `<p>${inline(rest.join(' '))}</p>`;
      }
      if (lines.every((l) => l.trim().startsWith('- '))) {
        return `<ul>${lines
          .map((l) => {
            const body = l.trim().slice(2);
            if (body.startsWith('[ ] ')) return `<li class="chk"><span>☐</span><span>${inline(body.slice(4))}</span></li>`;
            if (body.startsWith('[x] ') || body.startsWith('[X] '))
              return `<li class="chk"><span>☑</span><span>${inline(body.slice(4))}</span></li>`;
            return `<li>${inline(body)}</li>`;
          })
          .join('')}</ul>`;
      }
      return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function projectState(proj) {
  if (proj.archived) return 'arch';
  const ws = warningsOfProject(proj);
  if (ws.some((w) => w.src === 'rule' && w.sev === 'danger')) return 'danger';
  if ((proj.items || []).some((x) => x.item_type === 'shopping' && (x.shopping_status || 'order') === 'order')) {
    return 'buy';
  }
  if (openChecksOfProject(proj).length) return 'check';
  return 'ok';
}

function statusBadge(st) {
  const [col, label] = STATUS_META[st] || STATUS_META.ok;
  return `<span class="status"><i style="background:${col}"></i>${esc(label)}</span>`;
}

function tagsReadonlyHtml(proj) {
  const tags = proj.tags || [];
  if (!tags.length) return '';
  return tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
}

function glyphOfItem(rec) {
  if (!rec) return 'proto';
  if (rec.src) return glyphFor(rec.src);
  return glyphFor(rec);
}

export function findMcuRef(proj) {
  const items = proj.items || [];
  const explicit = items.find((x) => x.role === 'mcu');
  if (explicit) return explicit.ref;
  const board = items.find((x) => x.category === 'Microcontrollers');
  if (board) return board.ref;
  return items[0] ? items[0].ref : null;
}

/* =========================================================== Projects list */
export function renderProjectsListView() {
  const guest = isGuest();
  const tab = state.ptab || 'active';
  const all = state.projects || [];
  const tagsAll = [...new Set(all.flatMap((p) => p.tags || []))].sort();
  const list = all
    .filter((p) => (tab === 'archived') === Boolean(p.archived))
    .filter((p) => !state.tagf || (p.tags || []).includes(state.tagf));
  const nActive = all.filter((p) => !p.archived).length;
  const nArchived = all.length - nActive;

  return `<div class="screen full"><div class="work">
    <div class="pagehead">
      <div class="ph-title">
        <h1>Projects</h1>
        <span class="sub">${nActive} active · ${nArchived} archived</span>
      </div>
      ${guest ? '' : `<a class="btn ink" href="${appHref('/projects/new')}">+ New project</a>`}
    </div>

    <div class="cattabs" role="group" aria-label="Show">
      <button type="button" data-ptab="active" aria-pressed="${tab === 'active'}">Active<span class="fc">${nActive}</span></button>
      <button type="button" data-ptab="archived" aria-pressed="${tab === 'archived'}">Archived<span class="fc">${nArchived}</span></button>
    </div>

    ${
      tagsAll.length
        ? `<div class="toolbar"><div class="chips"><span class="k">Tags</span>${tagsAll
            .map(
              (t) =>
                `<button type="button" class="tag f" data-tagf="${esc(t)}" aria-pressed="${state.tagf === t}">${esc(t)}</button>`
            )
            .join('')}</div></div>`
        : ''
    }

    <div class="plist">
      ${
        list.length
          ? list
              .map((p) => {
                const next = nextStepOfProject(p);
                const open = openChecksOfProject(p);
                const st = projectState(p);
                const projUrl = projectHref(p);
                return `<div class="prow st-${st} ${p.archived ? 'arch' : ''}">
                  <div class="body">
                    <div class="ttl">
                      <h2><a href="${projUrl}">${esc(p.name)}</a></h2>
                      ${p.option ? `<span class="tag opt">${esc(p.option)}</span>` : ''}
                      ${statusBadge(st)}
                    </div>
                    ${p.description ? `<p class="dim">${esc(p.description)}</p>` : ''}
                    ${(p.tags || []).length ? `<div class="chips">${tagsReadonlyHtml(p)}</div>` : ''}
                  </div>
                  <div class="side">
                    ${
                      p.archived
                        ? '<span class="faint">archived</span>'
                        : `<span class="k">next</span><b>${esc(next.t)}</b><span class="faint">${open.length} open check${
                            open.length === 1 ? '' : 's'
                          }</span>`
                    }
                    <div class="pacts2">
                      ${
                        guest
                          ? ''
                          : `<button class="btn quiet" type="button" data-archive="${esc(p.id)}">${
                              p.archived ? 'Restore' : 'Archive'
                            }</button>`
                      }
                      <a class="btn" href="${projUrl}">Open →</a>
                    </div>
                  </div>
                </div>`;
              })
              .join('')
          : `<p class="faint">${
              tab === 'archived'
                ? 'Nothing archived.'
                : state.tagf
                ? 'No active projects match that tag.'
                : 'No active projects yet.'
            }</p>`
      }
    </div>

    ${
      guest
        ? ''
        : '<p class="faint pnote">Start one yourself with <b>New project</b>, or ask your assistant to plan it: it can pick parts, check your inventory, find stores and write the wiring list. You can change anything it writes.</p>'
    }
  </div></div>`;
}

/* =========================================================== Automatic block diagram layout */
function layoutProject(proj) {
  const items = proj.items || [];
  const allNets = proj.nets || [];
  const mcuRef = findMcuRef(proj);
  if (!mcuRef) return null;

  const power = items.filter((x) => x.role === 'power' && x.ref !== mcuRef).map((x) => x.ref);
  const periph = items
    .filter((x) => x.role !== 'power' && x.role !== 'material' && x.ref !== mcuRef)
    .map((x) => x.ref);

  const N = {};
  const nets = {};
  const W = 180;
  const GAP = 22;
  const TOP = 70;
  const PW = 250;

  // Power column
  power.forEach((r, i) => {
    N[r] = { x: 40, y: TOP + i * 116, w: W, h: 62, pins: [] };
  });

  const mcuX = power.length ? 340 : 80;
  const mcuW = 210;

  // Collect pins per peripheral (rails first, then signals touching MCU)
  const pinsOf = {};
  periph.forEach((r) => {
    pinsOf[r] = [];
  });

  const validNets = allNets.filter((n) => Array.isArray(n.conns) && n.conns.length > 1);
  const railNets = validNets.filter((n) => n.rail && n.conns.some(([r]) => r === mcuRef));
  const sigNets = validNets.filter((n) => !n.rail && n.kind !== 'bat' && n.conns.some(([r]) => r === mcuRef));
  const sideNets = validNets.filter((n) => !n.rail && n.kind !== 'bat' && !n.conns.some(([r]) => r === mcuRef));
  const batNets = validNets.filter((n) => n.kind === 'bat');

  railNets.forEach((n) =>
    n.conns.forEach(([r, pin]) => {
      if (pinsOf[r]) pinsOf[r].push([pin || '', n.id]);
    })
  );
  sigNets.forEach((n) =>
    n.conns.forEach(([r, pin]) => {
      if (pinsOf[r]) pinsOf[r].push([pin || '', n.id]);
    })
  );

  const laneStart = mcuX + mcuW + 34;
  const laneGap = 16;
  const periphX = Math.max(laneStart + (sigNets.length + railNets.length) * laneGap + 30, 700);

  let y = TOP;
  periph.forEach((r) => {
    const k = pinsOf[r].length;
    const h = Math.max(62, 46 + k * 20);
    N[r] = { x: periphX, y, w: PW, h, pins: [] };
    pinsOf[r].forEach(([pin, nid], i) => {
      N[r].pins.push({ pin, net: nid, x: periphX, y: y + 46 + i * 20 - 6, side: 'l' });
    });
    y += h + GAP;
  });

  // MCU right pins aligned with first peripheral pin of each signal net
  const mpins = [];
  sigNets.forEach((n) => {
    const first = n.conns.find(([r]) => r !== mcuRef && N[r]);
    const pp = first ? N[first[0]].pins.find((q) => q.net === n.id) : null;
    const mEntry = n.conns.find(([r]) => r === mcuRef);
    if (pp && mEntry) {
      mpins.push({ pin: mEntry[1] || '', net: n.id, y: pp.y });
    }
  });
  mpins.sort((a, b) => a.y - b.y);
  // Nudge colliding MCU pin y positions slightly so labels never overlap
  for (let i = 1; i < mpins.length; i++) {
    if (mpins[i].y - mpins[i - 1].y < 18) mpins[i].y = mpins[i - 1].y + 18;
  }

  const minY = Math.min(TOP + 10, ...(mpins.length ? mpins.map((m) => m.y - 40) : [TOP + 10]));
  const maxY = Math.max(
    TOP + 260,
    ...(mpins.length ? mpins.map((m) => m.y + 40) : [TOP + 260]),
    power.length ? N[power[power.length - 1]].y + 40 : 0
  );
  N[mcuRef] = { x: mcuX, y: minY, w: mcuW, h: maxY - minY, pins: [] };
  mpins.forEach((m) => {
    N[mcuRef].pins.push({ pin: m.pin, net: m.net, x: mcuX + mcuW, y: m.y, side: 'r' });
  });

  // Signal net paths
  sigNets.forEach((n, i) => {
    const m = mpins.find((q) => q.net === n.id);
    if (!m) return;
    const targets = n.conns
      .filter(([r]) => r !== mcuRef && N[r])
      .map(([r]) => N[r].pins.find((q) => q.net === n.id))
      .filter(Boolean);
    if (!targets.length) return;
    const lx = laneStart + i * laneGap;
    const paths = [];
    const straight = targets.length === 1 && Math.abs(targets[0].y - m.y) < 1;
    if (straight) {
      paths.push(`M${mcuX + mcuW} ${m.y} H${periphX}`);
    } else {
      paths.push(`M${mcuX + mcuW} ${m.y} H${lx}`);
      targets.forEach((t) => paths.push(`M${lx} ${m.y} V${t.y} H${periphX}`));
    }
    const ys = [m.y, ...targets.map((t) => t.y)];
    nets[n.id] = {
      paths,
      anchor: straight ? [(mcuX + mcuW + periphX) / 2, m.y] : [lx, (Math.min(...ys) + Math.max(...ys)) / 2],
      label: [mcuX + mcuW + 8, m.y - 6],
    };
  });

  // Power rails from MCU top
  railNets.forEach((n, i) => {
    const px = mcuX + mcuW - 26 - i * 34;
    const mp = n.conns.find(([r]) => r === mcuRef);
    if (!mp) return;
    N[mcuRef].pins.push({ pin: mp[1] || '', net: n.id, x: px, y: N[mcuRef].y, side: 't' });
    const ry = N[mcuRef].y - 22 - i * 14;
    const rx = laneStart + (sigNets.length + i) * laneGap;
    const targets = n.conns
      .filter(([r]) => r !== mcuRef && N[r])
      .map(([r]) => N[r].pins.find((q) => q.net === n.id))
      .filter(Boolean);
    if (!targets.length) return;
    const maxT = Math.max(...targets.map((t) => t.y));
    const paths = [`M${px} ${N[mcuRef].y} V${ry} H${rx} V${maxT}`];
    targets.forEach((t) => paths.push(`M${rx} ${t.y} H${periphX}`));
    nets[n.id] = {
      paths,
      anchor: [rx, (ry + maxT) / 2 + 10],
      label: [px + 6, ry - 5],
    };
  });

  // Battery chain
  batNets.forEach((n) => {
    const paths = [];
    let last = null;
    n.conns.forEach(([r, pin], i) => {
      const node = N[r];
      if (!node) return;
      if (r === mcuRef) {
        const my = N[mcuRef].y + 62;
        N[mcuRef].pins.push({ pin: pin || '', net: n.id, x: mcuX, y: my, side: 'l' });
        if (last) {
          const lx = mcuX - 50;
          paths.push(`M${last.x} ${last.y} H${lx} V${my} H${mcuX}`);
          nets[n.id] = { anchor: [lx, (last.y + my) / 2] };
        }
        return;
      }
      const first = !last || last.r !== r;
      const isTop = first && i > 0;
      const nextIsMcu = n.conns[i + 1] && n.conns[i + 1][0] === mcuRef;
      const pt = isTop
        ? { x: node.x + node.w / 2, y: node.y, side: 't' }
        : nextIsMcu
        ? { x: node.x + node.w, y: node.y + node.h / 2, side: 'r' }
        : { x: node.x + node.w / 2, y: node.y + node.h, side: 'b' };
      node.pins.push({ pin: pin || '', net: n.id, ...pt });
      if (last && last.r !== r) paths.push(`M${last.x} ${last.y} V${pt.y}`);
      last = { r, ...pt };
    });
    const firstPower = power[0] ? N[power[0]] : N[mcuRef];
    nets[n.id] = {
      ...(nets[n.id] || { anchor: [140, TOP + 100] }),
      paths,
      label: [firstPower.x + firstPower.w / 2 + 6, firstPower.y + firstPower.h + 16],
    };
  });

  // Side nets (periph ↔ periph, e.g. coin cell to RTC)
  sideNets.forEach((n, i) => {
    const valid = n.conns.filter(([r]) => N[r]);
    if (valid.length < 2) return;
    const pts = valid.map(([r]) => N[r]);
    const hx = periphX + PW + 18 + i * 10;
    const ys = pts.map((b) => b.y + b.h / 2);
    pts.forEach((b, j) => {
      b.pins.push({ pin: valid[j][1] || '', net: n.id, x: b.x + b.w, y: ys[j], side: 'r' });
    });
    const x0 = pts[0].x + pts[0].w;
    const x1 = pts[pts.length - 1].x + pts[pts.length - 1].w;
    nets[n.id] = {
      paths: [`M${x0} ${ys[0]} H${hx} V${ys[ys.length - 1]} H${x1}`],
      anchor: [hx, (ys[0] + ys[ys.length - 1]) / 2],
    };
  });

  const boxes = Object.values(N);
  const H = Math.max(320, ...boxes.map((b) => b.y + b.h)) + 70;
  const Wd = Math.max(periphX + PW + 60, ...boxes.map((b) => b.x + b.w + 60));
  const mcuItem = resolveProjectItem(proj, mcuRef);
  const usbSide = builtinBoardUsbSide(mcuItem && mcuItem.src ? mcuItem.src : mcuItem);
  N[mcuRef].usb = usbSide === 'bottom'
    ? { x: mcuX + mcuW / 2, y: N[mcuRef].y + N[mcuRef].h, side: 'b' }
    : { x: mcuX + mcuW / 2, y: N[mcuRef].y, side: 't' };
  return { N, nets, W: Wd, H, mcuRef };
}

export function buildMapDiagramData(proj) {
  const L = layoutProject(proj);
  if (!L) return null;
  const ws = warningsOfProject(proj);

  const validKinds = new Set(['bat', 'v5', 'v33', 'i2c', 'spi', 'sig']);
  const netEls = (proj.nets || [])
    .map((n) => {
      const g = L.nets[n.id];
      if (!g || !g.paths.length) return '';
      const safeKind = validKinds.has(n.kind) ? n.kind : 'sig';
      const col = `var(--${safeKind})`;
      const bus = safeKind === 'i2c' || safeKind === 'spi';
      const draw = g.paths
        .map((d) =>
          bus
            ? `<path class="bus" d="${d}" stroke="${col}"/><path class="bus-in" d="${d}"/>`
            : `<path class="w" d="${d}" stroke="${col}"/>`
        )
        .join('');
      const lab =
        g.label && safeKind !== 'sig'
          ? `<text class="lab" x="${g.label[0]}" y="${g.label[1]}" style="fill:${col}">${esc(
              n.rail ? `${n.rail} V` : safeKind === 'bat' ? '3.0–4.2 V' : safeKind.toUpperCase()
            )}</text>`
          : '';
      return `<g class="net" data-sel="net:${esc(n.id)}">${draw}${g.paths
        .map((d) => `<path class="flow" d="${d}"/>`)
        .join('')}${g.paths.map((d) => `<path class="hit" d="${d}"/>`).join('')}${lab}</g>`;
    })
    .join('');

  const nodeEls = Object.entries(L.N)
    .map(([r, b]) => {
      const x = resolveProjectItem(proj, r);
      if (!x) return '';
      const st = x.owned
        ? `owned${x.src && x.src.location ? ` · bin ${x.src.location}` : ''}`
        : (x.shopping_status || 'order') === 'order'
        ? `to buy · ${x.buy_quantity || x.quantity_needed || 1}×`
        : x.shopping_status === 'ordered'
        ? 'on the way'
        : 'arrived';

      const pins = b.pins
        .map((q) => {
          let tx,
            ty,
            a = 'start';
          if (q.side === 'l') {
            tx = q.x + 6;
            ty = q.y + 3;
          } else if (q.side === 'r') {
            tx = q.x - 6;
            ty = q.y + 3;
            a = 'end';
          } else if (q.side === 't') {
            tx = q.x + 5;
            ty = q.y - 5;
          } else {
            tx = q.x + 5;
            ty = q.y + 12;
          }
          return `<circle cx="${q.x}" cy="${q.y}" r="2.6" fill="var(--ink-3)"/>${
            q.pin ? `<text class="pin" x="${tx}" y="${ty}" text-anchor="${a}">${esc(q.pin)}</text>` : ''
          }`;
        })
        .join('');

      const hasL = b.pins.some((q) => q.side === 'l' && r !== L.mcuRef);
      const ox = hasL ? 62 : 0;
      const gKey = glyphOfItem(x);
      const maxChars = Math.max(12, Math.floor((b.w - 50 - ox) / 7.2));
      const shortNm = x.displayName.length > maxChars ? `${x.displayName.slice(0, maxChars - 1)}…` : x.displayName;
      const usb =
        r === L.mcuRef && b.usb
          ? b.usb.side === 't'
            ? `<path d="M${b.usb.x} ${b.usb.y} v-24" stroke="var(--sig)" stroke-width="2" stroke-dasharray="4 4"/><text class="pin" x="${
                b.usb.x + 8
              }" y="${b.usb.y - 10}">USB</text>`
            : `<path d="M${b.usb.x} ${b.usb.y} v26" stroke="var(--sig)" stroke-width="2" stroke-dasharray="4 4"/><text class="pin" x="${
                b.usb.x + 8
              }" y="${b.usb.y + 22}">USB</text>`
          : '';

      return `<g class="node ${x.owned ? 'own' : 'buy'} ${r === L.mcuRef ? 'mcu' : ''}" data-sel="node:${esc(
        r
      )}" tabindex="0" role="button" aria-label="${esc(x.displayName)}">
        <rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/>
        <rect class="phb" x="${b.x + 8 + ox}" y="${b.y + 8}" width="28" height="28" rx="3"/>
        <g transform="translate(${b.x + 10 + ox} ${b.y + 10})"><g class="gl">${G[gKey] || G.proto}</g></g>
        <text class="nm" x="${b.x + 44 + ox}" y="${b.y + 20}">${esc(shortNm)}</text>
        <text class="st" x="${b.x + 44 + ox}" y="${b.y + 33}">${esc(st)}</text>
        ${pins}${usb}
      </g>`;
    })
    .join('');

  const usedAnchors = {};
  const marks = ws
    .map((w) => {
      let a;
      if ((w.on.nets || []).length && L.nets[w.on.nets[0]]) {
        a = [...L.nets[w.on.nets[0]].anchor];
      } else {
        const b = L.N[(w.on.nodes || [])[0]];
        if (!b) return '';
        a = [b.x + b.w - 10, b.y + 10];
      }
      const key = a.join(',');
      usedAnchors[key] = (usedAnchors[key] || 0) + 1;
      if (usedAnchors[key] > 1) a[1] += (usedAnchors[key] - 1) * 22;
      const done = w.src === 'assistant' && w.is_done;
      const plainLabel = plainWarningText(w.t);
      return `<g class="mk ${esc(w.sev)} ${done ? 'done' : ''}" data-sel="warn:${esc(
        w.id
      )}" tabindex="0" role="button" aria-label="${esc(plainLabel)}">
        <circle class="ring" cx="${a[0]}" cy="${a[1]}" r="9"/>
        <circle class="b" cx="${a[0]}" cy="${a[1]}" r="10"/>
        <text x="${a[0]}" y="${a[1] + 0.5}">${sevGlyph(w.sev, done)}</text>
        <circle class="mhit" cx="${a[0]}" cy="${a[1]}" r="13"/>
      </g>`;
    })
    .join('');

  return { W: L.W, H: L.H, inner: `${netEls}${nodeEls}${marks}` };
}

function renderMapSvg(proj) {
  const d = buildMapDiagramData(proj);
  if (!d) return '';
  return `<svg class="map" id="map" width="${d.W}" height="${d.H}" viewBox="0 0 ${d.W} ${d.H}" data-w="${d.W}" data-h="${d.H}" role="img" aria-label="${esc(
    proj.name
  )} wiring map">${d.inner}</svg>`;
}

/* Interactive pan & zoom camera for the fixed-frame Map viewport */
const mapCam = { pid: null, scale: 1, fitScale: 1, tx: 0, ty: 0, fitted: true, W: 0, H: 0 };
let mapResizeObs = null;

function computeMapFit(wrap, W, H) {
  const rect = wrap.getBoundingClientRect();
  const topPad = 48;
  const padX = 20;
  const padB = 22;
  const availW = Math.max(120, rect.width - padX * 2);
  const availH = Math.max(120, rect.height - topPad - padB);
  const fitScale = Math.min(availW / W, availH / H, 1.15);
  const tx = (rect.width - W * fitScale) / 2;
  const ty = topPad + (availH - H * fitScale) / 2;
  return { fitScale, tx, ty };
}

function clampMapCam(wrap) {
  const rect = wrap.getBoundingClientRect();
  const scaledW = mapCam.W * mapCam.scale;
  const scaledH = mapCam.H * mapCam.scale;
  const keep = Math.min(96, scaledW * 0.4, scaledH * 0.4);
  const minTx = keep - scaledW;
  const maxTx = rect.width - keep;
  const minTy = keep - scaledH;
  const maxTy = rect.height - keep;
  mapCam.tx = Math.max(minTx, Math.min(maxTx, mapCam.tx));
  mapCam.ty = Math.max(minTy, Math.min(maxTy, mapCam.ty));
}

function applyMapTransform(wrap, stage, animate = false) {
  clampMapCam(wrap);
  stage.classList.toggle('anim', animate);
  stage.style.transform = `translate3d(${mapCam.tx.toFixed(1)}px, ${mapCam.ty.toFixed(1)}px, 0) scale(${mapCam.scale.toFixed(4)})`;
  const g = Math.max(8, 16 * mapCam.scale);
  wrap.style.backgroundSize = `${g.toFixed(2)}px ${g.toFixed(2)}px`;
  wrap.style.backgroundPosition = `${(mapCam.tx % g).toFixed(1)}px ${(mapCam.ty % g).toFixed(1)}px`;
  const fitBtn = wrap.querySelector('[data-zoom="fit"]');
  if (fitBtn) {
    const pct = Math.round((mapCam.scale / (mapCam.fitScale || 1)) * 100);
    fitBtn.textContent = mapCam.fitted || Math.abs(pct - 100) <= 1 ? 'Fit' : `${pct}%`;
  }
}

function zoomMapAround(wrap, stage, factor, cx, cy, animate = false) {
  const minS = mapCam.fitScale * 0.45;
  const maxS = Math.max(2.6, mapCam.fitScale * 3.5);
  const nextS = Math.max(minS, Math.min(maxS, mapCam.scale * factor));
  const ratio = nextS / mapCam.scale;
  mapCam.tx = cx - (cx - mapCam.tx) * ratio;
  mapCam.ty = cy - (cy - mapCam.ty) * ratio;
  mapCam.scale = nextS;
  mapCam.fitted = false;
  applyMapTransform(wrap, stage, animate);
}

export function zoomMapViewport(action) {
  const wrap = document.getElementById('mapwrap');
  const stage = document.getElementById('mapstage');
  if (!wrap || !stage || !mapCam.W) return;
  const rect = wrap.getBoundingClientRect();
  if (action === 'fit') {
    const f = computeMapFit(wrap, mapCam.W, mapCam.H);
    mapCam.fitScale = f.fitScale;
    mapCam.scale = f.fitScale;
    mapCam.tx = f.tx;
    mapCam.ty = f.ty;
    mapCam.fitted = true;
    applyMapTransform(wrap, stage, true);
    return;
  }
  const factor = action === 'in' ? 1.28 : 1 / 1.28;
  zoomMapAround(wrap, stage, factor, rect.width / 2, rect.height / 2, true);
}

export function disconnectMapObserver() {
  if (mapResizeObs) {
    mapResizeObs.disconnect();
    mapResizeObs = null;
  }
}

export function initMapViewport(pid) {
  disconnectMapObserver();
  const wrap = document.getElementById('mapwrap');
  const stage = document.getElementById('mapstage');
  const svg = document.getElementById('map');
  if (!wrap || !stage || !svg) return;

  const W = Number(svg.dataset.w) || 800;
  const H = Number(svg.dataset.h) || 400;
  const f = computeMapFit(wrap, W, H);
  const sameProj = mapCam.pid === pid && mapCam.W === W && mapCam.H === H;

  if (!sameProj || mapCam.fitted) {
    mapCam.pid = pid;
    mapCam.W = W;
    mapCam.H = H;
    mapCam.fitScale = f.fitScale;
    mapCam.scale = f.fitScale;
    mapCam.tx = f.tx;
    mapCam.ty = f.ty;
    mapCam.fitted = true;
  } else {
    mapCam.fitScale = f.fitScale;
  }
  applyMapTransform(wrap, stage, false);

  if (typeof ResizeObserver === 'function') {
    mapResizeObs = new ResizeObserver(() => {
      if (!wrap.isConnected) return;
      const nf = computeMapFit(wrap, mapCam.W, mapCam.H);
      mapCam.fitScale = nf.fitScale;
      if (mapCam.fitted) {
        mapCam.scale = nf.fitScale;
        mapCam.tx = nf.tx;
        mapCam.ty = nf.ty;
      }
      applyMapTransform(wrap, stage, false);
    });
    mapResizeObs.observe(wrap);
  }

  // Pointer drag-to-pan + 2-finger pinch-to-zoom
  const pts = new Map();
  let dragStart = null;
  let dragged = false;
  let pinchPrev = null;

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, tx: mapCam.tx, ty: mapCam.ty, pid: e.pointerId };
      dragged = false;
      pinchPrev = null;
    } else if (pts.size === 2) {
      dragStart = null;
      const [a, b] = [...pts.values()];
      pinchPrev = {
        dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      wrap.classList.add('panning');
    }
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 2 && pinchPrev) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const rect = wrap.getBoundingClientRect();
      mapCam.tx += mx - pinchPrev.mx;
      mapCam.ty += my - pinchPrev.my;
      zoomMapAround(wrap, stage, dist / pinchPrev.dist, mx - rect.left, my - rect.top, false);
      pinchPrev = { dist, mx, my };
      dragged = true;
      return;
    }

    if (pts.size === 1 && dragStart && dragStart.pid === e.pointerId) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (!dragged && Math.hypot(dx, dy) > 4) {
        dragged = true;
        mapCam.fitted = false;
        wrap.classList.add('panning');
        if (state.hot) {
          state.hot = null;
          applyMapFocus(pid);
        }
        try {
          wrap.setPointerCapture(e.pointerId);
        } catch {}
      }
      if (dragged) {
        mapCam.tx = dragStart.tx + dx;
        mapCam.ty = dragStart.ty + dy;
        applyMapTransform(wrap, stage, false);
      }
    }
  });

  const endPtr = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchPrev = null;
    if (pts.size === 0) {
      wrap.classList.remove('panning');
      dragStart = null;
      if (dragged) {
        dragged = false;
        const eat = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        wrap.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => wrap.removeEventListener('click', eat, true), 250);
      }
    }
  };
  wrap.addEventListener('pointerup', endPtr);
  wrap.addEventListener('pointercancel', endPtr);

  // Trackpad pinch / Ctrl+wheel zoom toward cursor
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0045);
      zoomMapAround(wrap, stage, factor, e.clientX - rect.left, e.clientY - rect.top, false);
    },
    { passive: false }
  );

  // Double-click empty canvas to zoom in (or reset to Fit if already zoomed in)
  wrap.addEventListener('dblclick', (e) => {
    if (e.target.closest('.zoom, [data-sel]')) return;
    if (mapCam.scale > mapCam.fitScale * 1.75) {
      zoomMapViewport('fit');
    } else {
      const rect = wrap.getBoundingClientRect();
      zoomMapAround(wrap, stage, 1.5, e.clientX - rect.left, e.clientY - rect.top, true);
    }
  });
}

function relatedToSelection(proj, sel) {
  if (!sel || !proj) return null;
  const ws = warningsOfProject(proj);
  const idx = sel.indexOf(':');
  if (idx < 0) return null;
  const type = sel.slice(0, idx);
  const id = sel.slice(idx + 1);
  const on = { nodes: new Set(), nets: new Set(), warns: new Set() };
  if (type === 'node') {
    on.nodes.add(id);
    (proj.nets || []).forEach((n) => {
      if ((n.conns || []).some(([r]) => r === id)) {
        on.nets.add(n.id);
        n.conns.forEach(([r]) => on.nodes.add(r));
      }
    });
    ws.forEach((w) => {
      if ((w.on.nodes || []).includes(id) || (w.on.nets || []).some((x) => on.nets.has(x))) {
        on.warns.add(w.id);
      }
    });
  } else if (type === 'net') {
    on.nets.add(id);
    const n = (proj.nets || []).find((q) => q.id === id);
    if (n) (n.conns || []).forEach(([r]) => on.nodes.add(r));
    ws.forEach((w) => {
      if ((w.on.nets || []).includes(id)) on.warns.add(w.id);
    });
  } else if (type === 'warn') {
    const w = ws.find((x) => x.id === id);
    if (!w) return null;
    on.warns.add(id);
    (w.on.nodes || []).forEach((x) => on.nodes.add(x));
    (w.on.nets || []).forEach((x) => on.nets.add(x));
  } else {
    return null;
  }
  return on;
}

export function applyMapFocus(pid) {
  const el = document.getElementById('map');
  if (!el || !pid) return;
  const proj = projectById(pid);
  if (!proj) return;
  const on = relatedToSelection(proj, state.sel || state.hot);
  const wrap = el.closest('.mapwrap');
  if (wrap) wrap.classList.toggle('focus', Boolean(on));
  el.querySelectorAll('[data-sel]').forEach((g) => {
    const raw = g.dataset.sel;
    const idx = raw.indexOf(':');
    const t = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    const isOn =
      on &&
      ((t === 'node' && on.nodes.has(id)) ||
        (t === 'net' && on.nets.has(id)) ||
        (t === 'warn' && on.warns.has(id)));
    g.classList.toggle('on', Boolean(isOn));
    g.classList.toggle('sel', state.sel === raw);
    if (t === 'net') g.classList.toggle('hot', Boolean(isOn));
  });
}

/* =========================================================== One part (focus) view */
function renderFocusView(proj) {
  const guest = isGuest();
  const mcuRef = findMcuRef(proj);
  if (!mcuRef) {
    return `<div class="map-empty"><p>${
      guest ? 'No parts in this project yet.' : 'Add parts to this project to explore connections one part at a time.'
    }</p>${guest ? '' : `<a class="btn" href="${projectHref(proj, 'edit')}">Edit project</a>`}</div>`;
  }
  const c = state.focusRef[proj.id] || mcuRef;
  const x = resolveProjectItem(proj, c) || resolveProjectItem(proj, mcuRef);
  if (!x) return '';
  const ws = warningsOfProject(proj);
  const trail = state.trail[proj.id] || [];
  const allNets = proj.nets || [];
  const mine = allNets.filter((n) => (n.conns || []).some(([r]) => r === x.ref));
  const nodeWarn = ws.filter((w) => (w.on.nodes || []).includes(x.ref));
  const wRow = (w) => {
    const done = w.src === 'assistant' && w.is_done;
    return `<div class="fwarn" data-sel="warn:${esc(w.id)}" role="button" tabindex="0"><span class="sev ${done ? 'done' : esc(w.sev)}">${sevGlyph(
      w.sev,
      done
    )}</span><b>${w.t}</b></div>`;
  };

  // Part switcher options: MCU first, then power, peripherals, and materials
  const roleOrder = { mcu: 0, power: 1, periph: 2, material: 3 };
  const switchItems = (proj.items || [])
    .filter((it) => it.role !== 'material')
    .slice()
    .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9))
    .map((it) => {
      const rec = resolveProjectItem(proj, it.ref);
      if (!rec) return null;
      const wired = allNets.some((n) => (n.conns || []).some(([r]) => r === it.ref));
      return [it.ref, `${rec.displayName}${wired ? '' : ' (unwired)'}`, it.ref === x.ref];
    })
    .filter(Boolean);

  const crumbBar = trail.length
    ? `<nav class="crumbs" aria-label="Part trail">${trail
        .map((r) => {
          const tr = resolveProjectItem(proj, r);
          return tr
            ? `<button type="button" data-focus="${esc(r)}" data-crumb="1">${esc(tr.displayName)}</button><span class="csep" aria-hidden="true">→</span>`
            : '';
        })
        .join('')}<span class="ccur" aria-current="page">${esc(x.displayName)}</span></nav>`
    : `<div class="crumbs empty">${
        mine.length
          ? 'Tap a connected part below to step through the circuit.'
          : 'No wiring connections drawn for this part yet.'
      }</div>`;

  return `<div class="fview">
    <div class="fbar">
      ${switchItems.length > 1 ? menuHtml('focuspart', 'Part', x.displayName, switchItems) : ''}
      ${crumbBar}
    </div>

    <div class="fcenter ${x.owned ? '' : 'buy'}">
      <div class="fcenter-main" data-sel="node:${esc(x.ref)}" role="button" tabindex="0">
        ${x.src ? phPart(x.src) : ph(glyphOfItem(x))}
        <div>
          <b>${esc(x.displayName)}</b>
          <div class="faint">${x.owned ? 'owned' : 'to buy'}${x.project_notes ? ` · ${esc(x.project_notes)}` : ''}</div>
        </div>
      </div>
      ${nodeWarn.length ? `<div class="fcenter-warns">${nodeWarn.map(wRow).join('')}</div>` : ''}
    </div>

    ${
      mine.length
        ? mine
            .map((n, i) => {
              const myPins = [
                ...new Set(
                  (n.conns || [])
                    .filter(([r]) => r === x.ref)
                    .map(([, pin]) => pin)
                    .filter(Boolean)
                ),
              ];
              const myPin = myPins.join(', ');
              const others = (n.conns || []).filter(([r]) => r !== x.ref);
              const uniq = [];
              others.forEach(([r, pin]) => {
                const u = uniq.find((q) => q[0] === r);
                if (u) {
                  if (pin && !u[1].split(', ').includes(pin)) u[1] += u[1] ? `, ${pin}` : pin;
                } else {
                  uniq.push([r, pin || '']);
                }
              });
              const nw = ws.filter((w) => (w.on.nets || []).includes(n.id));
              return `<div class="fnet" style="animation-delay:${i * 40}ms">
                <div class="rail" style="background:var(--${esc(n.kind || 'sig')})"></div>
                <div>
                  <div class="hd">
                    <button type="button" class="fnet-btn" data-sel="net:${esc(n.id)}">${esc(n.name)}</button>
                    <span class="via">${esc(myPin)}</span>
                  </div>
                  <div class="nbrs">${uniq
                    .map(([r, pin]) => {
                      const y = resolveProjectItem(proj, r);
                      if (!y) return '';
                      return `<button type="button" class="nbr ${y.owned ? '' : 'buy'}" data-focus="${esc(r)}">${
                        y.src ? phPart(y.src) : ph(glyphOfItem(y))
                      }<span>${esc(y.displayName)}${pin ? `<small>${esc(pin)}</small>` : ''}</span></button>`;
                    })
                    .join('')}</div>
                  ${nw.map(wRow).join('')}
                </div>
              </div>`;
            })
            .join('')
        : guest
        ? `<p class="faint">No wires linked to ${esc(x.displayName)} yet. Switch to the <b>Parts</b> tab to see every part in this project.</p>`
        : `<p class="faint">No wires linked to ${esc(x.displayName)} yet. <a href="${appHref(
            `/projects/${encodeURIComponent(proj.id)}/edit`
          )}">Add wiring</a> or switch to the <b>Parts</b> tab to see every part in this project.</p>`
    }
  </div>`;
}

/* =========================================================== Metro (Lines) view */
function renderMetroView(proj) {
  const guest = isGuest();
  const nets = proj.nets || [];
  if (!nets.length) {
    return `<div class="map-empty">
      <p>${
        guest
          ? 'No wiring lines yet.'
          : 'No wiring lines yet. Add connections in <b>Edit project</b>, or ask your assistant to write the wiring list.'
      }</p>
      ${guest ? '' : `<a class="btn" href="${appHref(`/projects/${encodeURIComponent(proj.id)}/edit`)}">Edit wiring</a>`}
    </div>`;
  }
  const ws = warningsOfProject(proj);
  const mcuRef = findMcuRef(proj);

  return `<div class="metro">${nets
    .map((n, i) => {
      const stops = [];
      (n.conns || []).forEach(([r, pin]) => {
        const last = stops[stops.length - 1];
        if (last && last.r === r) last.pins.push(pin || '');
        else stops.push({ r, pins: pin ? [pin] : [] });
      });
      if (n.kind !== 'bat' && mcuRef) {
        stops.sort((a, b) => (a.r === mcuRef ? -1 : b.r === mcuRef ? 1 : 0));
      }
      const nw = ws.filter((w) => (w.on.nets || []).includes(n.id));
      const kindLabel = n.rail
        ? `${n.rail} V`
        : n.kind === 'bat'
        ? '3.0–4.2 V'
        : n.kind === 'sig'
        ? ''
        : String(n.kind || '').toUpperCase();

      return `<div class="line" style="--c:var(--${esc(n.kind || 'sig')});animation-delay:${i * 40}ms">
        <div class="hd">
          <b><i style="background:var(--${esc(n.kind || 'sig')})"></i>${esc(n.name)}</b>
          <span class="faint mono">${esc(kindLabel)}</span>
        </div>
        <div class="stops">${stops
          .map((s, j) => {
            const x = resolveProjectItem(proj, s.r);
            if (!x) return '';
            const sw = ws.filter((w) => (w.on.nodes || []).includes(s.r) && !(w.on.nets || []).length);
            return `<div class="stop ${j === 0 || j === stops.length - 1 ? 'term' : ''} ${
              x.owned ? '' : 'buy'
            }" data-sel="node:${esc(s.r)}" role="button" tabindex="0"><b>${esc(x.displayName)}</b>${
              s.pins.length ? `<span class="pinl">${esc(s.pins.join(' → '))}</span>` : ''
            }${
              sw.length
                ? `<span class="sevs">${sw
                    .map((w) => {
                      const d = w.src === 'assistant' && w.is_done;
                      return `<span class="sev ${d ? 'done' : esc(w.sev)}">${sevGlyph(w.sev, d)}</span>`;
                    })
                    .join('')}</span>`
                : ''
            }</div>`;
          })
          .join('')}</div>
        ${nw
          .map((w) => {
            const d = w.src === 'assistant' && w.is_done;
            return `<div class="fwarn" data-sel="warn:${esc(w.id)}" role="button" tabindex="0"><span class="sev ${
              d ? 'done' : esc(w.sev)
            }">${sevGlyph(w.sev, d)}</span><b>${w.t}</b></div>`;
          })
          .join('')}
      </div>`;
    })
    .join('')}</div>`;
}

/* =========================================================== Parts list view */
function renderPartsListView(proj) {
  const guest = isGuest();
  const items = proj.items || [];
  if (!items.length) {
    return `<div class="map-empty"><p>No parts in this project yet.</p>${
      guest ? '' : `<a class="btn" href="${appHref(`/projects/${encodeURIComponent(proj.id)}/edit`)}">Add parts</a>`
    }</div>`;
  }
  const ws = warningsOfProject(proj);
  const roleGroups = [
    ['power', 'Power'],
    ['mcu', 'Brain'],
    ['periph', 'Sensors, screens, inputs'],
    ['material', 'Build materials'],
  ];

  return `<div class="lst">${roleGroups
    .map(([role, heading]) => {
      const xs = items.filter((q) => (q.role || 'periph') === role);
      if (!xs.length) return '';
      return `<div class="grp"><span class="k">${esc(heading)}</span></div>${xs
        .map((q) => {
          const x = resolveProjectItem(proj, q.ref);
          if (!x) return '';
          const w = ws.filter((y) => (y.on.nodes || []).includes(q.ref) && y.sev !== 'ok');
          const loc = x.owned
            ? x.src && x.src.location
              ? `bin <span class="bin">${esc(x.src.location)}</span>`
              : 'owned'
            : esc(storeDisplayName(q.retailer || (x.src && x.src.retailer) || 'to buy'));
          const qtyVal = x.owned
            ? x.src ? x.src.quantity : q.owned_quantity || 0
            : x.src ? x.src.quantity : q.buy_quantity || 1;
          const qtyCtl = guest
            ? `<span class="mono">×${qtyVal}</span>`
            : x.owned
            ? stepHtml('data-qty', q.part_id, qtyVal, 'You own')
            : stepHtml('data-buy', q.shopping_item_id, qtyVal, 'To buy');

          return `<div class="lrow ${state.sel === `node:${q.ref}` ? 'sel' : ''}" data-sel="node:${esc(q.ref)}" role="button" tabindex="0">
            ${x.src ? phPart(x.src) : ph(glyphOfItem(x))}
            <div class="n">${esc(x.displayName)}<small>${esc(q.project_notes || '')}</small></div>
            <span class="c3 dim">${loc}</span>
            <span class="c4 r">${qtyCtl}</span>
            <span class="w">${w
              .map((y) => {
                const d = y.src === 'assistant' && y.is_done;
                return `<span class="sev ${d ? 'done' : esc(y.sev)}">${sevGlyph(y.sev, d)}</span>`;
              })
              .join('')}</span>
          </div>`;
        })
        .join('')}`;
    })
    .join('')}</div>`;
}

/* =========================================================== Project Inspector */
const inspHead = (title, sub) =>
  `<div class="insp-h"><div><h2>${title}</h2>${
    sub ? `<div class="faint" style="margin-top:2px">${sub}</div>` : ''
  }</div><button class="btn quiet close" type="button" data-act="clear" aria-label="Close">${sv(
    '<path d="M18 6 6 18M6 6l12 12"/>'
  )}</button></div>`;

function warnBlock(proj, w) {
  const guest = isGuest();
  const done = w.src === 'assistant' && w.is_done;
  return `<div class="warn ${done ? 'done' : ''}">
    <span class="sev ${done ? 'done' : esc(w.sev)}">${sevGlyph(w.sev, done)}</span>
    <div>
      <b>${w.t}</b> <span class="src">${w.src === 'rule' ? 'built-in check' : 'assistant'}</span>
      ${w.b ? `<p>${w.b}</p>` : ''}
      ${
        w.sev !== 'ok'
          ? `<div class="acts">${
              w.src === 'assistant'
                ? guest
                  ? `<span class="faint">${done ? 'Checked' : 'Open check'}</span>`
                  : `<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input class="tick" type="checkbox" data-done="${esc(
                      proj.id
                    )}|${esc(w.id)}" ${done ? 'checked' : ''}><span>${done ? 'Checked' : 'Mark as checked'}</span></label>`
                : '<span class="faint">Goes away when the wiring changes.</span>'
            }</div>`
          : ''
      }
    </div>
  </div>`;
}

export function renderProjectInspector(proj) {
  const guest = isGuest();
  const ws = warningsOfProject(proj);
  const sel = state.sel;

  if (!sel || (!sel.startsWith('node:') && !sel.startsWith('net:') && !sel.startsWith('warn:'))) {
    const next = nextStepOfProject(proj);
    const checks = ws.filter((w) => w.sev !== 'ok');
    const okChecks = ws.filter((w) => w.sev === 'ok');
    return `${inspHead(esc(proj.name), esc(proj.description || ''))}
    <div class="insp-body"><div class="insp-in">
      <div class="sec">
        <span class="k">next</span>
        <div class="next">
          <div><b>${esc(next.t)}</b><span class="faint">${esc(next.s)}</span></div>
          ${
            next.href
              ? `<a class="btn ink" href="${esc(next.href)}">Open →</a>`
              : next.act
              ? `<button class="btn ink" type="button" data-sel="${esc(next.act)}">Show →</button>`
              : ''
          }
        </div>
      </div>

      <div class="sec">
        <span class="k">before you power it</span>
        ${
          checks.length
            ? checks
                .map((w) => {
                  const done = w.src === 'assistant' && w.is_done;
                  return `<div class="check-row ${done ? 'done' : ''}" data-sel="warn:${esc(w.id)}" role="button" tabindex="0">
                    ${
                      w.src === 'assistant' && !guest
                        ? `<input class="tick" type="checkbox" data-done="${esc(proj.id)}|${esc(w.id)}" ${
                            done ? 'checked' : ''
                          } aria-label="Checked">`
                        : `<span class="sev ${done ? 'done' : esc(w.sev)}">${sevGlyph(w.sev, done)}</span>`
                    }
                    <b>${w.t}</b>
                    ${
                      w.src === 'assistant'
                        ? guest
                          ? `<span class="src">${done ? 'checked' : 'note'}</span>`
                          : `<span class="sev ${done ? 'done' : esc(w.sev)}">${sevGlyph(w.sev, done)}</span>`
                        : '<span class="src">check</span>'
                    }
                  </div>`;
                })
                .join('')
            : '<p class="faint" style="margin-top:4px">No warnings or open checks yet.</p>'
        }
      </div>

      ${
        okChecks.length
          ? `<div class="sec">
              <span class="k">works together · built-in checks</span>
              ${okChecks
                .map(
                  (w) =>
                    `<div class="check-row" data-sel="warn:${esc(w.id)}" role="button" tabindex="0"><span class="sev ok">✓</span><b>${w.t}</b><span></span></div>`
                )
                .join('')}
            </div>`
          : ''
      }

      <div class="sec faint">${
        guest
          ? 'Built-in checks run automatically against the wiring.'
          : 'The built-in checks run every time the wiring changes. The assistant’s notes need you to tick them.'
      }</div>
    </div></div>`;
  }

  const idx = sel.indexOf(':');
  const type = sel.slice(0, idx);
  const id = sel.slice(idx + 1);

  if (type === 'node') {
    const x = resolveProjectItem(proj, id);
    if (!x) {
      state.sel = null;
      return renderProjectInspector(proj);
    }
    const nw = ws.filter((w) => (w.on.nodes || []).includes(id));
    const nets = (proj.nets || []).filter((n) => (n.conns || []).some(([r]) => r === id));
    const sub = x.owned
      ? `owned${x.src && x.src.location ? ` · bin ${x.src.location}` : ''}`
      : `to buy · ${x.src ? x.src.quantity : x.buy_quantity || 1}× from ${storeDisplayName(
          x.retailer || (x.src && x.src.retailer) || 'store'
        )}`;

    return `${inspHead(esc(x.fullName), esc(sub))}
    <div class="insp-body"><div class="insp-in">
      <div class="sec">${x.src ? phPart(x.src, 'photo', Boolean(x.src.image_path), true) : ph(glyphOfItem(x), 'photo')}</div>
      ${x.project_notes ? `<div class="sec"><span class="k">in this project</span><p>${esc(x.project_notes)}</p></div>` : ''}
      ${!x.owned && (x.why_needed || (x.src && x.src.why_needed)) ? `<div class="sec"><span class="k">why buy it</span><p>${esc(x.why_needed || x.src.why_needed)}</p></div>` : ''}
      ${
        nets.length
          ? `<div class="sec"><span class="k">connects to</span><div class="conn">${nets
              .map((n) => {
                const grouped = [];
                (n.conns || [])
                  .filter(([r]) => r !== id)
                  .forEach(([r, pin]) => {
                    const g = grouped.find((q) => q[0] === r);
                    if (g) {
                      if (pin && !g[1].includes(pin)) g[1].push(pin);
                    } else {
                      grouped.push([r, pin ? [pin] : []]);
                    }
                  });
                return `<i style="background:var(--${esc(n.kind || 'sig')})"></i><button class="term" type="button" data-sel="net:${esc(
                  n.id
                )}" style="cursor:pointer;text-decoration:none;text-align:left">${esc(n.name)}</button><span class="dim">${grouped
                  .map(([r, pins]) => {
                    const other = resolveProjectItem(proj, r);
                    return `${esc(other ? other.displayName : r)}${pins.length ? ` <span class="mono">${esc(pins.join(', '))}</span>` : ''}`;
                  })
                  .join(', ')}</span>`;
              })
              .join('')}</div></div>`
          : ''
      }
      ${nw.length ? `<div class="sec"><span class="k">warnings and checks</span>${nw.map((w) => warnBlock(proj, w)).join('')}</div>` : ''}
      <div class="sec" style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn" type="button" data-act="clear">← Whole project</button>
        ${nets.length ? `<button class="btn" type="button" data-focus="${esc(id)}" data-view-to="focus">Show its connections</button>` : ''}
        ${
          x.part_id && !guest
            ? `<a class="btn quiet" href="${appHref(`/parts/${encodeURIComponent(x.part_id)}/edit`)}">Edit part</a>`
            : x.shopping_item_id
            ? `<a class="btn quiet" href="${appHref('/shopping')}">Shopping →</a>`
            : ''
        }
      </div>
    </div></div>`;
  }

  if (type === 'net') {
    const n = (proj.nets || []).find((q) => q.id === id);
    if (!n) {
      state.sel = null;
      return renderProjectInspector(proj);
    }
    const nw = ws.filter((w) => (w.on.nets || []).includes(id));
    return `${inspHead(
      esc(n.name),
      `<span style="color:var(--${esc(n.kind || 'sig')})">●</span> ${esc(n.rail ? `${n.rail} V` : n.kind || 'signal')}`
    )}
    <div class="insp-body"><div class="insp-in">
      <div class="sec">
        <span class="k">stops</span>
        ${(n.conns || [])
          .map(([r, pin]) => {
            const other = resolveProjectItem(proj, r);
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0"><span>${esc(
              other ? other.displayName : r
            )}</span><span class="mono dim">${esc(pin || '')}</span></div>`;
          })
          .join('')}
      </div>
      ${nw.length ? `<div class="sec"><span class="k">on this wire</span>${nw.map((w) => warnBlock(proj, w)).join('')}</div>` : ''}
      <div class="sec"><button class="btn" type="button" data-act="clear">← Whole project</button></div>
    </div></div>`;
  }

  if (type === 'warn') {
    const w = ws.find((q) => q.id === id);
    if (!w) {
      state.sel = null;
      return renderProjectInspector(proj);
    }
    const where = [
      ...(w.on.nodes || []).map((r) => {
        const x = resolveProjectItem(proj, r);
        return x ? x.displayName : r;
      }),
      ...(w.on.nets || []).map((nid) => {
        const n = (proj.nets || []).find((q) => q.id === nid);
        return n ? n.name : nid;
      }),
    ];
    const headTitle = w.sev === 'danger' ? 'Can damage parts' : w.sev === 'check' ? 'Check first' : 'Works together';
    return `${inspHead(headTitle, esc(where.join(' · ')))}
    <div class="insp-body"><div class="insp-in">
      <div class="sec">${warnBlock(proj, w)}</div>
      <div class="sec"><button class="btn" type="button" data-act="clear">← Whole project</button></div>
    </div></div>`;
  }

  return '';
}

/* =========================================================== Project Detail screen */
export function renderProjectDetailView(pid) {
  const guest = isGuest();
  const proj = projectById(pid);
  if (!proj) {
    return `<div class="screen full"><div class="work">
      <a class="eback pback" href="${appHref('/projects')}">← Projects</a>
      <h1>Project not found</h1>
      <p class="dim" style="margin-top:8px">That project may have been deleted.</p>
    </div></div>`;
  }

  const hasNets = (proj.nets || []).length > 0;
  const def = hasNets ? (isPhone() ? 'focus' : 'map') : 'list';
  const v = state.projView[pid] || def;
  const ws = warningsOfProject(proj);
  const checks = ws.filter((w) => w.sev !== 'ok');
  const doneN = checks.filter((w) => w.src === 'assistant' && w.is_done).length;
  const items = proj.items || [];
  const ownedCount = items.filter((x) => x.part_id).length;

  const tabs = [
    ['map', 'Map'],
    ['focus', 'One part'],
    ['metro', 'Lines'],
    ['list', 'Parts'],
    ['code', 'Code'],
    ['notes', 'Notes'],
  ];

  let body = '';
  if (v === 'map') {
    if (hasNets) {
      const dlIcon = sv('<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>');
      body = `<div class="mapwrap" id="mapwrap">
          <div class="zoom">
            <button class="btn" type="button" data-zoom="out" aria-label="Zoom out">−</button>
            <button class="btn" type="button" data-zoom="fit" title="Reset view to fit">Fit</button>
            <button class="btn" type="button" data-zoom="in" aria-label="Zoom in">+</button>
            <span class="mapsep" aria-hidden="true"></span>
            <button class="btn" type="button" data-map-export="png" title="Download wiring map as PNG">${dlIcon}PNG</button>
            <button class="btn" type="button" data-map-export="pdf" title="Download wiring map as PDF">${dlIcon}PDF</button>
          </div>
          <div class="mapstage" id="mapstage">${renderMapSvg(proj)}</div>
          <div class="maphint" aria-hidden="true">Drag to pan · Ctrl+scroll to zoom</div>
        </div>
        <div class="legend">
          <span><i style="background:var(--bat)"></i>battery</span>
          <span><i style="background:var(--v5)"></i>5 V</span>
          <span><i style="background:var(--v33)"></i>3.3 V</span>
          <span><i style="background:var(--i2c)"></i>I2C</span>
          <span><i style="background:var(--spi)"></i>SPI</span>
          <span><i style="background:var(--sig)"></i>signal</span>
          <span><span class="sev danger">!</span>can damage parts</span>
          <span><span class="sev check">?</span>check first</span>
          <span><span class="sev ok">✓</span>works together</span>
          <span class="faint">solid: owned · dashed: to buy · GND not drawn · logical diagram (see Bench for physical pinout)</span>
        </div>`;
    } else {
      body = `<div class="map-empty">
        <p>${
          guest
            ? 'No wiring connections yet.'
            : 'No wiring connections yet. Add them in <b>Edit project</b>, or ask your assistant to write the wiring list — the diagram draws itself automatically.'
        }</p>
        <div class="chips">
          ${guest ? '' : `<a class="btn ink" href="${projectHref(proj, 'edit')}">Add wiring</a>`}
          <button class="btn" type="button" data-view="list">View parts (${items.length})</button>
        </div>
      </div>`;
    }
  } else if (v === 'focus') {
    body = renderFocusView(proj);
  } else if (v === 'metro') {
    body = renderMetroView(proj);
  } else if (v === 'list') {
    body = renderPartsListView(proj);
  } else if (v === 'code') {
    body = renderProjectCodeView(proj, renderMapSvg);
  } else if (v === 'notes') {
    body = `<div class="notes">${mdLite(
      proj.notes
    )}<p class="faint" style="margin-top:16px">Safety notes live on the map, attached to the wire or part they are about.</p></div>`;
  }

  const mats = items.filter((x) => x.role === 'material');
  if ((v === 'map' || v === 'focus') && mats.length) {
    body += `<div class="tray">
      <span class="k">also on the bench</span>
      ${mats
        .map((q) => {
          const x = resolveProjectItem(proj, q.ref);
          if (!x) return '';
          return `<button type="button" class="item ${x.owned ? 'own' : ''}" data-sel="node:${esc(q.ref)}">${
            x.src ? phPart(x.src) : ph(glyphOfItem(x))
          }${esc(x.displayName)}<span class="faint">${x.owned ? 'owned' : 'to buy'}</span></button>`;
        })
        .join('')}
    </div>`;
  }

  const hasSel = Boolean(
    state.sel && (state.sel.startsWith('node:') || state.sel.startsWith('net:') || state.sel.startsWith('warn:'))
  );
  const pwr = computePowerBudget(proj);

  return `<div class="screen">
    <div class="work">
      <div class="projhead">
        <a class="eback pback" href="${appHref('/projects')}">← Projects</a>
        <div class="row1">
          <h1>${esc(proj.name)}</h1>
          ${proj.option ? `<span class="tag opt">${esc(proj.option)}</span>` : ''}
          <span style="flex:1"></span>
          ${
            guest
              ? ''
              : `<div class="pacts">
                  ${
                    proj.archived
                      ? ''
                      : `<a class="btn" href="${projectHref(proj, 'edit')}">Edit project</a>`
                  }
                  <button class="btn quiet" type="button" data-archive="${esc(pid)}">${
                    proj.archived ? 'Restore' : 'Archive'
                  }</button>
                </div>`
          }
        </div>
        ${proj.description ? `<p class="desc">${esc(proj.description)}</p>` : ''}
        <div class="row2">
          <div class="chips">${tagsReadonlyHtml(proj)}</div>
          <span style="flex:1"></span>
          <div class="stat">
            <div><span class="k">owned</span><b class="num">${ownedCount}/${items.length}</b></div>
            ${
              pwr.totalMa > 0
                ? `<div><span class="k">draw</span><b class="num">~${Math.round(pwr.totalMa)} mA${
                    pwr.estHours ? ` · ~${pwr.estHours} h` : ''
                  }</b></div>`
                : ''
            }
            <div><span class="k">checks</span><b class="num">${doneN}/${checks.length}</b><span class="meter"><i style="width:${
    checks.length ? (doneN / checks.length) * 100 : 100
  }%"></i></span></div>
          </div>
        </div>
        ${
          proj.archived
            ? `<div class="archived-note"><span>Archived. It is hidden from Inventory and Shopping.</span>${
                guest ? '' : `<button class="btn" type="button" data-archive="${esc(pid)}">Restore</button>`
              }</div>`
            : ''
        }
      </div>

      <div class="cattabs" role="group" aria-label="View">
        ${tabs
          .map(
            ([k, label]) =>
              `<button type="button" data-view="${k}" aria-pressed="${v === k}">${esc(label)}</button>`
          )
          .join('')}
      </div>

      ${body}
    </div>
    <aside class="insp ${hasSel ? 'open' : ''}" id="insp" aria-label="Project details">${renderProjectInspector(proj)}</aside>
  </div>`;
}

/* =========================================================== Actions */
export async function toggleProjectArchive(pid, renderFn) {
  const proj = projectById(pid);
  if (!proj) return;
  if (!proj.archived) {
    const ok = window.confirm(
      `Archive "${proj.name}"?\n\nIt will be hidden from Inventory and Shopping until you restore it.`
    );
    if (!ok) return;
  }
  const prevStatus = proj.status || 'planning';
  const nextStatus = proj.archived ? 'planning' : 'archived';
  proj.status = nextStatus;
  proj.archived = nextStatus === 'archived';
  if (proj.archived && state.lens === pid) state.lens = null;
  renderFn();
  try {
    const updated = await api.patchProject(pid, { status: nextStatus });
    Object.assign(proj, updated);
    renderFn();
    toast(proj.archived ? `${proj.name} archived` : `${proj.name} restored`, async () => {
      try {
        const reverted = await api.patchProject(pid, { status: prevStatus });
        Object.assign(proj, reverted);
        renderFn();
      } catch (err) {
        toast(err.message);
      }
    });
  } catch (err) {
    proj.status = prevStatus;
    proj.archived = prevStatus === 'archived';
    renderFn();
    toast(err.message);
  }
}

export async function toggleProjectCheck(pid, cid, isDone, renderFn) {
  const proj = projectById(pid);
  if (!proj) return;
  const chk = (proj.checks || []).find((c) => c.id === cid);
  if (!chk) return;
  const prev = Boolean(chk.is_done);
  chk.is_done = isDone;
  renderFn();
  try {
    const updated = await api.patchProjectCheck(pid, cid, { is_done: isDone });
    if (updated && updated.id) Object.assign(proj, updated);
  } catch (err) {
    chk.is_done = prev;
    renderFn();
    toast(err.message);
  }
}
