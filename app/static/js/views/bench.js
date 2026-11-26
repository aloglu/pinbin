// Bench screen: interactive board pinouts, breadboard, resistor bands, multimeter dial, calculators, and bin QR labels.
import { state, esc, partById, isGuest } from '../state.js';
import { secBarHtml } from '../secbar.js';

const PK = {
  pwr: ['var(--v5)', 'Power in'],
  v33: ['var(--v33)', '3.3 V out'],
  gnd: ['var(--ink)', 'Ground'],
  io: ['var(--i2c)', 'Free to use'],
  inp: ['var(--spi)', 'Input only'],
  strap: ['var(--check)', 'Careful at start-up'],
  ser: ['var(--ink-3)', 'USB link'],
  ctrl: ['var(--ink-3)', 'Control'],
};

const BUILTIN_BOARDS = {
  c3: {
    title: 'ESP32-C3 SuperMini',
    chip: 'ESP32-C3',
    usb: 'top',
    L: [
      ['GPIO5', 'io', 'ADC. SPI MISO. Can wake the chip from deep sleep.'],
      ['GPIO6', 'io', 'General use / SPI MOSI.'],
      ['GPIO7', 'io', 'General use / SPI SS.'],
      ['GPIO8', 'strap', 'On-board LED. Default I2C SDA. Strapping pin.'],
      ['GPIO9', 'strap', 'BOOT button. Default I2C SCL. Strapping pin.'],
      ['GPIO10', 'io', 'General use.'],
      ['GPIO20', 'io', 'UART0 RX.'],
      ['GPIO21', 'io', 'UART0 TX.'],
    ],
    R: [
      ['5V', 'pwr', 'Power in, from USB or battery. Has a regulator behind it.'],
      ['GND', 'gnd', 'Ground.'],
      ['3V3', 'v33', '3.3 V out from the regulator. About 500 mA max.'],
      ['GPIO4', 'io', 'ADC. SPI SCK. Can wake the chip from deep sleep.'],
      ['GPIO3', 'io', 'ADC. Can wake the chip from deep sleep.'],
      ['GPIO2', 'strap', 'ADC. Strapping pin: keep it free at power-on.'],
      ['GPIO1', 'io', 'ADC. Can wake the chip from deep sleep.'],
      ['GPIO0', 'io', 'ADC. Can wake the chip from deep sleep.'],
    ],
  },
  esp32: {
    title: 'ESP32 30-pin',
    chip: 'ESP-WROOM-32',
    usb: 'bottom',
    L: [
      ['EN', 'ctrl', 'Reset. Pull to GND to restart.'],
      ['GPIO36', 'inp', 'Input only (VP). ADC.'],
      ['GPIO39', 'inp', 'Input only (VN). ADC.'],
      ['GPIO34', 'inp', 'Input only. ADC.'],
      ['GPIO35', 'inp', 'Input only. ADC.'],
      ['GPIO32', 'io', 'ADC. Touch.'],
      ['GPIO33', 'io', 'ADC. Touch.'],
      ['GPIO25', 'io', 'DAC (real analogue out).'],
      ['GPIO26', 'io', 'DAC.'],
      ['GPIO27', 'io', 'General use.'],
      ['GPIO14', 'io', 'General use.'],
      ['GPIO12', 'strap', 'Strapping pin: must be LOW at power-on.'],
      ['GPIO13', 'io', 'General use.'],
      ['GND', 'gnd', 'Ground.'],
      ['VIN', 'pwr', '5 V in (or out from USB). Has a regulator behind it.'],
    ],
    R: [
      ['GPIO23', 'io', 'SPI MOSI.'],
      ['GPIO22', 'io', 'I2C SCL by default.'],
      ['GPIO1', 'ser', 'TX0: the USB link. Leave free.'],
      ['GPIO3', 'ser', 'RX0: the USB link. Leave free.'],
      ['GPIO21', 'io', 'I2C SDA by default.'],
      ['GPIO19', 'io', 'SPI MISO.'],
      ['GPIO18', 'io', 'SPI clock.'],
      ['GPIO5', 'strap', 'Strapping pin.'],
      ['GPIO17', 'io', 'UART2 TX.'],
      ['GPIO16', 'io', 'UART2 RX.'],
      ['GPIO4', 'io', 'General use.'],
      ['GPIO2', 'strap', 'Strapping pin. On-board LED on many boards.'],
      ['GPIO15', 'strap', 'Strapping pin.'],
      ['GND', 'gnd', 'Ground.'],
      ['3V3', 'v33', '3.3 V out.'],
    ],
  },
  pico2: {
    title: 'Raspberry Pi Pico 2',
    chip: 'RP2350',
    usb: 'top',
    L: [
      ['GP0', 'io', 'UART0 TX / I2C0 SDA / SPI0 RX.'],
      ['GP1', 'io', 'UART0 RX / I2C0 SCL / SPI0 CS.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP2', 'io', 'SPI0 SCK / I2C1 SDA.'],
      ['GP3', 'io', 'SPI0 TX / I2C1 SCL.'],
      ['GP4', 'io', 'I2C0 SDA / UART1 TX.'],
      ['GP5', 'io', 'I2C0 SCL / UART1 RX.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP6', 'io', 'General use / I2C1 SDA.'],
      ['GP7', 'io', 'General use / I2C1 SCL.'],
      ['GP8', 'io', 'UART1 TX / I2C0 SDA.'],
      ['GP9', 'io', 'UART1 RX / I2C0 SCL.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP10', 'io', 'SPI1 SCK / I2C1 SDA.'],
      ['GP11', 'io', 'SPI1 TX / I2C1 SCL.'],
      ['GP12', 'io', 'SPI1 RX / I2C0 SDA.'],
      ['GP13', 'io', 'SPI1 CS / I2C0 SCL.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP14', 'io', 'SPI1 SCK / I2C1 SDA.'],
      ['GP15', 'io', 'SPI1 TX / I2C1 SCL.'],
    ],
    R: [
      ['VBUS', 'pwr', '5 V straight from USB.'],
      ['VSYS', 'pwr', 'Main power input (1.8–5.5 V).'],
      ['GND', 'gnd', 'Ground.'],
      ['3V3_EN', 'ctrl', 'Pull LOW to turn off the 3.3 V regulator.'],
      ['3V3', 'v33', '3.3 V out (300 mA max).'],
      ['ADC_VREF', 'ctrl', 'Analog reference voltage.'],
      ['GP28', 'io', 'ADC2 (3.3 V max).'],
      ['GND', 'gnd', 'Analog ground (AGND).'],
      ['GP27', 'io', 'ADC1 / I2C1 SCL.'],
      ['GP26', 'io', 'ADC0 / I2C1 SDA.'],
      ['RUN', 'ctrl', 'Reset pin: pull LOW to restart.'],
      ['GP22', 'io', 'General use.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP21', 'io', 'I2C0 SCL.'],
      ['GP20', 'io', 'I2C0 SDA.'],
      ['GP19', 'io', 'SPI0 TX (MOSI) / I2C1 SCL.'],
      ['GP18', 'io', 'SPI0 SCK / I2C1 SDA.'],
      ['GND', 'gnd', 'Ground.'],
      ['GP17', 'io', 'SPI0 CS / UART0 RX.'],
      ['GP16', 'io', 'SPI0 RX (MISO) / UART0 TX.'],
    ],
  },
  uno: {
    title: 'Arduino Uno (5 V)',
    chip: 'ATmega328P',
    usb: 'top',
    L: [
      ['IOREF', 'v33', '5 V logic reference.'],
      ['RESET', 'ctrl', 'Pull LOW to restart.'],
      ['3.3V', 'v33', '3.3 V out (50 mA max — too weak for Wi-Fi).'],
      ['5V', 'pwr', 'Regulated 5 V out (up to ~500 mA from USB).'],
      ['GND', 'gnd', 'Ground.'],
      ['GND', 'gnd', 'Ground.'],
      ['VIN', 'pwr', '7–12 V barrel / battery input to regulator.'],
      ['A0', 'io', 'Analog input 0 (0–5 V).'],
      ['A1', 'io', 'Analog input 1.'],
      ['A2', 'io', 'Analog input 2.'],
      ['A3', 'io', 'Analog input 3.'],
      ['A4', 'io', 'Analog 4 / I2C SDA.'],
      ['A5', 'io', 'Analog 5 / I2C SCL.'],
    ],
    R: [
      ['D13', 'io', 'SPI SCK + built-in LED.'],
      ['D12', 'io', 'SPI MISO.'],
      ['D11', 'io', 'PWM ~ / SPI MOSI.'],
      ['D10', 'io', 'PWM ~ / SPI SS.'],
      ['D9', 'io', 'PWM ~.'],
      ['D8', 'io', 'General digital I/O (5 V).'],
      ['D7', 'io', 'General digital I/O (5 V).'],
      ['D6', 'io', 'PWM ~.'],
      ['D5', 'io', 'PWM ~.'],
      ['D4', 'io', 'General digital I/O.'],
      ['D3', 'io', 'PWM ~ / Interrupt.'],
      ['D2', 'io', 'Interrupt pin.'],
      ['D1', 'ser', 'TX: USB serial link. Leave free.'],
      ['D0', 'ser', 'RX: USB serial link. Leave free.'],
    ],
  },
};

