'use strict';

/**
 * Pinbin Phase 3 — Workbench Mini-Calculators & Interactive SVG Guides
 * All instructional copy follows ASD-STE100 (Simplified Technical English).
 */

const wbState = {
  subTab: 'guides', // 'guides' | 'calculators' | 'compat' | 'labels'
  activeGuide: 'breadboard', // 'breadboard' | 'resistor' | 'multimeter' | 'boards'
  activeBoard: 'pico2', // 'pico2' | 'esp32' | 'uno'
  boardPinFilter: 'all', // 'all' | 'power' | 'i2c' | 'spi' | 'adc'
  selectedPinIdx: null,
  bbSplitRail: false,
  resistorBandsMode: 4, // 4 | 5
  resistorBands: [2, 2, 1, 10], // Red Red Brown Gold = 220Ω ±5%
  resistorBands5: [1, 0, 0, 2, 1], // Brown Black Black Red Brown = 10kΩ ±1%
  dmmMode: 'dcv', // 'dcv' | 'acv' | 'ohm' | 'cont' | 'dc10a'
  compatSelectedIds: [],
  compatSearch: '',
  compatAiResult: null,
  compatAiLoading: false,
  selectedBins: null, // null means all bins selected
};

const E12_STANDARD = [
  10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82,
  100, 120, 150, 180, 220, 270, 330, 390, 470, 560, 680, 820,
  1000, 1200, 1500, 1800, 2200, 2700, 3300, 3900, 4700, 5600, 6800, 8200,
  10000, 15000, 22000, 33000, 47000, 100000,
];

const RESISTOR_COLORS = [
  { name: 'Black', hex: '#18181B', digit: 0, mult: 1, tol: null },
  { name: 'Brown', hex: '#7C3F1D', digit: 1, mult: 10, tol: '±1%' },
  { name: 'Red', hex: '#DC2626', digit: 2, mult: 100, tol: '±2%' },
  { name: 'Orange', hex: '#EA580C', digit: 3, mult: 1000, tol: null },
  { name: 'Yellow', hex: '#EAB308', digit: 4, mult: 10000, tol: null },
  { name: 'Green', hex: '#16A34A', digit: 5, mult: 100000, tol: '±0.5%' },
  { name: 'Blue', hex: '#2563EB', digit: 6, mult: 1000000, tol: '±0.25%' },
  { name: 'Violet', hex: '#7C3AED', digit: 7, mult: 10000000, tol: '±0.1%' },
  { name: 'Grey', hex: '#6B7280', digit: 8, mult: null, tol: '±0.05%' },
  { name: 'White', hex: '#F3F4F6', digit: 9, mult: null, tol: null },
  { name: 'Gold', hex: '#CA8A04', digit: null, mult: 0.1, tol: '±5%' },
  { name: 'Silver', hex: '#9CA3AF', digit: null, mult: 0.01, tol: '±10%' },
];

function formatOhms(val) {
  if (!Number.isFinite(val) || val < 0) return '—';
  if (val >= 1e6) return `${+(val / 1e6).toFixed(2)} MΩ`;
  if (val >= 1e3) return `${+(val / 1e3).toFixed(2)} kΩ`;
  return `${+val.toFixed(1)} Ω`;
}

function nearestStandardResistor(ohms) {
  for (const std of E12_STANDARD) {
    if (std >= ohms) return std;
  }
  return E12_STANDARD[E12_STANDARD.length - 1];
}

