// Project Code tab: split-screen Wiring Map + Firmware Editor + Live Simulator.
import { api } from '../api.js';
import { state, esc, sv, sevGlyph, projectById, projectHref, toast, isGuest, apiUrl } from '../state.js';
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

export function copyWokwiSketchAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  const src = d.source.trim() ? d.source : d.wokwiBundle?.code_source || '';
  const fname = d.wokwiBundle?.code_filename || (d.language === 'micropython' ? 'main.py' : 'sketch.ino');
  if (!src.trim()) {
    toast('No sketch code to copy yet');
    return;
  }
  navigator.clipboard?.writeText(src).then(
    () => toast(`${fname} copied to clipboard`),
    () => toast(`Could not copy ${fname}`)
  );
}

export function copyWokwiLibrariesAction(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const d = getCodeDraft(proj);
  const txt = d.wokwiBundle?.libraries_txt || '';
  if (!txt.trim()) {
    toast('No extra libraries needed');
    return;
  }
  navigator.clipboard?.writeText(txt).then(
    () => toast('libraries.txt copied to clipboard'),
    () => toast('Could not copy libraries.txt')
  );
}

export function jumpToCodeLine(lineNo, pid = null) {
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
  const targetPid = pid || ta.closest('[data-code-pid]')?.dataset.codePid;
  if (targetPid) {
    const proj = projectById(targetPid);
    if (proj) {
      const d = getCodeDraft(proj);
      d.activeLine = clamped;
      refreshSimUi(targetPid);
    }
  }
}