function boardMatchKey(name) {
  const low = String(name || '').toLowerCase();
  if (low.includes('esp32-c3')) return 'c3';
  if (low.includes('esp32') || low.includes('esp-32')) return 'esp32';
  if (low.includes('pico') || low.includes('rp2350') || low.includes('rp2040')) return 'pico2';
  if (low.includes('uno') || low.includes('atmega328')) return 'uno';
  return '';
}

function buildToolCatalog() {
  const catalog = {};
  const addedBoards = new Set();

  // Discover boards from user's owned parts & shopping items
  const candidates = [
    ...(state.parts || [])
      .filter((p) => p.category === 'Microcontrollers' || p.pinout_svg)
      .map((p) => ({ src: p, tag: 'owned' })),
    ...(state.shopping || [])
      .filter((s) => s.category === 'Microcontrollers')
      .map((s) => ({ src: s, tag: 'buying' })),
  ];

  for (const { src, tag } of candidates) {
    if (src.pinout_svg) {
      const k = `part:${src.id}`;
      catalog[k] = {
        t: src.name,
        g: 'Boards',
        tag,
        d: 'Assistant-supplied board pinout diagram.',
        partId: src.id,
      };
      addedBoards.add(boardMatchKey(src.name));
      continue;
    }
    const bk = boardMatchKey(src.name);
    if (bk && BUILTIN_BOARDS[bk] && !addedBoards.has(bk)) {
      addedBoards.add(bk);
      catalog[bk] = {
        t: BUILTIN_BOARDS[bk].title,
        g: 'Boards',
        tag,
        d: 'Tap a pin to see what it does and what your projects use it for.',
      };
    }
  }

  // Fallback so Boards is never empty
  if (!Object.values(catalog).some((t) => t.g === 'Boards')) {
    catalog.c3 = {
      t: BUILTIN_BOARDS.c3.title,
      g: 'Boards',
      tag: '',
      d: 'Tap a pin to see what it does.',
    };
  }

  // Guides
  catalog.bb = {
    t: 'Breadboard',
    g: 'Guides',
    d: 'Tap a hole to see which other holes it connects to inside the board.',
  };
  catalog.res = {
    t: 'Resistor bands',
    g: 'Guides',
    d: 'Pick the colours you see. Read from the end where the bands sit closest together.',
  };
  catalog.dmm = {
    t: 'Multimeter dial',
    g: 'Guides',
    tag: 'UT33D+',
    d: 'Pick what you want to check. The dial shows where to turn it, and where the leads go.',
  };

  // Calculators
  catalog.led = { t: 'LED resistor', g: 'Calculators', d: 'Works out the resistor an LED needs.' };
  catalog.div = { t: 'Voltage divider', g: 'Calculators', d: 'Works out the voltage between two resistors.' };
  catalog.ohm = { t: 'Ohm’s law', g: 'Calculators', d: 'Enter two of volts, amps and ohms; get the third.' };
  catalog.batt = { t: 'Battery life', g: 'Calculators', d: 'How long a battery lasts at a given current.' };

  // Labels (owner-only workshop QR sticker printing)
  if (!isGuest()) {
    catalog.qr = {
      t: 'Bin QR labels',
      g: 'Labels',
      d: 'Print QR labels for your storage bins. Scanning one opens Inventory filtered to that bin.',
    };
  }

  return catalog;
}

