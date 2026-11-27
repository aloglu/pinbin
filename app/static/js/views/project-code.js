// Project Code tab: split-screen Wiring Map + Firmware Editor + Live Simulator.
import { api } from '../api.js';
import { state, esc, sv, sevGlyph, projectById, toast, isGuest, appHref, apiUrl } from '../state.js';
import { PinbinSimulator, buildSimTopology } from '../sim-engine.js';

const codeDrafts = new Map();
let analyzeTimer = null;
let activeSim = null;
let activeSimPid = null;
let activeSimKey = '';
let simTimer = null;

function simKeyFor(pid, d) {
  return `${pid}|${d.language}|${d.source}`;
}

export function stopActiveSimulator() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  if (activeSim) {
    activeSim.running = false;
    activeSim.paused = false;
  }
}

function startSimLoop(pid) {
  if (simTimer) clearInterval(simTimer);
  simTimer = setInterval(() => {
    if (!activeSim || activeSimPid !== pid || !document.getElementById('code-editor')) {
      stopActiveSimulator();
      return;
    }
    activeSim.tick(50, 25);
    refreshSimUi(pid);
    if (!activeSim.running) {
      clearInterval(simTimer);
      simTimer = null;
    }
  }, 50);
}

function ensureSimInstance(pid) {
  const proj = projectById(pid);
  if (!proj) return null;
  const d = getCodeDraft(proj);
  const key = simKeyFor(pid, d);
  if (!activeSim || activeSimPid !== pid || activeSimKey !== key) {
    stopActiveSimulator();
    activeSim = new PinbinSimulator(proj, d.source, d.language);
    activeSimPid = pid;
    activeSimKey = key;
  }
  return activeSim;
}

export function simPlayPauseAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  if (!d.source.trim()) {
    toast('Write or generate code first, then press Run');
    return;
  }
  const key = simKeyFor(pid, d);
  if (activeSim && activeSimPid === pid && activeSimKey === key && activeSim.running && !activeSim.paused) {
    activeSim.paused = true;
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    refreshSimUi(pid);
    return;
  }
  if (!activeSim || activeSimPid !== pid || activeSimKey !== key || activeSim.phase === 'done' || activeSim.error) {
    stopActiveSimulator();
    activeSim = new PinbinSimulator(proj, d.source, d.language);
    activeSimPid = pid;
    activeSimKey = key;
  }
  activeSim.running = true;
  activeSim.paused = false;
  activeSim.stepOne(false);
  refreshSimUi(pid);
  startSimLoop(pid);
}

export function simStepAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  if (!d.source.trim()) {
    toast('Write or generate code first');
    return;
  }
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  const sim = ensureSimInstance(pid);
  if (!sim) return;
  if (sim.phase === 'done' || sim.error) {
    activeSim = new PinbinSimulator(proj, d.source, d.language);
    activeSimPid = pid;
    activeSimKey = simKeyFor(pid, d);
  }
  activeSim.running = true;
  activeSim.paused = true;
  activeSim.stepOne(true);
  refreshSimUi(pid);
}

export function simResetAction(pid) {
  stopActiveSimulator();
  activeSim = null;
  activeSimPid = null;
  activeSimKey = '';
  refreshSimUi(pid);
}

export function simClearSerialAction(pid) {
  if (activeSim && activeSimPid === pid) {
    activeSim.serial = [];
    refreshSimUi(pid);
  }
}

export function simUpdateInputAction(pid, ref, patch) {
  const sim = ensureSimInstance(pid);
  if (!sim) return;
  sim.setInput(ref, patch);
  refreshSimUi(pid);
}

function defaultLangFromProj(proj) {
  if (proj.code_language === 'arduino' || proj.code_language === 'micropython') return proj.code_language;
  const mcu = (proj.items || []).find((x) => x.role === 'mcu' || x.category === 'Microcontrollers');
  const nm = String(mcu?.name || mcu?.label || '').toLowerCase();
  if (nm.includes('pico') || nm.includes('rp2350') || nm.includes('rp2040')) return 'micropython';
  return 'arduino';
}

