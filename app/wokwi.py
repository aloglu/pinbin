"""Export a Pinbin project (wiring map + firmware code) to a Wokwi simulation bundle.

Generates:
- diagram.json (Wokwi parts, layout, and connections with auto-grounding)
- sketch.ino or main.py (saved project code or generated starter code)
- wokwi.toml (for VS Code Wokwi extension)
- README.txt (plain-English steps for beginners)
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

from app.project_code import (
    CODE_LANGUAGES,
    default_language_for_project,
    detect_board_family,
    expand_pin_tokens,
    find_project_mcu,
    generate_starter_code,
    normalize_pin_name,
)

WOKWI_BOARDS: dict[str, dict[str, Any]] = {
    "esp32": {
        "type": "board-esp32-devkit-c-v4",
        "gnd_pin": "GND.1",
        "v33_pin": "3V3",
        "v5_pin": "5V",
        "new_url_arduino": "https://wokwi.com/projects/new/esp32",
        "new_url_micropython": "https://wokwi.com/projects/new/micropython-esp32",
    },
    "c3": {
        "type": "board-esp32-c3-devkitm-1",
        "gnd_pin": "GND.1",
        "v33_pin": "3V3",
        "v5_pin": "5V",
        "new_url_arduino": "https://wokwi.com/projects/new/esp32-c3",
        "new_url_micropython": "https://wokwi.com/projects/new/micropython-esp32",
    },
    "pico": {
        "type": "board-pi-pico",
        "gnd_pin": "GND.1",
        "v33_pin": "3V3",
        "v5_pin": "VBUS",
        "new_url_arduino": "https://wokwi.com/projects/new/pi-pico",
        "new_url_micropython": "https://wokwi.com/projects/new/micropython-pi-pico",
    },
    "uno": {
        "type": "wokwi-arduino-uno",
        "gnd_pin": "GND.1",
        "v33_pin": "3.3V",
        "v5_pin": "5V",
        "new_url_arduino": "https://wokwi.com/projects/new/arduino-uno",
        "new_url_micropython": "https://wokwi.com/projects/new/arduino-uno",
    },
}

NET_COLORS: dict[str, str] = {
    "bat": "orange",
    "v5": "red",
    "v33": "#e67e22",
    "i2c": "blue",
    "spi": "purple",
    "sig": "green",
}


def _slug_id(raw: str, fallback: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", (raw or "").strip()).strip("_")
    return (s or fallback)[:24]


def _detect_led_color(text: str) -> str:
    low = text.lower()
    for col in ("green", "blue", "yellow", "white", "orange", "purple", "red"):
        if col in low:
            return col
    return "red"


def _map_peripheral_to_wokwi(item: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """Map a Pinbin project item to a Wokwi part descriptor, or return (None, reason)."""
    name = str(item.get("name") or "")
    label = str(item.get("label") or "")
    sub = str(item.get("subtitle") or "")
    cat = str(item.get("category") or "")
    text = f"{name} {label} {sub}".lower()

    if "ssd1306" in text or "oled" in text:
        return (
            {
                "type": "board-ssd1306",
                "attrs": {"i2cAddress": str((item.get("electrical_facts") or {}).get("i2c") or "0x3c").lower()},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "VIN": "VCC", "3V3": "VCC", "5V": "VCC", "GND": "GND", "SDA": "SDA", "SCL": "SCL"},
            },
            "",
        )
    if "1602" in text or "16x2" in text or "lcd" in text:
        return (
            {
                "type": "wokwi-lcd1602",
                "attrs": {"pins": "i2c"},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "5V": "VCC", "GND": "GND", "SDA": "SDA", "SCL": "SCL"},
            },
            "",
        )
    if "neopixel" in text or "ws2812" in text or "ws2811" in text:
        return (
            {
                "type": "wokwi-neopixel",
                "attrs": {},
                "gnd_pin": "VSS",
                "pin_map": {"VCC": "VDD", "5V": "VDD", "VDD": "VDD", "GND": "VSS", "VSS": "VSS", "DIN": "DIN", "DI": "DIN", "DATA": "DIN", "IN": "DIN", "DOUT": "DOUT"},
            },
            "",
        )
    if "rgb" in text and "led" in text:
        return (
            {
                "type": "wokwi-rgb-led",
                "attrs": {"common": "cathode"},
                "gnd_pin": "COM",
                "pin_map": {"R": "R", "RED": "R", "G": "G", "GREEN": "G", "B": "B", "BLUE": "B", "GND": "COM", "COM": "COM"},
            },
            "",
        )
    if "led" in text and "oled" not in text:
        return (
            {
                "type": "wokwi-led",
                "attrs": {"color": _detect_led_color(text)},
                "gnd_pin": "C",
                "pin_map": {"A": "A", "ANODE": "A", "+": "A", "IN": "A", "SIG": "A", "C": "C", "K": "C", "CATHODE": "C", "-": "C", "GND": "C"},
            },
            "",
        )
    if "button" in text or "tactile" in text or "btn" in text:
        return (
            {
                "type": "wokwi-pushbutton",
                "attrs": {"color": "green"},
                "gnd_pin": "2.l",
                "pin_map": {"OUT": "1.l", "SIG": "1.l", "S": "1.l", "1": "1.l", "IN": "1.l", "GND": "2.l", "2": "2.l"},
            },
            "",
        )
    if "switch" in text:
        return (
            {
                "type": "wokwi-slide-switch",
                "attrs": {},
                "gnd_pin": "3",
                "pin_map": {"1": "1", "2": "2", "OUT": "2", "COM": "2", "SIG": "2", "3": "3", "GND": "3"},
            },
            "",
        )
    if "potentiometer" in text or "pot " in text or text.strip() == "pot" or "trimpot" in text:
        return (
            {
                "type": "wokwi-potentiometer",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "3V3": "VCC", "5V": "VCC", "SIG": "SIG", "OUT": "SIG", "WIPER": "SIG", "AO": "SIG", "AOUT": "SIG", "GND": "GND"},
            },
            "",
        )
    if "dht22" in text or "dht11" in text or "am2302" in text:
        return (
            {
                "type": "wokwi-dht22",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "3V3": "VCC", "5V": "VCC", "DATA": "SDA", "OUT": "SDA", "SIG": "SDA", "SDA": "SDA", "GND": "GND"},
            },
            "",
        )
    if "hc-sr04" in text or "hcsr04" in text or "ultrasonic" in text:
        return (
            {
                "type": "wokwi-hc-sr04",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "5V": "VCC", "TRIG": "TRIG", "TRIGGER": "TRIG", "ECHO": "ECHO", "GND": "GND"},
            },
            "",
        )
    if "pir" in text or "hc-sr501" in text or "motion" in text:
        return (
            {
                "type": "wokwi-pir-motion-sensor",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "5V": "VCC", "3V3": "VCC", "OUT": "OUT", "SIG": "OUT", "DATA": "OUT", "GND": "GND"},
            },
            "",
        )
    if "ldr" in text or "photoresistor" in text or "light sensor" in text:
        return (
            {
                "type": "wokwi-photoresistor-sensor",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "3V3": "VCC", "5V": "VCC", "GND": "GND", "DO": "DO", "AO": "AO", "AOUT": "AO", "OUT": "AO"},
            },
            "",
        )
    if "servo" in text or "sg90" in text or "sg-90" in text or "mg996" in text:
        return (
            {
                "type": "wokwi-servo",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"PWM": "PWM", "SIG": "PWM", "SIGNAL": "PWM", "IN": "PWM", "DATA": "PWM", "VCC": "V+", "5V": "V+", "V+": "V+", "GND": "GND"},
            },
            "",
        )
    if "buzzer" in text or "piezo" in text:
        return (
            {
                "type": "wokwi-buzzer",
                "attrs": {},
                "gnd_pin": "1",
                "pin_map": {"+": "2", "SIG": "2", "IN": "2", "IO": "2", "VCC": "2", "2": "2", "-": "1", "GND": "1", "1": "1"},
            },
            "",
        )
    if "relay" in text:
        return (
            {
                "type": "wokwi-relay-module",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "5V": "VCC", "IN": "IN", "SIG": "IN", "S": "IN", "GND": "GND"},
            },
            "",
        )
    if "ds1307" in text or "ds3231" in text or "rtc" in text:
        return (
            {
                "type": "wokwi-ds1307",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "5V", "5V": "5V", "3V3": "5V", "GND": "GND", "SDA": "SDA", "SCL": "SCL"},
            },
            "",
        )
    if "mpu6050" in text or "mpu-6050" in text or "gyro" in text or "accel" in text:
        return (
            {
                "type": "wokwi-mpu6050",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"VCC": "VCC", "3V3": "VCC", "5V": "VCC", "GND": "GND", "SDA": "SDA", "SCL": "SCL"},
            },
            "",
        )
    if "rotary" in text or "ky-040" in text or "encoder" in text:
        return (
            {
                "type": "wokwi-ky-040",
                "attrs": {},
                "gnd_pin": "GND",
                "pin_map": {"CLK": "CLK", "DT": "DT", "SW": "SW", "VCC": "VCC", "3V3": "VCC", "5V": "VCC", "GND": "GND"},
            },
            "",
        )
    if "resistor" in text:
        return (
            {
                "type": "wokwi-resistor",
                "attrs": {"value": "220"},
                "gnd_pin": "",
                "pin_map": {"1": "1", "2": "2", "A": "1", "B": "2", "IN": "1", "OUT": "2"},
            },
            "",
        )

    if str(item.get("role") or "") == "power" or "battery" in text or "lipo" in text or "li-po" in text or "charger" in text:
        return None, "Power/battery part omitted — Wokwi powers the microcontroller board directly over virtual USB."

    return None, (
        f"No exact Wokwi model for '{label or name}' ({cat or 'part'}). "
        "You can add a pushbutton or potentiometer in Wokwi as a stand-in to test your logic."
    )


def _wokwi_mcu_pin(pin_raw: str, board_family: str) -> str:
    toks = expand_pin_tokens(pin_raw)
    tok = toks[0] if toks else str(pin_raw or "").strip().upper()
    norm = normalize_pin_name(tok, board_family) or tok.upper()

    if board_family in ("esp32", "c3"):
        if norm in ("GND", "AGND"):
            return "GND.1"
        if norm in ("VIN", "5V", "VBUS"):
            return "5V"
        if norm in ("3V3", "3.3V"):
            return "3V3"
        m = re.fullmatch(r"GPIO(\d+)", norm)
        if m:
            return m.group(1)
        return norm

    if board_family == "pico":
        if norm in ("GND", "AGND"):
            return "GND.1"
        if norm in ("3V3", "3.3V"):
            return "3V3"
        if norm in ("5V", "VBUS"):
            return "VBUS"
        if norm == "VSYS":
            return "VSYS"
        return norm

    if board_family == "uno":
        if norm in ("GND", "AGND"):
            return "GND.1"
        if norm in ("3V3", "3.3V"):
            return "3.3V"
        if norm == "5V":
            return "5V"
        if norm == "VIN":
            return "VIN"
        m = re.fullmatch(r"D(\d+)", norm)
        if m:
            return m.group(1)
        return norm

    return norm


def _wokwi_periph_pin(pin_raw: str, spec: dict[str, Any]) -> str:
    clean = str(pin_raw or "").strip().upper()
    pin_map: dict[str, str] = spec.get("pin_map") or {}
    if clean in pin_map:
        return pin_map[clean]
    # Try first token if slash-separated
    tok = re.split(r"[,/\s]+", clean)[0] if clean else ""
    if tok in pin_map:
        return pin_map[tok]
    return clean or next(iter(pin_map.values()), "1")


def export_wokwi_project(
    project: dict[str, Any],
    code_language: str | None = None,
    include_starter_if_empty: bool = True,
) -> dict[str, Any]:
    """Convert a Pinbin project into a complete Wokwi simulation bundle."""
    proj_name = str(project.get("name") or "Pinbin Project").strip()
    mcu = find_project_mcu(project)
    mcu_ref = str(mcu.get("ref") or "mcu") if mcu else "mcu"
    mcu_label = str((mcu.get("label") or mcu.get("name")) if mcu else "Microcontroller")
    board_family = (
        detect_board_family(f"{mcu.get('name', '')} {mcu.get('label', '')} {mcu.get('subtitle', '')}") if mcu else ""
    )

    warnings: list[str] = []
    if board_family not in WOKWI_BOARDS:
        warnings.append(
            f"Could not match '{mcu_label}' to a specific Wokwi board — defaulted to ESP32 DevKit v4."
        )
        board_family = "esp32"

    board_info = WOKWI_BOARDS[board_family]
    lang = (code_language or project.get("code_language") or default_language_for_project(project)).strip().lower()
    if lang not in CODE_LANGUAGES:
        lang = "arduino"
    if board_family == "uno" and lang == "micropython":
        warnings.append("Arduino Uno only supports Arduino C++ in Wokwi — switched exported sketch to sketch.ino.")
        lang = "arduino"

    parts: list[dict[str, Any]] = [
        {
            "type": board_info["type"],
            "id": _slug_id(mcu_ref, "mcu"),
            "top": 0,
            "left": 0,
            "attrs": {},
        }
    ]
    mcu_wokwi_id = parts[0]["id"]

    ref_to_wokwi_id: dict[str, str] = {mcu_ref: mcu_wokwi_id}
    ref_to_spec: dict[str, dict[str, Any]] = {}
    mapped_parts: list[dict[str, Any]] = [
        {"ref": mcu_ref, "name": mcu_label, "wokwi_type": board_info["type"], "wokwi_id": mcu_wokwi_id}
    ]
    unmapped_parts: list[dict[str, Any]] = []

    used_ids: set[str] = {mcu_wokwi_id}
    periph_idx = 0
    for item in project.get("items") or []:
        ref = str(item.get("ref") or "")
        if not ref or ref == mcu_ref:
            continue
        if str(item.get("role") or "") == "material":
            continue
        spec, reason = _map_peripheral_to_wokwi(item)
        item_name = str(item.get("label") or item.get("name") or ref)
        if spec is None:
            unmapped_parts.append({"ref": ref, "name": item_name, "reason": reason})
            continue

        wid = _slug_id(ref, f"p{periph_idx + 1}")
        suffix = 2
        while wid in used_ids:
            wid = f"{_slug_id(ref, 'p')}_{suffix}"
            suffix += 1
        used_ids.add(wid)

        col = periph_idx % 2
        row = periph_idx // 2
        left = 290 + col * 210
        top = -20 + row * 145
        periph_idx += 1

        parts.append(
            {
                "type": spec["type"],
                "id": wid,
                "top": top,
                "left": left,
                "attrs": dict(spec.get("attrs") or {}),
            }
        )
        ref_to_wokwi_id[ref] = wid
        ref_to_spec[ref] = spec
        mapped_parts.append({"ref": ref, "name": item_name, "wokwi_type": spec["type"], "wokwi_id": wid})

    # Convert Pinbin nets into Wokwi point-to-point connections
    connections: list[list[Any]] = []
    seen_conns: set[tuple[str, str]] = set()
    grounded_refs: set[str] = set()

    for net in project.get("nets") or []:
        kind = str(net.get("kind") or "sig")
        color = NET_COLORS.get(kind, "green")
        endpoints: list[tuple[str, str]] = []
        for pair in net.get("conns") or []:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            ref, pin_raw = str(pair[0]), str(pair[1] or "")
            if ref not in ref_to_wokwi_id:
                continue
            wid = ref_to_wokwi_id[ref]
            if ref == mcu_ref:
                wpin = _wokwi_mcu_pin(pin_raw, board_family)
            else:
                spec = ref_to_spec[ref]
                wpin = _wokwi_periph_pin(pin_raw, spec)
                if spec.get("gnd_pin") and wpin == spec["gnd_pin"]:
                    grounded_refs.add(ref)
            endpoints.append((wid, wpin))

        if len(endpoints) < 2:
            continue
        # Connect first endpoint (prefer MCU if present) to each remaining endpoint
        mcu_ep = next((ep for ep in endpoints if ep[0] == mcu_wokwi_id), endpoints[0])
        for ep in endpoints:
            if ep == mcu_ep:
                continue
            a = f"{mcu_ep[0]}:{mcu_ep[1]}"
            b = f"{ep[0]}:{ep[1]}"
            key = (min(a, b), max(a, b))
            if key not in seen_conns:
                seen_conns.add(key)
                connections.append([a, b, color, []])

    # Auto-add GND wires for mapped peripherals (Pinbin's map intentionally omits GND)
    auto_grounded = 0
    for ref, spec in ref_to_spec.items():
        gnd_pin = spec.get("gnd_pin")
        if not gnd_pin or ref in grounded_refs:
            continue
        wid = ref_to_wokwi_id[ref]
        a = f"{wid}:{gnd_pin}"
        b = f"{mcu_wokwi_id}:{board_info['gnd_pin']}"
        key = (min(a, b), max(a, b))
        if key not in seen_conns:
            seen_conns.add(key)
            connections.append([a, b, "black", []])
            auto_grounded += 1

    if auto_grounded:
        warnings.append(
            f"Auto-added {auto_grounded} black GND wire(s) to {mcu_wokwi_id}:{board_info['gnd_pin']} "
            "(Pinbin's wiring map omits GND for clarity, but Wokwi needs them)."
        )

    diagram = {
        "version": 1,
        "author": f"Pinbin ({proj_name})",
        "editor": "wokwi",
        "parts": parts,
        "connections": connections,
        "dependencies": {},
    }
    diagram_json = json.dumps(diagram, indent=2) + "\n"

    code_source = str(project.get("code_source") or "")
    used_starter = False
    if not code_source.strip() and include_starter_if_empty:
        gen = generate_starter_code(project, language=lang)
        code_source = gen["code"]
        lang = gen["language"]
        used_starter = True

    code_filename = "main.py" if lang == "micropython" else "sketch.ino"
    wokwi_new_url = (
        board_info["new_url_micropython"] if lang == "micropython" else board_info["new_url_arduino"]
    )
    wokwi_toml = (
        "[wokwi]\n"
        "version = 1\n"
        f"# Exported from Pinbin: {proj_name}\n"
        f"# Board: {board_info['type']} | Language: {lang}\n"
    )
    readme_lines = [
        f"{proj_name} — Wokwi Simulation Bundle (exported from Pinbin)",
        "=" * 60,
        "",
        "Quick start on wokwi.com:",
        f"1. Open a new Wokwi project for your board: {wokwi_new_url}",
        "2. Click the 'diagram.json' tab in Wokwi and replace its contents with diagram.json from this bundle.",
        f"3. Paste {code_filename} into the code tab ({code_filename}).",
        "4. Press the green Play button to simulate!",
        "",
        f"Mapped parts ({len(mapped_parts)}): " + ", ".join(f"{p['name']} ({p['wokwi_type']})" for p in mapped_parts),
    ]
    if unmapped_parts:
        readme_lines += ["", "Parts needing a stand-in or omitted:"]
        for u in unmapped_parts:
            readme_lines.append(f"- {u['name']}: {u['reason']}")
    if warnings:
        readme_lines += ["", "Notes:"]
        for w in warnings:
            readme_lines.append(f"- {w}")

    return {
        "project_id": str(project.get("id") or ""),
        "project_name": proj_name,
        "board_family": board_family,
        "wokwi_board_type": board_info["type"],
        "wokwi_new_url": wokwi_new_url,
        "code_language": lang,
        "code_filename": code_filename,
        "code_source": code_source,
        "used_starter_code": used_starter,
        "diagram": diagram,
        "diagram_json": diagram_json,
        "wokwi_toml": wokwi_toml,
        "readme": "\n".join(readme_lines) + "\n",
        "mapped_parts": mapped_parts,
        "unmapped_parts": unmapped_parts,
        "warnings": warnings,
    }


def build_wokwi_zip_bytes(bundle: dict[str, Any]) -> bytes:
    """Package a Wokwi bundle into a clean in-memory ZIP archive."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("diagram.json", bundle["diagram_json"])
        zf.writestr(bundle["code_filename"], bundle["code_source"])
        zf.writestr("wokwi.toml", bundle["wokwi_toml"])
        zf.writestr("README.txt", bundle["readme"])
    return buf.getvalue()