function projectPinUsageForBoard(boardKey) {
  const usage = {};
  let projName = '';
  for (const pr of state.projects || []) {
    if (pr.archived) continue;
    const mcu = (pr.items || []).find(
      (it) => (it.role === 'mcu' || it.category === 'Microcontrollers') && boardMatchKey(it.name) === boardKey
    );
    if (!mcu) continue;
    projName = pr.name;
    for (const net of pr.nets || []) {
      const mConn = (net.conns || []).find(([r]) => r === mcu.ref);
      if (!mConn || !mConn[1]) continue;
      // Split composite labels like GPIO4/6/7 or GPIO8/9
      const rawPin = String(mConn[1]);
      const pins = [];
      if (/^GPIO\d+(\/\d+)+$/i.test(rawPin)) {
        rawPin
          .slice(4)
          .split('/')
          .forEach((num) => pins.push(`GPIO${num}`));
      } else {
        pins.push(rawPin);
      }
      pins.forEach((p) => {
        usage[p] = net.name || 'used';
      });
    }
    break;
  }
  return { projName, usage };
}

function renderBoardTool(id, toolDef) {
  if (id.startsWith('part:')) {
    const p = partById(toolDef.partId);
    if (!p || !p.pinout_svg) return '<p class="faint">No pinout SVG attached yet.</p>';
    return `<figure class="pinout"><div class="pinout-art">${p.pinout_svg}</div></figure>`;
  }

  const b = BUILTIN_BOARDS[id];
  if (!b) return '';
  const { projName, usage } = projectPinUsageForBoard(id);
  const n = Math.max(b.L.length, b.R.length);
  const top = b.usb === 'top';
  const H = (top ? 70 : 40) + n * 30 + (top ? 20 : 50);
  const all = [...b.L.map((p, i) => [...p, 'L', i]), ...b.R.map((p, i) => [...p, 'R', i])];
  const cur = all.find((p) => `${id}:${p[0]}:${p[3]}:${p[4]}` === state.bench.pin);

  const art = (compact) => {
    const boardY = top ? 50 : 20;
    const boardH = n * 30 + 10;
    const chipY = Math.round(boardY + (boardH - 66) / 2);
    const pin = (side, i, [nm, k]) => {
      const y = (top ? 70 : 40) + i * 30;
      const x = side === 'L' ? 150 : 330;
      const key = `${id}:${nm}:${side}:${i}`;
      const on = state.bench.pin === key;
      const u = usage[nm] || '';
      const leftEdge = compact ? 52 : -66;
      const rightEdge = compact ? 428 : 546;
      const rx = side === 'L' ? leftEdge : x - 14;
      const rw = side === 'L' ? x + 14 - leftEdge : rightEdge - (x - 14);
      const labelX = side === 'L' ? 118 : 362;
      const useX = side === 'L' ? 46 : 434;
      const col = PK[k][0];
      const pillW = Math.round(nm.length * 7.5 + 14);
      const pillX = side === 'L' ? 125 - pillW : 355;
      return `<g class="bp${on ? ' on' : ''}" data-pin="${esc(key)}" style="--pc:${col}" role="button" tabindex="0" aria-label="${esc(nm)}${
        u ? `: ${esc(u)}` : ''
      }">
        <rect class="bp-hit" x="${rx}" y="${y - 14}" width="${rw}" height="28" fill="transparent"/>
        <rect class="bp-pill" x="${pillX}" y="${y - 11}" width="${pillW}" height="22" rx="5"/>
        ${on ? `<circle class="bp-halo" cx="${x}" cy="${y}" r="12.5"/>` : ''}
        <circle class="bp-pad" cx="${x}" cy="${y}" r="8.5" fill="${on ? col : 'var(--raised)'}" stroke="${col}" stroke-width="2.2"/>
        ${on ? `<circle class="bp-core" cx="${x}" cy="${y}" r="3"/>` : ''}
        <text x="${labelX}" y="${y + 4}" text-anchor="${
        side === 'L' ? 'end' : 'start'
      }" class="bn">${esc(nm)}</text>
        ${
          u && !compact
            ? `<text x="${useX}" y="${y + 4}" text-anchor="${
                side === 'L' ? 'end' : 'start'
              }" class="bu">${esc(u)}</text>`
            : ''
        }
      </g>`;
    };
    const vb = compact ? `48 0 384 ${H}` : `-70 0 620 ${H}`;
    return `<svg viewBox="${vb}" class="board2 ${compact ? 'compact' : 'wide'}" role="img" aria-label="${esc(
      b.title
    )} pinout">
      <rect x="130" y="${boardY}" width="220" height="${boardH}" rx="10" fill="var(--surface)" stroke="var(--ink-3)" stroke-width="1.4"/>
      <rect x="210" y="${top ? 34 : n * 30 + 22}" width="60" height="26" rx="5" fill="var(--bg)" stroke="var(--ink-3)"/>
      <text x="240" y="${top ? 51 : n * 30 + 39}" text-anchor="middle" class="bu">USB</text>
      <rect x="195" y="${chipY}" width="90" height="66" rx="4" fill="var(--bg)" stroke="var(--ink-3)"/>
      <text x="240" y="${chipY + 37}" text-anchor="middle" class="bu">${esc(b.chip)}</text>
      ${b.L.map((p, i) => pin('L', i, p)).join('')}
      ${b.R.map((p, i) => pin('R', i, p)).join('')}
    </svg>`;
  };

  const used = all.filter((p) => usage[p[0]]);
  return `<figure class="pinout">
      <div class="pinout-art">${art(false)}${art(true)}</div>
      <figcaption class="legend2">${[...new Set(all.map((p) => p[1]))]
        .map((k) => `<span><i style="border-color:${PK[k][0]}"></i>${PK[k][1]}</span>`)
        .join('')}<span class="faint">Top view · chip facing up</span></figcaption>
    </figure>
    <div class="readout">${
      cur
        ? `<div class="ro-h"><b class="mono">${esc(cur[0])}</b><span class="dim">${PK[cur[1]][1]}</span></div>
           <p>${esc(cur[2])}</p>
           ${
             projName
               ? `<p>${
                   usage[cur[0]]
                     ? `In ${esc(projName)}: <b>${esc(usage[cur[0]])}</b>`
                     : `<span class="faint">Not used in ${esc(projName)}.</span>`
                 }</p>`
               : ''
           }`
        : '<span class="faint">Tap any pin on the board to see what it does.</span>'
    }</div>
    ${
      used.length
        ? `<h3 class="tool-sub">Used in ${esc(projName)}</h3>
           <div class="lgroup pinlist">${used
             .map(
               (p) =>
                 `<button type="button" class="li ${`${id}:${p[0]}:${p[3]}` === state.bench.pin ? 'on' : ''}" data-pin="${esc(
                   `${id}:${p[0]}:${p[3]}`
                 )}"><span class="pdot" style="border-color:${PK[p[1]][0]}"></span><span class="lt"><b class="mono">${esc(
                   p[0]
                 )}</b><span>${esc(usage[p[0]])}</span></span></button>`
             )
             .join('')}</div>`
        : ''
    }`;
}

function renderBreadboardTool() {
  const mini = (state.bench.bb || 'mini') === 'mini';
  const cols = mini ? 17 : 30;
  const P = 16;
  const x0 = 40;
  const rowsY = (r) => (mini ? 40 : 76) + (r < 5 ? r : r + 1.4) * P;
  const hot = state.bench.bbHot || '';

  let holes = '';
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 10; r++) {
      const grp = `t${c}${r < 5 ? 'a' : 'f'}`;
      holes += `<rect class="hole ${hot === grp ? 'on' : ''}" data-bb="${grp}" x="${x0 + c * P - 4}" y="${
        rowsY(r) - 4
      }" width="8" height="8" rx="1.5"/>`;
    }
  }

  let rails = '';
  if (!mini) {
    [
      ['r1', 22, '+', 'var(--v5)'],
      ['r2', 38, '−', 'var(--ink-3)'],
      ['r3', 76 + 11.4 * P + 18, '+', 'var(--v5)'],
      ['r4', 76 + 11.4 * P + 34, '−', 'var(--ink-3)'],
    ].forEach(([id, y, sym, col]) => {
      rails += `<text x="${x0 - 22}" y="${y + 4}" class="bn" style="fill:${col}">${sym}</text>`;
      for (let c2 = 0; c2 < cols; c2++) {
        if (c2 % 6 === 5) continue;
        rails += `<rect class="hole ${hot === id ? 'on' : ''}" data-bb="${id}" x="${x0 + c2 * P - 4}" y="${
          y - 4
        }" width="8" height="8" rx="1.5"/>`;
      }
    });
  }

  const W = x0 + cols * P + 20;
  const H = mini ? 40 + 11.4 * P + 20 : 76 + 11.4 * P + 60;
  const lab =
    'abcdefghij'
      .split('')
      .map((ch, r) => `<text x="${x0 - 22}" y="${rowsY(r) + 4}" class="bu">${ch}</text>`)
      .join('') +
    Array.from({ length: cols }, (_, c) =>
      c % 5 === 0 || c === cols - 1
        ? `<text x="${x0 + c * P}" y="${(mini ? 40 : 76) - 14}" text-anchor="middle" class="bu">${c + 1}</text>`
        : ''
    ).join('');

  const msg = !hot
    ? 'Tap any hole.'
    : hot.startsWith('t')
    ? `Column ${parseInt(hot.slice(1), 10) + 1}, rows ${
        hot.endsWith('a') ? 'a–e' : 'f–j'
      } are joined. Anything plugged into these 5 holes is connected. The middle gap separates them from rows ${
        hot.endsWith('a') ? 'f–j' : 'a–e'
      }.`
    : `This whole rail is joined along the board. Use it for ${
        hot === 'r1' || hot === 'r3' ? 'power (+)' : 'ground (−)'
      }. Some long boards split the rail in the middle: check with the multimeter.`;

  return `<div class="ctl" style="margin-bottom:12px">
      <div class="tabs" role="group" aria-label="Board">
        <button type="button" data-bbk="mini" aria-pressed="${mini}">Mini · 170</button>
        <button type="button" data-bbk="half" aria-pressed="${!mini}">Half · 400</button>
      </div>
      <span class="faint">${
        mini
          ? '17 columns, no power rails — like your yellow, red and green mini breadboards.'
          : '30 columns and top/bottom power rails — like your 400-point breadboards.'
      }</span>
    </div>
    <div class="tool-fig"><svg viewBox="0 0 ${W} ${H}" class="bbsvg" role="img" aria-label="Breadboard">
      <rect x="${x0 - 34}" y="${mini ? 14 : 6}" width="${W - x0 + 26}" height="${H - (mini ? 20 : 12)}" rx="8" fill="var(--surface)" stroke="var(--ink-3)"/>
      <rect x="${x0 - 10}" y="${rowsY(4) + 8}" width="${cols * P + 4}" height="${P * 1.4 - 14}" rx="2" fill="var(--bg)"/>
      ${lab}${holes}${rails}
    </svg></div>
    <div class="readout">${msg}</div>`;
}

