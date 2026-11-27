"""Tests for Phase 1 Project Code analyzer, starter generator, DB storage, REST API, and MCP tools."""
from __future__ import annotations

import io
import json
import unittest
import zipfile

from app.project_code import analyze_project_code, build_wiring_summary, generate_starter_code
from app.wokwi import build_wokwi_zip_bytes, export_wokwi_project


def _sample_esp32_project() -> dict:
    return {
        "id": "p-esp32",
        "name": "Desk Sensor",
        "code_language": "",
        "code_source": "",
        "items": [
            {
                "ref": "mcu",
                "role": "mcu",
                "name": "ESP32 30-pin",
                "label": "ESP32",
                "category": "Microcontrollers",
                "electrical_facts": {"logic": "v33", "io": 3.6},
            },
            {
                "ref": "led1",
                "role": "periph",
                "name": "Status LED",
                "label": "Status LED",
                "category": "Passives",
                "electrical_facts": {},
            },
            {
                "ref": "btn1",
                "role": "periph",
                "name": "Wake Button",
                "label": "Button",
                "category": "Prototyping",
                "electrical_facts": {},
            },
            {
                "ref": "oled",
                "role": "periph",
                "name": "SSD1306 OLED",
                "label": "OLED",
                "category": "Displays",
                "electrical_facts": {"i2c": "0x3C"},
            },
        ],
        "nets": [
            {"id": "net-led", "name": "LED_CTRL", "kind": "sig", "conns": [["mcu", "GPIO13"], ["led1", "A"]]},
            {"id": "net-btn", "name": "BTN_IN", "kind": "sig", "conns": [["mcu", "GPIO34"], ["btn1", "OUT"]]},
            {"id": "net-sda", "name": "I2C_SDA", "kind": "i2c", "conns": [["mcu", "GPIO21"], ["oled", "SDA"]]},
            {"id": "net-scl", "name": "I2C_SCL", "kind": "i2c", "conns": [["mcu", "GPIO22"], ["oled", "SCL"]]},
            {"id": "net-3v3", "name": "3V3", "kind": "v33", "conns": [["mcu", "3V3"], ["oled", "VCC"]]},
        ],
    }


def _sample_pico_project() -> dict:
    return {
        "id": "p-pico",
        "name": "Pico Blinker",
        "code_language": "",
        "code_source": "",
        "items": [
            {
                "ref": "mcu",
                "role": "mcu",
                "name": "Raspberry Pi Pico 2",
                "label": "Pico 2",
                "category": "Microcontrollers",
            },
            {
                "ref": "led",
                "role": "periph",
                "name": "Green LED",
                "label": "Green LED",
                "category": "Passives",
            },
        ],
        "nets": [
            {"id": "net-led", "name": "LED", "kind": "sig", "conns": [["mcu", "GP15"], ["led", "A"]]},
        ],
    }


def _sample_uno_project() -> dict:
    return {
        "id": "p-uno",
        "name": "Uno Reader",
        "code_language": "",
        "code_source": "",
        "items": [
            {
                "ref": "mcu",
                "role": "mcu",
                "name": "Arduino Uno",
                "label": "Uno",
                "category": "Microcontrollers",
            },
            {
                "ref": "pot",
                "role": "periph",
                "name": "10k Potentiometer",
                "label": "Pot",
                "category": "Passives",
            },
        ],
        "nets": [
            {"id": "net-pot", "name": "POT_WIPER", "kind": "sig", "conns": [["mcu", "A0"], ["pot", "SIG"]]},
        ],
    }


