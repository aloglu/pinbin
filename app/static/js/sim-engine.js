// CSP-safe browser simulator engine for beginner Arduino C++ and MicroPython sketches.
// Runs statement-by-statement (no eval/new Function) so Play, Pause, Step, delay/sleep,
// live pin states, interactive bench widgets, and Serial Monitor all work cleanly.

const POWER_PINS = new Set([
  '5V', '3V3', '3.3V', 'VIN', 'VBUS', 'VSYS', 'GND', 'AGND', 'VCC', 'BAT', 'EN', 'RUN', 'RESET',
]);

export function detectBoardFamily(mcuItem) {
  const low = `${mcuItem?.name || ''} ${mcuItem?.label || ''} ${mcuItem?.subtitle || ''}`.toLowerCase();
  if (low.includes('esp32-c3') || low.includes('esp32 c3')) return 'c3';
  if (low.includes('esp32') || low.includes('esp-32')) return 'esp32';
  if (low.includes('pico') || low.includes('rp2350') || low.includes('rp2040')) return 'pico';
  if (low.includes('uno') || low.includes('atmega328')) return 'uno';
  return 'esp32';
}

export function normalizePin(raw, boardFamily) {
  const tok = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '').toUpperCase();
  if (!tok) return '';
  if (tok === 'LED_BUILTIN' || tok === 'LED') {
    if (boardFamily === 'uno') return 'D13';
    if (boardFamily === 'c3') return 'GPIO8';
    if (boardFamily === 'pico') return 'GP25';
    return 'GPIO2';
  }
  if (tok === 'SDA') {
    if (boardFamily === 'uno') return 'A4';
    if (boardFamily === 'c3') return 'GPIO8';
    if (boardFamily === 'pico') return 'GP4';
    return 'GPIO21';
  }
  if (tok === 'SCL') {
    if (boardFamily === 'uno') return 'A5';
    if (boardFamily === 'c3') return 'GPIO9';
    if (boardFamily === 'pico') return 'GP5';
    return 'GPIO22';
  }
  if (/^\d{1,2}$/.test(tok)) {
    const n = Number(tok);
    if (boardFamily === 'uno') return n >= 14 && n <= 19 ? `A${n - 14}` : `D${n}`;
    if (boardFamily === 'pico') return `GP${n}`;
    return `GPIO${n}`;
  }
  const m = tok.match(/^(GPIO|GP|D|A)(\d{1,2})$/);
  if (m) {
    const [, pref, numS] = m;
    const n = Number(numS);
    if (boardFamily === 'uno') return pref === 'A' ? `A${n}` : `D${n}`;
    if (boardFamily === 'pico') return pref === 'A' && n <= 2 ? `GP${26 + n}` : `GP${n}`;
    return pref === 'A' ? tok : `GPIO${n}`;
  }
  return tok;
}

export function detectSimArchetype(item) {
  const text = `${item?.name || ''} ${item?.label || ''} ${item?.subtitle || ''} ${item?.category || ''}`.toLowerCase();
  if (text.includes('ssd1306') || text.includes('oled') || text.includes('1602') || text.includes('lcd')) {
    return { kind: 'display', label: 'Display' };
  }
  if (text.includes('neopixel') || text.includes('ws2812') || (text.includes('led') && !text.includes('oled'))) {
    const color = ['green', 'blue', 'yellow', 'white', 'orange', 'purple'].find((c) => text.includes(c)) || 'red';
    return { kind: 'led', label: 'LED', color };
  }
  if (text.includes('button') || text.includes('tactile') || text.includes('btn')) {
    return { kind: 'button', label: 'Button' };
  }
  if (text.includes('switch')) {
    return { kind: 'switch', label: 'Switch' };
  }
  if (text.includes('servo') || text.includes('sg90') || text.includes('sg-90')) {
    return { kind: 'servo', label: 'Servo' };
  }
  if (text.includes('buzzer') || text.includes('piezo')) {
    return { kind: 'buzzer', label: 'Buzzer' };
  }
  if (text.includes('relay') || text.includes('motor') || text.includes('pump') || text.includes('fan')) {
    return { kind: 'relay', label: 'Relay / Load' };
  }
  if (text.includes('pir') || text.includes('motion') || text.includes('reed') || text.includes('hall') || text.includes('obstacle')) {
    return { kind: 'digital_sensor', label: 'Digital Sensor' };
  }
  if (
    text.includes('pot') ||
    text.includes('ldr') ||
    text.includes('photoresistor') ||
    text.includes('moisture') ||
    text.includes('mq-') ||
    text.includes('analog') ||
    text.includes('dht') ||
    text.includes('temp') ||
    text.includes('ultrasonic') ||
    text.includes('hc-sr04') ||
    text.includes('sensor')
  ) {
    return { kind: 'analog', label: 'Sensor' };
  }
  return { kind: 'generic', label: 'Part' };
}