const BANDS = [
  ['black', '#111', 0],
  ['brown', '#7a4a21', 1],
  ['red', '#d6322c', 2],
  ['orange', '#f07a1a', 3],
  ['yellow', '#f2cf1d', 4],
  ['green', '#2e9a50', 5],
  ['blue', '#2f5bd3', 6],
  ['violet', '#7c4ddb', 7],
  ['grey', '#8a8c8f', 8],
  ['white', '#f4f4f2', 9],
];

const ohmFmt = (v) =>
  v >= 1e6 ? `${+(v / 1e6).toFixed(2)} MΩ` : v >= 1e3 ? `${+(v / 1e3).toFixed(2)} kΩ` : `${+v.toFixed(1)} Ω`;

function renderResistorTool() {
  const [a, b2, m] = state.bench.res;
  const val = (BANDS[a][2] * 10 + BANDS[b2][2]) * Math.pow(10, BANDS[m][2]);
  const presets = [
    ['2.4 kΩ', [2, 4, 2], 'TP4056 charge resistor · Smartwatch'],
    ['220 Ω', [2, 2, 1], 'LED current-limiting resistor'],
    ['1 kΩ', [1, 0, 2], 'Voltage divider top (5 V → 3.3 V)'],
    ['2 kΩ', [2, 0, 2], 'Voltage divider bottom (5 V → 3.3 V)'],
    ['10 kΩ', [1, 0, 3], 'Pull-up / pull-down resistor'],
  ];

  return `<div class="tool-fig"><svg viewBox="0 0 420 90" class="ressvg" role="img" aria-label="4-band resistor">
      <line x1="0" y1="45" x2="420" y2="45" stroke="var(--ink-3)" stroke-width="4"/>
      <rect x="100" y="18" width="220" height="54" rx="26" fill="#D9C49A"/>
      ${[a, b2, m].map((c, i) => `<rect x="${140 + i * 36}" y="18" width="16" height="54" fill="${BANDS[c][1]}"/>`).join('')}
      <rect x="280" y="18" width="16" height="54" fill="#C9A441"/>
    </svg></div>
    <div class="bigval num">${ohmFmt(val)} <span class="faint" style="font-size:14px">±5%</span></div>
    <div class="rb">${['1st digit', '2nd digit', 'Multiplier']
      .map(
        (lab, bi) =>
          `<div class="rcol"><span class="k">${lab}</span>${BANDS.map(
            ([nm, c], ci) =>
              `<button class="sw" type="button" data-band="${bi}:${ci}" aria-pressed="${
                state.bench.res[bi] === ci
              }"><i style="background:${c}"></i>${nm}</button>`
          ).join('')}</div>`
      )
      .join('')}</div>
    <h3 class="tool-sub">Common values</h3>
    <div class="lgroup">${presets
      .map(
        ([t, v, why]) =>
          `<button class="li" type="button" data-rpre="${v.join(',')}"><span class="lt"><b class="num">${t}</b><span>${esc(
            why
          )}</span></span><span class="faint">Set bands</span></button>`
      )
      .join('')}</div>`;
}