// =============================================================================
// BOARD PINOUT DEFINITIONS (Accurate Beginner Reference)
// =============================================================================
const BOARD_DEFS = {
  pico2: {
    name: 'Raspberry Pi Pico / Pico 2',
    subtitle: 'RP2040 / RP2350 · 3.3V Logic · 40-Pin',
    matchKeywords: ['pico', 'rp2350', 'rp2040'],
    pcbFill: '#166534',
    pcbStroke: '#14532D',
    chipLabel: 'RP2350',
    left: [
      { pin: 1, name: 'GP0', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SDA / SPI0 RX / UART0 TX. 3.3V logic.' },
      { pin: 2, name: 'GP1', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SCL / SPI0 CSn / UART0 RX. 3.3V logic.' },
      { pin: 3, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V). Connect all circuit grounds here.' },
      { pin: 4, name: 'GP2', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SDA / SPI0 SCK. 3.3V logic.' },
      { pin: 5, name: 'GP3', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SCL / SPI0 TX. 3.3V logic.' },
      { pin: 6, name: 'GP4', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SDA / SPI0 RX. 3.3V logic.' },
      { pin: 7, name: 'GP5', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SCL / SPI0 CSn. 3.3V logic.' },
      { pin: 8, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 9, name: 'GP6', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SDA / SPI0 SCK. 3.3V logic.' },
      { pin: 10, name: 'GP7', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SCL / SPI0 TX. 3.3V logic.' },
      { pin: 11, name: 'GP8', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SDA / SPI1 RX. 3.3V logic.' },
      { pin: 12, name: 'GP9', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SCL / SPI1 CSn. 3.3V logic.' },
      { pin: 13, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 14, name: 'GP10', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SDA / SPI1 SCK. 3.3V logic.' },
      { pin: 15, name: 'GP11', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SCL / SPI1 TX. 3.3V logic.' },
      { pin: 16, name: 'GP12', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SDA / SPI1 RX. 3.3V logic.' },
      { pin: 17, name: 'GP13', roles: ['gpio', 'i2c', 'spi'], note: 'I2C0 SCL / SPI1 CSn. 3.3V logic.' },
      { pin: 18, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 19, name: 'GP14', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SDA / SPI1 SCK. 3.3V logic.' },
      { pin: 20, name: 'GP15', roles: ['gpio', 'i2c', 'spi'], note: 'I2C1 SCL / SPI1 TX. 3.3V logic.' },
    ],
    right: [
      { pin: 40, name: 'VBUS', roles: ['power'], color: '#DC2626', note: '5V power directly from the USB port.' },
      { pin: 39, name: 'VSYS', roles: ['power'], color: '#DC2626', note: 'Main system power input (1.8V to 5.5V).' },
      { pin: 38, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 37, name: '3V3_EN', roles: ['power'], color: '#D97706', note: 'Pull LOW to disable the onboard 3.3V regulator.' },
      { pin: 36, name: '3V3(OUT)', roles: ['power'], color: '#EA580C', note: 'Regulated 3.3V output (up to 300mA) for sensors.' },
      { pin: 35, name: 'ADC_VREF', roles: ['adc'], color: '#7C3AED', note: 'Analog reference voltage for ADC readings.' },
      { pin: 34, name: 'GP28', roles: ['gpio', 'adc'], color: '#16A34A', note: 'ADC2 analog input + GPIO. Max 3.3V input.' },
      { pin: 33, name: 'AGND', roles: ['power', 'adc'], color: '#374151', note: 'Clean analog ground reference.' },
      { pin: 32, name: 'GP27', roles: ['gpio', 'adc', 'i2c'], color: '#16A34A', note: 'ADC1 analog input / I2C1 SCL. Max 3.3V.' },
      { pin: 31, name: 'GP26', roles: ['gpio', 'adc', 'i2c'], color: '#16A34A', note: 'ADC0 analog input / I2C1 SDA. Max 3.3V.' },
      { pin: 30, name: 'RUN', roles: ['power'], color: '#D97706', note: 'Reset pin. Connect briefly to GND to restart.' },
      { pin: 29, name: 'GP22', roles: ['gpio'], note: 'General GPIO / PWM. 3.3V logic.' },
      { pin: 28, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 27, name: 'GP21', roles: ['gpio', 'i2c'], note: 'I2C0 SCL / General GPIO. 3.3V logic.' },
      { pin: 26, name: 'GP20', roles: ['gpio', 'i2c'], note: 'I2C0 SDA / General GPIO. 3.3V logic.' },
      { pin: 25, name: 'GP19', roles: ['gpio', 'i2c', 'spi'], note: 'SPI0 TX / I2C1 SCL. 3.3V logic.' },
      { pin: 24, name: 'GP18', roles: ['gpio', 'i2c', 'spi'], note: 'SPI0 SCK / I2C1 SDA. 3.3V logic.' },
      { pin: 23, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 22, name: 'GP17', roles: ['gpio', 'i2c', 'spi'], note: 'SPI0 CSn / I2C0 SCL. 3.3V logic.' },
      { pin: 21, name: 'GP16', roles: ['gpio', 'i2c', 'spi'], note: 'SPI0 RX / I2C0 SDA. 3.3V logic.' },
    ],
  },
  esp32: {
    name: 'ESP32 DevKit (30-Pin)',
    subtitle: 'ESP-WROOM-32 · 3.3V Logic · WiFi + BLE',
    matchKeywords: ['esp32', 'esp-32s', 'wroom'],
    pcbFill: '#1E222B',
    pcbStroke: '#374151',
    chipLabel: 'ESP-WROOM-32',
    left: [
      { pin: 1, name: 'EN', roles: ['power'], color: '#D97706', note: 'Reset / Enable pin. Pull LOW to reset the chip.' },
      { pin: 2, name: 'VP (G36)', roles: ['adc'], color: '#7C3AED', note: 'ADC1_0. Input ONLY (no output, no internal pull-up).' },
      { pin: 3, name: 'VN (G39)', roles: ['adc'], color: '#7C3AED', note: 'ADC1_3. Input ONLY (no output, no internal pull-up).' },
      { pin: 4, name: 'G34', roles: ['adc'], color: '#7C3AED', note: 'ADC1_6. Input ONLY. Safe while WiFi is active.' },
      { pin: 5, name: 'G35', roles: ['adc'], color: '#7C3AED', note: 'ADC1_7. Input ONLY. Safe while WiFi is active.' },
      { pin: 6, name: 'G32', roles: ['gpio', 'adc'], note: 'ADC1_4 + GPIO + PWM. Safe general pin.' },
      { pin: 7, name: 'G33', roles: ['gpio', 'adc'], note: 'ADC1_5 + GPIO + PWM. Safe general pin.' },
      { pin: 8, name: 'G25', roles: ['gpio', 'adc'], note: 'DAC1 / GPIO / PWM. Safe general pin.' },
      { pin: 9, name: 'G26', roles: ['gpio', 'adc'], note: 'DAC2 / GPIO / PWM. Safe general pin.' },
      { pin: 10, name: 'G27', roles: ['gpio'], note: 'General GPIO / PWM. Safe pin.' },
      { pin: 11, name: 'G14', roles: ['gpio', 'spi'], note: 'HSPI SCK / GPIO. Outputs brief PWM pulse at boot.' },
      { pin: 12, name: 'G12', roles: ['gpio', 'spi'], color: '#D97706', note: 'Strapping pin! Boot fails if pulled HIGH at startup.' },
      { pin: 13, name: 'G13', roles: ['gpio', 'spi'], note: 'HSPI MOSI / GPIO. Safe general pin.' },
      { pin: 14, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 15, name: 'VIN', roles: ['power'], color: '#DC2626', note: '5V power input (or 5V output when powered via USB).' },
    ],
    right: [
      { pin: 30, name: 'G23', roles: ['gpio', 'spi'], note: 'Default VSPI MOSI. Safe general pin.' },
      { pin: 29, name: 'G22', roles: ['gpio', 'i2c'], color: '#2563EB', note: 'Default I2C SCL pin. Safe general pin.' },
      { pin: 28, name: 'TX0', roles: ['gpio'], color: '#D97706', note: 'USB Serial TX. Avoid for sensors if using Serial Monitor.' },
      { pin: 27, name: 'RX0', roles: ['gpio'], color: '#D97706', note: 'USB Serial RX. Avoid for sensors if using Serial Monitor.' },
      { pin: 26, name: 'G21', roles: ['gpio', 'i2c'], color: '#2563EB', note: 'Default I2C SDA pin. Safe general pin.' },
      { pin: 25, name: 'G19', roles: ['gpio', 'spi'], note: 'Default VSPI MISO. Safe general pin.' },
      { pin: 24, name: 'G18', roles: ['gpio', 'spi'], note: 'Default VSPI SCK. Safe general pin.' },
      { pin: 23, name: 'G5', roles: ['gpio', 'spi'], note: 'Default VSPI CS. Safe general pin.' },
      { pin: 22, name: 'G17', roles: ['gpio'], note: 'UART2 TX / General GPIO.' },
      { pin: 21, name: 'G16', roles: ['gpio'], note: 'UART2 RX / General GPIO.' },
      { pin: 20, name: 'G4', roles: ['gpio'], note: 'General GPIO / PWM.' },
      { pin: 19, name: 'G2', roles: ['gpio'], note: 'Connected to onboard blue LED. Keep LOW during flashing.' },
      { pin: 18, name: 'G15', roles: ['gpio'], note: 'Strapping pin. Safe for outputs.' },
      { pin: 17, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 16, name: '3V3', roles: ['power'], color: '#EA580C', note: 'Regulated 3.3V output for sensors (max ~300mA).' },
    ],
  },
  uno: {
    name: 'Arduino Uno (ATmega328P)',
    subtitle: '5V Logic · Classic Beginner Board',
    matchKeywords: ['arduino', 'uno', 'ch340', 'atmega328p'],
    pcbFill: '#1D4ED8',
    pcbStroke: '#1E3A8A',
    chipLabel: 'ATmega328P',
    left: [
      { pin: 1, name: 'IOREF', roles: ['power'], color: '#D97706', note: 'Reference voltage (5V) for stacked shields.' },
      { pin: 2, name: 'RESET', roles: ['power'], color: '#D97706', note: 'Pull LOW to restart the Arduino.' },
      { pin: 3, name: '3.3V', roles: ['power'], color: '#EA580C', note: '3.3V output (low current, max 50mA).' },
      { pin: 4, name: '5V', roles: ['power'], color: '#DC2626', note: 'Regulated 5V output for sensors and displays.' },
      { pin: 5, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 6, name: 'GND', roles: ['power'], color: '#374151', note: 'Ground (0V).' },
      { pin: 7, name: 'VIN', roles: ['power'], color: '#DC2626', note: 'External battery input (7V to 12V DC).' },
      { pin: 8, name: 'A0', roles: ['adc', 'gpio'], color: '#7C3AED', note: 'Analog Input 0 (0–5V, 10-bit 0–1023).' },
      { pin: 9, name: 'A1', roles: ['adc', 'gpio'], color: '#7C3AED', note: 'Analog Input 1 (0–5V).' },
      { pin: 10, name: 'A2', roles: ['adc', 'gpio'], color: '#7C3AED', note: 'Analog Input 2 (0–5V).' },
      { pin: 11, name: 'A3', roles: ['adc', 'gpio'], color: '#7C3AED', note: 'Analog Input 3 (0–5V).' },
      { pin: 12, name: 'A4 (SDA)', roles: ['adc', 'i2c', 'gpio'], color: '#2563EB', note: 'I2C SDA data line + Analog Input 4.' },
      { pin: 13, name: 'A5 (SCL)', roles: ['adc', 'i2c', 'gpio'], color: '#2563EB', note: 'I2C SCL clock line + Analog Input 5.' },
    ],
    right: [
      { pin: 26, name: 'D13 (SCK)', roles: ['gpio', 'spi'], note: 'SPI SCK + Onboard LED. Flashes on reset.' },
      { pin: 25, name: 'D12 (MISO)', roles: ['gpio', 'spi'], note: 'SPI MISO / Digital I/O.' },
      { pin: 24, name: 'D11~ (MOSI)', roles: ['gpio', 'spi'], note: 'PWM (~) + SPI MOSI.' },
      { pin: 23, name: 'D10~ (SS)', roles: ['gpio', 'spi'], note: 'PWM (~) + SPI Chip Select (SS).' },
      { pin: 22, name: 'D9~', roles: ['gpio'], note: 'PWM (~) capable digital pin. Great for servos.' },
      { pin: 21, name: 'D8', roles: ['gpio'], note: 'Digital I/O pin.' },
      { pin: 20, name: 'D7', roles: ['gpio'], note: 'Digital I/O pin.' },
      { pin: 19, name: 'D6~', roles: ['gpio'], note: 'PWM (~) capable digital pin.' },
      { pin: 18, name: 'D5~', roles: ['gpio'], note: 'PWM (~) capable digital pin.' },
      { pin: 17, name: 'D4', roles: ['gpio'], note: 'Digital I/O pin.' },
      { pin: 16, name: 'D3~', roles: ['gpio'], note: 'PWM (~) + Hardware Interrupt 1.' },
      { pin: 15, name: 'D2', roles: ['gpio'], note: 'Digital I/O + Hardware Interrupt 0.' },
      { pin: 14, name: 'D0 / D1', roles: ['gpio'], color: '#D97706', note: 'USB Serial RX (D0) and TX (D1). Keep free during upload.' },
    ],
  },
};

const DMM_MODES = {
  dcv: {
    label: 'DC Voltage (V⎓)',
    angle: -60,
    redJack: 'voma',
    title: 'Measure DC Voltage (Batteries, 3.3V, 5V)',
    steps: 'Plug black probe into COM and red probe into VΩmA. Touch probes in parallel across the component or power rails.',
    caution: 'Select a range higher than your expected voltage (for example, 20V for 5V or 9V circuits).',
  },
  acv: {
    label: 'AC Voltage (V~)',
    angle: -20,
    redJack: 'voma',
    title: 'Measure AC Voltage (Wall Outlets, Transformers)',
    steps: 'Plug black probe into COM and red probe into VΩmA. Keep fingers behind the probe guards.',
    caution: 'Mains AC voltage is dangerous. Avoid testing wall outlets while you learn.',
  },
  ohm: {
    label: 'Resistance (Ω)',
    angle: 25,
    redJack: 'voma',
    title: 'Check Resistor Values',
    steps: 'Plug black probe into COM and red probe into VΩmA. Touch both legs of a loose resistor.',
    caution: 'Turn off circuit power and disconnect the resistor before you measure resistance.',
  },
  cont: {
    label: 'Continuity (🔊)',
    angle: 65,
    redJack: 'voma',
    title: 'Test Wires & Solder Joints (Beep Mode)',
    steps: 'Plug black probe into COM and red probe into VΩmA. Touch two points — a steady beep confirms an electrical connection.',
    caution: 'Turn off circuit power before you test continuity.',
  },
  dc10a: {
    label: 'High Current (10A)',
    angle: 115,
    redJack: '10a',
    title: 'Measure DC Current (In Series)',
    steps: 'Move the red probe to the 10A jack. Break the circuit so current flows through the meter.',
    caution: 'Move the red probe back to VΩmA immediately after testing. Probing voltage while in 10A blows the internal fuse.',
  },
};

// =============================================================================
// MAIN RENDER ENTRYPOINT
// =============================================================================
function renderWorkbench() {
  const root = document.getElementById('benchView');
  if (!root) return;

  const tabCls = (tab) => (wbState.subTab === tab ? 'pb-tab pb-tab-active' : 'pb-tab');

  let bodyHtml = '';
  if (wbState.subTab === 'guides') bodyHtml = renderInteractiveGuidesSection();
  else if (wbState.subTab === 'calculators') bodyHtml = renderCalculatorsSection();
  else if (wbState.subTab === 'compat') bodyHtml = renderCompatibilitySection();
  else bodyHtml = renderBinLabelsSection();

  root.innerHTML = `
    <div class="space-y-6">
      <div class="no-print">
        <h1 class="pb-page-title">Bench</h1>
        <p class="pb-page-lede">Guides, calculators, a wiring check and printable bin labels.</p>
        <div class="pb-tabs overflow-x-auto no-scrollbar mt-5">
          <button type="button" data-wb-sub="guides" class="${tabCls('guides')}">Guides</button>
          <button type="button" data-wb-sub="calculators" class="${tabCls('calculators')}">Calculators</button>
          <button type="button" data-wb-sub="compat" class="${tabCls('compat')}">Wiring check</button>
          <button type="button" data-wb-sub="labels" class="${tabCls('labels')}">Bin labels</button>
        </div>
      </div>

      ${bodyHtml}
    </div>
  `;

  root.querySelectorAll('button[data-wb-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.subTab = btn.dataset.wbSub;
      if (typeof window.syncBenchUrl === 'function') {
        window.syncBenchUrl(wbState.subTab);
      }
      renderWorkbench();
    });
  });

  if (wbState.subTab === 'guides') bindInteractiveGuideEvents();
  else if (wbState.subTab === 'calculators') bindCalculatorEvents();
  else if (wbState.subTab === 'compat') bindCompatibilityEvents();
  else bindBinLabelsEvents();
}

// =============================================================================
// 1. CALCULATORS SECTION
// =============================================================================
function renderCalculatorsSection() {
  return `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- LED Resistor Calculator -->
      <div class="elevated-card rounded-md bg-surface-light p-4 flex flex-col gap-3.5">
        <div>
          <h2 class="text-sm font-semibold text-ink">LED Resistor Calculator</h2>
          <p class="text-[11px] text-muted mt-0.5">Find the safe series resistor for a bare LED.</p>
        </div>

        <div class="grid grid-cols-2 gap-2.5 text-xs">
          <div>
            <label class="block text-[11px] text-muted mb-1">Supply (V)</label>
            <input id="calcLedVs" type="number" step="0.1" value="5" class="w-full h-8 px-2.5 font-mono rounded-md bg-canvas-light border border-hairline-light focus:outline-none focus:border-accent" />
          </div>
          <div>
            <label class="block text-[11px] text-muted mb-1">Current (mA)</label>
            <input id="calcLedMa" type="number" step="1" value="15" class="w-full h-8 px-2.5 font-mono rounded-md bg-canvas-light border border-hairline-light focus:outline-none focus:border-accent" />
          </div>
        </div>

        <div class="text-xs">
          <label class="block text-[11px] text-muted mb-1">LED Color (Forward Voltage)</label>
          <select id="calcLedVf" class="w-full h-8 px-2.5 rounded-md bg-canvas-light border border-hairline-light focus:outline-none focus:border-accent">
            <option value="2.0" selected>Red / Yellow (~2.0V)</option>
            <option value="2.1">Green (~2.1V)</option>
            <option value="3.1">Blue (~3.1V)</option>
            <option value="3.2">White (~3.2V)</option>
            <option value="1.2">Infrared IR (~1.2V)</option>
          </select>
        </div>

        <div id="calcLedResult" class="pb-well mt-auto rounded p-3 space-y-1"></div>
      </div>

      <!-- Voltage Divider Calculator -->
      <div class="elevated-card rounded-md p-4 flex flex-col gap-3.5">
        <div>
          <h2 class="text-sm font-semibold">Voltage Divider</h2>
          <p class="text-[11px] text-muted mt-0.5">Step a higher signal down to a safe pin voltage.</p>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <button type="button" data-vd-preset="5,1000,2000" class="btn-secondary h-6 px-2.5 rounded-md text-[10px] font-mono">5V → 3.3V (1k/2k)</button>
          <button type="button" data-vd-preset="9,10000,4700" class="btn-secondary h-6 px-2.5 rounded-md text-[10px] font-mono">9V → 2.9V (10k/4.7k)</button>
          <button type="button" data-vd-preset="12,10000,4700" class="btn-secondary h-6 px-2.5 rounded-md text-[10px] font-mono">12V → 3.8V</button>
        </div>

        <div class="grid grid-cols-3 gap-2 text-xs">
          <div>
            <label class="block text-[11px] text-muted mb-1">Vin (V)</label>
            <input id="calcVdVin" type="number" step="0.1" value="5" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
          <div>
            <label class="block text-[11px] text-muted mb-1">R1 Top (Ω)</label>
            <input id="calcVdR1" type="number" step="100" value="1000" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
          <div>
            <label class="block text-[11px] text-muted mb-1">R2 GND (Ω)</label>
            <input id="calcVdR2" type="number" step="100" value="2000" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
        </div>

        <div id="calcVdResult" class="pb-well mt-auto rounded p-3 space-y-1"></div>
      </div>

      <!-- Ohm's Law Calculator -->
      <div class="elevated-card rounded-md p-4 flex flex-col gap-3.5">
        <div>
          <h2 class="text-sm font-semibold">Ohm's Law (V = I × R)</h2>
          <p class="text-[11px] text-muted mt-0.5">Enter any two values. Leave the unknown box blank.</p>
        </div>

        <div class="grid grid-cols-3 gap-2 text-xs">
          <div>
            <label class="block text-[11px] text-muted mb-1">Voltage (V)</label>
            <input id="calcOhmV" type="number" step="0.1" value="5" placeholder="?" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
          <div>
            <label class="block text-[11px] text-muted mb-1">Current (mA)</label>
            <input id="calcOhmI" type="number" step="1" value="" placeholder="?" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
          <div>
            <label class="block text-[11px] text-muted mb-1">Resistance (Ω)</label>
            <input id="calcOhmR" type="number" step="10" value="220" placeholder="?" class="w-full h-8 px-2 font-mono rounded-md" />
          </div>
        </div>

        <div id="calcOhmResult" class="pb-well mt-auto rounded p-3 space-y-1"></div>
      </div>
    </div>
  `;
}

function updateLedCalc() {
  const vs = parseFloat(document.getElementById('calcLedVs').value);
  const ma = parseFloat(document.getElementById('calcLedMa').value);
  const vf = parseFloat(document.getElementById('calcLedVf').value);
  const out = document.getElementById('calcLedResult');
  if (!Number.isFinite(vs) || !Number.isFinite(ma) || ma <= 0) {
    out.innerHTML = `<p class="text-xs text-muted">Enter valid numbers.</p>`;
    return;
  }
  if (vs <= vf) {
    out.innerHTML = `<p class="text-xs text-stop">Supply voltage must be higher than LED forward voltage (${vf}V).</p>`;
    return;
  }
  const exact = (vs - vf) / (ma / 1000);
  const std = nearestStandardResistor(exact);
  const actualMa = ((vs - vf) / std) * 1000;
  const mw = (vs - vf) * actualMa;
  out.innerHTML = `
    <div class="flex items-baseline justify-between">
      <span class="text-[11px] text-muted">Use standard resistor</span>
      <span class="font-mono text-base font-semibold text-accent">${formatOhms(std)}</span>
    </div>
    <p class="text-[11px] text-muted">Exact: ${formatOhms(exact)} · Actual: ${actualMa.toFixed(1)} mA · Power: ${mw.toFixed(0)} mW (${mw < 200 ? '1/4W safe' : 'use 1/2W+'})</p>
  `;
}

function updateVdCalc() {
  const vin = parseFloat(document.getElementById('calcVdVin').value);
  const r1 = parseFloat(document.getElementById('calcVdR1').value);
  const r2 = parseFloat(document.getElementById('calcVdR2').value);
  const out = document.getElementById('calcVdResult');
  if (!Number.isFinite(vin) || !Number.isFinite(r1) || !Number.isFinite(r2) || r1 + r2 <= 0) {
    out.innerHTML = `<p class="text-xs text-muted">Enter valid resistor values.</p>`;
    return;
  }
  const vout = vin * (r2 / (r1 + r2));
  const ma = (vin / (r1 + r2)) * 1000;
  const safe33 = vout <= 3.45;
  out.innerHTML = `
    <div class="flex items-baseline justify-between">
      <span class="text-[11px] text-muted">Output (Vout)</span>
      <span class="font-mono text-base font-semibold ${safe33 ? 'text-go' : 'text-stop'}">${vout.toFixed(2)} V</span>
    </div>
    <p class="text-[11px] text-muted">Draw: ${ma.toFixed(2)} mA · ${safe33 ? 'Safe for 3.3V GPIO pins.' : 'Above 3.3V — check board rating.'}</p>
  `;
}

function updateOhmCalc() {
  const vRaw = document.getElementById('calcOhmV').value.trim();
  const iRaw = document.getElementById('calcOhmI').value.trim();
  const rRaw = document.getElementById('calcOhmR').value.trim();
  const out = document.getElementById('calcOhmResult');

  const v = vRaw !== '' ? parseFloat(vRaw) : null;
  const iMa = iRaw !== '' ? parseFloat(iRaw) : null;
  const r = rRaw !== '' ? parseFloat(rRaw) : null;
  const filled = [v, iMa, r].filter((x) => x !== null && Number.isFinite(x)).length;

  if (filled < 2) {
    out.innerHTML = `<p class="text-xs text-muted">Fill in any two boxes to calculate the third.</p>`;
    return;
  }

  let resV = v, resI = iMa, resR = r;
  if (resV === null) resV = (resI / 1000) * resR;
  else if (resI === null && resR > 0) resI = (resV / resR) * 1000;
  else if (resR === null && resI > 0) resR = resV / (resI / 1000);

  if (!Number.isFinite(resV) || !Number.isFinite(resI) || !Number.isFinite(resR)) {
    out.innerHTML = `<p class="text-xs text-amber-500">Values must be greater than zero.</p>`;
    return;
  }
  const mw = resV * resI;
  out.innerHTML = `
    <div class="grid grid-cols-3 gap-2 font-mono text-xs">
      <div><span class="block text-[10px] text-muted">V</span>${resV.toFixed(2)} V</div>
      <div><span class="block text-[10px] text-muted">I</span>${resI.toFixed(1)} mA</div>
      <div><span class="block text-[10px] text-muted">R</span>${formatOhms(resR)}</div>
    </div>
    <p class="text-[11px] text-muted">Power: ${mw >= 1000 ? (mw / 1000).toFixed(2) + ' W' : mw.toFixed(1) + ' mW'}</p>
  `;
}

function bindCalculatorEvents() {
  ['calcLedVs', 'calcLedMa', 'calcLedVf'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateLedCalc);
  });
  ['calcVdVin', 'calcVdR1', 'calcVdR2'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateVdCalc);
  });
  document.querySelectorAll('button[data-vd-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [vin, r1, r2] = btn.dataset.vdPreset.split(',');
      document.getElementById('calcVdVin').value = vin;
      document.getElementById('calcVdR1').value = r1;
      document.getElementById('calcVdR2').value = r2;
      updateVdCalc();
    });
  });
  ['calcOhmV', 'calcOhmI', 'calcOhmR'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateOhmCalc);
  });

  updateLedCalc();
  updateVdCalc();
  updateOhmCalc();
}

// =============================================================================
// 2. INTERACTIVE SVG GUIDES SECTION
// =============================================================================
function detectInventoryBoards() {
  const parts = (typeof state !== 'undefined' && Array.isArray(state.parts)) ? state.parts : [];
  const allText = parts.map((p) => `${p.name} ${p.subtitle}`.toLowerCase()).join(' ');
  const owned = {};
  for (const [key, def] of Object.entries(BOARD_DEFS)) {
    owned[key] = def.matchKeywords.some((kw) => allText.includes(kw));
  }
  return owned;
}

function renderInteractiveGuidesSection() {
  const tabs = [
    { id: 'breadboard', label: 'Breadboard Rails' },
    { id: 'resistor', label: 'Resistor Bands' },
    { id: 'multimeter', label: 'Multimeter Dial' },
    { id: 'boards', label: 'Board Pinouts' },
  ];

  const tabHtml = tabs
    .map((t) => {
      const act = wbState.activeGuide === t.id;
      return `<button type="button" data-wb-guide="${t.id}" aria-pressed="${act}" class="pb-toggle-chip h-7 px-3 rounded text-xs font-medium whitespace-nowrap">${t.label}</button>`;
    })
    .join('');

  let bodyHtml = '';
  if (wbState.activeGuide === 'breadboard') bodyHtml = renderBreadboardGuide();
  else if (wbState.activeGuide === 'resistor') bodyHtml = renderResistorGuide();
  else if (wbState.activeGuide === 'multimeter') bodyHtml = renderMultimeterGuide();
  else bodyHtml = renderBoardPinoutGuide();

  return `
    <div class="space-y-4">
      <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar">${tabHtml}</div>
      ${bodyHtml}
    </div>
  `;
}

// --- GUIDE 1: INTERACTIVE BREADBOARD SVG ---
function renderBreadboardGuide() {
  const cols = 16;
  const colSpacing = 32;
  const startX = 64;
  const holes = [];

  // Top power rails (+ and -)
  for (let c = 0; c < cols; c++) {
    const x = startX + c * colSpacing;
    const half = wbState.bbSplitRail && c >= cols / 2 ? 'R' : 'L';
    holes.push(`<circle cx="${x}" cy="34" r="5" class="bb-hole cursor-pointer" data-net="rail-top-pos-${half}" data-desc="Top positive (+) rail. All holes along this red line connect horizontally${wbState.bbSplitRail ? ' (split in the middle!)' : ''}." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
    holes.push(`<circle cx="${x}" cy="56" r="5" class="bb-hole cursor-pointer" data-net="rail-top-neg-${half}" data-desc="Top ground (−) rail. All holes along this blue line connect horizontally${wbState.bbSplitRail ? ' (split in the middle!)' : ''}." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
  }

  // Terminal strips: Top 5 rows (a-e) and Bottom 5 rows (f-j)
  const topYs = [96, 116, 136, 156, 176];
  const botYs = [224, 244, 264, 284, 304];
  for (let c = 0; c < cols; c++) {
    const x = startX + c * colSpacing;
    topYs.forEach((y) => {
      holes.push(`<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" class="bb-hole cursor-pointer" data-net="col-top-${c}" data-desc="Column ${c + 1} (rows a–e). These 5 vertical holes connect together under the plastic. They do not cross the center trench." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
    });
    botYs.forEach((y) => {
      holes.push(`<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" class="bb-hole cursor-pointer" data-net="col-bot-${c}" data-desc="Column ${c + 1} (rows f–j). These 5 vertical holes connect together under the plastic. Place DIP chips across the center trench." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
    });
  }

  // Bottom power rails (+ and -)
  for (let c = 0; c < cols; c++) {
    const x = startX + c * colSpacing;
    const half = wbState.bbSplitRail && c >= cols / 2 ? 'R' : 'L';
    holes.push(`<circle cx="${x}" cy="344" r="5" class="bb-hole cursor-pointer" data-net="rail-bot-pos-${half}" data-desc="Bottom positive (+) rail. Does not connect to the top rail unless you add a jumper wire." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
    holes.push(`<circle cx="${x}" cy="366" r="5" class="bb-hole cursor-pointer" data-net="rail-bot-neg-${half}" data-desc="Bottom ground (−) rail. Connect to the top ground rail with a black jumper wire." fill="#1F2937" stroke="#64748B" stroke-width="1.2"/>`);
  }

  const railLine = (y, color) =>
    wbState.bbSplitRail
      ? `<line x1="56" y1="${y}" x2="294" y2="${y}" stroke="${color}" stroke-width="2"/><line x1="316" y1="${y}" x2="554" y2="${y}" stroke="${color}" stroke-width="2"/>`
      : `<line x1="56" y1="${y}" x2="554" y2="${y}" stroke="${color}" stroke-width="2"/>`;

  return `
    <div class="elevated-card rounded-md bg-surface-light p-5 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-ink">Interactive Breadboard Connections</h2>
          <p class="text-xs text-muted">Hover or tap any hole to see which holes connect together inside the board.</p>
        </div>
        <label class="inline-flex items-center gap-2.5 text-xs text-muted cursor-pointer">
          <span>Simulate split power rails (830-pt)</span>
          <span class="pinbin-switch">
            <input id="bbSplitToggle" type="checkbox" ${wbState.bbSplitRail ? 'checked' : ''} />
            <span class="pinbin-switch-track"></span>
          </span>
        </label>
      </div>

      <div class="pb-well rounded-md p-3 overflow-x-auto">
        <svg id="bbSvg" viewBox="0 0 600 400" class="w-full max-w-2xl mx-auto select-none">
          <rect x="16" y="10" width="568" height="380" rx="12" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="2"/>
          <!-- Center trench -->
          <rect x="24" y="192" width="552" height="16" rx="4" fill="#CBD5E1"/>
          <text x="300" y="203" text-anchor="middle" font-family="monospace" font-size="9" fill="#475569">CENTER TRENCH (ISOLATES TOP &amp; BOTTOM STRIPS)</text>
          <!-- Power rail lines -->
          ${railLine(22, '#EF4444')}
          ${railLine(68, '#3B82F6')}
          ${railLine(332, '#EF4444')}
          ${railLine(378, '#3B82F6')}
          <text x="34" y="38" font-family="monospace" font-size="13" font-weight="700" fill="#DC2626">+</text>
          <text x="35" y="60" font-family="monospace" font-size="14" font-weight="700" fill="#2563EB">−</text>
          <text x="34" y="348" font-family="monospace" font-size="13" font-weight="700" fill="#DC2626">+</text>
          <text x="35" y="370" font-family="monospace" font-size="14" font-weight="700" fill="#2563EB">−</text>
          ${holes.join('')}
        </svg>
      </div>

      <div id="bbInfoBox" class="pb-well rounded-md p-3.5 text-xs leading-relaxed">
        Hover or tap any hole on the breadboard above to inspect its hidden copper strip.
      </div>
    </div>
  `;
}

// --- GUIDE 2: INTERACTIVE RESISTOR COLOR BAND DECODER SVG ---
function computeResistorValue() {
  if (wbState.resistorBandsMode === 4) {
    const [b1, b2, multIdx, tolIdx] = wbState.resistorBands;
    const d1 = RESISTOR_COLORS[b1].digit ?? 0;
    const d2 = RESISTOR_COLORS[b2].digit ?? 0;
    const mult = RESISTOR_COLORS[multIdx].mult ?? 1;
    const tol = RESISTOR_COLORS[tolIdx].tol || '±5%';
    return { ohms: (d1 * 10 + d2) * mult, tol };
  }
  const [b1, b2, b3, multIdx, tolIdx] = wbState.resistorBands5;
  const d1 = RESISTOR_COLORS[b1].digit ?? 0;
  const d2 = RESISTOR_COLORS[b2].digit ?? 0;
  const d3 = RESISTOR_COLORS[b3].digit ?? 0;
  const mult = RESISTOR_COLORS[multIdx].mult ?? 1;
  const tol = RESISTOR_COLORS[tolIdx].tol || '±1%';
  return { ohms: (d1 * 100 + d2 * 10 + d3) * mult, tol };
}

function renderResistorGuide() {
  const is5 = wbState.resistorBandsMode === 5;
  const bands = is5 ? wbState.resistorBands5 : wbState.resistorBands;
  const { ohms, tol } = computeResistorValue();
  const bodyColor = is5 ? '#7DD3FC' : '#E6C79C';
  const bodyStroke = is5 ? '#0284C7' : '#B48A5A';

  const bandPositions = is5 ? [168, 206, 244, 282, 344] : [178, 224, 270, 342];
  const bandRects = bands
    .map((cIdx, i) => `<rect x="${bandPositions[i]}" y="46" width="18" height="88" rx="2" fill="${RESISTOR_COLORS[cIdx].hex}" stroke="#111827" stroke-opacity="0.25" stroke-width="1"/>`)
    .join('');

  const labels = is5 ? ['Band 1', 'Band 2', 'Band 3', 'Multiplier', 'Tolerance'] : ['Band 1', 'Band 2', 'Multiplier', 'Tolerance'];
  const selectors = labels
    .map((lbl, idx) => {
      const isDigit = is5 ? idx < 3 : idx < 2;
      const isMult = is5 ? idx === 3 : idx === 2;
      const opts = RESISTOR_COLORS.map((c, ci) => {
        if (isDigit && c.digit === null) return '';
        if (isDigit && idx === 0 && c.digit === 0) return '';
        if (isMult && c.mult === null) return '';
        if (!isDigit && !isMult && !c.tol) return '';
        return `<option value="${ci}" ${bands[idx] === ci ? 'selected' : ''}>${c.name}</option>`;
      }).join('');
      return `
        <div>
          <label class="block text-[11px] text-muted mb-1">${lbl}</label>
          <select data-res-band="${idx}" class="w-full h-8 px-2 text-xs rounded-md bg-canvas-light border border-hairline-light focus:outline-none focus:border-accent">
            ${opts}
          </select>
        </div>
      `;
    })
    .join('');

  return `
    <div class="elevated-card rounded-md bg-surface-light p-5 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-ink">Interactive Resistor Color Decoder</h2>
          <p class="text-xs text-muted">Select the color bands or click a common value to see its bands.</p>
        </div>
        <div class="pb-segmented inline-flex rounded p-0.5 gap-0.5 text-xs">
          <button type="button" data-res-mode="4" class="px-2.5 py-1 rounded-md font-medium transition-colors ${!is5 ? 'pb-seg-active' : 'opacity-70'}">4-Band (Tan)</button>
          <button type="button" data-res-mode="5" class="px-2.5 py-1 rounded-md font-medium transition-colors ${is5 ? 'pb-seg-active' : 'opacity-70'}">5-Band (Blue 1%)</button>
        </div>
      </div>

      <div class="pb-well rounded-md p-4 flex flex-col items-center gap-2">
        <svg viewBox="0 0 540 180" class="w-full max-w-lg select-none">
          <!-- Metal leads -->
          <rect x="20" y="84" width="110" height="12" rx="4" fill="#94A3B8"/>
          <rect x="410" y="84" width="110" height="12" rx="4" fill="#94A3B8"/>
          <!-- Resistor body -->
          <rect x="122" y="46" width="296" height="88" rx="28" fill="${bodyColor}" stroke="${bodyStroke}" stroke-width="2.5"/>
          ${bandRects}
        </svg>
        <div class="flex items-baseline gap-2.5">
          <span class="font-mono text-2xl font-semibold text-ink dark:text-white">${formatOhms(ohms)}</span>
          <span class="font-mono text-xs text-muted">${tol}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 ${is5 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-2.5">${selectors}</div>

      <div class="flex flex-wrap items-center gap-1.5 pt-1">
        <span class="text-[11px] text-muted mr-1">Quick presets:</span>
        <button type="button" data-res-preset="220" class="btn-secondary h-7 px-2.5 rounded-md font-mono text-[11px]">220 Ω (LED)</button>
        <button type="button" data-res-preset="1000" class="btn-secondary h-7 px-2.5 rounded-md font-mono text-[11px]">1 kΩ (Signal)</button>
        <button type="button" data-res-preset="2000" class="btn-secondary h-7 px-2.5 rounded-md font-mono text-[11px]">2 kΩ (Divider)</button>
        <button type="button" data-res-preset="10000" class="btn-secondary h-7 px-2.5 rounded-md font-mono text-[11px]">10 kΩ (Pull-Up)</button>
      </div>
    </div>
  `;
}

// --- GUIDE 3: INTERACTIVE MULTIMETER DIAL SVG ---
function renderMultimeterGuide() {
  const m = DMM_MODES[wbState.dmmMode] || DMM_MODES.dcv;
  const is10A = m.redJack === '10a';

  return `
    <div class="elevated-card rounded-md p-5 grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
      <div class="md:col-span-5 flex justify-center">
        <svg viewBox="0 0 240 360" class="w-56 select-none">
          <!-- Protective holster -->
          <rect x="18" y="12" width="204" height="336" rx="28" fill="#B91C1C" stroke="#7F1D1D" stroke-width="2.5"/>
          <rect x="32" y="26" width="176" height="308" rx="18" fill="#1F242D"/>
          <!-- LCD -->
          <rect x="48" y="42" width="144" height="62" rx="6" fill="#C4CFC9" stroke="#0F1115" stroke-width="2"/>
          <text x="120" y="79" text-anchor="middle" font-family="monospace" font-size="22" font-weight="700" fill="#111827">${
            wbState.dmmMode === 'dcv' ? '5.02 V' :
            wbState.dmmMode === 'acv' ? '230 V~' :
            wbState.dmmMode === 'ohm' ? '220 Ω' :
            wbState.dmmMode === 'cont' ? '0.0 Ω 🔊' : '0.42 A'
          }</text>
          <!-- Rotary dial -->
          <circle cx="120" cy="192" r="46" fill="#14171E" stroke="#4B5563" stroke-width="2"/>
          <g transform="rotate(${m.angle} 120 192)">
            <rect x="115" y="152" width="10" height="80" rx="5" fill="#CBD5E1"/>
            <polygon points="120,148 114,160 126,160" fill="#3B82F6"/>
          </g>
          <!-- Mode indicators around dial -->
          <text x="64" y="156" font-family="monospace" font-size="11" fill="${wbState.dmmMode === 'dcv' ? '#60A5FA' : '#9CA3AF'}" class="cursor-pointer" data-dmm-mode="dcv">V⎓</text>
          <text x="108" y="136" font-family="monospace" font-size="11" fill="${wbState.dmmMode === 'acv' ? '#60A5FA' : '#9CA3AF'}" class="cursor-pointer" data-dmm-mode="acv">V~</text>
          <text x="164" y="156" font-family="monospace" font-size="11" fill="${wbState.dmmMode === 'ohm' ? '#60A5FA' : '#9CA3AF'}" class="cursor-pointer" data-dmm-mode="ohm">Ω</text>
          <text x="176" y="204" font-family="monospace" font-size="11" fill="${wbState.dmmMode === 'cont' ? '#60A5FA' : '#9CA3AF'}" class="cursor-pointer" data-dmm-mode="cont">🔊</text>
          <text x="158" y="246" font-family="monospace" font-size="10" fill="${wbState.dmmMode === 'dc10a' ? '#60A5FA' : '#9CA3AF'}" class="cursor-pointer" data-dmm-mode="dc10a">10A</text>

          <!-- Probe Jacks -->
          <circle cx="68" cy="292" r="15" fill="${is10A ? '#EF4444' : '#374151'}" stroke="${is10A ? '#FCA5A5' : '#64748B'}" stroke-width="${is10A ? '3' : '2'}"/>
          <text x="68" y="320" text-anchor="middle" font-family="monospace" font-size="9" fill="${is10A ? '#FCA5A5' : '#9CA3AF'}">10A</text>

          <circle cx="120" cy="292" r="15" fill="#111827" stroke="#9CA3AF" stroke-width="3"/>
          <text x="120" y="320" text-anchor="middle" font-family="monospace" font-size="9" fill="#E5E7EB">COM (−)</text>

          <circle cx="172" cy="292" r="15" fill="${!is10A ? '#EF4444' : '#374151'}" stroke="${!is10A ? '#FCA5A5' : '#64748B'}" stroke-width="${!is10A ? '3' : '2'}"/>
          <text x="172" y="320" text-anchor="middle" font-family="monospace" font-size="9" fill="${!is10A ? '#FCA5A5' : '#9CA3AF'}">VΩmA</text>
        </svg>
      </div>

      <div class="md:col-span-7 space-y-4">
        <div class="flex flex-wrap gap-1.5">
          ${Object.entries(DMM_MODES)
            .map(([k, info]) => {
              const act = wbState.dmmMode === k;
              return `<button type="button" data-dmm-mode="${k}" aria-pressed="${act}" class="pb-toggle-chip h-7 px-3 rounded-full text-xs font-medium">${info.label}</button>`;
            })
            .join('')}
        </div>

        <div class="space-y-4">
          <h3 class="text-base font-semibold">${escapeHTML(m.title)}</h3>
          <div class="text-[13px] leading-relaxed">
            <div class="pb-section-label mb-1">Steps</div>
            <p>${escapeHTML(m.steps)}</p>
          </div>
          <div class="pb-alert-warn p-4 text-[13px] leading-relaxed">
            <div class="pb-alert-warn-title flex items-center gap-1.5 pb-section-label mb-1">
              <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
              <span>Caution</span>
            </div>
            <p>${escapeHTML(m.caution)}</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// --- GUIDE 4: INTERACTIVE BOARD PINOUT EXPLORERS (Inventory-Aware) ---
function renderBoardPinoutGuide() {
  const owned = detectInventoryBoards();
  const board = BOARD_DEFS[wbState.activeBoard] || BOARD_DEFS.pico2;
  const rows = Math.max(board.left.length, board.right.length);
  const svgHeight = rows * 22 + 76;

  const pinMatchesFilter = (p) => {
    if (wbState.boardPinFilter === 'all') return true;
    return p.roles.includes(wbState.boardPinFilter);
  };

  const renderPinSide = (pins, side) =>
    pins
      .map((p, idx) => {
        const y = 54 + idx * 22;
        const match = pinMatchesFilter(p);
        const isSelected = wbState.selectedPinIdx === `${side}-${idx}`;
        const dotX = side === 'left' ? 148 : 292;
        const labelX = side === 'left' ? 132 : 308;
        const anchor = side === 'left' ? 'end' : 'start';
        const pinColor = p.color || '#22C55E';
        const opacity = match ? '1' : '0.2';

        return `
          <g class="cursor-pointer board-pin" data-pin-key="${side}-${idx}" opacity="${opacity}">
            <circle cx="${dotX}" cy="${y}" r="${isSelected ? 7 : 5}" fill="${pinColor}" stroke="${isSelected ? '#FFFFFF' : '#0F1115'}" stroke-width="${isSelected ? 2 : 1}"/>
            <text x="${labelX}" y="${y + 3.5}" text-anchor="${anchor}" font-family="monospace" font-size="10.5" font-weight="${isSelected ? '700' : '500'}" fill="${isSelected ? '#3B82F6' : 'currentColor'}">${escapeHTML(p.name)}</text>
          </g>
        `;
      })
      .join('');

  let selectedPin = null;
  if (wbState.selectedPinIdx) {
    const [side, idxStr] = wbState.selectedPinIdx.split('-');
    const arr = side === 'left' ? board.left : board.right;
    selectedPin = arr[parseInt(idxStr, 10)] || null;
  }

  return `
    <div class="elevated-card rounded-md bg-surface-light p-5 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-1.5">
          ${Object.entries(BOARD_DEFS)
            .map(([k, b]) => {
              const act = wbState.activeBoard === k;
              return `<button type="button" data-wb-board="${k}" aria-pressed="${act}" class="pb-toggle-chip h-8 px-3 rounded-full text-xs font-medium inline-flex items-center gap-1.5">
                <span>${escapeHTML(b.name)}</span>
                ${owned[k] ? `<span class="w-1.5 h-1.5 rounded-full ${act ? 'bg-white' : 'bg-emerald-500'}" title="In your inventory"></span>` : ''}
              </button>`;
            })
            .join('')}
        </div>

        <div class="pb-segmented inline-flex flex-wrap items-center rounded p-0.5 gap-0.5">
          ${[
            ['all', 'All'],
            ['power', 'Power / GND'],
            ['i2c', 'I2C'],
            ['spi', 'SPI'],
            ['adc', 'Analog'],
          ]
            .map(([fk, fl]) => {
              const act = wbState.boardPinFilter === fk;
              return `<button type="button" data-pin-filter="${fk}" class="h-6 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
                act ? 'pb-seg-active' : 'opacity-70 hover:opacity-100'
              }">${fl}</button>`;
            })
            .join('')}
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div class="pb-well lg:col-span-7 rounded-md p-3 flex justify-center overflow-x-auto">
          <svg viewBox="0 0 440 ${svgHeight}" class="w-full max-w-md select-none text-ink">
            <!-- USB port -->
            <rect x="195" y="10" width="50" height="22" rx="3" fill="#CBD5E1" stroke="#64748B" stroke-width="1.5"/>
            <!-- PCB body -->
            <rect x="138" y="26" width="164" height="${svgHeight - 40}" rx="10" fill="${board.pcbFill}" stroke="${board.pcbStroke}" stroke-width="2"/>
            <!-- Main MCU chip -->
            <rect x="184" y="${Math.floor(svgHeight / 2) - 34}" width="72" height="68" rx="4" fill="#111827" stroke="#374151" stroke-width="1.5"/>
            <text x="220" y="${Math.floor(svgHeight / 2) + 4}" text-anchor="middle" font-family="monospace" font-size="9" fill="#9CA3AF">${escapeHTML(board.chipLabel)}</text>
            ${renderPinSide(board.left, 'left')}
            ${renderPinSide(board.right, 'right')}
          </svg>
        </div>

        <div class="lg:col-span-5 space-y-3">
          <div>
            <h3 class="text-sm font-semibold">${escapeHTML(board.name)}</h3>
            <p class="text-xs text-muted">${escapeHTML(board.subtitle)}</p>
          </div>

          <div id="boardPinInspector" class="pb-well rounded-md p-4 space-y-2">
            ${
              selectedPin
                ? `<div class="flex items-center justify-between">
                     <span class="font-mono text-sm font-semibold text-accent">${escapeHTML(selectedPin.name)}</span>
                     <span class="font-mono text-[11px] text-muted">Pin #${selectedPin.pin}</span>
                   </div>
                   <p class="text-xs leading-relaxed text-ink-2">${escapeHTML(selectedPin.note)}</p>`
                : `<p class="text-xs text-muted">Click or tap any pin on the board diagram to inspect its function and voltage rating.</p>`
            }
          </div>

          <div class="text-[11px] text-muted flex flex-wrap gap-x-3 gap-y-1 pt-1">
            <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-red-600"></span>Power</span>
            <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-gray-600"></span>GND</span>
            <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500"></span>GPIO</span>
            <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-purple-600"></span>Analog</span>
            <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-stop"></span>Caution/Reset</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// INTERACTIVE GUIDE EVENTS
// =============================================================================
function bindInteractiveGuideEvents() {
  const root = document.getElementById('benchView');
  if (!root) return;

  root.querySelectorAll('button[data-wb-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.subTab = btn.dataset.wbSub;
      if (typeof window.syncBenchUrl === 'function') {
        window.syncBenchUrl(wbState.subTab);
      }
      renderWorkbench();
    });
  });

  root.querySelectorAll('button[data-wb-guide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.activeGuide = btn.dataset.wbGuide;
      wbState.selectedPinIdx = null;
      renderWorkbench();
    });
  });

  // Breadboard events
  const bbSvg = document.getElementById('bbSvg');
  if (bbSvg) {
    const infoBox = document.getElementById('bbInfoBox');
    const highlightNet = (net, desc) => {
      bbSvg.querySelectorAll('.bb-hole').forEach((el) => {
        const match = el.dataset.net === net;
        el.setAttribute('fill', match ? '#3B82F6' : '#1F2937');
        el.setAttribute('stroke', match ? '#93C5FD' : '#64748B');
      });
      if (infoBox && desc) infoBox.textContent = desc;
    };
    bbSvg.addEventListener('mouseover', (e) => {
      const hole = e.target.closest('.bb-hole');
      if (hole) highlightNet(hole.dataset.net, hole.dataset.desc);
    });
    bbSvg.addEventListener('click', (e) => {
      const hole = e.target.closest('.bb-hole');
      if (hole) highlightNet(hole.dataset.net, hole.dataset.desc);
    });
    const splitToggle = document.getElementById('bbSplitToggle');
    if (splitToggle) {
      splitToggle.addEventListener('change', (e) => {
        wbState.bbSplitRail = e.target.checked;
        renderWorkbench();
      });
    }
  }

  // Resistor events
  root.querySelectorAll('button[data-res-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.resistorBandsMode = parseInt(btn.dataset.resMode, 10);
      renderWorkbench();
    });
  });
  root.querySelectorAll('select[data-res-band]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.resBand, 10);
      const val = parseInt(sel.value, 10);
      if (wbState.resistorBandsMode === 5) wbState.resistorBands5[idx] = val;
      else wbState.resistorBands[idx] = val;
      renderWorkbench();
    });
  });
  root.querySelectorAll('button[data-res-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.resPreset;
      if (wbState.resistorBandsMode === 4) {
        if (target === '220') wbState.resistorBands = [2, 2, 1, 10];
        else if (target === '1000') wbState.resistorBands = [1, 0, 2, 10];
        else if (target === '2000') wbState.resistorBands = [2, 0, 2, 10];
        else if (target === '10000') wbState.resistorBands = [1, 0, 3, 10];
      } else {
        if (target === '220') wbState.resistorBands5 = [2, 2, 0, 0, 1];
        else if (target === '1000') wbState.resistorBands5 = [1, 0, 0, 1, 1];
        else if (target === '2000') wbState.resistorBands5 = [2, 0, 0, 1, 1];
        else if (target === '10000') wbState.resistorBands5 = [1, 0, 0, 2, 1];
      }
      renderWorkbench();
    });
  });

  // Multimeter events
  root.querySelectorAll('[data-dmm-mode]').forEach((el) => {
    el.addEventListener('click', () => {
      wbState.dmmMode = el.dataset.dmmMode;
      renderWorkbench();
    });
  });

  // Board pinout events
  root.querySelectorAll('button[data-wb-board]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.activeBoard = btn.dataset.wbBoard;
      wbState.selectedPinIdx = null;
      renderWorkbench();
    });
  });
  root.querySelectorAll('button[data-pin-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wbState.boardPinFilter = btn.dataset.pinFilter;
      renderWorkbench();
    });
  });
  root.querySelectorAll('.board-pin').forEach((pinEl) => {
    pinEl.addEventListener('click', () => {
      wbState.selectedPinIdx = pinEl.dataset.pinKey;
      renderWorkbench();
    });
  });
}