export function buildSimTopology(proj) {
  const items = proj?.items || [];
  const mcu = items.find((x) => x.role === 'mcu') || items.find((x) => x.category === 'Microcontrollers') || items[0] || null;
  const mcuRef = mcu?.ref || '';
  const boardFamily = detectBoardFamily(mcu);
  const adcMax = boardFamily === 'uno' ? 1023 : 4095;
  const itemsByRef = new Map(items.map((it) => [it.ref, it]));

  const pinToNet = new Map(); // canonicalPin -> { netId, netName, kind, nodes: [ref] }
  const nodeWidgets = new Map(); // ref -> { ref, name, kind, color, pins: [canonicalPin], netIds: [netId], i2c }

  for (const net of proj?.nets || []) {
    const conns = net.conns || [];
    const mcuPins = [];
    const otherRefs = [];
    for (const pair of conns) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [ref, pinRaw] = pair;
      if (ref === mcuRef) {
        const toks = String(pinRaw || '').split(/[,/]/).map((s) => s.trim()).filter(Boolean);
        for (const t of toks) {
          const norm = normalizePin(t, boardFamily);
          if (norm && !POWER_PINS.has(norm)) mcuPins.push(norm);
        }
      } else {
        otherRefs.push(ref);
      }
    }
    for (const p of mcuPins) {
      if (!pinToNet.has(p)) {
        pinToNet.set(p, { netId: net.id, netName: net.name, kind: net.kind || 'sig', nodes: [] });
      }
      const entry = pinToNet.get(p);
      for (const r of otherRefs) {
        if (!entry.nodes.includes(r)) entry.nodes.push(r);
        const it = itemsByRef.get(r);
        if (!it || it.role === 'material' || it.role === 'power') continue;
        if (!nodeWidgets.has(r)) {
          const arch = detectSimArchetype(it);
          nodeWidgets.set(r, {
            ref: r,
            name: it.label || it.name || r,
            kind: arch.kind,
            label: arch.label,
            color: arch.color || 'red',
            pins: [],
            netIds: [],
            i2c: it.electrical_facts?.i2c || null,
          });
        }
        const w = nodeWidgets.get(r);
        if (!w.pins.includes(p)) w.pins.push(p);
        if (!w.netIds.includes(net.id)) w.netIds.push(net.id);
      }
    }
  }

  return {
    mcuRef,
    boardFamily,
    adcMax,
    pinToNet,
    widgets: [...nodeWidgets.values()],
  };
}

/* ========================================================= Expression & Statement Engine */

function stripLineComment(line, lang) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (lang === 'micropython' && ch === '#') return line.slice(0, i);
    if (lang === 'arduino' && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(str, sep = ',') {
  const out = [];
  let cur = '';
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out.filter((x) => x !== '');
}

function parseProgram(source, lang) {
  const rawLines = String(source || '').split('\n');
  if (lang === 'micropython') return parseMicroPython(rawLines);
  return parseArduino(rawLines);
}

function parseMicroPython(rawLines) {
  const lines = rawLines.map((l, idx) => {
    const stripped = stripLineComment(l, 'micropython');
    const trimmed = stripped.trim();
    const indent = stripped.match(/^\s*/)[0].length;
    return { lineNo: idx + 1, indent, text: trimmed };
  }).filter((x) => x.text.length > 0);

  function parseBlock(startIdx, minIndent) {
    const stmts = [];
    let i = startIdx;
    while (i < lines.length && lines[i].indent >= minIndent) {
      const cur = lines[i];
      if (cur.text.startsWith('import ') || cur.text.startsWith('from ')) {
        i++;
        continue;
      }
      if (/^while\s+(.+):$/.test(cur.text)) {
        const cond = cur.text.match(/^while\s+(.+):$/)[1].trim();
        const [body, nextI] = parseBlock(i + 1, cur.indent + 1);
        stmts.push({ type: 'while', lineNo: cur.lineNo, cond, body });
        i = nextI;
        continue;
      }
      if (/^for\s+([A-Za-z_]\w*)\s+in\s+range\((.+)\):$/.test(cur.text)) {
        const m = cur.text.match(/^for\s+([A-Za-z_]\w*)\s+in\s+range\((.+)\):$/);
        const [body, nextI] = parseBlock(i + 1, cur.indent + 1);
        stmts.push({ type: 'for_range', lineNo: cur.lineNo, varName: m[1], rangeExpr: m[2].trim(), body });
        i = nextI;
        continue;
      }
      if (/^if\s+(.+):$/.test(cur.text)) {
        const branches = [];
        const cond = cur.text.match(/^if\s+(.+):$/)[1].trim();
        let [body, nextI] = parseBlock(i + 1, cur.indent + 1);
        branches.push({ cond, body, lineNo: cur.lineNo });
        i = nextI;
        while (i < lines.length && lines[i].indent === cur.indent && /^elif\s+(.+):$/.test(lines[i].text)) {
          const c2 = lines[i].text.match(/^elif\s+(.+):$/)[1].trim();
          const ln2 = lines[i].lineNo;
          [body, nextI] = parseBlock(i + 1, cur.indent + 1);
          branches.push({ cond: c2, body, lineNo: ln2 });
          i = nextI;
        }
        let elseBody = [];
        if (i < lines.length && lines[i].indent === cur.indent && /^else\s*:$/.test(lines[i].text)) {
          [elseBody, nextI] = parseBlock(i + 1, cur.indent + 1);
          i = nextI;
        }
        stmts.push({ type: 'if', lineNo: cur.lineNo, branches, elseBody });
        continue;
      }
      if (/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\):$/.test(cur.text)) {
        const m = cur.text.match(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\):$/);
        const [body, nextI] = parseBlock(i + 1, cur.indent + 1);
        stmts.push({
          type: 'funcdef',
          lineNo: cur.lineNo,
          name: m[1],
          params: m[2].split(',').map((s) => s.trim()).filter(Boolean),
          body,
        });
        i = nextI;
        continue;
      }
      if (cur.text === 'pass') { i++; continue; }
      if (cur.text === 'break') { stmts.push({ type: 'break', lineNo: cur.lineNo }); i++; continue; }
      if (cur.text === 'continue') { stmts.push({ type: 'continue', lineNo: cur.lineNo }); i++; continue; }
      stmts.push({ type: 'stmt', lineNo: cur.lineNo, text: cur.text });
      i++;
    }
    return [stmts, i];
  }

  const [top] = parseBlock(0, 0);
  return { lang: 'micropython', setup: top, loop: [] };
}