const DIAL = [
  ['off', 'OFF', 0, 'Turn it off when you finish. The battery lasts much longer.', '', ''],
  [
    'vdc',
    'V⎓',
    -60,
    'Measures DC voltage: batteries, USB, your 3.3 V and 5 V rails.',
    'Red lead in VΩ, black in COM. Touch red to the point, black to GND.',
    'Start on the 20 V range for 3.3 V and 5 V circuits.',
  ],
  [
    'vac',
    'V~',
    -100,
    'Measures AC voltage, like mains. You will not need it for these projects.',
    'Red in VΩ, black in COM.',
    'Do not measure mains yourself.',
  ],
  [
    'ohm',
    'Ω',
    40,
    'Measures resistance: check a resistor’s value.',
    'Red in VΩ, black in COM. Power must be OFF.',
    'Measuring a powered circuit gives wrong readings and can damage the meter.',
  ],
  [
    'cont',
    '·)))',
    80,
    'Beeps when two points connect: find broken wires, bad joints, or check a breadboard row. Also tests diodes.',
    'Red in VΩ, black in COM. Power must be OFF.',
    '',
  ],
  [
    'adc',
    'A⎓',
    120,
    'Measures current: how much your circuit draws (sleep current, for example).',
    'Move the red lead to the A or mA socket. The meter goes IN the wire, not across it.',
    'Move the red lead back to VΩ afterwards. Measuring voltage in the A socket shorts the circuit.',
  ],
  [
    'ncv',
    'NCV',
    160,
    'Beeps near a live mains wire without touching it.',
    'No leads needed.',
    'A silent NCV does not prove a wire is safe.',
  ],
];