export function getCodeDraft(proj) {
  if (!proj) return null;
  let d = codeDrafts.get(proj.id);
  const serverSrc = String(proj.code_source || '');
  const serverLang = proj.code_language || '';
  if (!d) {
    const lang = defaultLangFromProj(proj);
    d = {
      language: lang,
      source: serverSrc,
      savedLanguage: serverLang,
      savedSource: serverSrc,
      analysis: null,
      loading: false,
      saving: false,
      generating: false,
      wokwiOpen: false,
      wokwiLoading: false,
      wokwiBundle: null,
      activePin: '',
      activeLine: null,
      lastAnalyzedKey: '',
    };
    codeDrafts.set(proj.id, d);
  } else if (d.source === d.savedSource && (serverSrc !== d.savedSource || serverLang !== d.savedLanguage)) {
    d.source = serverSrc;
    d.savedSource = serverSrc;
    d.savedLanguage = serverLang;
    d.language = defaultLangFromProj(proj);
    d.lastAnalyzedKey = '';
  }
  return d;
}

export function isCodeDirty(proj) {
  const d = codeDrafts.get(proj?.id);
  if (!d) return false;
  return d.source !== d.savedSource || (Boolean(d.source.trim()) && d.language !== (d.savedLanguage || d.language));
}

export async function ensureProjectCodeAnalyzed(proj, renderFn) {
  if (!proj) return;
  const d = getCodeDraft(proj);
  const key = `${proj.id}|${d.language}|${d.source}|${(proj.nets || []).length}`;
  if (d.loading || d.lastAnalyzedKey === key) return;
  d.loading = true;
  try {
    if (isGuest()) {
      const res = await api.getProjectCode(proj.id);
      if (res && res.analysis) d.analysis = res.analysis;
    } else {
      const res = await api.analyzeProjectCode(proj.id, {
        code_source: d.source,
        code_language: d.language,
      });
      d.analysis = res;
    }
    d.lastAnalyzedKey = key;
  } catch {
    // Non-fatal: keep editor usable
  } finally {
    d.loading = false;
    updateCodeLivePanels(proj);
  }
}

export function scheduleCodeAnalyze(proj, renderFn) {
  if (!proj || isGuest()) return;
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    ensureProjectCodeAnalyzed(proj, renderFn);
  }, 380);
}

export async function saveProjectCodeAction(pid, renderFn) {
  const proj = projectById(pid);
  if (!proj || isGuest()) return;
  const d = getCodeDraft(proj);
  if (d.saving) return;
  d.saving = true;
  updateCodeLivePanels(proj);
  try {
    const res = await api.saveProjectCode(pid, {
      code_source: d.source,
      code_language: d.language,
    });
    if (res) {
      proj.code_source = res.code_source ?? d.source;
      proj.code_language = res.code_language ?? d.language;
      proj.code_updated_at = res.code_updated_at ?? proj.code_updated_at;
      d.savedSource = proj.code_source;
      d.savedLanguage = proj.code_language;
      if (res.analysis) {
        d.analysis = res.analysis;
        d.lastAnalyzedKey = `${proj.id}|${d.language}|${d.source}|${(proj.nets || []).length}`;
      }
    }
    toast('Project code saved');
  } catch (err) {
    toast(err.message || 'Could not save code');
  } finally {
    d.saving = false;
    updateCodeLivePanels(proj);
  }
}

export async function generateProjectStarterAction(pid, renderFn) {
  const proj = projectById(pid);
  if (!proj || isGuest()) return;
  const d = getCodeDraft(proj);
  if (d.generating) return;
  if (d.source.trim() && !window.confirm('Replace the current editor text with freshly generated starter code? (You can undo by reloading before saving.)')) {
    return;
  }
  d.generating = true;
  updateCodeLivePanels(proj);
  try {
    const res = await api.generateProjectCode(pid, { code_language: d.language });
    if (res) {
      d.language = res.language || d.language;
      d.source = res.code || '';
      d.analysis = res.analysis || null;
      d.lastAnalyzedKey = `${proj.id}|${d.language}|${d.source}|${(proj.nets || []).length}`;
    }
    renderFn();
    toast('Starter code generated from wiring map');
  } catch (err) {
    toast(err.message || 'Could not generate starter code');
  } finally {
    d.generating = false;
    updateCodeLivePanels(proj);
  }
}

export function setProjectCodeLanguage(pid, lang, renderFn) {
  const proj = projectById(pid);
  if (!proj || isGuest()) return;
  if (lang !== 'arduino' && lang !== 'micropython') return;
  const d = getCodeDraft(proj);
  d.language = lang;
  d.lastAnalyzedKey = '';
  simResetAction(pid);
  renderFn();
  ensureProjectCodeAnalyzed(proj, renderFn);
}