// =============================================================================
// 3. COMPATIBILITY & WIRING CHECKER (Offline Rules + Optional AI)
// =============================================================================
function runOfflineCompatibilityRules(selectedParts) {
  const issues = [];
  const tips = [];

  const textOf = (p) =>
    [p.name, p.subtitle, p.what_it_does, p.warning, p.notes, JSON.stringify(p.specs || {})]
      .join(' ')
      .toLowerCase();

  const has33Board = selectedParts.some((p) => p.category === 'Microcontrollers' && textOf(p).includes('3.3v'));
  const has5vBoard = selectedParts.some((p) => p.category === 'Microcontrollers' && (textOf(p).includes('5v') || textOf(p).includes('arduino uno')));
  const hasRc522 = selectedParts.some((p) => textOf(p).includes('rc522'));
  const hasHcsr04 = selectedParts.some((p) => textOf(p).includes('hc-sr04'));
  const hasStepper = selectedParts.some((p) => textOf(p).includes('28byj-48'));
  const hasUln2003 = selectedParts.some((p) => textOf(p).includes('uln2003'));
  const hasBareLed = selectedParts.some((p) => textOf(p).includes('5mm led') || textOf(p).includes('5611ah') || textOf(p).includes('5641ah') || textOf(p).includes('dot matrix'));
  const hasResistor = selectedParts.some((p) => textOf(p).includes('resistor'));
  const hasHighPower = selectedParts.some((p) => textOf(p).includes('servo') || textOf(p).includes('relay') || textOf(p).includes('mq-2') || textOf(p).includes('28byj-48'));
  const i2cParts = selectedParts.filter((p) => textOf(p).includes('i2c'));

  if (has5vBoard && hasRc522) {
    issues.push({ level: 'danger', text: 'RC522 requires 3.3V power ONLY. Do not connect RC522 VCC to the 5V pin on a 5V board.' });
  }
  if (has33Board && hasHcsr04) {
    issues.push({ level: 'danger', text: 'HC-SR04 outputs a 5V Echo pulse. Use a 1kΩ / 2kΩ voltage divider before connecting Echo to a 3.3V board.' });
  }
  if (hasStepper && !hasUln2003) {
    issues.push({ level: 'danger', text: 'Do not connect the 28BYJ-48 stepper directly to GPIO pins. Add a ULN2003 driver board.' });
  }
  if (hasBareLed && !hasResistor) {
    issues.push({ level: 'caution', text: 'Bare LEDs and 7-segment displays need current-limiting resistors (220Ω to 1kΩ) in series.' });
  }
  if (hasHighPower) {
    tips.push('Motors, relays, and gas heaters draw high current. Connect all grounds (GND) together and avoid browning out USB power.');
  }
  if (i2cParts.length >= 2) {
    tips.push(`You selected ${i2cParts.length} I2C devices (${i2cParts.map((p) => p.name).join(', ')}). Share SDA and SCL, and check that their hex addresses do not collide.`);
  }

  return { issues, tips };
}