class ProjectCodeAnalyzerTests(unittest.TestCase):
    def test_wiring_summary_excludes_power_pins(self) -> None:
        summary = build_wiring_summary(_sample_esp32_project())
        self.assertEqual(summary["board_family"], "esp32")
        pins = [p["pin"] for p in summary["wired_pins"]]
        self.assertEqual(pins, ["GPIO13", "GPIO34", "GPIO21", "GPIO22"])
        self.assertNotIn("3V3", pins)

    def test_generate_arduino_starter_and_clean_audit(self) -> None:
        proj = _sample_esp32_project()
        gen = generate_starter_code(proj, language="arduino")
        self.assertEqual(gen["language"], "arduino")
        self.assertIn("#include <Wire.h>", gen["code"])
        self.assertIn("Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);", gen["code"])
        self.assertIn("0x3C", gen["code"])
        # Generated starter should match all 4 wired pins cleanly with 0 dangers
        self.assertTrue(gen["analysis"]["ok"])
        self.assertEqual(gen["analysis"]["matched_pin_count"], 4)
        self.assertEqual(gen["analysis"]["danger_count"], 0)

    def test_generate_micropython_starter_for_pico(self) -> None:
        proj = _sample_pico_project()
        gen = generate_starter_code(proj)
        self.assertEqual(gen["language"], "micropython")
        self.assertIn("PIN_GREEN_LED = 15", gen["code"])
        self.assertTrue(gen["analysis"]["ok"])
        self.assertEqual(gen["analysis"]["matched_pin_count"], 1)

    def test_detects_input_only_output_and_unwired_pin(self) -> None:
        proj = _sample_esp32_project()
        code = """
        #define BAD_OUT 34
        #define UNWIRED 14
        void setup() {
          pinMode(BAD_OUT, OUTPUT);
          digitalWrite(BAD_OUT, HIGH);
          pinMode(UNWIRED, OUTPUT);
          // digitalWrite(12, HIGH);  // commented out, must be ignored
        }
        """
        res = analyze_project_code(proj, code_source=code, code_language="arduino")
        self.assertFalse(res["ok"])
        codes = [i["code"] for i in res["issues"]]
        self.assertIn("input_only_output", codes)
        self.assertIn("unwired_pin", codes)
        self.assertNotIn("strapping_pin", codes)  # GPIO12 was commented out

    def test_uno_rejects_micropython(self) -> None:
        proj = _sample_uno_project()
        res = analyze_project_code(proj, code_source="from machine import Pin\np = Pin(0)", code_language="micropython")
        self.assertFalse(res["ok"])
        self.assertTrue(any(i["code"] == "unsupported_language" for i in res["issues"]))

    def test_micropython_symbol_resolution(self) -> None:
        proj = _sample_pico_project()
        code = """
        from machine import Pin
        LED_PIN = 15
        led = Pin(LED_PIN, Pin.OUT)
        """
        res = analyze_project_code(proj, code_source=code, code_language="micropython")
        self.assertTrue(res["ok"])
        self.assertEqual(res["matched_pin_count"], 1)
        self.assertEqual(res["pin_map"][0]["pin"], "GP15")
        self.assertTrue(res["pin_map"][0]["used_in_code"])


class WokwiExportTests(unittest.TestCase):
    def test_esp32_wokwi_diagram_and_auto_ground(self) -> None:
        proj = _sample_esp32_project()
        bundle = export_wokwi_project(proj, code_language="arduino")
        self.assertEqual(bundle["wokwi_board_type"], "board-esp32-devkit-c-v4")
        self.assertEqual(bundle["code_filename"], "sketch.ino")
        self.assertTrue(bundle["used_starter_code"])
        types = {p["id"]: p["type"] for p in bundle["diagram"]["parts"]}
        self.assertEqual(types["mcu"], "board-esp32-devkit-c-v4")
        self.assertEqual(types["led1"], "wokwi-led")
        self.assertEqual(types["btn1"], "wokwi-pushbutton")
        self.assertEqual(types["oled"], "board-ssd1306")

        conns = {(c[0], c[1]) for c in bundle["diagram"]["connections"]}
        self.assertIn(("mcu:13", "led1:A"), conns)
        self.assertIn(("mcu:21", "oled:SDA"), conns)
        self.assertIn(("mcu:22", "oled:SCL"), conns)
        # Auto-grounding adds GND wires for mapped peripherals
        self.assertTrue(any("GND.1" in (a + b) and "led1:C" in (a + b) for a, b in conns))

    def test_pico_micropython_zip_bundle(self) -> None:
        proj = _sample_pico_project()
        proj["code_language"] = "micropython"
        proj["code_source"] = "from machine import Pin\nled = Pin(15, Pin.OUT)\nled.on()\n"
        bundle = export_wokwi_project(proj)
        self.assertEqual(bundle["wokwi_board_type"], "board-pi-pico")
        self.assertEqual(bundle["code_filename"], "main.py")
        self.assertFalse(bundle["used_starter_code"])

        zbytes = build_wokwi_zip_bytes(bundle)
        with zipfile.ZipFile(io.BytesIO(zbytes), "r") as zf:
            names = set(zf.namelist())
            self.assertEqual(names, {"diagram.json", "main.py", "wokwi.toml", "README.txt"})
            parsed = json.loads(zf.read("diagram.json").decode("utf-8"))
            self.assertEqual(parsed["editor"], "wokwi")
            self.assertEqual(zf.read("main.py").decode("utf-8"), proj["code_source"])

    def test_unmapped_exotic_part_is_reported_cleanly(self) -> None:
        proj = _sample_uno_project()
        proj["items"].append(
            {
                "ref": "rfid",
                "role": "periph",
                "name": "RC522 RFID Reader",
                "label": "RC522",
                "category": "Sensors",
            }
        )
        bundle = export_wokwi_project(proj, code_language="micropython")
        # Uno falls back to Arduino C++ with a warning
        self.assertEqual(bundle["code_language"], "arduino")
        self.assertEqual(bundle["code_filename"], "sketch.ino")
        self.assertTrue(any(u["ref"] == "rfid" for u in bundle["unmapped_parts"]))
        self.assertTrue(any("Arduino Uno" in w for w in bundle["warnings"]))


if __name__ == "__main__":
    unittest.main()