export function copyProjectCodeAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  if (!d.source.trim()) {
    toast('No code to copy yet');
    return;
  }
  navigator.clipboard?.writeText(d.source).then(
    () => toast('Code copied to clipboard'),
    () => toast('Could not copy to clipboard')
  );
}

export async function toggleWokwiExportAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  if (d.wokwiOpen && !d.wokwiLoading) {
    d.wokwiOpen = false;
    updateCodeLivePanels(proj);
    return;
  }
  d.wokwiOpen = true;
  d.wokwiLoading = true;
  updateCodeLivePanels(proj);
  try {
    d.wokwiBundle = await api.getProjectWokwi(pid, d.language);
  } catch (err) {
    d.wokwiOpen = false;
    toast(err.message || 'Could not build Wokwi export');
  } finally {
    d.wokwiLoading = false;
    updateCodeLivePanels(proj);
  }
}

export function closeWokwiExportAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  d.wokwiOpen = false;
  updateCodeLivePanels(proj);
}

export function copyWokwiDiagramAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  if (!d.wokwiBundle?.diagram_json) {
    toast('No diagram.json ready yet');
    return;
  }
  navigator.clipboard?.writeText(d.wokwiBundle.diagram_json).then(
    () => toast('diagram.json copied to clipboard'),
    () => toast('Could not copy diagram.json')
  );
}

export function jumpToCodeLine(lineNo) {
  const ta = document.getElementById('code-editor');
  if (!ta || !lineNo || lineNo < 1) return;
  const lines = ta.value.split('\n');
  const clamped = Math.min(lineNo, lines.length);
  let pos = 0;
  for (let i = 0; i < clamped - 1; i++) pos += lines[i].length + 1;
  const end = pos + (lines[clamped - 1]?.length || 0);
  ta.focus();
  ta.setSelectionRange(pos, end);
  // Scroll editor roughly to target line
  const lineH = 20;
  ta.scrollTop = Math.max(0, (clamped - 4) * lineH);
  syncCodeGutter(ta);
}

export function syncCodeGutter(ta) {
  const gutter = document.getElementById('code-gutter');
  if (!ta || !gutter) return;
  const count = Math.max(1, ta.value.split('\n').length);
  const existing = Number(gutter.dataset.lines || 0);
  if (existing !== count) {
    let html = '';
    for (let i = 1; i <= count; i++) html += `<span>${i}</span>`;
    gutter.innerHTML = html;
    gutter.dataset.lines = String(count);
  }
  gutter.scrollTop = ta.scrollTop;
}

function statusPillHtml(d) {
  const a = d.analysis;
  if (d.saving) return '<span class="code-pill dim">Saving…</span>';
  if (d.generating) return '<span class="code-pill dim">Generating…</span>';
  if (!a) return '<span class="code-pill dim">Checking pins…</span>';
  if (!d.source.trim()) return '<span class="code-pill dim">Empty · click Generate starter</span>';
  if (a.danger_count > 0) {
    return `<span class="code-pill danger">! ${a.danger_count} error${a.danger_count === 1 ? '' : 's'}</span>`;
  }
  if (a.check_count > 0) {
    return `<span class="code-pill check">? ${a.check_count} check${a.check_count === 1 ? '' : 's'}</span>`;
  }
  if (a.wired_pin_count > 0) {
    return `<span class="code-pill ok">✓ ${a.matched_pin_count}/${a.wired_pin_count} wired pins matched</span>`;
  }
  return '<span class="code-pill ok">✓ Looks good</span>';
}

function selectionBannerHtml(proj, d) {
  const sel = state.sel;
  const a = d.analysis;
  if (!sel || !a) return '';
  let matches = [];
  let label = '';
  if (sel.startsWith('net:')) {
    const nid = sel.slice(4);
    const net = (proj.nets || []).find((n) => n.id === nid);
    label = net ? net.name : nid;
    matches = (a.references || []).filter((r) => r.net_id === nid);
  } else if (sel.startsWith('node:')) {
    const ref = sel.slice(5);
    const it = (proj.items || []).find((x) => x.ref === ref);
    label = it ? it.label || it.name || ref : ref;
    matches = (a.references || []).filter((r) => (r.node_refs || []).includes(ref) || ref === a.mcu_ref);
  } else {
    return '';
  }
  const uniqLines = [...new Set(matches.map((m) => m.line))].sort((x, y) => x - y);
  if (!uniqLines.length) {
    return `<div class="code-selbar"><span class="dim">Selected: <b>${esc(label)}</b> — not referenced in code yet.</span></div>`;
  }
  return `<div class="code-selbar">
    <span><b>${esc(label)}</b> in code:</span>
    <span class="code-linechips">${uniqLines
      .slice(0, 12)
      .map((ln) => `<button type="button" class="code-lchip" data-code-line="${ln}">L${ln}</button>`)
      .join('')}</span>
  </div>`;
}