const DTASKS = [
  ['Is my 3.3 V rail really 3.3 V?', 'vdc'],
  ['Is this battery charged?', 'vdc'],
  ['What value is this resistor?', 'ohm'],
  ['Is this wire or joint broken?', 'cont'],
  ['Which way round is this diode?', 'cont'],
  ['How much does the watch draw asleep?', 'adc'],
];

export function updateDmmDialInPlace(dialId, dtask) {
  const cur = DIAL.find((d) => d[0] === dialId) || DIAL[1];
  const ptr = document.querySelector('.dialsvg .ptr');
  if (!ptr) return false;
  ptr.style.transform = `rotate(${cur[2]}deg)`;
  document.querySelectorAll('.dialsvg .dpos').forEach((g) => {
    const on = g.dataset.dial === cur[0];
    const c = g.querySelector('circle');
    const t = g.querySelector('text');
    if (c) c.setAttribute('fill', on ? 'var(--ink)' : 'transparent');
    if (t) t.style.fill = on ? 'var(--bg)' : 'var(--ink)';
  });
  document.querySelectorAll('.dmm-side [data-dtask]').forEach((b) => {
    const on = dtask !== null && Number(b.dataset.dtask) === dtask;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  const ro = document.querySelector('.tool .readout');
  if (ro) {
    ro.innerHTML = `<div><b>${cur[1]}</b> <span class="dim">${esc(cur[3])}</span></div>
      ${cur[4] ? `<p>${esc(cur[4])}</p>` : ''}
      ${cur[5] ? `<p class="warnline"><span class="sev danger">!</span><span>${esc(cur[5])}</span></p>` : ''}`;
  }
  return true;
}

function renderDmmTool() {
  const cur = DIAL.find((d) => d[0] === (state.bench.dial || 'vdc')) || DIAL[1];
  return `<div class="dmm">
      <div class="tool-fig"><svg viewBox="0 0 260 260" class="dialsvg" role="img" aria-label="Multimeter dial">
        <circle cx="130" cy="130" r="118" fill="var(--surface)" stroke="var(--ink-3)"/>
        <circle cx="130" cy="130" r="46" fill="var(--raised)" stroke="var(--ink-3)" stroke-width="1.5"/>
        ${DIAL.map(([id, lab, ang]) => {
          const rad = ((ang - 90) * Math.PI) / 180;
          const x = 130 + Math.cos(rad) * 88;
          const y = 130 + Math.sin(rad) * 88;
          return `<g class="dpos" data-dial="${id}" role="button" tabindex="0">
            <circle cx="${x}" cy="${y}" r="20" fill="${cur[0] === id ? 'var(--ink)' : 'transparent'}"/>
            <text x="${x}" y="${y + 4}" text-anchor="middle" class="dl" style="fill:${
            cur[0] === id ? 'var(--bg)' : 'var(--ink)'
          }">${lab}</text>
          </g>`;
        }).join('')}
        <g class="ptr" style="transform:rotate(${cur[2]}deg);transform-origin:130px 130px">
          <rect x="125" y="62" width="10" height="70" rx="5" fill="var(--ink)"/>
        </g>
      </svg></div>
      <div class="dmm-side">
        <h3 class="tool-sub" style="margin-top:0">What do you want to check?</h3>
        <div class="lgroup">${DTASKS.map(
          ([t, d], i) =>
            `<button type="button" class="li ${state.bench.dtask === i ? 'on' : ''}" ${
              state.bench.dtask === i ? 'aria-current="true"' : ''
            } data-dial="${d}" data-dtask="${i}"><span class="lt"><b>${esc(t)}</b></span></button>`
        ).join('')}</div>
      </div>
    </div>
    <div class="readout">
      <div><b>${cur[1]}</b> <span class="dim">${esc(cur[3])}</span></div>
      ${cur[4] ? `<p>${esc(cur[4])}</p>` : ''}
      ${cur[5] ? `<p class="warnline"><span class="sev danger">!</span><span>${esc(cur[5])}</span></p>` : ''}
    </div>`;
}

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const nextE12 = (r) => {
  const d = Math.pow(10, Math.floor(Math.log10(r)));
  for (const e of E12) if (e * d >= r - 1e-9) return e * d;
  return 10 * d;
};

const numIn = (id, label, val, unit, step = 'any') =>
  `<label class="fld"><span>${esc(label)}</span><span class="inu"><input id="${id}" type="number" inputmode="decimal" step="${step}" value="${esc(
    val
  )}" data-calc="${id}"><em>${esc(unit)}</em></span></label>`;

export function computeCalcOutputs(id) {
  const c = state.bench.calc;
  if (id === 'led') {
    const r = Math.max(0, (c.ledV - c.ledVf) / Math.max(0.0001, c.ledI / 1000));
    const e = r > 0 ? nextE12(r) : 0;
    const p = (c.ledI / 1000) ** 2 * e * 1000;
    return [
      r > 0 ? ohmFmt(e) : '—',
      r > 0
        ? `Exact: ${ohmFmt(r)}. Use the next standard value up: ${ohmFmt(e)}. It wastes ${p.toFixed(0)} mW; a 1/4 W resistor is fine.`
        : 'The supply must be higher than the LED voltage.',
    ];
  }
  if (id === 'div') {
    const denom = Number(c.dR1) + Number(c.dR2);
    const v = denom > 0 ? (Number(c.dVin) * Number(c.dR2)) / denom : 0;
    const safe = v <= 3.6;
    return [
      `${v.toFixed(2)} V`,
      safe
        ? '<span class="sev ok">✓</span> Safe for 3.3 V pins.'
        : '<span class="sev danger">!</span> Above 3.6 V: too high for a 3.3 V pin. Make R2 smaller or R1 bigger.',
    ];
  }
  if (id === 'ohm') {
    const sol = c.oSolve;
    const V = sol === 'V' ? (c.oI / 1000) * c.oR : c.oV;
    const I = sol === 'I' ? (c.oV / Math.max(0.0001, c.oR)) * 1000 : c.oI;
    const R = sol === 'R' ? c.oV / Math.max(0.000001, c.oI / 1000) : c.oR;
    return [
      sol === 'V' ? `${V.toFixed(2)} V` : sol === 'I' ? `${I.toFixed(1)} mA` : ohmFmt(R),
      `Power: ${(V * I).toFixed(0)} mW.`,
    ];
  }
  if (id === 'batt') {
    const h = (c.bCap / Math.max(0.0001, c.bMa)) * 0.85;
    return [
      h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} hours`,
      'Capacity ÷ current × 0.85, to allow for real-world losses.',
    ];
  }
  return ['—', ''];
}

function renderCalcTool(id) {
  const c = state.bench.calc;
  const [out1, out2] = computeCalcOutputs(id);

  if (id === 'led') {
    return `<div class="calc2">${numIn('ledV', 'Supply', c.ledV, 'V')}${numIn(
      'ledVf',
      'LED forward voltage',
      c.ledVf,
      'V'
    )}${numIn('ledI', 'Current', c.ledI, 'mA')}</div>
      <div class="ef tfield"><span>LED colour</span><div class="tabs" role="group" aria-label="LED colour">${[
        ['Red', 2.0],
        ['Yellow', 2.1],
        ['Green', 2.2],
        ['Blue / white', 3.0],
      ]
        .map(([t, v]) => `<button type="button" data-cset="ledVf:${v}" aria-pressed="${Number(c.ledVf) === v}">${t}</button>`)
        .join('')}</div></div>
      <div class="bigval num" id="calcOut">${out1}</div>
      <p class="dim" id="calcOut2">${out2}</p>`;
  }
  if (id === 'div') {
    return `<div class="calc2">${numIn('dVin', 'Voltage in', c.dVin, 'V')}${numIn(
      'dR1',
      'R1 (top)',
      c.dR1,
      'Ω',
      100
    )}${numIn('dR2', 'R2 (bottom)', c.dR2, 'Ω', 100)}</div>
      <div class="chips" style="margin:12px 0 4px">
        <span class="k">Presets</span>
        <button class="tag f" type="button" data-cset="dVin:5,dR1:1000,dR2:2000">HC-SR04 ECHO → ESP32</button>
        <button class="tag f" type="button" data-cset="dVin:4.2,dR1:100000,dR2:100000">Battery level · Smartwatch</button>
      </div>
      <div class="bigval num" id="calcOut">${out1}</div>
      <p class="dim" id="calcOut2">${out2}</p>`;
  }
  if (id === 'ohm') {
    const sol = c.oSolve;
    return `<div class="tabs" role="group" aria-label="Solve for" style="margin-bottom:12px">${[
      ['V', 'Volts'],
      ['I', 'Amps'],
      ['R', 'Ohms'],
    ]
      .map(([k2, t]) => `<button type="button" data-osolve="${k2}" aria-pressed="${sol === k2}">Find ${t.toLowerCase()}</button>`)
      .join('')}</div>
      <div class="calc2">${sol !== 'V' ? numIn('oV', 'Voltage', c.oV, 'V') : ''}${
      sol !== 'I' ? numIn('oI', 'Current', c.oI, 'mA') : ''
    }${sol !== 'R' ? numIn('oR', 'Resistance', c.oR, 'Ω') : ''}</div>
      <div class="bigval num" id="calcOut">${out1}</div>
      <p class="dim" id="calcOut2">${out2}</p>`;
  }
  if (id === 'batt') {
    return `<div class="calc2">${numIn('bCap', 'Battery', c.bCap, 'mAh')}${numIn(
      'bMa',
      'Average current',
      c.bMa,
      'mA'
    )}</div>
      <div class="ef tfield"><span>Fill in from Smartwatch</span><div class="presets">
        <button class="btn" type="button" data-cset="bCap:500,bMa:50">Screen on · 50 mA</button>
        <button class="btn" type="button" data-cset="bCap:500,bMa:4">Asleep, LEDs on · 4 mA</button>
        <button class="btn" type="button" data-cset="bCap:500,bMa:0.3">Asleep, LEDs off · 0.3 mA</button>
      </div></div>
      <div class="bigval num" id="calcOut">${out1}</div>
      <p class="dim" id="calcOut2">${out2}</p>`;
  }
  return '';
}

function renderQrLabelsTool() {
  const byBin = new Map();
  for (const p of state.parts || []) {
    const bin = (p.location || '').trim();
    if (!bin) continue;
    if (!byBin.has(bin)) byBin.set(bin, []);
    byBin.get(bin).push(p.name);
  }
  for (const extra of state.bench.qrExtra || []) {
    if (extra && !byBin.has(extra)) byBin.set(extra, []);
  }
  const bins = [...byBin.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const origin = location.origin;

  return `<div class="qr-bar">
      <form data-qrform style="display:flex;gap:8px;align-items:center">
        <input class="ei" name="bin" placeholder="Add label, e.g. A1" autocomplete="off" aria-label="New bin label">
        <button class="btn" type="submit">+ Add label</button>
      </form>
      <span style="flex:1"></span>
      <button class="btn ink" type="button" data-print-qr ${bins.length ? '' : 'disabled'}>Print labels</button>
    </div>
    ${
      bins.length
        ? `<div class="qrgrid">${bins
            .map(([bin, names]) => {
              const targetUrl = `${origin}/?bin=${encodeURIComponent(bin)}`;
              const qrSrc = `/api/qr?text=${encodeURIComponent(targetUrl)}`;
              return `<div class="qrcard">
                <div class="qrbox"><img src="${qrSrc}" alt="QR code for bin ${esc(bin)}" loading="lazy"></div>
                <div class="qrmeta">
                  <span class="k">Bin</span>
                  <span class="qrbin">${esc(bin)}</span>
                  <span class="qrsub">${
                    names.length ? `${names.length} part${names.length === 1 ? '' : 's'}` : 'Empty bin'
                  }</span>
                  ${names.length ? `<span class="qrsub faint">${esc(names.slice(0, 2).join(', '))}</span>` : ''}
                </div>
              </div>`;
            })
            .join('')}</div>`
        : `<div class="map-empty">
            <p>None of your parts have a bin assigned yet. Add a bin name above to preview a label, or assign bins to parts in Inventory.</p>
          </div>`
    }`;
}

export function renderBenchView() {
  const catalog = buildToolCatalog();
  const keys = Object.keys(catalog);
  const id = catalog[state.bench.tool] ? state.bench.tool : keys[0];
  state.bench.tool = id;
  const tl = catalog[id];

  const groups = ['Boards', 'Guides', 'Calculators', 'Labels'];
  const nav = `<nav class="tools2" aria-label="Tools">${groups
    .map((g) => {
      const entries = Object.entries(catalog).filter(([, t]) => t.g === g);
      if (!entries.length) return '';
      return `<div class="sh"><h2>${esc(g)}</h2></div>
        <div class="lgroup">${entries
          .map(
            ([k, t]) =>
              `<button type="button" class="tl li ${k === id ? 'on' : ''}" ${
                k === id ? 'aria-current="true"' : ''
              } data-tool="${esc(k)}"><span class="lt"><b>${esc(t.t)}</b></span>${
                t.tag ? `<span class="faint">${esc(t.tag)}</span>` : ''
              }</button>`
          )
          .join('')}</div>`;
    })
    .join('')}</nav>`;

  let body = '';
  if (tl.g === 'Boards') body = renderBoardTool(id, tl);
  else if (id === 'bb') body = renderBreadboardTool();
  else if (id === 'res') body = renderResistorTool();
  else if (id === 'dmm') body = renderDmmTool();
  else if (id === 'qr') body = renderQrLabelsTool();
  else body = renderCalcTool(id);

  const secItems = Object.entries(catalog).map(([k, t]) => [k, t.t, t.g]);

  return `<div class="screen full"><div class="work">
    <div class="pagehead">
      <h1>Bench</h1>
      <span class="sub">${isGuest() ? 'Boards, guides and calculators' : 'Boards, guides, calculators and bin labels'}</span>
    </div>
    ${secBarHtml('bench', secItems, id)}
    <div class="bench3">
      ${nav}
      <section class="tool">
        <div class="tool-h">
          <h2>${esc(tl.t)}</h2>
          <p class="dim">${esc(tl.d)}</p>
        </div>
        ${body}
      </section>
    </div>
  </div></div>`;
}
