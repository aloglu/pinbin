import assert from 'node:assert/strict';
import { PinbinSimulator } from '../app/static/js/sim-engine.js';

const esp32Project = {
  id: 'p1',
  name: 'Sim Test',
  items: [
    { ref: 'mcu', role: 'mcu', name: 'ESP32 30-pin', category: 'Microcontrollers' },
    { ref: 'led1', role: 'periph', name: 'Red LED', category: 'Passives' },
    { ref: 'btn1', role: 'periph', name: 'Push Button', category: 'Prototyping' },
    { ref: 'pot1', role: 'periph', name: '10k Potentiometer', category: 'Passives' },
    { ref: 'oled', role: 'periph', name: 'SSD1306 OLED', category: 'Displays', electrical_facts: { i2c: '0x3C' } },
  ],
  nets: [
    { id: 'n-led', name: 'LED', kind: 'sig', conns: [['mcu', 'GPIO13'], ['led1', 'A']] },
    { id: 'n-btn', name: 'BTN', kind: 'sig', conns: [['mcu', 'GPIO4'], ['btn1', 'OUT']] },
    { id: 'n-pot', name: 'POT', kind: 'sig', conns: [['mcu', 'GPIO34'], ['pot1', 'SIG']] },
    { id: 'n-sda', name: 'SDA', kind: 'i2c', conns: [['mcu', 'GPIO21'], ['oled', 'SDA']] },
  ],
};

// 1. Arduino C++: pinMode, digitalRead (INPUT_PULLUP), digitalWrite, analogRead, Serial.println, display.println
{
  const arduinoCode = `
    #define PIN_LED 13
    #define PIN_BTN 4
    #define PIN_POT 34

    void setup() {
      Serial.begin(115200);
      pinMode(PIN_LED, OUTPUT);
      pinMode(PIN_BTN, INPUT_PULLUP);
      Serial.println("boot");
    }

    void loop() {
      int pressed = digitalRead(PIN_BTN) == LOW;
      int val = analogRead(PIN_POT);
      if (pressed) {
        digitalWrite(PIN_LED, HIGH);
        display.println("PRESSED");
      } else {
        digitalWrite(PIN_LED, LOW);
      }
      Serial.println(val);
      delay(100);
    }
  `;

  const sim = new PinbinSimulator(esp32Project, arduinoCode, 'arduino');
  sim.running = true;
  sim.setInput('pot1', { value: 1.0 });
  sim.tick(50, 40);
  let snap = sim.getSnapshot();
  assert.equal(snap.error, '');
  assert.equal(snap.netStates['n-led'].state, 'low');
  assert.ok(snap.serial.some((s) => s.text === 'boot'));
  assert.ok(snap.serial.some((s) => s.text === '4095'));

  // Press button and advance past delay(100)
  sim.setInput('btn1', { pressed: true });
  sim.tick(120, 40);
  snap = sim.getSnapshot();
  assert.equal(snap.netStates['n-led'].state, 'high');
  assert.equal(snap.widgetStates.find((w) => w.ref === 'led1').active, true);
  assert.ok(snap.displayLines.includes('PRESSED'));
  console.log('✓ Arduino C++ live simulation test passed');
}

// 2. MicroPython on Pico 2: Pin, PWM, ADC, I2C.scan, print, step-by-step
{
  const picoProject = {
    id: 'p2',
    name: 'Pico Sim',
    items: [
      { ref: 'mcu', role: 'mcu', name: 'Raspberry Pi Pico 2', category: 'Microcontrollers' },
      { ref: 'led', role: 'periph', name: 'Green LED', category: 'Passives' },
      { ref: 'oled', role: 'periph', name: 'SSD1306 OLED', category: 'Displays', electrical_facts: { i2c: '0x3C' } },
    ],
    nets: [
      { id: 'n-led', name: 'LED', kind: 'sig', conns: [['mcu', 'GP15'], ['led', 'A']] },
      { id: 'n-sda', name: 'SDA', kind: 'i2c', conns: [['mcu', 'GP4'], ['oled', 'SDA']] },
    ],
  };

  const pyCode = `
from machine import Pin, PWM, I2C
import time

PIN_LED = 15
pwm = PWM(Pin(PIN_LED))
i2c = I2C(0, sda=Pin(4), scl=Pin(5))
print("i2c:", i2c.scan())
pwm.duty_u16(32768)
time.sleep_ms(50)
`;

  const sim = new PinbinSimulator(picoProject, pyCode, 'micropython');
  sim.running = true;
  sim.tick(20, 30);
  const snap = sim.getSnapshot();
  assert.equal(snap.error, '');
  assert.equal(snap.netStates['n-led'].state, 'pwm');
  assert.ok(snap.netStates['n-led'].pwm > 100 && snap.netStates['n-led'].pwm < 160);
  assert.ok(snap.serial.some((s) => s.text.includes('0x3c')));
  console.log('✓ MicroPython live simulation test passed');
}

// 3. DOM stability & Run -> Pause -> Reset clickability test (ensures refreshSimUi never replaces buttons mid-tick)
{
  // Minimal DOM mock for testing refreshSimUi in-place updates
  const byId = new Map();
  const makeEl = (tag, id = '') => {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      id,
      textContent: '',
      value: '50',
      disabled: false,
      style: {},
      dataset: {},
      children: [],
      className: '',
      classList: {
        toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        delete: (c) => classes.delete(c),
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(_v) {
        this._innerHtmlWrites = (this._innerHtmlWrites || 0) + 1;
      },
      _innerHtmlWrites: 0,
    };
    if (id) byId.set(id, el);
    return el;
  };

  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => byId.get(id) || null,
  };
  globalThis.window = { confirm: () => true };

  const { state } = await import('../app/static/js/state.js');
  const {
    getCodeDraft,
    simPlayPauseAction,
    simResetAction,
    refreshSimUi,
    stopActiveSimulator,
  } = await import('../app/static/js/views/project-code.js');

  state.projects = [esp32Project];
  const draft = getCodeDraft(esp32Project);
  draft.language = 'arduino';
  draft.source = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(50); }';

  // Pre-mount stable toolbar buttons
  const barSlot = makeEl('div', 'sim-bar-slot');
  const playBtn = makeEl('button', 'sim-play-btn');
  const resetBtn = makeEl('button', 'sim-reset-btn');
  const badgeEl = makeEl('span', 'sim-badge');
  makeEl('textarea', 'code-editor');

  // Click Run
  simPlayPauseAction('p1');
  assert.equal(playBtn.textContent, '❚❚ Pause');
  assert.equal(resetBtn.disabled, false);
  assert.equal(barSlot._innerHtmlWrites, 0, 'sim-bar-slot innerHTML must NOT be overwritten when buttons exist');

  // Simulate multiple 50ms UI refreshes
  refreshSimUi('p1');
  refreshSimUi('p1');
  assert.equal(barSlot._innerHtmlWrites, 0, 'Pause/Reset buttons must stay mounted across ticks');

  // Click Pause
  simPlayPauseAction('p1');
  assert.equal(playBtn.textContent, '▶ Run');
  assert.ok(badgeEl.textContent.includes('Paused'));

  // Click Reset
  simResetAction('p1');
  assert.equal(resetBtn.disabled, true);
  assert.equal(badgeEl.textContent, 'Simulator idle');
  stopActiveSimulator();
  console.log('✓ Live simulator DOM stability & Run/Pause/Reset test passed');
}