function renderCompatibilitySection() {
  const parts = (typeof state !== 'undefined' && Array.isArray(state.parts)) ? state.parts : [];
  const selectedParts = wbState.compatSelectedIds
    .map((id) => parts.find((p) => p.id === id))
    .filter(Boolean);

  const q = wbState.compatSearch.trim().toLowerCase();
  const filtered = parts.filter((p) => {
    if (!q) return true;
    return `${p.name} ${p.subtitle} ${p.category}`.toLowerCase().includes(q);
  });

  const offline = selectedParts.length >= 2 ? runOfflineCompatibilityRules(selectedParts) : null;
  const aiEnabled = typeof state !== 'undefined' && state.config && state.config.ai_enabled;

  return `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      <!-- Left: Part Selector -->
      <div class="lg:col-span-5 elevated-card rounded-md bg-surface-light p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-ink">Select 2–6 Parts (${selectedParts.length}/6)</span>
          ${selectedParts.length > 0 ? `<button id="compatClearBtn" type="button" class="btn-danger-outline h-7 px-2.5 rounded text-[11px] font-medium">Clear</button>` : ''}
        </div>

        <input id="compatSearchInput" type="text" value="${escapeHTML(wbState.compatSearch)}" placeholder="Filter your parts..." class="w-full h-8 px-2.5 text-xs rounded-md bg-canvas-light border border-hairline-light focus:outline-none focus:border-accent" />

        <div class="max-h-80 overflow-y-auto divide-y divide-hairline-light/60">
          ${filtered
            .slice(0, 40)
            .map((p) => {
              const checked = wbState.compatSelectedIds.includes(p.id);
              return `
                <label class="flex items-center gap-2.5 py-2 px-1 cursor-pointer hover:bg-matte-light/60 rounded">
                  <input type="checkbox" data-compat-part="${escapeHTML(p.id)}" ${checked ? 'checked' : ''} class="h-3.5 w-3.5 rounded accent-orange-500 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-medium text-ink truncate">${escapeHTML(p.name)}</div>
                    <div class="text-[10px] text-muted truncate">${escapeHTML(p.category)}</div>
                  </div>
                </label>
              `;
            })
            .join('')}
        </div>
      </div>

      <!-- Right: Analysis Output -->
      <div class="lg:col-span-7 elevated-card rounded-md bg-surface-light p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-ink">Compatibility &amp; Wiring Check</h2>
          ${
            aiEnabled && selectedParts.length >= 2
              ? `<button id="runCompatAiBtn" type="button" ${wbState.compatAiLoading ? 'disabled' : ''} class="btn-primary h-8 px-3.5 rounded text-xs font-medium inline-flex items-center gap-1.5">
                   <span>${wbState.compatAiLoading ? 'Checking...' : 'Deep AI Wiring Check'}</span>
                 </button>`
              : ''
          }
        </div>

        ${
          selectedParts.length < 2
            ? `<p class="text-xs text-muted py-8 text-center">Pick at least 2 parts on the left (for example, a microcontroller and a sensor) to check voltage, drivers, and wiring.</p>`
            : `
              <div class="flex flex-wrap gap-1.5">
                ${selectedParts.map((p) => `<span class="pb-badge pb-badge-neutral">${escapeHTML(p.name)}</span>`).join('')}
              </div>

              <!-- Offline Instant Rules -->
              <div class="space-y-2.5">
                <div class="pb-section-label">Instant Safety Check</div>
                ${
                  offline.issues.length === 0
                    ? `<div class="pb-well rounded-md p-3.5 text-xs text-go">No obvious voltage or driver conflicts detected by offline rules.</div>`
                    : offline.issues
                        .map(
                          (iss) => `<div class="pb-alert-warn p-3.5 text-xs leading-relaxed">${escapeHTML(iss.text)}</div>`
                        )
                        .join('')
                }
                ${offline.tips.map((t) => `<div class="pb-well rounded-md p-3.5 text-xs leading-relaxed">${escapeHTML(t)}</div>`).join('')}
              </div>

              <!-- Optional Deep AI Check Result -->
              ${
                wbState.compatAiResult
                  ? `<div class="pt-3 border-t border-hairline-light space-y-3">
                       <div class="flex items-center justify-between">
                         <span class="pb-section-label text-accent">AI Wiring Plan (ASD-STE100)</span>
                         <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded ${
                           wbState.compatAiResult.status === 'danger'
                             ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                             : wbState.compatAiResult.status === 'ok'
                             ? 'bg-emerald-500/15 text-go'
                             : 'bg-amber-500/15 text-stop'
                         }">${escapeHTML(wbState.compatAiResult.status)}</span>
                       </div>
                       <p class="text-xs leading-relaxed text-ink-2">${escapeHTML(wbState.compatAiResult.summary)}</p>
                       ${
                         wbState.compatAiResult.issues.length > 0
                           ? `<ul class="space-y-1.5 text-xs text-amber-900 dark:text-amber-300 list-disc pl-4">
                                ${wbState.compatAiResult.issues.map((x) => `<li>${escapeHTML(x)}</li>`).join('')}
                              </ul>`
                           : ''
                       }
                       ${
                         wbState.compatAiResult.wiring_steps.length > 0
                           ? `<div class="space-y-1">
                                <div class="pb-section-label">Wiring Steps</div>
                                <ol class="space-y-1 text-xs text-ink list-decimal pl-4">
                                  ${wbState.compatAiResult.wiring_steps.map((x) => `<li>${escapeHTML(x)}</li>`).join('')}
                                </ol>
                              </div>`
                           : ''
                       }
                     </div>`
                  : ''
              }
            `
        }
      </div>
    </div>
  `;
}

