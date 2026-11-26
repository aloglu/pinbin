// Glossary screen: categorized plain-English terms, inline SVG diagrams, project links, and in-place Part Inspector.
import {
  state,
  esc,
  sv,
  chev,
  phPart,
  sevGlyph,
  partById,
  appHref,
} from '../state.js';
import { warningsOfProject } from '../rules.js';
import { renderPartInspector } from '../inspectors.js';

const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

const CATEGORY_ORDER = [
  'Electricity & Power',
  'Circuit Basics',
  'Components & Parts',
  'Signals & Protocols',
  'Soldering & Bench',
];

const BENCH_TOOL_LABELS = {
  c3: 'ESP32-C3 SuperMini',
  esp32: 'ESP32 30-pin',
  pico2: 'Raspberry Pi Pico 2',
  uno: 'Arduino Uno',
  bb: 'Breadboard',
  res: 'Resistor bands',
  dmm: 'Multimeter dial',
  led: 'LED resistor',
  div: 'Voltage divider',
  ohm: 'Ohm’s law',
  batt: 'Battery life',
};

const FIGURES = {
  ohm: `<svg viewBox="0 0 220 120" class="fig" role="img" aria-label="Ohm's law triangle: V over I and R"><path d="M110 10 L200 110 H20 Z" fill="none" stroke="var(--ink-3)" stroke-width="1.5"/><line x1="55" y1="72" x2="165" y2="72" stroke="var(--ink-3)"/><line x1="110" y1="72" x2="110" y2="110" stroke="var(--ink-3)"/><text x="110" y="58" text-anchor="middle" class="fv">V</text><text x="80" y="98" text-anchor="middle" class="fv">I</text><text x="140" y="98" text-anchor="middle" class="fv">R</text><text x="110" y="118" text-anchor="middle" class="fl">cover the one you want</text></svg>`,
  divider: `<svg viewBox="0 0 240 150" class="fig" role="img" aria-label="Voltage divider bringing 5 V down to about 3.3 V with 1k and 2k resistors"><text x="20" y="18" class="fl">5 V in</text><path d="M40 24 V40" stroke="var(--ink)" stroke-width="1.6"/><rect x="30" y="40" width="20" height="34" rx="2" fill="none" stroke="var(--ink)" stroke-width="1.6"/><text x="58" y="61" class="fl">R1 1 kΩ</text><path d="M40 74 V90" stroke="var(--ink)" stroke-width="1.6"/><circle cx="40" cy="90" r="3" fill="var(--ink)"/><path d="M40 90 H150" stroke="var(--ok)" stroke-width="1.6"/><text x="156" y="94" class="fv" style="font-size:13px">≈ 3.3 V out</text><path d="M40 90 V106" stroke="var(--ink)" stroke-width="1.6"/><rect x="30" y="106" width="20" height="30" rx="2" fill="none" stroke="var(--ink)" stroke-width="1.6"/><text x="58" y="125" class="fl">R2 2 kΩ</text><path d="M40 136 V146 M30 146 H50" stroke="var(--ink)" stroke-width="1.6"/></svg>`,
  i2c: `<svg viewBox="0 0 260 120" class="fig" role="img" aria-label="I2C two shared wires SDA and SCL with separate device addresses"><rect x="10" y="35" width="60" height="50" rx="4" fill="none" stroke="var(--ink)" stroke-width="1.5"/><text x="40" y="64" text-anchor="middle" class="fl">board</text><path d="M70 50 H230 M70 70 H230" stroke="var(--i2c)" stroke-width="2"/><text x="236" y="54" class="fl">SDA</text><text x="236" y="74" class="fl">SCL</text><path d="M120 50 V20 M128 70 V20 M180 50 V20 M188 70 V20" stroke="var(--i2c)" stroke-width="1.5"/><rect x="104" y="4" width="40" height="18" rx="3" fill="var(--surface)" stroke="var(--ink-3)"/><text x="124" y="17" text-anchor="middle" class="fl">0x68</text><rect x="164" y="4" width="40" height="18" rx="3" fill="var(--surface)" stroke="var(--ink-3)"/><text x="184" y="17" text-anchor="middle" class="fl">0x53</text><text x="130" y="104" text-anchor="middle" class="fl">one address per device</text></svg>`,
  diode: `<svg viewBox="0 0 240 90" class="fig" role="img" aria-label="Diode symbol showing anode plus and cathode stripe"><path d="M10 40 H90 M150 40 H230" stroke="var(--ink)" stroke-width="1.6"/><path d="M90 20 V60 L140 40 Z" fill="none" stroke="var(--ink)" stroke-width="1.6"/><path d="M140 20 V60" stroke="var(--ink)" stroke-width="3"/><text x="20" y="72" class="fl">anode (+)</text><text x="160" y="72" class="fl">cathode · stripe</text><path d="M100 82 H130" stroke="var(--ok)" stroke-width="1.5" marker-end="url(#glAr)"/><defs><marker id="glAr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="var(--ok)"/></marker></defs></svg>`,
  led: `<svg viewBox="0 0 200 120" class="fig" role="img" aria-label="LED polarity: long leg plus, short leg with flat side minus"><path d="M80 60 V30 a20 20 0 0 1 40 0 V60 Z" fill="none" stroke="var(--ink)" stroke-width="1.6"/><path d="M72 60 H128" stroke="var(--ink)" stroke-width="1.6"/><path d="M90 60 V112" stroke="var(--ink)" stroke-width="1.6"/><path d="M110 60 V96" stroke="var(--ink)" stroke-width="1.6"/><text x="40" y="104" class="fl">+ long</text><text x="118" y="92" class="fl">− short, flat side</text></svg>`,
  pullup: `<svg viewBox="0 0 240 140" class="fig" role="img" aria-label="Pull-up resistor holding a GPIO pin high until a button pulls it to ground"><text x="18" y="16" class="fl">3.3 V</text><path d="M40 22 V36" stroke="var(--ink)" stroke-width="1.6"/><rect x="30" y="36" width="20" height="30" rx="2" fill="none" stroke="var(--ink)" stroke-width="1.6"/><text x="58" y="56" class="fl">pull-up (built in)</text><path d="M40 66 V80 H140" stroke="var(--ink)" stroke-width="1.6"/><text x="146" y="84" class="fl">to GPIO pin</text><path d="M40 80 V96" stroke="var(--ink)" stroke-width="1.6"/><path d="M40 96 L56 110 M40 116 V128 M30 128 H50" stroke="var(--ink)" stroke-width="1.6"/><text x="62" y="112" class="fl">button to GND</text></svg>`,
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partsMatchingTerm(term) {
  const id = term.id;
  const parts = state.parts || [];

  // Exact electrical-fact rules for core technical terms
  if (id === 'i2c') return parts.filter((p) => (p.electrical_facts?.interfaces || []).includes('I2C') || p.electrical_facts?.i2c);
  if (id === 'spi') return parts.filter((p) => (p.electrical_facts?.interfaces || []).includes('SPI'));
  if (id === 'uart') return parts.filter((p) => (p.electrical_facts?.interfaces || []).includes('UART'));
  if (id === 'pwm') return parts.filter((p) => (p.electrical_facts?.interfaces || []).includes('PWM'));
  if (id === 'voltage-divider') return parts.filter((p) => p.electrical_facts?.out && Object.keys(p.electrical_facts.out).length > 0);
  if (id === 'logic-level') return parts.filter((p) => p.electrical_facts?.logic === 'v5' || p.electrical_facts?.logic === 'v33');
  if (id === 'gpio' || id === 'microcontroller') return parts.filter((p) => p.category === 'Microcontrollers');
  if (id === 'voltage') return parts.filter((p) => p.electrical_facts?.logic === 'v33' || p.electrical_facts?.logic === 'v5');

  // Keyword matching against part name / subtitle / what_it_does
  const kws = String(term.keywords || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
  if (!kws.length) return [];

  const regexes = kws.map((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i'));
  return parts.filter((p) => {
    const hay = `${p.name || ''} ${p.subtitle || ''} ${p.what_it_does || ''}`;
    return regexes.some((re) => re.test(hay));
  });
}

function projectHitsForTerm(term) {
  const hits = [];
  const activeProjects = (state.projects || []).filter((p) => !p.archived);
  const kws = [
    term.term.toLowerCase().split(' (')[0],
    ...String(term.keywords || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 3),
  ];
  const regexes = [...new Set(kws)].map((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i'));

  for (const pr of activeProjects) {
    const ws = warningsOfProject(pr);
    for (const w of ws) {
      const raw = `${w.t || ''} ${w.b || ''}`;
      const plain = raw.replace(/<[^>]+>/g, '');
      const hasAttr = raw.includes(`data-term="${term.id}"`);
      const hasKw = regexes.some((re) => re.test(plain));
      if (hasAttr || hasKw) {
        hits.push([pr, w]);
      }
    }
  }
  return hits;
}

export function renderGlossaryView() {
  const allTerms = state.glossary || [];
  const gl = state.gl;
  const q = (gl.q || '').trim().toLowerCase();
  const filter = gl.filter || 'all';

  // Cache parts & project hits per term for this render pass
  const partMap = new Map();
  const hitMap = new Map();
  for (const t of allTerms) {
    partMap.set(t.id, partsMatchingTerm(t));
    hitMap.set(t.id, projectHitsForTerm(t));
  }

  const countFor = (f) =>
    allTerms.filter(
      (t) =>
        f === 'all' ||
        (f === 'parts' && (partMap.get(t.id) || []).length > 0) ||
        (f === 'projects' && (hitMap.get(t.id) || []).length > 0)
    ).length;

  const filtered = allTerms.filter((t) => {
    if (filter === 'parts' && !(partMap.get(t.id) || []).length) return false;
    if (filter === 'projects' && !(hitMap.get(t.id) || []).length) return false;
    if (!q) return true;
    const hay = `${t.term} ${t.summary} ${t.rule_of_thumb} ${t.keywords || ''} ${t.category}`.toLowerCase();
    return hay.includes(q);
  });

  // Group filtered terms by category in clean order
  const catNames = [...new Set([...CATEGORY_ORDER, ...filtered.map((t) => t.category || 'Circuit Basics')])];
  const firstDisplayed =
    catNames
      .flatMap((cat) => filtered.filter((t) => (t.category || 'Circuit Basics') === cat))
      [0] || allTerms[0] || null;

  // Ensure a valid selected term (defaults to the first visible item in the list)
  let cur = allTerms.find((t) => t.id === gl.termId);
  if (!cur) {
    cur = firstDisplayed;
    if (cur) gl.termId = cur.id;
  }

  const narrow = isNarrow();
  const showDetail = !narrow || gl.detail;

  const indexHtml = `<div class="gl-idx" ${narrow && gl.detail ? 'hidden' : ''}>${
    filtered.length
      ? catNames
          .map((cat) => {
            const ks = filtered.filter((t) => (t.category || 'Circuit Basics') === cat);
            if (!ks.length) return '';
            return `<div class="sh"><h2>${esc(cat)}</h2><span class="cnt">${ks.length}</span></div>
              <div class="lgroup">${ks
                .map((t) => {
                  const nParts = (partMap.get(t.id) || []).length;
                  const nProj = (hitMap.get(t.id) || []).length;
                  const active = cur && cur.id === t.id && !narrow;
                  return `<button type="button" class="gt li ${active ? 'on' : ''}" data-gterm="${esc(t.id)}" ${
                    active ? 'aria-current="true"' : ''
                  }><span class="lt"><b>${esc(t.term)}</b><span>${esc(t.summary)}</span>${
                    nParts || nProj
                      ? `<span class="gm">${nParts ? `${nParts} of your parts` : ''}${
                          nParts && nProj ? ' · ' : ''
                        }${nProj ? 'in a project' : ''}</span>`
                      : ''
                  }</span>${chev}</button>`;
                })
                .join('')}</div>`;
          })
          .join('')
      : '<p class="faint" style="padding:12px 0">No terms match.</p>'
  }</div>`;

  let detailHtml = '';
  if (cur) {
    const ps = partMap.get(cur.id) || [];
    const hits = hitMap.get(cur.id) || [];
    const related = (cur.related_ids || [])
      .map((rid) => allTerms.find((t) => t.id === rid))
      .filter(Boolean);
    const figSvg = cur.figure_key && FIGURES[cur.figure_key] ? FIGURES[cur.figure_key] : '';
    const toolName = cur.bench_tool && BENCH_TOOL_LABELS[cur.bench_tool] ? BENCH_TOOL_LABELS[cur.bench_tool] : '';

    detailHtml = `<article class="gl-doc" ${showDetail ? '' : 'hidden'}>
      <span class="kick">${esc(cur.category || 'Circuit Basics')}</span>
      <h1 class="gtitle">${esc(cur.term)}</h1>
      <p class="lead">${esc(cur.summary)}</p>
      ${figSvg ? `<figure>${figSvg}</figure>` : ''}
      ${cur.rule_of_thumb ? `<h3>Rule of thumb</h3><p>${esc(cur.rule_of_thumb)}</p>` : ''}

      ${
        hits.length
          ? `<h3>Where it matters in your projects</h3>
             ${hits
               .map(
                 ([pr, w]) =>
                   `<button type="button" class="hitrow" data-goto="${esc(pr.id)}|${esc(w.id)}">
                     <span class="sev ${esc(w.sev)}">${sevGlyph(w.sev)}</span>
                     <span><b>${esc(String(w.t || '').replace(/<[^>]+>/g, ''))}</b><span class="faint">${esc(
                     pr.name
                   )}</span></span>
                   </button>`
               )
               .join('')}`
          : ''
      }

      ${
        ps.length
          ? `<h3>In your parts <span class="cnt">${ps.length}</span></h3>
             <div class="minis">${ps
               .slice(0, 12)
               .map(
                 (p) =>
                   `<button type="button" class="mini ${state.sel === `part:${p.id}` ? 'sel' : ''}" data-openpart="${esc(
                     p.id
                   )}">${phPart(p)}<span><b>${esc(p.name)}</b><span class="faint">${
                     p.location ? `Bin ${esc(p.location)}` : 'No bin'
                   }</span></span></button>`
               )
               .join('')}</div>`
          : ''
      }

      ${
        related.length
          ? `<h3>Related</h3>
             <div class="lgroup">${related
               .map(
                 (r) =>
                   `<button type="button" class="li" data-gterm="${esc(r.id)}"><span class="lt"><b>${esc(
                     r.term
                   )}</b><span>${esc(r.summary)}</span></span>${chev}</button>`
               )
               .join('')}</div>`
          : ''
      }

      ${
        toolName
          ? `<div class="tryit"><span>Try it on the Bench</span><button class="btn" type="button" data-gotool="${esc(
              cur.bench_tool
            )}">${esc(toolName)} →</button></div>`
          : ''
      }
    </article>`;
  }

  const selPartId = state.sel && state.sel.startsWith('part:') ? state.sel.slice(5) : null;
  const partAside =
    selPartId && partById(selPartId)
      ? `<aside class="insp open float ${state.panelWasOpen ? '' : 'enter'}" id="insp" aria-label="Details">${renderPartInspector(
          selPartId
        )}</aside>`
      : '';

  // Phone drill-down article view
  if (narrow && gl.detail && cur) {
    return `<div class="screen full">
      <div class="work gl-one">
        <div class="ehead">
          <a class="eback" href="${appHref('/glossary')}" data-gback>← Glossary</a>
        </div>
        ${detailHtml}
      </div>
      ${partAside}
    </div>`;
  }

  return `<div class="screen full">
    <div class="work">
      <div class="pagehead">
        <div class="ph-title">
          <h1>Glossary</h1>
          <span class="sub">${allTerms.length} terms, in plain words</span>
        </div>
      </div>

      <div class="cattabs" role="group" aria-label="Show">
        ${[
          ['all', 'All'],
          ['parts', 'In my parts'],
          ['projects', 'In my projects'],
        ]
          .map(
            ([v, label]) =>
              `<button type="button" data-gf="${v}" aria-pressed="${filter === v}">${esc(label)}<span class="fc">${countFor(
                v
              )}</span></button>`
          )
          .join('')}
      </div>

      <div class="ctl">
        <label class="search big">
          ${sv('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}
          <input id="gq" placeholder="Search terms" value="${esc(gl.q || '')}" aria-label="Search the glossary">
        </label>
      </div>

      <div class="gl3">${indexHtml}${detailHtml}</div>
    </div>
    ${partAside}
  </div>`;
}