function wiredPinsStripHtml(d) {
  const a = d.analysis;
  if (!a || !(a.pin_map || []).length) {
    return '<div class="code-strip faint">Wire signal, I2C, or SPI pins on the Map to see live pin mapping here.</div>';
  }
  return `<div class="code-strip">
    <span class="k">wired pins</span>
    <div class="code-pgrid">
      ${a.pin_map
        .map((pm) => {
          const target = (pm.connected_nodes || []).map((n) => n.name).join(', ') || pm.net_name;
          const firstLine = (pm.code_lines || [])[0] || '';
          const active = state.sel === `net:${pm.net_id}`;
          return `<button type="button" class="code-pchip ${pm.used_in_code ? 'used' : ''} ${active ? 'sel' : ''}" data-code-pin="${esc(
            pm.pin
          )}" data-code-net="${esc(pm.net_id)}" data-code-line="${esc(firstLine)}" title="${esc(
            `${pm.pin} → ${target}${firstLine ? ` (line ${firstLine})` : ' (not yet used in code)'}`
          )}">
            <i style="background:var(--${esc(pm.net_kind || 'sig')})"></i>
            <span class="mono">${esc(pm.pin)}</span>
            <span class="dim">${esc(target)}</span>
            <span class="st">${pm.used_in_code ? `L${firstLine}` : '○'}</span>
          </button>`;
        })
        .join('')}
    </div>
  </div>`;
}

function issuesPanelHtml(d) {
  const a = d.analysis;
  if (!a) return '';
  const issues = a.issues || [];
  if (!issues.length) {
    return d.source.trim()
      ? '<div class="code-checks"><div class="code-okmsg"><span class="sev ok">✓</span><span>All pins in code match your wiring map and board pinout.</span></div></div>'
      : '';
  }
  return `<div class="code-checks">
    <span class="k">code vs. wiring checks</span>
    ${issues
      .map((iss) => {
        const netAttr = iss.net_id ? ` data-code-net="${esc(iss.net_id)}"` : '';
        const nodeAttr = !iss.net_id && (iss.node_refs || []).length ? ` data-code-node="${esc(iss.node_refs[0])}"` : '';
        const lineAttr = iss.line ? ` data-code-line="${iss.line}"` : '';
        return `<button type="button" class="code-iss ${esc(iss.severity)}"${netAttr}${nodeAttr}${lineAttr}>
          <span class="sev ${esc(iss.severity === 'info' ? 'ok' : iss.severity)}">${
            iss.severity === 'info' ? 'i' : sevGlyph(iss.severity, false)
          }</span>
          <span class="body">
            <b>${esc(iss.title)}${iss.line ? ` <span class="mono dim">· L${iss.line}</span>` : ''}</b>
            <span>${esc(iss.body)}</span>
          </span>
        </button>`;
      })
      .join('')}
  </div>`;
}