function bindCompatibilityEvents() {
  const search = document.getElementById('compatSearchInput');
  if (search) {
    search.addEventListener('input', (e) => {
      wbState.compatSearch = e.target.value;
      renderWorkbench();
      const el = document.getElementById('compatSearchInput');
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }
  const clearBtn = document.getElementById('compatClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      wbState.compatSelectedIds = [];
      wbState.compatAiResult = null;
      renderWorkbench();
    });
  }
  document.querySelectorAll('input[data-compat-part]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.compatPart;
      if (cb.checked) {
        if (wbState.compatSelectedIds.length >= 6) {
          cb.checked = false;
          if (typeof showToast === 'function') showToast('Select up to 6 parts');
          return;
        }
        wbState.compatSelectedIds.push(id);
      } else {
        wbState.compatSelectedIds = wbState.compatSelectedIds.filter((x) => x !== id);
      }
      wbState.compatAiResult = null;
      renderWorkbench();
    });
  });
  const aiBtn = document.getElementById('runCompatAiBtn');
  if (aiBtn) {
    aiBtn.addEventListener('click', async () => {
      wbState.compatAiLoading = true;
      renderWorkbench();
      try {
        wbState.compatAiResult = await apiFetch('/api/compatibility', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ part_ids: wbState.compatSelectedIds }),
        });
        if (typeof loadConfig === 'function') loadConfig();
      } catch (err) {
        if (typeof showToast === 'function') showToast(err.message);
      } finally {
        wbState.compatAiLoading = false;
        renderWorkbench();
      }
    });
  }
}

