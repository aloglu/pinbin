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