function parseArduino(rawLines) {
  // Strip block comments while keeping line numbers
  let inBlock = false;
  const cleaned = rawLines.map((l, idx) => {
    let s = '';
    let i = 0;
    while (i < l.length) {
      if (inBlock) {
        if (l[i] === '*' && l[i + 1] === '/') { inBlock = false; i += 2; }
        else i++;
        continue;
      }
      if (l[i] === '/' && l[i + 1] === '*') { inBlock = true; i += 2; continue; }
      s += l[i++];
    }
    return { lineNo: idx + 1, text: stripLineComment(s, 'arduino').trim() };
  });

  // Tokenize into top-level lines and braced blocks
  const globals = [];
  const funcs = new Map();

  let i = 0;
  function readBlock(startIdx) {
    // Expects '{' already opened on startIdx or next line; returns [stmts, nextIdx]
    const stmts = [];
    let j = startIdx;
    while (j < cleaned.length) {
      const { lineNo, text } = cleaned[j];
      if (!text) { j++; continue; }
      if (text === '}' || text === '};') return [stmts, j + 1];
      if (text.startsWith('}')) return [stmts, j];

      // Handle single-line closing brace after statement
      const endsBlock = text.endsWith('}') && !text.includes('{');
      const bodyText = endsBlock ? text.slice(0, -1).trim() : text;

      if (/^if\s*\((.+)\)\s*\{?$/.test(bodyText)) {
        const m = bodyText.match(/^if\s*\((.+)\)\s*(\{)?$/);
        let body = [];
        let nextJ = j + 1;
        if (m[2]) {
          [body, nextJ] = readBlock(j + 1);
        } else if (nextJ < cleaned.length && cleaned[nextJ].text === '{') {
          [body, nextJ] = readBlock(nextJ + 1);
        } else if (nextJ < cleaned.length) {
          body = [{ type: 'stmt', lineNo: cleaned[nextJ].lineNo, text: cleaned[nextJ].text.replace(/;$/, '') }];
          nextJ++;
        }
        const branches = [{ cond: m[1].trim(), body, lineNo }];
        let elseBody = [];
        while (nextJ < cleaned.length && /^else\s+if\s*\((.+)\)\s*\{?$/.test(cleaned[nextJ].text.replace(/^\}\s*/, ''))) {
          const t2 = cleaned[nextJ].text.replace(/^\}\s*/, '');
          const m2 = t2.match(/^else\s+if\s*\((.+)\)\s*(\{)?$/);
          const ln2 = cleaned[nextJ].lineNo;
          let b2 = [];
          if (m2[2]) [b2, nextJ] = readBlock(nextJ + 1);
          else if (nextJ + 1 < cleaned.length && cleaned[nextJ + 1].text === '{') [b2, nextJ] = readBlock(nextJ + 2);
          else { b2 = [{ type: 'stmt', lineNo: cleaned[nextJ + 1]?.lineNo || ln2, text: (cleaned[nextJ + 1]?.text || '').replace(/;$/, '') }]; nextJ += 2; }
          branches.push({ cond: m2[1].trim(), body: b2, lineNo: ln2 });
        }
        if (nextJ < cleaned.length && /^else\s*\{?$/.test(cleaned[nextJ].text.replace(/^\}\s*/, ''))) {
          const t3 = cleaned[nextJ].text.replace(/^\}\s*/, '');
          if (t3.endsWith('{')) [elseBody, nextJ] = readBlock(nextJ + 1);
          else if (nextJ + 1 < cleaned.length && cleaned[nextJ + 1].text === '{') [elseBody, nextJ] = readBlock(nextJ + 2);
          else { elseBody = [{ type: 'stmt', lineNo: cleaned[nextJ + 1]?.lineNo || lineNo, text: (cleaned[nextJ + 1]?.text || '').replace(/;$/, '') }]; nextJ += 2; }
        }
        stmts.push({ type: 'if', lineNo, branches, elseBody });
        j = nextJ;
        continue;
      }

      if (/^while\s*\((.+)\)\s*\{?$/.test(bodyText)) {
        const m = bodyText.match(/^while\s*\((.+)\)\s*(\{)?$/);
        const [body, nextJ] = m[2] ? readBlock(j + 1) : readBlock(j + 2);
        stmts.push({ type: 'while', lineNo, cond: m[1].trim(), body });
        j = nextJ;
        continue;
      }

      if (/^for\s*\(([^;]*);([^;]*);([^)]*)\)\s*\{?$/.test(bodyText)) {
        const m = bodyText.match(/^for\s*\(([^;]*);([^;]*);([^)]*)\)\s*(\{)?$/);
        const [body, nextJ] = m[4] ? readBlock(j + 1) : readBlock(j + 2);
        stmts.push({ type: 'for_c', lineNo, init: m[1].trim(), cond: m[2].trim(), step: m[3].trim(), body });
        j = nextJ;
        continue;
      }

      if (bodyText && bodyText !== '{') {
        const cleanStmt = bodyText.replace(/;$/, '').trim();
        if (cleanStmt === 'break') stmts.push({ type: 'break', lineNo });
        else if (cleanStmt === 'continue') stmts.push({ type: 'continue', lineNo });
        else if (cleanStmt) stmts.push({ type: 'stmt', lineNo, text: cleanStmt });
      }
      if (endsBlock) return [stmts, j + 1];
      j++;
    }
    return [stmts, j];
  }

  while (i < cleaned.length) {
    const { lineNo, text } = cleaned[i];
    if (!text || text.startsWith('#include')) { i++; continue; }
    const defM = text.match(/^#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/);
    if (defM) {
      globals.push({ type: 'stmt', lineNo, text: `${defM[1]} = ${defM[2].trim()}` });
      i++;
      continue;
    }
    const fnM = text.match(/^(?:void|int|bool|float|double|String|long|unsigned\s+long)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(\{)?$/);
    if (fnM) {
      const fnName = fnM[1];
      const params = fnM[2].split(',').map((p) => p.trim().split(/\s+/).pop()).filter(Boolean);
      let bodyStart = i + 1;
      if (!fnM[3] && bodyStart < cleaned.length && cleaned[bodyStart].text === '{') bodyStart++;
      const [body, nextI] = readBlock(bodyStart);
      funcs.set(fnName, { name: fnName, params, body, lineNo });
      i = nextI;
      continue;
    }
    const cleanG = text.replace(/;$/, '').trim();
    if (cleanG) globals.push({ type: 'stmt', lineNo, text: cleanG });
    i++;
  }

  const setupBody = [...globals, ...(funcs.get('setup')?.body || [])];
  const loopBody = funcs.get('loop')?.body || [];
  return { lang: 'arduino', setup: setupBody, loop: loopBody, funcs };
}

/* ========================================================= Runtime Simulator Class */

export class PinbinSimulator {
  constructor(project, codeSource, language) {
    this.project = project;
    this.language = language === 'micropython' ? 'micropython' : 'arduino';
    this.topology = buildSimTopology(project);
    this.program = parseProgram(codeSource, this.language);

    this.running = false;
    this.paused = false;
    this.currentLine = null;
    this.simMs = 0;
    this.waitUntilMs = 0;
    this.stepCount = 0;
    this.error = '';

    // Pin & peripheral runtime state
    this.pinModes = new Map();   // pin -> 'OUTPUT' | 'INPUT' | 'INPUT_PULLUP'
    this.pinDigital = new Map(); // pin -> 0 | 1
    this.pinPwm = new Map();     // pin -> 0..255
    this.pinFreq = new Map();    // pin -> Hz (buzzer)
    this.pinAngle = new Map();   // pin -> 0..180 (servo)

    // User-driven input states keyed by node ref
    this.inputs = new Map(); // ref -> { pressed: bool, on: bool, value: 0..1 }
    for (const w of this.topology.widgets) {
      this.inputs.set(w.ref, { pressed: false, on: false, value: 0.5 });
    }

    this.displayLines = [];
    this.serial = [];
    this.env = Object.create(null);
    this.funcs = new Map(this.program.funcs || []);
    this._initBuiltins();

    // Execution frame stack: each frame = { stmts, idx, kind, ... }
    this.phase = 'setup'; // 'setup' | 'loop' | 'done'
    this.stack = [{ stmts: this.program.setup, idx: 0, kind: 'root' }];
  }

  _initBuiltins() {
    this.env.HIGH = 1;
    this.env.LOW = 0;
    this.env.INPUT = 'INPUT';
    this.env.OUTPUT = 'OUTPUT';
    this.env.INPUT_PULLUP = 'INPUT_PULLUP';
    this.env.True = true;
    this.env.False = false;
    this.env.true = true;
    this.env.false = false;
    this.env.LED_BUILTIN = normalizePin('LED_BUILTIN', this.topology.boardFamily);
  }

  logSerial(text, newline = true) {
    const s = String(text ?? '');
    if (newline || !this.serial.length) {
      this.serial.push({ ms: Math.round(this.simMs), text: s });
      if (this.serial.length > 120) this.serial.shift();
    } else {
      this.serial[this.serial.length - 1].text += s;
    }
  }

  _canonPin(val) {
    if (val && typeof val === 'object' && val.__type === 'Pin') return val.pin;
    return normalizePin(val, this.topology.boardFamily);
  }

  setInput(ref, patch) {
    const cur = this.inputs.get(ref) || { pressed: false, on: false, value: 0.5 };
    Object.assign(cur, patch);
    this.inputs.set(ref, cur);
  }

  readDigitalPin(pin) {
    const p = this._canonPin(pin);
    const net = this.topology.pinToNet.get(p);
    const mode = this.pinModes.get(p) || 'INPUT';
    if (net) {
      for (const ref of net.nodes) {
        const w = this.topology.widgets.find((x) => x.ref === ref);
        const inp = this.inputs.get(ref);
        if (!w || !inp) continue;
        if (w.kind === 'button') {
          return mode === 'INPUT_PULLUP' ? (inp.pressed ? 0 : 1) : (inp.pressed ? 1 : 0);
        }
        if (w.kind === 'switch' || w.kind === 'digital_sensor') {
          return mode === 'INPUT_PULLUP' ? (inp.on ? 0 : 1) : (inp.on ? 1 : 0);
        }
        if (w.kind === 'analog') {
          return inp.value >= 0.5 ? 1 : 0;
        }
      }
    }
    if (this.pinDigital.has(p)) return this.pinDigital.get(p);
    return mode === 'INPUT_PULLUP' ? 1 : 0;
  }

  readAnalogPin(pin, u16 = false) {
    const p = this._canonPin(pin);
    const net = this.topology.pinToNet.get(p);
    let ratio = 0.5;
    if (net) {
      for (const ref of net.nodes) {
        const inp = this.inputs.get(ref);
        if (inp) { ratio = Math.max(0, Math.min(1, Number(inp.value) || 0)); break; }
      }
    }
    return Math.round(ratio * (u16 ? 65535 : this.topology.adcMax));
  }

  writeDigitalPin(pin, val) {
    const p = this._canonPin(pin);
    const v = val ? 1 : 0;
    this.pinDigital.set(p, v);
    this.pinPwm.set(p, v ? 255 : 0);
  }

  writePwmPin(pin, val255) {
    const p = this._canonPin(pin);
    const clamped = Math.max(0, Math.min(255, Math.round(Number(val255) || 0)));
    this.pinPwm.set(p, clamped);
    this.pinDigital.set(p, clamped > 0 ? 1 : 0);
  }

  getSnapshot() {
    const netStates = {};
    for (const [pin, info] of this.topology.pinToNet.entries()) {
      const pwm = this.pinPwm.get(pin);
      const dig = this.pinDigital.has(pin) ? this.pinDigital.get(pin) : this.readDigitalPin(pin);
      let stateStr = dig ? 'high' : 'low';
      if (pwm !== undefined && pwm > 0 && pwm < 255) stateStr = 'pwm';
      netStates[info.netId] = { pin, state: stateStr, digital: dig, pwm: pwm ?? (dig ? 255 : 0) };
    }

    const widgetStates = this.topology.widgets.map((w) => {
      const p = w.pins[0] || '';
      const pwm = p && this.pinPwm.has(p) ? this.pinPwm.get(p) : (p && this.pinDigital.get(p) ? 255 : 0);
      const dig = p ? (this.pinDigital.has(p) ? this.pinDigital.get(p) : this.readDigitalPin(p)) : 0;
      const inp = this.inputs.get(w.ref) || { pressed: false, on: false, value: 0.5 };
      return {
        ...w,
        digital: dig,
        pwm,
        freq: p ? this.pinFreq.get(p) || 0 : 0,
        angle: p && this.pinAngle.has(p) ? this.pinAngle.get(p) : 90,
        input: { ...inp },
        active:
          (w.kind === 'led' && pwm > 0) ||
          (w.kind === 'relay' && dig > 0) ||
          (w.kind === 'buzzer' && (this.pinFreq.get(p) || 0) > 0) ||
          (w.kind === 'button' && inp.pressed) ||
          ((w.kind === 'switch' || w.kind === 'digital_sensor') && inp.on),
      };
    });

    return {
      running: this.running,
      paused: this.paused,
      phase: this.phase,
      currentLine: this.currentLine,
      simMs: Math.round(this.simMs),
      error: this.error,
      adcMax: this.topology.adcMax,
      netStates,
      widgetStates,
      displayLines: [...this.displayLines],
      serial: [...this.serial],
    };
  }

  /* ----- Expression evaluator (safe, no eval) ----- */
  evalExpr(raw) {
    const s = String(raw || '').trim();
    if (!s) return undefined;

    // String literals (including simple Python f-strings)
    if (/^f(['"])(.*)\1$/.test(s)) {
      const inner = s.slice(2, -1);
      return inner.replace(/\{([^}]+)\}/g, (_, expr) => String(this.evalExpr(expr) ?? ''));
    }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }

    // Numeric literal (decimal or hex)
    if (/^-?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^-?\d+(?:_\d+)*(?:\.\d+)?$/.test(s)) return Number(s.replace(/_/g, ''));

    // Strip wrapping parens if balanced
    if (s.startsWith('(') && s.endsWith(')')) {
      let depth = 0;
      let balanced = true;
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        if (depth === 0) { balanced = false; break; }
      }
      if (balanced) return this.evalExpr(s.slice(1, -1));
    }

    // Ternary: cond ? a : b
    const tern = this._splitTernary(s);
    if (tern) return this.evalExpr(tern[0]) ? this.evalExpr(tern[1]) : this.evalExpr(tern[2]);

    // Binary operators by precedence (lowest first)
    const opGroups = [
      ['||', ' or '],
      ['&&', ' and '],
      ['==', '!=', '<=', '>=', '<', '>'],
      ['+', '-'],
      ['*', '/', '//', '%'],
    ];
    for (const ops of opGroups) {
      const hit = this._splitBinary(s, ops);
      if (hit) {
        const [left, op, right] = hit;
        const a = this.evalExpr(left);
        const b = this.evalExpr(right);
        switch (op) {
          case '||': case ' or ': return a || b;
          case '&&': case ' and ': return a && b;
          case '==': return a == b; // eslint-disable-line eqeqeq
          case '!=': return a != b; // eslint-disable-line eqeqeq
          case '<=': return Number(a) <= Number(b);
          case '>=': return Number(a) >= Number(b);
          case '<': return Number(a) < Number(b);
          case '>': return Number(a) > Number(b);
          case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : Number(a) + Number(b);
          case '-': return Number(a) - Number(b);
          case '*': return Number(a) * Number(b);
          case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
          case '//': return Number(b) === 0 ? 0 : Math.floor(Number(a) / Number(b));
          case '%': return Number(b) === 0 ? 0 : Number(a) % Number(b);
        }
      }
    }

    // Unary not / minus
    if (s.startsWith('!')) return !this.evalExpr(s.slice(1));
    if (s.startsWith('not ')) return !this.evalExpr(s.slice(4));
    if (s.startsWith('-')) return -Number(this.evalExpr(s.slice(1)));

    // Method or function call: obj.method(args) or fn(args)
    const callM = s.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*\((.*)\)$/);
    if (callM) {
      return this.evalCall(callM[1], callM[2]);
    }

    // Direct identifier lookup
    if (s in this.env) return this.env[s];
    if (s === 'Pin.OUT') return 'OUTPUT';
    if (s === 'Pin.IN') return 'INPUT';
    if (s === 'Pin.PULL_UP') return 'INPUT_PULLUP';
    return s;
  }

  _splitTernary(s) {
    let depth = 0, inStr = null, qIdx = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && ch === '?' && qIdx < 0) qIdx = i;
      else if (depth === 0 && ch === ':' && qIdx >= 0) {
        return [s.slice(0, qIdx), s.slice(qIdx + 1, i), s.slice(i + 1)];
      }
    }
    return null;
  }

  _splitBinary(s, ops) {
    let depth = 0, inStr = null;
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (inStr) { if (ch === inStr && s[i - 1] !== '\\') inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === ')' || ch === ']') depth++;
      else if (ch === '(' || ch === '[') depth = Math.max(0, depth - 1);
      if (depth !== 0) continue;
      for (const op of ops) {
        const start = i - op.length + 1;
        if (start <= 0) continue;
        if (s.slice(start, i + 1) === op) {
          // Avoid splitting negative sign or compound op (<=, >=, ==, !=)
          if ((op === '+' || op === '-') && /[=<>!(,+\-*/%]$/.test(s.slice(0, start).trim())) continue;
          if ((op === '<' || op === '>') && s[start + 1] === '=') continue;
          return [s.slice(0, start).trim(), op, s.slice(i + 1).trim()];
        }
      }
    }
    return null;
  }

  evalCall(target, rawArgs) {
    const argParts = splitTopLevel(rawArgs, ',');
    const posArgs = [];
    const kwArgs = {};
    for (const part of argParts) {
      const kwM = part.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
      if (kwM && this.language === 'micropython') {
        kwArgs[kwM[1]] = this.evalExpr(kwM[2]);
      } else {
        posArgs.push(this.evalExpr(part));
      }
    }

    // Built-in Arduino & MicroPython hardware APIs
    if (target === 'pinMode') {
      const p = this._canonPin(posArgs[0]);
      this.pinModes.set(p, String(posArgs[1] || 'OUTPUT'));
      return undefined;
    }
    if (target === 'digitalWrite') {
      this.writeDigitalPin(posArgs[0], posArgs[1]);
      return undefined;
    }
    if (target === 'digitalRead') {
      return this.readDigitalPin(posArgs[0]);
    }
    if (target === 'analogRead') {
      return this.readAnalogPin(posArgs[0], false);
    }
    if (target === 'analogWrite' || target === 'ledcWrite') {
      this.writePwmPin(posArgs[0], posArgs[1]);
      return undefined;
    }
    if (target === 'tone') {
      const p = this._canonPin(posArgs[0]);
      this.pinFreq.set(p, Math.max(0, Number(posArgs[1]) || 440));
      this.pinDigital.set(p, 1);
      return undefined;
    }
    if (target === 'noTone') {
      const p = this._canonPin(posArgs[0]);
      this.pinFreq.set(p, 0);
      this.pinDigital.set(p, 0);
      return undefined;
    }
    if (target === 'delay' || target === 'time.sleep_ms') {
      const ms = Math.max(10, Math.min(10_000, Number(posArgs[0]) || 100));
      this.waitUntilMs = this.simMs + ms;
      return undefined;
    }
    if (target === 'time.sleep') {
      const ms = Math.max(10, Math.min(10_000, Math.round((Number(posArgs[0]) || 0.1) * 1000)));
      this.waitUntilMs = this.simMs + ms;
      return undefined;
    }
    if (target === 'millis' || target === 'time.ticks_ms') {
      return Math.round(this.simMs);
    }
    if (target === 'map') {
      const [x, inMin, inMax, outMin, outMax] = posArgs.map(Number);
      if (inMax === inMin) return outMin;
      return Math.round(((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin);
    }
    if (target === 'constrain') {
      const [x, lo, hi] = posArgs.map(Number);
      return Math.max(lo, Math.min(hi, x));
    }
    if (target === 'abs' || target === 'Math.abs') return Math.abs(Number(posArgs[0]));
    if (target === 'min') return Math.min(...posArgs.map(Number));
    if (target === 'max') return Math.max(...posArgs.map(Number));
    if (target === 'int') return parseInt(posArgs[0], 10) || 0;
    if (target === 'float') return parseFloat(posArgs[0]) || 0;
    if (target === 'str' || target === 'String') return String(posArgs[0] ?? '');
    if (target === 'hex') return '0x' + (Number(posArgs[0]) || 0).toString(16);
    if (target === 'const') return posArgs[0];
    if (target === 'print') {
      this.logSerial(posArgs.map((a) => String(a ?? '')).join(' '), true);
      return undefined;
    }
    if (target === 'Serial.println') {
      this.logSerial(posArgs.length ? posArgs[0] : '', true);
      return undefined;
    }
    if (target === 'Serial.print') {
      this.logSerial(posArgs.length ? posArgs[0] : '', false);
      return undefined;
    }
    if (target === 'Serial.begin' || target === 'Wire.begin' || target === 'SPI.begin') {
      return undefined;
    }

    // MicroPython constructors
    if (target === 'Pin' || target === 'machine.Pin') {
      const pin = this._canonPin(posArgs[0]);
      const mode = String(posArgs[1] || 'INPUT');
      const pull = String(posArgs[2] || '');
      this.pinModes.set(pin, pull === 'INPUT_PULLUP' ? 'INPUT_PULLUP' : mode);
      return { __type: 'Pin', pin };
    }
    if (target === 'PWM' || target === 'machine.PWM') {
      const pin = this._canonPin(posArgs[0]);
      this.pinModes.set(pin, 'OUTPUT');
      return { __type: 'PWM', pin, freq: kwArgs.freq || 1000 };
    }
    if (target === 'ADC' || target === 'machine.ADC') {
      const pin = this._canonPin(posArgs[0]);
      this.pinModes.set(pin, 'INPUT');
      return { __type: 'ADC', pin };
    }
    if (target === 'I2C' || target === 'SoftI2C' || target === 'machine.I2C') {
      return { __type: 'I2C' };
    }

    // Object method calls: obj.method(...)
    if (target.includes('.')) {
      const [objName, meth] = target.split('.');
      const obj = this.env[objName];

      // Display / LCD helpers (display.println, lcd.print, oled.text)
      if (/display|oled|lcd/i.test(objName)) {
        if (meth === 'clearDisplay' || meth === 'clear' || meth === 'fill') {
          this.displayLines = [];
        } else if (meth === 'println' || meth === 'print' || meth === 'text') {
          const txt = String(posArgs[0] ?? '');
          if (txt) {
            this.displayLines.push(txt);
            if (this.displayLines.length > 4) this.displayLines.shift();
          }
        }
        return undefined;
      }

      // Servo helpers (servo.attach(pin), servo.write(angle))
      if (meth === 'attach') {
        const pin = this._canonPin(posArgs[0]);
        this.env[objName] = { __type: 'Servo', pin };
        return undefined;
      }
      if (obj?.__type === 'Servo' && meth === 'write') {
        const angle = Math.max(0, Math.min(180, Math.round(Number(posArgs[0]) || 0)));
        this.pinAngle.set(obj.pin, angle);
        this.writePwmPin(obj.pin, Math.round((angle / 180) * 255));
        return undefined;
      }

      if (obj?.__type === 'Pin') {
        if (meth === 'on' || meth === 'high') { this.writeDigitalPin(obj.pin, 1); return undefined; }
        if (meth === 'off' || meth === 'low') { this.writeDigitalPin(obj.pin, 0); return undefined; }
        if (meth === 'toggle') { this.writeDigitalPin(obj.pin, this.pinDigital.get(obj.pin) ? 0 : 1); return undefined; }
        if (meth === 'value') {
          if (posArgs.length > 0) { this.writeDigitalPin(obj.pin, posArgs[0]); return undefined; }
          return this.readDigitalPin(obj.pin);
        }
      }
      if (obj?.__type === 'PWM') {
        if (meth === 'duty') { this.writePwmPin(obj.pin, Math.round((Number(posArgs[0]) / 1023) * 255)); return undefined; }
        if (meth === 'duty_u16') { this.writePwmPin(obj.pin, Math.round((Number(posArgs[0]) / 65535) * 255)); return undefined; }
        if (meth === 'freq') { this.pinFreq.set(obj.pin, Number(posArgs[0]) || 0); return undefined; }
      }
      if (obj?.__type === 'ADC') {
        if (meth === 'read') return this.readAnalogPin(obj.pin, false);
        if (meth === 'read_u16') return this.readAnalogPin(obj.pin, true);
      }
      if (obj?.__type === 'I2C' && meth === 'scan') {
        const addrs = this.topology.widgets
          .map((w) => w.i2c)
          .filter(Boolean)
          .map((a) => parseInt(String(a), 16))
          .filter((n) => Number.isFinite(n));
        return addrs.map((n) => '0x' + n.toString(16)).join(', ') || '[]';
      }
    }

    return undefined;
  }

  execSimpleStmt(text) {
    // Strip C type prefix if present (e.g. "const int x = 5", "unsigned long t = millis()")
    let s = text.trim();
    if (this.language === 'arduino') {
      s = s.replace(
        /^(?:static\s+)?(?:const\s+|constexpr\s+)?(?:unsigned\s+)?(?:int|uint8_t|int8_t|uint16_t|uint32_t|byte|bool|boolean|float|double|long|short|char|String|auto|Servo)\s+/,
        ''
      );
      if (/^[A-Za-z_]\w*$/.test(s)) {
        if (!(s in this.env)) this.env[s] = 0;
        return;
      }
    }

    // x++ / x--
    const incM = s.match(/^([A-Za-z_]\w*)\s*(\+\+|--)$/);
    if (incM) {
      const cur = Number(this.env[incM[1]] || 0);
      this.env[incM[1]] = incM[2] === '++' ? cur + 1 : cur - 1;
      return;
    }

    // Compound assignment: x += expr
    const compM = s.match(/^([A-Za-z_]\w*)\s*(\+=|-=|\*=|\/=)\s*(.+)$/);
    if (compM) {
      const cur = Number(this.env[compM[1]] || 0);
      const val = Number(this.evalExpr(compM[3]) || 0);
      if (compM[2] === '+=') this.env[compM[1]] = cur + val;
      else if (compM[2] === '-=') this.env[compM[1]] = cur - val;
      else if (compM[2] === '*=') this.env[compM[1]] = cur * val;
      else if (compM[2] === '/=') this.env[compM[1]] = val === 0 ? 0 : cur / val;
      return;
    }

    // Simple assignment: x = expr (avoid ==, !=, <=, >=)
    const assignM = s.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/);
    if (assignM) {
      this.env[assignM[1]] = this.evalExpr(assignM[2]);
      return;
    }

    // Expression statement (e.g., function call)
    this.evalExpr(s);
  }

  /** Execute a single statement step; returns true if a statement ran. */
  stepOne(ignoreWait = false) {
    if (this.error || this.phase === 'done') return false;
    if (!ignoreWait && this.simMs < this.waitUntilMs) return false;
    if (ignoreWait && this.simMs < this.waitUntilMs) this.simMs = this.waitUntilMs;

    let guard = 0;
    while (guard++ < 40) {
      if (!this.stack.length) {
        if (this.phase === 'setup' && this.program.loop.length) {
          this.phase = 'loop';
          this.stack.push({ stmts: this.program.loop, idx: 0, kind: 'arduino_loop' });
        } else if (this.phase === 'loop' && this.program.loop.length) {
          this.stack.push({ stmts: this.program.loop, idx: 0, kind: 'arduino_loop' });
          // Small implicit yield between loop iterations if sketch had no delay()
          this.simMs += 20;
          return true;
        } else {
          this.phase = 'done';
          this.running = false;
          return false;
        }
      }

      const frame = this.stack[this.stack.length - 1];
      if (frame.idx >= frame.stmts.length) {
        if (frame.kind === 'while') {
          if (this.evalExpr(frame.cond)) {
            frame.idx = 0;
            this.simMs += 10;
            return true;
          }
        } else if (frame.kind === 'for_range') {
          frame.cur += frame.step;
          if ((frame.step > 0 && frame.cur < frame.stop) || (frame.step < 0 && frame.cur > frame.stop)) {
            this.env[frame.varName] = frame.cur;
            frame.idx = 0;
            continue;
          }
        } else if (frame.kind === 'for_c') {
          if (frame.step) this.execSimpleStmt(frame.step);
          if (!frame.cond || this.evalExpr(frame.cond)) {
            frame.idx = 0;
            continue;
          }
        }
        this.stack.pop();
        continue;
      }

      const st = frame.stmts[frame.idx++];
      this.currentLine = st.lineNo;
      this.stepCount++;

      try {
        if (st.type === 'stmt') {
          this.execSimpleStmt(st.text);
          return true;
        }
        if (st.type === 'if') {
          let matched = false;
          for (const br of st.branches) {
            if (this.evalExpr(br.cond)) {
              this.stack.push({ stmts: br.body, idx: 0, kind: 'block' });
              matched = true;
              break;
            }
          }
          if (!matched && st.elseBody?.length) {
            this.stack.push({ stmts: st.elseBody, idx: 0, kind: 'block' });
          }
          return true;
        }
        if (st.type === 'while') {
          if (this.evalExpr(st.cond)) {
            this.stack.push({ stmts: st.body, idx: 0, kind: 'while', cond: st.cond });
          }
          return true;
        }
        if (st.type === 'for_range') {
          const rArgs = splitTopLevel(st.rangeExpr, ',').map((a) => Number(this.evalExpr(a) || 0));
          const start = rArgs.length >= 2 ? rArgs[0] : 0;
          const stop = rArgs.length >= 2 ? rArgs[1] : rArgs[0];
          const step = rArgs.length >= 3 ? (rArgs[2] || 1) : 1;
          if ((step > 0 && start < stop) || (step < 0 && start > stop)) {
            this.env[st.varName] = start;
            this.stack.push({ stmts: st.body, idx: 0, kind: 'for_range', varName: st.varName, cur: start, stop, step });
          }
          return true;
        }
        if (st.type === 'for_c') {
          if (st.init) this.execSimpleStmt(st.init);
          if (!st.cond || this.evalExpr(st.cond)) {
            this.stack.push({ stmts: st.body, idx: 0, kind: 'for_c', cond: st.cond, step: st.step });
          }
          return true;
        }
        if (st.type === 'funcdef') {
          this.funcs.set(st.name, st);
          return true;
        }
        if (st.type === 'break') {
          while (this.stack.length) {
            const popped = this.stack.pop();
            if (popped.kind === 'while' || popped.kind === 'for_range' || popped.kind === 'for_c') break;
          }
          return true;
        }
        if (st.type === 'continue') {
          while (this.stack.length) {
            const top = this.stack[this.stack.length - 1];
            if (top.kind === 'while' || top.kind === 'for_range' || top.kind === 'for_c') {
              top.idx = top.stmts.length;
              break;
            }
            this.stack.pop();
          }
          return true;
        }
      } catch (err) {
        this.error = `Line ${st.lineNo}: ${err.message || String(err)}`;
        this.running = false;
        return false;
      }
    }
    return false;
  }

  /** Advance simulated clock by dtMs and run statements up to a safe budget per tick. */
  tick(dtMs = 50, maxSteps = 25) {
    if (!this.running || this.paused || this.error) return;
    this.simMs += dtMs;
    let steps = 0;
    while (steps < maxSteps && this.running && !this.paused && this.simMs >= this.waitUntilMs) {
      if (!this.stepOne(false)) break;
      steps++;
    }
  }
}