// =============================================================================
// 4. PRINTABLE BIN QR LABELS
// =============================================================================
function renderBinLabelsSection() {
  const parts = (typeof state !== 'undefined' && Array.isArray(state.parts)) ? state.parts : [];
  const binMap = new Map();
  for (const p of parts) {
    const loc = (p.location || '').trim();
    if (!loc) continue;
    if (!binMap.has(loc)) binMap.set(loc, []);
    binMap.get(loc).push(p);
  }
  const bins = [...binMap.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

  if (bins.length === 0) {
    return `
      <div class="rounded-md border border-dashed border-hairline-light p-12 text-center space-y-1.5">
        <p class="text-sm font-medium text-ink">No bins assigned yet</p>
        <p class="text-xs text-muted">Assign a <strong>Bin / Location</strong> (such as <code>Mano-A1</code>) to your parts first. Printable QR labels appear here automatically.</p>
      </div>
    `;
  }

  const origin = window.location.origin;
  const labelsHtml = bins
    .map(([binName, binParts]) => {
      const targetUrl = `${origin}/?bin=${encodeURIComponent(binName)}`;
      const qrSrc = `/api/qr?text=${encodeURIComponent(targetUrl)}`;
      const previewNames = binParts.slice(0, 3).map((p) => p.name).join(' · ');
      return `
        <div class="bin-label-card elevated-card rounded-md bg-surface-light p-3 flex items-center gap-3">
          <img src="${qrSrc}" alt="QR for ${escapeHTML(binName)}" class="w-16 h-16 rounded bg-white p-1 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="font-mono text-sm font-semibold text-ink truncate">${escapeHTML(binName)}</div>
            <div class="text-[10px] font-mono text-muted">${binParts.length} part${binParts.length === 1 ? '' : 's'}</div>
            <p class="text-[10px] text-muted line-clamp-2 mt-0.5">${escapeHTML(previewNames)}</p>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="space-y-4">
      <div class="no-print flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-muted">Scan any printed QR label with your phone camera to open Pinbin filtered directly to that bin.</p>
        <button id="printBinLabelsBtn" type="button" class="btn-primary h-8 px-3.5 rounded text-xs font-medium inline-flex items-center gap-1.5">
          <span>Print Labels (${bins.length})</span>
        </button>
      </div>

      <div id="binLabelsPrintSheet" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        ${labelsHtml}
      </div>
    </div>
  `;
}

function bindBinLabelsEvents() {
  const btn = document.getElementById('printBinLabelsBtn');
  if (btn) {
    btn.addEventListener('click', () => window.print());
  }
}