export function syncCodeGutter(ta) {
  const gutter = document.getElementById('code-gutter');
  const hl = document.getElementById('code-hl');
  if (!ta) return;
  if (gutter) {
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
  if (hl) {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }
}

const ARDUINO_KW = new Set([
  'void', 'int', 'uint8_t', 'int8_t', 'uint16_t', 'uint32_t', 'byte', 'bool', 'boolean',
  'float', 'double', 'long', 'short', 'unsigned', 'char', 'String', 'const', 'constexpr',
  'static', 'auto', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'true', 'false', 'struct', 'class',
]);
const PY_KW = new Set([
  'import', 'from', 'as', 'def', 'class', 'if', 'elif', 'else', 'for', 'in', 'while',
  'break', 'continue', 'pass', 'return', 'True', 'False', 'None', 'and', 'or', 'not',
  'try', 'except', 'finally', 'with', 'global', 'lambda',
]);
const HW_API = new Set([
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'ledcWrite',
  'ledcAttach', 'tone', 'noTone', 'delay', 'millis', 'Serial', 'Wire', 'SPI', 'Servo',
  'Pin', 'PWM', 'ADC', 'I2C', 'SoftI2C', 'UART', 'NeoPixel', 'time', 'print',
  'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'LED_BUILTIN', 'OUT', 'IN', 'PULL_UP',
]);

export function highlightCode(src, lang) {
  const text = String(src || '');
  if (!text) return '\n';
  const isPy = lang === 'micropython';
  const kwSet = isPy ? PY_KW : ARDUINO_KW;
  const re = isPy
    ? /(#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|f?"(?:\\.|[^"\\\n])*"|f?'(?:\\.|[^'\\\n])*'|\b0x[0-9a-fA-F]+\b|\b\d+(?:_\d+)*(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|^\s*#\s*(?:include|define|ifdef|ifndef|endif|pragma)\b|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gm;

  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out += esc(text.slice(last, m.index));
    const tok = m[0];
    let cls = '';
    if (isPy ? tok.startsWith('#') : (tok.startsWith('//') || tok.startsWith('/*'))) {
      cls = 'hl-com';
    } else if (!isPy && /^\s*#/.test(tok)) {
      cls = 'hl-pre';
    } else if (tok[0] === '"' || tok[0] === "'" || (isPy && (tok.startsWith('f"') || tok.startsWith("f'")))) {
      cls = 'hl-str';
    } else if (/^(?:0x[0-9a-fA-F]+|\d)/.test(tok)) {
      cls = 'hl-num';
    } else if (kwSet.has(tok)) {
      cls = 'hl-kw';
    } else if (HW_API.has(tok)) {
      cls = 'hl-api';
    } else if (/^(?:PIN_[A-Z0-9_]+|GPIO\d+|GP\d+)$/.test(tok)) {
      cls = 'hl-pin';
    }
    out += cls ? `<span class="${cls}">${esc(tok)}</span>` : esc(tok);
    last = re.lastIndex;
  }
  if (last < text.length) out += esc(text.slice(last));
  return out.endsWith('\n') ? `${out} ` : `${out}\n`;
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
      <button type="button" class="btn" data-code-act="wokwi-sketch">Copy ${esc(b.code_filename)}</button>
      ${
        (b.libraries || []).length
          ? '<button type="button" class="btn" data-code-act="wokwi-libs">Copy libraries.txt</button>'
          : ''
      }
      <a class="btn quiet" href="${esc(b.wokwi_new_url)}" target="_blank" rel="noopener noreferrer">Open Wokwi ↗</a>
    </div>
    <p class="dim wokwi-steps">On Wokwi: open the link above, replace <code>diagram.json</code>, paste <code>${esc(
      b.code_filename
    )}</code>${
      (b.libraries || []).length ? `, add libraries (<code>${esc(b.libraries.join(', '))}</code>)` : ''
    }, and hit Play.</p>
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

function simBadgeContent(snap) {
  const isRunning = Boolean(snap && snap.running && !snap.paused);
  const isPaused = Boolean(snap && snap.running && snap.paused);
  if (snap?.error) {
    return { cls: 'code-pill danger', text: `! ${snap.error}` };
  }
  if (isRunning) {
    return {
      cls: 'code-pill ok',
      text: `● Running${snap.currentLine ? ` · L${snap.currentLine}` : ''} · ${(snap.simMs / 1000).toFixed(1)}s`,
    };
  }
  if (isPaused) {
    return {
      cls: 'code-pill check',
      text: `❚❚ Paused${snap.currentLine ? ` · L${snap.currentLine}` : ''} · ${(snap.simMs / 1000).toFixed(1)}s`,
    };
  }
  if (snap && snap.phase === 'done') {
    return { cls: 'code-pill dim', text: `Finished · ${(snap.simMs / 1000).toFixed(1)}s` };
  }
  return { cls: 'code-pill dim', text: 'Simulator idle' };
}

function simBarHtml(proj) {
  const snap = activeSim && activeSimPid === proj.id ? activeSim.getSnapshot() : null;
  const isRunning = Boolean(snap && snap.running && !snap.paused);
  const b = simBadgeContent(snap);
  return `<div class="sim-bar" data-sim-bar="${esc(proj.id)}">
    <button type="button" id="sim-play-btn" class="btn ${isRunning ? '' : 'ink'}" data-sim-act="play">${isRunning ? '❚❚ Pause' : '▶ Run'}</button>
    <button type="button" id="sim-step-btn" class="btn" data-sim-act="step" title="Execute one line at a time">⏭ Step</button>
    <button type="button" id="sim-reset-btn" class="btn quiet" data-sim-act="reset" ${snap ? '' : 'disabled'}>↺ Reset</button>
    <span style="flex:1"></span>
    <span id="sim-badge" class="${b.cls}">${esc(b.text)}</span>
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
      ctl = `<div class="sim-led-row"><span class="sim-led-dot" style="background:${esc(w.color)};${glow}"></span><span class="mono sim-led-txt">${w.pwm > 0 ? (pct < 100 ? `PWM ${pct}%` : 'ON') : 'OFF'}</span></div>`;
    } else if (w.kind === 'button') {
      ctl = `<button type="button" class="btn ${w.input.pressed ? 'ink' : ''}" data-sim-btn="${esc(w.ref)}">${w.input.pressed ? 'Pressed (click to release)' : 'Press button'}</button>`;
    } else if (w.kind === 'switch' || w.kind === 'digital_sensor') {
      const onLabel = w.kind === 'switch' ? 'ON' : 'Triggered';
      const offLabel = w.kind === 'switch' ? 'OFF' : 'Idle';
      ctl = `<button type="button" class="btn ${w.input.on ? 'ink' : ''}" data-sim-toggle="${esc(w.ref)}">${w.input.on ? onLabel : offLabel}</button>`;
    } else if (w.kind === 'analog') {
      const pct = Math.round((w.input.value ?? 0.5) * 100);
      const raw = Math.round((w.input.value ?? 0.5) * adcMax);
      ctl = `<div class="sim-slider-row"><input type="range" min="0" max="100" value="${pct}" data-sim-range="${esc(w.ref)}"><span class="mono sim-adc-val">${raw}</span></div>`;
    } else if (w.kind === 'servo') {
      ctl = `<div class="sim-led-row"><span class="mono sim-servo-val">${w.angle}°</span><span class="meter"><i class="sim-servo-bar" style="width:${Math.round((w.angle / 180) * 100)}%"></i></span></div>`;
    } else if (w.kind === 'buzzer') {
      ctl = `<span class="mono sim-buzzer-txt ${w.freq > 0 ? 'sim-hi-txt' : 'dim'}">${w.freq > 0 ? `♪ ${w.freq} Hz` : 'Silent'}</span>`;
    } else if (w.kind === 'relay') {
      ctl = `<span class="mono sim-relay-txt ${w.digital ? 'sim-hi-txt' : 'dim'}">${w.digital ? 'CLOSED (ON)' : 'OPEN (OFF)'}</span>`;
    } else if (w.kind === 'display') {
      ctl = `<div class="sim-oled">${
        displayLines.length
          ? displayLines.map((l) => `<div>${esc(l)}</div>`).join('')
          : `<div class="faint">${w.i2c ? `I2C ${esc(w.i2c)} · ` : ''}ready</div>`
      }</div>`;
    } else {
      ctl = `<span class="mono sim-gen-txt ${w.digital ? 'sim-hi-txt' : 'dim'}">${w.digital ? 'HIGH' : 'LOW'}</span>`;
    }

    return `<div class="sim-card ${w.active ? 'active' : ''}" data-sim-card="${esc(w.ref)}" data-sim-kind="${esc(w.kind)}">
      <div class="sim-card-h"><b>${esc(w.name)}</b>${pinTag}</div>
      ${ctl}
    </div>`;
  }).join('');

  return `<div class="sim-bench" data-sim-bench="${esc(proj.id)}">
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
      <button type="button" id="sim-clear-btn" class="btn quiet" data-sim-act="clear-serial" ${rows.length ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="sim-serial-log" id="sim-serial-log" data-count="${rows.length}">${
      rows.length
        ? rows.map((r) => `<div><span class="faint">[${(r.ms / 1000).toFixed(2)}s]</span> ${esc(r.text)}</div>`).join('')
        : '<div class="faint">Press ▶ Run to see Serial.println / print() output here.</div>'
    }</div>
  </div>`;
}

function explainLinePlainEnglish(lineText, lineNo, d) {
  const s = String(lineText || '').trim();
  if (!s) return 'Blank line (spacing to keep the code easy to read).';
  if (s.startsWith('//') || s.startsWith('#')) {
    const comment = s.replace(/^(?:\/\/|#)\s*/, '').trim();
    return comment ? `Note: ${comment}` : 'Comment line (ignored by the board).';
  }
  const refs = (d?.analysis?.references || []).filter((r) => r.line === lineNo);
  const pinMap = d?.analysis?.pin_map || [];
  const describePin = (ref) => {
    if (!ref) return '';
    const pm = pinMap.find((p) => p.pin === ref.pin);
    const target = pm?.connected_nodes?.map((n) => n.name).join(', ');
    return target ? `${ref.pin} (${target})` : ref.pin;
  };
  const targetPin = refs.length ? describePin(refs[0]) : '';

  if (/^#\s*define\b/.test(s) || (/^[A-Z0-9_]+\s*=\s*\d+/.test(s) && s.startsWith('PIN_'))) {
    return targetPin
      ? `Names ${targetPin} so the rest of the code is easier to read.`
      : 'Gives a friendly name to a pin number or constant.';
  }
  if (/\bpinMode\b/.test(s) || /\bPin\s*\([^)]*Pin\.(OUT|IN)/.test(s)) {
    const isOut = /OUTPUT|Pin\.OUT/.test(s);
    const isPullup = /INPUT_PULLUP|PULL_UP/.test(s);
    if (isOut) return `Configures ${targetPin || 'this pin'} as an OUTPUT so the board can drive it ON or OFF.`;
    if (isPullup) return `Configures ${targetPin || 'this pin'} as an INPUT with an internal pull-up resistor (reads LOW when a button connects it to GND).`;
    return `Configures ${targetPin || 'this pin'} as an INPUT so the board can read signals from it.`;
  }
  if (/\bdigitalWrite\b|\.(?:on|off|toggle)\s*\(|\.value\s*\(\s*[^)\s]/.test(s)) {
    const isHigh = /\bHIGH\b|\(\s*1\s*\)|\.on\s*\(/.test(s);
    const isLow = /\bLOW\b|\(\s*0\s*\)|\.off\s*\(/.test(s);
    if (isHigh) return `Turns ${targetPin || 'this pin'} ON (HIGH) — watch the wire light up on the map.`;
    if (isLow) return `Turns ${targetPin || 'this pin'} OFF (LOW).`;
    return `Updates the ON/OFF output on ${targetPin || 'this pin'} — watch the wire change on the map.`;
  }
  if (/\bdigitalRead\b|\.value\s*\(\s*\)/.test(s)) {
    return `Reads whether ${targetPin || 'this pin'} is currently HIGH or LOW (try clicking its button/switch under Live bench controls).`;
  }
  if (/\banalogRead\b|\.read(?:_u16)?\s*\(\s*\)/.test(s)) {
    return `Reads the current analog level from ${targetPin || 'this sensor'} (drag its slider under Live bench controls to test changes).`;
  }
  if (/\banalogWrite\b|\bledcWrite\b|\.duty(?:_u16)?\s*\(/.test(s)) {
    return `Sets a PWM brightness/speed level on ${targetPin || 'this pin'}.`;
  }
  if (/\bWire\d?\.begin\b|\bI2C\s*\(/.test(s)) {
    return 'Starts the I2C bus so the board can talk to I2C displays or sensors over two shared wires.';
  }
  if (/\bSPI\d?\.begin\b|\bSPI\s*\(/.test(s)) {
    return 'Starts the SPI bus for fast communication with screens or SPI modules.';
  }
  if (/\bSerial\.println?\b|\bprint\s*\(/.test(s)) {
    return 'Prints a message to the Serial Monitor (bottom-left) so you can see what the board is reading or doing.';
  }
  if (/\bdelay\s*\(|\btime\.sleep/.test(s)) {
    return 'Pauses briefly so changes are easy to see before the next step runs.';
  }
  if (/^(?:if|elif|else\s+if)\b/.test(s)) {
    return 'Checks a condition to decide which branch of code to run next.';
  }
  if (/^(?:while|for)\b/.test(s)) {
    return 'Starts a loop that repeats the indented block of instructions.';
  }
  if (/\bSerial\.begin\b/.test(s)) {
    return 'Opens the USB Serial connection so the board can send text logs to the Serial Monitor.';
  }
  return `Runs: ${s}`;
}

function simExplainHtml(proj, d, snap) {
  const cur = snap?.currentLine || d.activeLine || 0;
  if (cur > 0 && d.source) {
    const lines = d.source.split('\n');
    const lineText = lines[cur - 1] || '';
    const msg = explainLinePlainEnglish(lineText, cur, d);
    const isLive = Boolean(snap?.currentLine);
    return `<div class="code-explain ${isLive ? 'live' : ''}">
      <span class="mono tag">Line ${cur}</span>
      <span>${esc(msg)}</span>
    </div>`;
  }
  const pinMap = d?.analysis?.pin_map || [];
  if (!d.source.trim()) {
    return `<div class="code-explain">
      <span>Click <b>Generate starter</b> to build code from your wiring map, then click any line or press <b>⏭ Step</b> to learn what it does in plain English.</span>
    </div>`;
  }
  const targets = [...new Set(pinMap.flatMap((p) => (p.connected_nodes || []).map((n) => n.name)))];
  const summary = targets.length
    ? `This sketch connects to <b>${esc(targets.slice(0, 4).join(', '))}${targets.length > 4 ? ` +${targets.length - 4} more` : ''}</b>.`
    : 'Click any line in the code editor to read what it does in plain English.';
  return `<div class="code-explain">
    <span>${summary} Click any line in the editor—or press <b>⏭ Step</b>—for a plain-English explanation.</span>
  </div>`;
}

export function refreshSimUi(pid) {
  const proj = projectById(pid);
  if (!proj) return;
  const snap = activeSim && activeSimPid === pid ? activeSim.getSnapshot() : null;
  const isRunning = Boolean(snap && snap.running && !snap.paused);

  // Update simulator bar IN PLACE so Pause/Step/Reset buttons are never destroyed mid-click
  const barSlot = document.getElementById('sim-bar-slot');
  if (barSlot) {
    const playBtn = document.getElementById('sim-play-btn');
    const resetBtn = document.getElementById('sim-reset-btn');
    const badgeEl = document.getElementById('sim-badge');
    if (!playBtn || !resetBtn || !badgeEl) {
      barSlot.innerHTML = simBarHtml(proj);
    } else {
      playBtn.textContent = isRunning ? '❚❚ Pause' : '▶ Run';
      playBtn.classList.toggle('ink', !isRunning);
      resetBtn.disabled = !snap;
      const b = simBadgeContent(snap);
      badgeEl.className = b.cls;
      badgeEl.textContent = b.text;
    }
  }

  // Update bench controls IN PLACE so buttons/switches/sliders stay mounted and clickable
  const benchSlot = document.getElementById('sim-bench-slot');
  if (benchSlot) {
    const existingBench = benchSlot.querySelector(`[data-sim-bench="${CSS.escape(pid)}"]`);
    const widgets = snap
      ? snap.widgetStates
      : buildSimTopology(proj).widgets.map((w) => ({
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

    if (!existingBench || existingBench.querySelectorAll('[data-sim-card]').length !== widgets.length) {
      benchSlot.innerHTML = simBenchHtml(proj);
    } else {
      for (const w of widgets) {
        const card = existingBench.querySelector(`[data-sim-card="${CSS.escape(w.ref)}"]`);
        if (!card) continue;
        card.classList.toggle('active', Boolean(w.active));
        if (w.kind === 'led') {
          const dot = card.querySelector('.sim-led-dot');
          const txt = card.querySelector('.sim-led-txt');
          const pct = Math.round((w.pwm / 255) * 100);
          if (dot) {
            dot.style.opacity = w.pwm > 0 ? Math.max(0.25, w.pwm / 255).toFixed(2) : '0.15';
            dot.style.boxShadow = w.pwm > 0 ? `0 0 10px ${w.color}` : 'none';
          }
          if (txt) txt.textContent = w.pwm > 0 ? (pct < 100 ? `PWM ${pct}%` : 'ON') : 'OFF';
        } else if (w.kind === 'button') {
          const btn = card.querySelector('[data-sim-btn]');
          if (btn) {
            btn.classList.toggle('ink', Boolean(w.input.pressed));
            btn.textContent = w.input.pressed ? 'Pressed (click to release)' : 'Press button';
          }
        } else if (w.kind === 'switch' || w.kind === 'digital_sensor') {
          const btn = card.querySelector('[data-sim-toggle]');
          if (btn) {
            const onLabel = w.kind === 'switch' ? 'ON' : 'Triggered';
            const offLabel = w.kind === 'switch' ? 'OFF' : 'Idle';
            btn.classList.toggle('ink', Boolean(w.input.on));
            btn.textContent = w.input.on ? onLabel : offLabel;
          }
        } else if (w.kind === 'analog') {
          const inp = card.querySelector('[data-sim-range]');
          const valEl = card.querySelector('.sim-adc-val');
          const pct = Math.round((w.input.value ?? 0.5) * 100);
          const raw = Math.round((w.input.value ?? 0.5) * adcMax);
          if (inp && document.activeElement !== inp) inp.value = String(pct);
          if (valEl) valEl.textContent = String(raw);
        } else if (w.kind === 'servo') {
          const valEl = card.querySelector('.sim-servo-val');
          const barEl = card.querySelector('.sim-servo-bar');
          if (valEl) valEl.textContent = `${w.angle}°`;
          if (barEl) barEl.style.width = `${Math.round((w.angle / 180) * 100)}%`;
        } else if (w.kind === 'buzzer') {
          const el = card.querySelector('.sim-buzzer-txt');
          if (el) {
            el.textContent = w.freq > 0 ? `♪ ${w.freq} Hz` : 'Silent';
            el.classList.toggle('sim-hi-txt', w.freq > 0);
            el.classList.toggle('dim', !(w.freq > 0));
          }
        } else if (w.kind === 'relay') {
          const el = card.querySelector('.sim-relay-txt');
          if (el) {
            el.textContent = w.digital ? 'CLOSED (ON)' : 'OPEN (OFF)';
            el.classList.toggle('sim-hi-txt', Boolean(w.digital));
            el.classList.toggle('dim', !w.digital);
          }
        } else if (w.kind === 'display') {
          const el = card.querySelector('.sim-oled');
          if (el) {
            el.innerHTML = displayLines.length
              ? displayLines.map((l) => `<div>${esc(l)}</div>`).join('')
              : `<div class="faint">${w.i2c ? `I2C ${esc(w.i2c)} · ` : ''}ready</div>`;
          }
        } else {
          const el = card.querySelector('.sim-gen-txt');
          if (el) {
            el.textContent = w.digital ? 'HIGH' : 'LOW';
            el.classList.toggle('sim-hi-txt', Boolean(w.digital));
            el.classList.toggle('dim', !w.digital);
          }
        }
      }
    }
  }

  // Update Serial Monitor IN PLACE so Clear button stays clickable
  const serialLog = document.getElementById('sim-serial-log');
  const clearBtn = document.getElementById('sim-clear-btn');
  const rows = snap ? snap.serial : [];
  if (clearBtn) clearBtn.disabled = rows.length === 0;
  if (serialLog) {
    const key = `${rows.length}:${rows.length ? rows[rows.length - 1].ms : 0}:${rows.length ? rows[rows.length - 1].text : ''}`;
    if (serialLog.dataset.key !== key) {
      serialLog.dataset.key = key;
      serialLog.innerHTML = rows.length
        ? rows.map((r) => `<div><span class="faint">[${(r.ms / 1000).toFixed(2)}s]</span> ${esc(r.text)}</div>`).join('')
        : '<div class="faint">Press ▶ Run to see Serial.println / print() output here.</div>';
      serialLog.scrollTop = serialLog.scrollHeight;
    }
  }

  // Apply live pin/net glow directly onto the SVG wiring map
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

  // Highlight currently executing line in the code gutter and follow it in the editor
  const gutter = document.getElementById('code-gutter');
  const ta = document.getElementById('code-editor');
  const cur = snap?.currentLine || 0;
  if (gutter) {
    const spans = gutter.children;
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('sim-cur', cur > 0 && i + 1 === cur);
    }
    if (ta && cur > 0 && Number(gutter.dataset.curLine || 0) !== cur) {
      gutter.dataset.curLine = String(cur);
      const lineH = 20;
      const targetTop = (cur - 1) * lineH;
      const viewTop = ta.scrollTop;
      const viewBottom = viewTop + ta.clientHeight;
      if (targetTop < viewTop + lineH || targetTop > viewBottom - lineH * 2) {
        ta.scrollTop = Math.max(0, targetTop - Math.floor(ta.clientHeight / 2) + lineH);
        syncCodeGutter(ta);
      }
    } else if (cur === 0) {
      gutter.dataset.curLine = '0';
    }
  }

  // Update plain-English line walkthrough banner
  const explainSlot = document.getElementById('sim-explain-slot');
  if (explainSlot) {
    const d = getCodeDraft(proj);
    const shownLine = cur || d.activeLine || 0;
    const key = `${shownLine}|${Boolean(cur)}|${d.source.length}|${d.analysis?.matched_pin_count || 0}`;
    if (explainSlot.dataset.key !== key) {
      explainSlot.dataset.key = key;
      explainSlot.innerHTML = simExplainHtml(proj, d, snap);
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

  const mapBody = hasNets
    ? `<div class="code-map-pane">
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
        <div class="map-empty">
          <p>${
            guest
              ? 'No wiring connections yet.'
              : 'No wiring connections yet. Add wires in <b>Edit project</b> so Pinbin can generate pin definitions and animate live signals on the map.'
          }</p>
          ${guest ? '' : `<a class="btn ink" href="${projectHref(proj, 'edit')}">Add wiring</a>`}
        </div>
        <div id="sim-serial-slot">${simSerialHtml(proj)}</div>
      </div>`;

  const copyIcon = sv('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');

  return `<div class="code-lab" data-code-pid="${esc(proj.id)}">
    <div id="sim-bar-slot" class="code-lab-bar-l">${simBarHtml(proj)}</div>
    <div class="code-bar code-lab-bar-r">
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
        <button type="button" class="btn quiet" data-code-act="copy" title="Copy code to clipboard">${copyIcon}Copy code</button>
        <button type="button" class="btn quiet" data-code-act="wokwi" title="Open Wokwi export panel (diagram.json, sketch, and libraries)">Wokwi export</button>
        ${
          guest
            ? ''
            : `<button type="button" id="code-save-btn" class="btn ${dirty ? 'ink' : ''}" data-code-act="save" ${
                d.saving || !dirty ? 'disabled' : ''
              }>${d.saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}</button>`
        }
      </div>
    </div>

    ${mapBody}

    <div class="code-pane">
      <div id="sim-explain-slot">${simExplainHtml(proj, d, activeSim && activeSimPid === proj.id ? activeSim.getSnapshot() : null)}</div>
      <div id="code-wokwi-slot">${wokwiPanelHtml(proj, d)}</div>
      <div id="code-selbar-slot">${selectionBannerHtml(proj, d)}</div>

      <div class="code-editor-wrap">
        <div class="code-gutter" id="code-gutter" data-lines="${lines}" aria-hidden="true">${gutterHtml}</div>
        <div class="code-ed-stack">
          <pre class="code-hl" id="code-hl" aria-hidden="true">${highlightCode(d.source, d.language)}</pre>
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
    syncCodeGutter(ta);
  });

  const handleCursorLine = () => {
    const pos = ta.selectionStart || 0;
    const lineNo = ta.value.slice(0, pos).split('\n').length;
    if (d.activeLine !== lineNo) {
      d.activeLine = lineNo;
      refreshSimUi(pid);
      // If this line references a wired pin, highlight its wire on the left map
      const ref = (d.analysis?.references || []).find((r) => r.line === lineNo && r.net_id);
      if (ref && state.sel !== `net:${ref.net_id}`) {
        state.sel = `net:${ref.net_id}`;
        const map = document.getElementById('map');
        if (map) {
          map.querySelectorAll('[data-sel]').forEach((g) => {
            g.classList.toggle('sel', g.dataset.sel === state.sel);
            if (g.dataset.sel.startsWith('net:')) g.classList.toggle('hot', g.dataset.sel === state.sel);
          });
        }
      }
    }
  };
  ta.addEventListener('click', handleCursorLine);
  ta.addEventListener('keyup', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      handleCursorLine();
    }
  });

  if (!isGuest()) {
    const refreshHighlight = () => {
      const hl = document.getElementById('code-hl');
      if (hl) hl.innerHTML = highlightCode(ta.value, d.language);
      syncCodeGutter(ta);
    };
    ta.addEventListener('input', () => {
      d.source = ta.value;
      refreshHighlight();
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
        refreshHighlight();
        updateCodeLivePanels(proj);
        scheduleCodeAnalyze(proj, renderFn);
      }
    });
  }

  ensureProjectCodeAnalyzed(proj, renderFn);
  refreshSimUi(pid);
}