function wokwiPanelHtml(proj, d) {
  if (!d.wokwiOpen) return '';
  if (d.wokwiLoading) {
    return '<div class="wokwi-card"><div class="dim">Building Wokwi diagram.json…</div></div>';
  }
  const b = d.wokwiBundle;
  if (!b) return '';
  const zipHref = apiUrl(
    `/api/projects/${encodeURIComponent(proj.id)}/wokwi.zip?language=${encodeURIComponent(b.code_language || d.language)}`
  );
  const dirtyNote = isCodeDirty(proj)
    ? '<div class="wokwi-note">You have unsaved edits in the editor — click <b>Save*</b> first if you want them included in the .zip.</div>'
    : '';
  return `<div class="wokwi-card">
    <div class="wokwi-head">
      <div>
        <b>Export to Wokwi</b>
        <span class="dim mono" style="margin-left:8px">${esc(b.wokwi_board_type)} · ${esc(b.code_filename)}</span>
      </div>
      <button type="button" class="btn quiet" data-code-act="wokwi-close" aria-label="Close">✕</button>
    </div>
    ${dirtyNote}
    <div class="wokwi-acts">
      <a class="btn ink" href="${esc(zipHref)}" download>Download Wokwi .zip</a>
      <button type="button" class="btn" data-code-act="wokwi-copy">Copy diagram.json</button>
      <a class="btn quiet" href="${esc(b.wokwi_new_url)}" target="_blank" rel="noopener noreferrer">Open Wokwi ↗</a>
    </div>
    <p class="dim wokwi-steps">On Wokwi: open the link above, replace <code>diagram.json</code> with the exported file, paste <code>${esc(
      b.code_filename
    )}</code>, and hit Play.</p>
    <div class="wokwi-meta">
      <span class="k">mapped (${(b.mapped_parts || []).length})</span>
      <div class="wokwi-chips">${(b.mapped_parts || [])
        .map((p) => `<span class="tag">${esc(p.name)} <span class="mono faint">${esc(p.wokwi_type)}</span></span>`)
        .join('')}</div>
    </div>
    ${
      (b.unmapped_parts || []).length
        ? `<div class="wokwi-meta">
            <span class="k">needs stand-in / omitted (${b.unmapped_parts.length})</span>
            <ul class="wokwi-list">${b.unmapped_parts
              .map((u) => `<li><b>${esc(u.name)}:</b> ${esc(u.reason)}</li>`)
              .join('')}</ul>
          </div>`
        : ''
    }
    ${
      (b.warnings || []).length
        ? `<ul class="wokwi-list dim">${b.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
        : ''
    }
    <details class="wokwi-prev">
      <summary>Preview diagram.json</summary>
      <pre class="mono">${esc(b.diagram_json)}</pre>
    </details>
  </div>`;
}

export function updateCodeLivePanels(proj) {
  if (!proj) return;
  const d = getCodeDraft(proj);
  const pill = document.getElementById('code-status-pill');
  if (pill) pill.innerHTML = statusPillHtml(d);
  const saveBtn = document.getElementById('code-save-btn');
  if (saveBtn) {
    const dirty = isCodeDirty(proj);
    saveBtn.disabled = d.saving || !dirty;
    saveBtn.textContent = d.saving ? 'Saving…' : dirty ? 'Save*' : 'Saved';
    saveBtn.classList.toggle('ink', dirty);
  }
  const wokwiSlot = document.getElementById('code-wokwi-slot');
  if (wokwiSlot) wokwiSlot.innerHTML = wokwiPanelHtml(proj, d);
  const selBar = document.getElementById('code-selbar-slot');
  if (selBar) selBar.innerHTML = selectionBannerHtml(proj, d);
  const pinsSlot = document.getElementById('code-pins-slot');
  if (pinsSlot) pinsSlot.innerHTML = wiredPinsStripHtml(d);
  const issSlot = document.getElementById('code-issues-slot');
  if (issSlot) issSlot.innerHTML = issuesPanelHtml(d);
}

function simBarHtml(proj) {
  const snap = activeSim && activeSimPid === proj.id ? activeSim.getSnapshot() : null;
  const isRunning = Boolean(snap && snap.running && !snap.paused);
  const isPaused = Boolean(snap && snap.running && snap.paused);
  let badge = '<span class="code-pill dim">Simulator idle</span>';
  if (snap?.error) {
    badge = `<span class="code-pill danger">! ${esc(snap.error)}</span>`;
  } else if (isRunning) {
    badge = `<span class="code-pill ok">● Running${snap.currentLine ? ` · L${snap.currentLine}` : ''} · ${(snap.simMs / 1000).toFixed(1)}s</span>`;
  } else if (isPaused) {
    badge = `<span class="code-pill check">❚❚ Paused${snap.currentLine ? ` · L${snap.currentLine}` : ''} · ${(snap.simMs / 1000).toFixed(1)}s</span>`;
  } else if (snap && snap.phase === 'done') {
    badge = `<span class="code-pill dim">Finished · ${(snap.simMs / 1000).toFixed(1)}s</span>`;
  }
  return `<div class="sim-bar">
    <button type="button" class="btn ${isRunning ? '' : 'ink'}" data-sim-act="play">${isRunning ? '❚❚ Pause' : '▶ Run'}</button>
    <button type="button" class="btn" data-sim-act="step" title="Execute one line at a time">⏭ Step</button>
    <button type="button" class="btn quiet" data-sim-act="reset" ${snap ? '' : 'disabled'}>↺ Reset</button>
    <span style="flex:1"></span>
    ${badge}
  </div>`;
}

function simBenchHtml(proj) {
  const snap = activeSim && activeSimPid === proj.id ? activeSim.getSnapshot() : null;
  const widgets = snap ? snap.widgetStates : buildSimTopology(proj).widgets.map((w) => ({
    ...w,
    digital: 0,
    pwm: 0,
    freq: 0,
    angle: 90,
    input: { pressed: false, on: false, value: 0.5 },
    active: false,
  }));
  const adcMax = snap ? snap.adcMax : buildSimTopology(proj).adcMax;
  const displayLines = snap ? snap.displayLines : [];

  if (!widgets.length) return '';

  const cards = widgets.map((w) => {
    const pinTag = w.pins.length ? `<span class="mono faint">${esc(w.pins.join(', '))}</span>` : '';
    let ctl = '';
    if (w.kind === 'led') {
      const pct = Math.round((w.pwm / 255) * 100);
      const glow = w.pwm > 0 ? `opacity:${Math.max(0.25, w.pwm / 255).toFixed(2)};box-shadow:0 0 10px ${esc(w.color)}` : 'opacity:0.15';
      ctl = `<div class="sim-led-row"><span class="sim-led-dot" style="background:${esc(w.color)};${glow}"></span><span class="mono">${w.pwm > 0 ? (pct < 100 ? `PWM ${pct}%` : 'ON') : 'OFF'}</span></div>`;
    } else if (w.kind === 'button') {
      ctl = `<button type="button" class="btn ${w.input.pressed ? 'ink' : ''}" data-sim-btn="${esc(w.ref)}">${w.input.pressed ? 'Pressed (click to release)' : 'Press button'}</button>`;
    } else if (w.kind === 'switch' || w.kind === 'digital_sensor') {
      const onLabel = w.kind === 'switch' ? 'ON' : 'Triggered';
      const offLabel = w.kind === 'switch' ? 'OFF' : 'Idle';
      ctl = `<button type="button" class="btn ${w.input.on ? 'ink' : ''}" data-sim-toggle="${esc(w.ref)}">${w.input.on ? onLabel : offLabel}</button>`;
    } else if (w.kind === 'analog') {
      const pct = Math.round((w.input.value ?? 0.5) * 100);
      const raw = Math.round((w.input.value ?? 0.5) * adcMax);
      ctl = `<div class="sim-slider-row"><input type="range" min="0" max="100" value="${pct}" data-sim-range="${esc(w.ref)}"><span class="mono">${raw}</span></div>`;
    } else if (w.kind === 'servo') {
      ctl = `<div class="sim-led-row"><span class="mono">${w.angle}°</span><span class="meter"><i style="width:${Math.round((w.angle / 180) * 100)}%"></i></span></div>`;
    } else if (w.kind === 'buzzer') {
      ctl = `<span class="mono ${w.freq > 0 ? 'sim-hi-txt' : 'dim'}">${w.freq > 0 ? `♪ ${w.freq} Hz` : 'Silent'}</span>`;
    } else if (w.kind === 'relay') {
      ctl = `<span class="mono ${w.digital ? 'sim-hi-txt' : 'dim'}">${w.digital ? 'CLOSED (ON)' : 'OPEN (OFF)'}</span>`;
    } else if (w.kind === 'display') {
      ctl = `<div class="sim-oled">${
        displayLines.length
          ? displayLines.map((l) => `<div>${esc(l)}</div>`).join('')
          : `<div class="faint">${w.i2c ? `I2C ${esc(w.i2c)} · ` : ''}ready</div>`
      }</div>`;
    } else {
      ctl = `<span class="mono ${w.digital ? 'sim-hi-txt' : 'dim'}">${w.digital ? 'HIGH' : 'LOW'}</span>`;
    }

    return `<div class="sim-card ${w.active ? 'active' : ''}">
      <div class="sim-card-h"><b>${esc(w.name)}</b>${pinTag}</div>
      ${ctl}
    </div>`;
  }).join('');

  return `<div class="sim-bench">
    <span class="k">live bench controls</span>
    <div class="sim-grid">${cards}</div>
  </div>`;
}

function simSerialHtml(proj) {
  const snap = activeSim && activeSimPid === proj.id ? activeSim.getSnapshot() : null;
  const rows = snap ? snap.serial : [];
  return `<div class="sim-serial">
    <div class="sim-serial-h">
      <span class="k">serial monitor</span>
      <button type="button" class="btn quiet" data-sim-act="clear-serial" ${rows.length ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="sim-serial-log" id="sim-serial-log">${
      rows.length
        ? rows.map((r) => `<div><span class="faint">[${(r.ms / 1000).toFixed(2)}s]</span> ${esc(r.text)}</div>`).join('')
        : '<div class="faint">Press ▶ Run to see Serial.println / print() output here.</div>'
    }</div>
  </div>`;
}

export function refreshSimUi(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const bar = document.getElementById('sim-bar-slot');
  if (bar) bar.innerHTML = simBarHtml(proj);
  const bench = document.getElementById('sim-bench-slot');
  if (bench) {
    const activeEl = document.activeElement;
    const draggingRange = Boolean(activeEl && bench.contains(activeEl) && activeEl.matches('[data-sim-range]'));
    if (draggingRange) {
      const snap0 = activeSim && activeSimPid === pid ? activeSim.getSnapshot() : null;
      const adcMax = snap0 ? snap0.adcMax : buildSimTopology(proj).adcMax;
      bench.querySelectorAll('[data-sim-range]').forEach((inp) => {
        const raw = Math.round((Number(inp.value) / 100) * adcMax);
        if (inp.nextElementSibling) inp.nextElementSibling.textContent = String(raw);
      });
    } else {
      bench.innerHTML = simBenchHtml(proj);
    }
  }
  const serial = document.getElementById('sim-serial-slot');
  if (serial) {
    serial.innerHTML = simSerialHtml(proj);
    const log = document.getElementById('sim-serial-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  // Apply live pin/net glow directly onto the SVG wiring map
  const snap = activeSim && activeSimPid === pid ? activeSim.getSnapshot() : null;
  const svg = document.getElementById('map');
  if (svg) {
    svg.querySelectorAll('[data-sel^="net:"]').forEach((g) => {
      const nid = g.dataset.sel.slice(4);
      const ns = snap?.netStates?.[nid];
      g.classList.toggle('sim-high', Boolean(ns && ns.state === 'high'));
      g.classList.toggle('sim-pwm', Boolean(ns && ns.state === 'pwm'));
      g.classList.toggle('sim-low', Boolean(ns && ns.state === 'low'));
    });
    const activeNodes = new Set((snap?.widgetStates || []).filter((w) => w.active).map((w) => w.ref));
    svg.querySelectorAll('[data-sel^="node:"]').forEach((g) => {
      const ref = g.dataset.sel.slice(5);
      g.classList.toggle('sim-active', activeNodes.has(ref));
    });
  }

  // Highlight currently executing line in the code gutter
  const gutter = document.getElementById('code-gutter');
  if (gutter) {
    const cur = snap?.currentLine || 0;
    const spans = gutter.children;
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('sim-cur', cur > 0 && i + 1 === cur);
    }
  }
}

export function renderProjectCodeView(proj, renderMapSvgFn) {
  const guest = isGuest();
  const d = getCodeDraft(proj);
  const hasNets = (proj.nets || []).length > 0;
  const dirty = isCodeDirty(proj);
  const lines = Math.max(1, d.source.split('\n').length);
  let gutterHtml = '';
  for (let i = 1; i <= lines; i++) gutterHtml += `<span>${i}</span>`;

  const mapPane = hasNets
    ? `<div class="code-map-pane">
        <div id="sim-bar-slot">${simBarHtml(proj)}</div>
        <div class="mapwrap" id="mapwrap">
          <div class="zoom">
            <button class="btn" type="button" data-zoom="out" aria-label="Zoom out">−</button>
            <button class="btn" type="button" data-zoom="fit" title="Reset view to fit">Fit</button>
            <button class="btn" type="button" data-zoom="in" aria-label="Zoom in">+</button>
          </div>
          <div class="mapstage" id="mapstage">${renderMapSvgFn(proj)}</div>
          <div class="maphint" aria-hidden="true">Click a part or wire to find it in code</div>
        </div>
        <div id="sim-bench-slot">${simBenchHtml(proj)}</div>
        <div id="sim-serial-slot">${simSerialHtml(proj)}</div>
      </div>`
    : `<div class="code-map-pane">
        <div id="sim-bar-slot">${simBarHtml(proj)}</div>
        <div class="map-empty">
          <p>${
            guest
              ? 'No wiring connections yet.'
              : 'No wiring connections yet. Add wires in <b>Edit project</b> so Pinbin can generate pin definitions and animate live signals on the map.'
          }</p>
          ${guest ? '' : `<a class="btn ink" href="${appHref(`/projects/${encodeURIComponent(proj.id)}/edit`)}">Add wiring</a>`}
        </div>
        <div id="sim-serial-slot">${simSerialHtml(proj)}</div>
      </div>`;

  const copyIcon = sv('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');

  return `<div class="code-lab" data-code-pid="${esc(proj.id)}">
    ${mapPane}
    <div class="code-pane">
      <div class="code-bar">
        <div class="code-lang" role="group" aria-label="Firmware language">
          <button type="button" class="btn ${d.language === 'arduino' ? 'ink' : 'quiet'}" data-code-lang="arduino" ${
            guest ? 'disabled' : ''
          }>Arduino C++</button>
          <button type="button" class="btn ${d.language === 'micropython' ? 'ink' : 'quiet'}" data-code-lang="micropython" ${
            guest ? 'disabled' : ''
          }>MicroPython</button>
        </div>
        <span id="code-status-pill">${statusPillHtml(d)}</span>
        <span style="flex:1"></span>
        <div class="code-acts">
          ${
            guest
              ? ''
              : `<button type="button" class="btn" data-code-act="generate" title="Generate starter pin definitions from your wiring map">Generate starter</button>`
          }
          <button type="button" class="btn quiet" data-code-act="copy" title="Copy code">${copyIcon}Copy</button>
          <button type="button" class="btn quiet" data-code-act="wokwi" title="Export diagram.json and code bundle for Wokwi">Wokwi ↗</button>
          ${
            guest
              ? ''
              : `<button type="button" id="code-save-btn" class="btn ${dirty ? 'ink' : ''}" data-code-act="save" ${
                  d.saving || !dirty ? 'disabled' : ''
                }>${d.saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}</button>`
          }
        </div>
      </div>

      <div id="code-wokwi-slot">${wokwiPanelHtml(proj, d)}</div>
      <div id="code-selbar-slot">${selectionBannerHtml(proj, d)}</div>

      <div class="code-editor-wrap">
        <div class="code-gutter" id="code-gutter" data-lines="${lines}" aria-hidden="true">${gutterHtml}</div>
        <textarea
          id="code-editor"
          class="code-ta"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          ${guest ? 'readonly' : ''}
          placeholder="${
            guest
              ? 'No firmware code saved for this project yet.'
              : 'Paste or write your Arduino / MicroPython code here, or click “Generate starter” to build it from your wiring map…'
          }"
        >${esc(d.source)}</textarea>
      </div>

      <div id="code-pins-slot">${wiredPinsStripHtml(d)}</div>
      <div id="code-issues-slot">${issuesPanelHtml(d)}</div>
    </div>
  </div>`;
}

export function bindProjectCodeEditor(pid, renderFn) {
  const proj = projectById(pid);
  const ta = document.getElementById('code-editor');
  if (!proj || !ta) return;
  const d = getCodeDraft(proj);

  ta.addEventListener('scroll', () => {
    const gutter = document.getElementById('code-gutter');
    if (gutter) gutter.scrollTop = ta.scrollTop;
  });

  if (!isGuest()) {
    ta.addEventListener('input', () => {
      d.source = ta.value;
      syncCodeGutter(ta);
      updateCodeLivePanels(proj);
      scheduleCodeAnalyze(proj, renderFn);
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProjectCodeAction(pid, renderFn);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const indent = d.language === 'micropython' ? '    ' : '  ';
        ta.value = ta.value.slice(0, start) + indent + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + indent.length;
        d.source = ta.value;
        syncCodeGutter(ta);
        updateCodeLivePanels(proj);
        scheduleCodeAnalyze(proj, renderFn);
      }
    });
  }

  ensureProjectCodeAnalyzed(proj, renderFn);
  refreshSimUi(pid);
}
