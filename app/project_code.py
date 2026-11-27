"""Project firmware code analysis, pin-to-wiring verification, and starter code generation.

Shared by REST API endpoints and MCP tools so the web UI and AI assistants always
produce identical pin checks, net mappings, and starter sketches.
"""
from __future__ import annotations

import re
from typing import Any

CODE_LANGUAGES = ("arduino", "micropython")
MAX_CODE_CHARS = 200_000

BOARD_SPECS: dict[str, dict[str, Any]] = {
    "c3": {
        "title": "ESP32-C3 SuperMini",
        "prefix": "GPIO",
        "default_language": "arduino",
        "supports_micropython": True,
        "valid_pins": {
            "5V", "GND", "3V3",
            "GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7",
            "GPIO8", "GPIO9", "GPIO10", "GPIO20", "GPIO21",
        },
        "gpio_nums": {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21},
        "input_only": set(),
        "strap": {"GPIO2", "GPIO8", "GPIO9"},
        "serial": set(),
        "adc": {"GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5"},
        "default_i2c": ("GPIO8", "GPIO9"),
        "builtin_led": "GPIO8",
        "aliases": {"SDA": "GPIO8", "SCL": "GPIO9", "LED_BUILTIN": "GPIO8"},
    },
    "esp32": {
        "title": "ESP32 30-pin",
        "prefix": "GPIO",
        "default_language": "arduino",
        "supports_micropython": True,
        "valid_pins": {
            "EN", "VIN", "GND", "3V3",
            "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO12", "GPIO13", "GPIO14", "GPIO15",
            "GPIO16", "GPIO17", "GPIO18", "GPIO19", "GPIO21", "GPIO22", "GPIO23", "GPIO25",
            "GPIO26", "GPIO27", "GPIO32", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO39",
            "TX0", "RX0", "TX2", "RX2", "VP", "VN",
        },
        "gpio_nums": {
            1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19,
            21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
        },
        "input_only": {"GPIO34", "GPIO35", "GPIO36", "GPIO39"},
        "strap": {"GPIO0", "GPIO2", "GPIO5", "GPIO12", "GPIO15"},
        "serial": {"GPIO1", "GPIO3"},
        "adc": {"GPIO32", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO39", "GPIO2", "GPIO4", "GPIO12", "GPIO13", "GPIO14", "GPIO15", "GPIO25", "GPIO26", "GPIO27"},
        "default_i2c": ("GPIO21", "GPIO22"),
        "builtin_led": "GPIO2",
        "aliases": {
            "TX0": "GPIO1", "RX0": "GPIO3", "TX2": "GPIO17", "RX2": "GPIO16",
            "VP": "GPIO36", "VN": "GPIO39", "SDA": "GPIO21", "SCL": "GPIO22",
            "LED_BUILTIN": "GPIO2",
        },
    },
    "pico": {
        "title": "Raspberry Pi Pico 2",
        "prefix": "GP",
        "default_language": "micropython",
        "supports_micropython": True,
        "valid_pins": {
            "VBUS", "VSYS", "GND", "3V3_EN", "3V3", "ADC_VREF", "RUN", "AGND",
            *(f"GP{i}" for i in range(23)), "GP25", "GP26", "GP27", "GP28",
        },
        "gpio_nums": {*(range(23)), 25, 26, 27, 28},
        "input_only": set(),
        "strap": set(),
        "serial": set(),
        "adc": {"GP26", "GP27", "GP28"},
        "default_i2c": ("GP4", "GP5"),
        "builtin_led": "GP25",
        "aliases": {"LED_BUILTIN": "GP25", "LED": "GP25", "A0": "GP26", "A1": "GP27", "A2": "GP28"},
    },
    "uno": {
        "title": "Arduino Uno",
        "prefix": "D",
        "default_language": "arduino",
        "supports_micropython": False,
        "valid_pins": {
            "IOREF", "RESET", "3.3V", "3V3", "5V", "GND", "VIN", "AREF", "SDA", "SCL",
            *(f"A{i}" for i in range(6)), *(f"D{i}" for i in range(14)),
        },
        "gpio_nums": set(range(20)),
        "input_only": set(),
        "strap": set(),
        "serial": {"D0", "D1"},
        "adc": {f"A{i}" for i in range(6)},
        "default_i2c": ("A4", "A5"),
        "builtin_led": "D13",
        "aliases": {
            "SDA": "A4", "SCL": "A5", "LED_BUILTIN": "D13",
            "TX": "D1", "RX": "D0",
            "14": "A0", "15": "A1", "16": "A2", "17": "A3", "18": "A4", "19": "A5",
        },
    },
}

POWER_PIN_NAMES = {
    "5V", "3V3", "3.3V", "VIN", "VBUS", "VSYS", "GND", "AGND",
    "VCC", "BAT", "BAT+", "BAT-", "EN", "RUN", "RESET", "IOREF", "AREF", "3V3_EN", "ADC_VREF",
}


def detect_board_family(name: str) -> str:
    low = (name or "").lower()
    if "esp32-c3" in low or "esp32 c3" in low:
        return "c3"
    if "esp32" in low or "esp-32" in low:
        return "esp32"
    if "pico" in low or "rp2350" in low or "rp2040" in low:
        return "pico"
    if "uno" in low or "atmega328" in low:
        return "uno"
    return ""


def find_project_mcu(project: dict[str, Any]) -> dict[str, Any] | None:
    items = project.get("items") or []
    for it in items:
        if str(it.get("role") or "").lower() == "mcu":
            return it
    for it in items:
        if str(it.get("category") or "") == "Microcontrollers":
            return it
    return items[0] if items else None


def default_language_for_project(project: dict[str, Any]) -> str:
    saved = str(project.get("code_language") or "").strip().lower()
    if saved in CODE_LANGUAGES:
        return saved
    mcu = find_project_mcu(project)
    if mcu:
        family = detect_board_family(f"{mcu.get('name', '')} {mcu.get('label', '')} {mcu.get('subtitle', '')}")
        spec = BOARD_SPECS.get(family)
        if spec:
            return str(spec["default_language"])
    return "arduino"


def expand_pin_tokens(pin_str: str) -> list[str]:
    raw = (pin_str or "").strip()
    if not raw:
        return []
    m = re.match(r"^(GPIO|GP|D|A)(\d+(?:/\d+)+)$", raw, re.IGNORECASE)
    if m:
        prefix = m.group(1).upper()
        return [f"{prefix}{num}" for num in m.group(2).split("/")]
    return [tok.strip().upper() for tok in re.split(r"[,/]", raw) if tok.strip()]


def normalize_pin_name(raw_token: str, board_family: str) -> str | None:
    """Normalize a pin token (e.g. '8', 'GPIO8', 'GP4', 'A0', 'LED_BUILTIN') to canonical board form."""
    tok = str(raw_token or "").strip().strip("'\"").upper()
    if not tok:
        return None
    spec = BOARD_SPECS.get(board_family)
    if spec and tok in spec["aliases"]:
        return spec["aliases"][tok]

    # Direct numeric pin (e.g. '8', '21')
    if re.fullmatch(r"\d{1,2}", tok):
        num = int(tok)
        if board_family == "uno":
            if 14 <= num <= 19:
                return f"A{num - 14}"
            return f"D{num}"
        if board_family == "pico":
            return f"GP{num}"
        if board_family in ("esp32", "c3"):
            return f"GPIO{num}"
        return f"GPIO{num}"

    # Explicit GPIO / GP / D / A prefixes
    m = re.fullmatch(r"(GPIO|GP|D|A)(\d{1,2})", tok)
    if m:
        pref, num_s = m.group(1), m.group(2)
        num = int(num_s)
        if board_family == "uno":
            if pref == "A":
                return f"A{num}"
            return f"D{num}"
        if board_family == "pico":
            if pref == "A" and num in (0, 1, 2):
                return f"GP{26 + num}"
            return f"GP{num}"
        if board_family in ("esp32", "c3"):
            if pref in ("GPIO", "GP", "D"):
                return f"GPIO{num}"
            return tok
        return f"{pref}{num}"

    if tok in POWER_PIN_NAMES:
        return tok
    if spec and tok in spec["valid_pins"]:
        return tok
    return None


def _pin_number_literal(canonical_pin: str, board_family: str, language: str) -> str:
    """Convert canonical pin name to idiomatic code literal (e.g. 'GPIO8' -> '8', 'A4' -> 'A4')."""
    p = canonical_pin.upper()
    if board_family == "uno" and re.fullmatch(r"A\d+", p):
        return p
    m = re.fullmatch(r"(?:GPIO|GP|D)(\d+)", p)
    if m:
        return m.group(1)
    if p == "LED" and board_family == "pico" and language == "micropython":
        return "'LED'"
    return f'"{p}"'


def _strip_comments_preserve_lines(code: str, language: str) -> list[str]:
    """Strip comments while preserving exact 1-based line indices."""
    if language == "micropython":
        out: list[str] = []
        in_triple: str | None = None
        for line in code.splitlines():
            buf: list[str] = []
            i = 0
            n = len(line)
            in_str: str | None = None
            while i < n:
                ch = line[i]
                if in_triple:
                    if line[i : i + 3] == in_triple:
                        in_triple = None
                        i += 3
                    else:
                        i += 1
                    continue
                if in_str:
                    buf.append(ch)
                    if ch == "\\" and i + 1 < n:
                        buf.append(line[i + 1])
                        i += 2
                        continue
                    if ch == in_str:
                        in_str = None
                    i += 1
                    continue
                if line[i : i + 3] in ('"""', "'''"):
                    in_triple = line[i : i + 3]
                    i += 3
                    continue
                if ch in ('"', "'"):
                    in_str = ch
                    buf.append(ch)
                    i += 1
                    continue
                if ch == "#":
                    break
                buf.append(ch)
                i += 1
            out.append("".join(buf))
        return out

    # Arduino C / C++
    out_c: list[str] = []
    in_block = False
    for line in code.splitlines():
        buf = []
        i = 0
        n = len(line)
        in_str = None
        while i < n:
            ch = line[i]
            if in_block:
                if line[i : i + 2] == "*/":
                    in_block = False
                    i += 2
                else:
                    i += 1
                continue
            if in_str:
                buf.append(ch)
                if ch == "\\" and i + 1 < n:
                    buf.append(line[i + 1])
                    i += 2
                    continue
                if ch == in_str:
                    in_str = None
                i += 1
                continue
            if line[i : i + 2] == "/*":
                in_block = True
                i += 2
                continue
            if line[i : i + 2] == "//":
                break
            if ch in ('"', "'"):
                in_str = ch
                buf.append(ch)
                i += 1
                continue
            buf.append(ch)
            i += 1
        out_c.append("".join(buf))
    return out_c


def _extract_symbols(clean_lines: list[str], language: str, board_family: str) -> dict[str, tuple[str, int]]:
    """Extract pin constant definitions: symbol -> (canonical_pin, line_no)."""
    symbols: dict[str, tuple[str, int]] = {}
    if language == "micropython":
        pat_assign = re.compile(
            r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:const\(\s*)?(\d{1,2}|['\"](?:GP|GPIO|D|A)?\d{1,2}['\"]|['\"]LED['\"])(?:\s*\))?\s*$"
        )
        pat_pin_obj = re.compile(
            r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:machine\.)?Pin\(\s*([^,\)]+)"
        )
        for idx, line in enumerate(clean_lines, start=1):
            m = pat_assign.match(line)
            if m:
                sym, raw_val = m.group(1), m.group(2)
                pin = normalize_pin_name(raw_val, board_family)
                if pin:
                    symbols[sym] = (pin, idx)
                continue
            m2 = pat_pin_obj.match(line)
            if m2:
                sym, arg = m2.group(1), m2.group(2).strip()
                pin = symbols[arg][0] if arg in symbols else normalize_pin_name(arg, board_family)
                if pin:
                    symbols[sym] = (pin, idx)
        return symbols

    # Arduino C/C++
    pat_define = re.compile(r"^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+)\b")
    pat_const = re.compile(
        r"^\s*(?:static\s+)?(?:const|constexpr)\s+(?:unsigned\s+)?(?:int|uint8_t|int8_t|byte|short|long|auto)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z0-9_]+)\s*;"
    )
    for idx, line in enumerate(clean_lines, start=1):
        m = pat_define.match(line) or pat_const.match(line)
        if m:
            sym, raw_val = m.group(1), m.group(2)
            # Only treat as a pin constant if it looks like a pin name or has a pin-like symbol name
            pin = normalize_pin_name(raw_val, board_family)
            if pin:
                symbols[sym] = (pin, idx)
    return symbols


def _resolve_arg_to_pin(arg: str, symbols: dict[str, tuple[str, int]], board_family: str) -> tuple[str | None, str]:
    tok = arg.strip()
    if not tok:
        return None, ""
    # Strip Pin(...) wrapper if present
    m_pin = re.fullmatch(r"(?:machine\.)?Pin\(\s*([^,\)]+)(?:,.*)?\)", tok)
    if m_pin:
        tok = m_pin.group(1).strip()
    if tok in symbols:
        return symbols[tok][0], tok
    pin = normalize_pin_name(tok, board_family)
    if pin:
        return pin, tok
    return None, tok


def extract_code_pin_references(
    code_source: str,
    language: str,
    board_family: str,
) -> list[dict[str, Any]]:
    """Extract pin references with 1-based line numbers and usage modes from Arduino or MicroPython code."""
    if not code_source.strip():
        return []
    clean_lines = _strip_comments_preserve_lines(code_source, language)
    symbols = _extract_symbols(clean_lines, language, board_family)
    refs: list[dict[str, Any]] = []
    seen_line_pin_mode: set[tuple[int, str, str]] = set()

    def add_ref(line_no: int, raw_arg: str, mode: str) -> None:
        pin, sym = _resolve_arg_to_pin(raw_arg, symbols, board_family)
        if not pin or pin in POWER_PIN_NAMES:
            return
        key = (line_no, pin, mode)
        if key in seen_line_pin_mode:
            return
        seen_line_pin_mode.add(key)
        refs.append({"line": line_no, "pin": pin, "symbol": sym, "mode": mode})

    if language == "micropython":
        re_pin = re.compile(r"\b(?:machine\.)?Pin\(\s*([^,\)]+)(?:,\s*([^\)]*))?\)")
        re_pwm = re.compile(r"\b(?:machine\.)?PWM\(\s*((?:machine\.)?Pin\([^\)]+\)|[A-Za-z_][A-Za-z0-9_]*|\d+)")
        re_adc = re.compile(r"\b(?:machine\.)?ADC\(\s*((?:machine\.)?Pin\([^\)]+\)|[A-Za-z_][A-Za-z0-9_]*|\d+)")
        re_kw_pin = re.compile(
            r"\b(sda|scl|sck|mosi|miso|cs|tx|rx)\s*=\s*((?:machine\.)?Pin\([^\)]+\)|[A-Za-z_][A-Za-z0-9_]*|\d+)"
        )
        re_neopixel = re.compile(r"\bNeoPixel\(\s*((?:machine\.)?Pin\([^\)]+\)|[A-Za-z_][A-Za-z0-9_]*)")
        for idx, line in enumerate(clean_lines, start=1):
            for m in re_kw_pin.finditer(line):
                kw = m.group(1).lower()
                mode = "i2c" if kw in ("sda", "scl") else "spi" if kw in ("sck", "mosi", "miso", "cs") else "uart"
                add_ref(idx, m.group(2), mode)
            for m in re_pwm.finditer(line):
                add_ref(idx, m.group(1), "pwm")
            for m in re_adc.finditer(line):
                add_ref(idx, m.group(1), "adc")
            for m in re_neopixel.finditer(line):
                add_ref(idx, m.group(1), "output")
            for m in re_pin.finditer(line):
                arg = m.group(1)
                rest = (m.group(2) or "").upper()
                if "PIN.OUT" in rest or "OPEN_DRAIN" in rest:
                    mode = "output"
                elif "PIN.IN" in rest:
                    mode = "input"
                else:
                    mode = "ref"
                add_ref(idx, arg, mode)
    else:
        # Arduino C / C++
        re_pinmode = re.compile(r"\bpinMode\s*\(\s*([^,\)]+)\s*,\s*([^\)]+)\)")
        re_dwrite = re.compile(r"\bdigitalWrite\s*\(\s*([^,\)]+)\s*,")
        re_dread = re.compile(r"\bdigitalRead\s*\(\s*([^\)]+)\)")
        re_aread = re.compile(r"\banalogRead\s*\(\s*([^\)]+)\)")
        re_awrite = re.compile(r"\b(?:analogWrite|ledcAttach|ledcAttachPin|tone|noTone)\s*\(\s*([^,\)]+)")
        re_attach = re.compile(r"\.\s*attach\s*\(\s*([^,\)]+)")
        re_intr = re.compile(r"\bdigitalPinToInterrupt\s*\(\s*([^\)]+)\)")
        re_wire = re.compile(r"\bWire\d?\s*\.\s*begin\s*\(\s*([^,\)]+)\s*,\s*([^,\)]+)")
        re_spi = re.compile(r"\bSPI\d?\s*\.\s*begin\s*\(([^\)]*)\)")

        for idx, line in enumerate(clean_lines, start=1):
            for m in re_pinmode.finditer(line):
                mode_arg = m.group(2).upper()
                mode = "output" if "OUTPUT" in mode_arg else "input" if "INPUT" in mode_arg else "ref"
                add_ref(idx, m.group(1), mode)
            for m in re_dwrite.finditer(line):
                add_ref(idx, m.group(1), "output")
            for m in re_dread.finditer(line):
                add_ref(idx, m.group(1), "input")
            for m in re_aread.finditer(line):
                add_ref(idx, m.group(1), "adc")
            for m in re_awrite.finditer(line):
                add_ref(idx, m.group(1), "pwm")
            for m in re_attach.finditer(line):
                add_ref(idx, m.group(1), "pwm")
            for m in re_intr.finditer(line):
                add_ref(idx, m.group(1), "input")
            for m in re_wire.finditer(line):
                add_ref(idx, m.group(1), "i2c")
                add_ref(idx, m.group(2), "i2c")
            for m in re_spi.finditer(line):
                args = [a.strip() for a in m.group(1).split(",") if a.strip()]
                for a in args[:4]:
                    add_ref(idx, a, "spi")

    # Also include #define / constant lines if the symbol was actually used as a pin
    used_syms = {r["symbol"] for r in refs}
    for sym, (pin, line_no) in symbols.items():
        if sym in used_syms and pin not in POWER_PIN_NAMES:
            add_ref(line_no, sym, "def")

    refs.sort(key=lambda r: (r["line"], r["pin"]))
    return refs


def detect_sim_archetype(item: dict[str, Any] | None) -> str:
    """Detect the built-in Pinbin live simulator widget archetype for a project part."""
    if not item:
        return "generic"
    text = f"{item.get('name', '')} {item.get('label', '')} {item.get('subtitle', '')} {item.get('category', '')}".lower()
    if any(k in text for k in ("ssd1306", "oled", "1602", "lcd")):
        return "display"
    if "neopixel" in text or "ws2812" in text or ("led" in text and "oled" not in text):
        return "led"
    if any(k in text for k in ("button", "tactile", "btn")):
        return "button"
    if "switch" in text:
        return "switch"
    if any(k in text for k in ("servo", "sg90", "sg-90")):
        return "servo"
    if any(k in text for k in ("buzzer", "piezo")):
        return "buzzer"
    if any(k in text for k in ("relay", "motor", "pump", "fan")):
        return "relay"
    if any(k in text for k in ("pir", "motion", "reed", "hall", "obstacle")):
        return "digital_sensor"
    if any(k in text for k in ("pot", "ldr", "photoresistor", "moisture", "mq-", "analog", "dht", "temp", "ultrasonic", "hc-sr04", "sensor")):
        return "analog"
    return "generic"


def build_wiring_summary(project: dict[str, Any]) -> dict[str, Any]:
    """Return a clean MCU-centric wiring summary for UI and MCP tools."""
    mcu = find_project_mcu(project)
    mcu_ref = str(mcu.get("ref") or "") if mcu else ""
    mcu_name = str(mcu.get("label") or mcu.get("name") or mcu_ref) if mcu else ""
    board_family = (
        detect_board_family(f"{mcu.get('name', '')} {mcu.get('label', '')} {mcu.get('subtitle', '')}") if mcu else ""
    )
    items_by_ref = {str(it.get("ref") or ""): it for it in (project.get("items") or []) if it.get("ref")}
    wired_pins: list[dict[str, Any]] = []
    seen_pins: set[tuple[str, str]] = set()

    for net in project.get("nets") or []:
        conns = net.get("conns") or []
        mcu_pins_on_net: list[str] = []
        others: list[dict[str, Any]] = []
        for pair in conns:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            ref, pin_raw = str(pair[0]), str(pair[1] or "")
            if ref == mcu_ref:
                for tok in expand_pin_tokens(pin_raw):
                    norm = normalize_pin_name(tok, board_family) or tok
                    mcu_pins_on_net.append(norm)
            else:
                it = items_by_ref.get(ref)
                others.append(
                    {
                        "ref": ref,
                        "name": str((it.get("label") or it.get("name")) if it else ref),
                        "category": str(it.get("category") or "") if it else "",
                        "pin": pin_raw,
                        "i2c": (it.get("electrical_facts") or {}).get("i2c") if it else None,
                        "sim_archetype": detect_sim_archetype(it),
                    }
                )
        for pin in mcu_pins_on_net:
            if pin in POWER_PIN_NAMES:
                continue
            key = (pin, str(net.get("id") or ""))
            if key in seen_pins:
                continue
            seen_pins.add(key)
            wired_pins.append(
                {
                    "pin": pin,
                    "net_id": str(net.get("id") or ""),
                    "net_name": str(net.get("name") or ""),
                    "net_kind": str(net.get("kind") or "sig"),
                    "wake": bool(net.get("wake")),
                    "connected_nodes": others,
                }
            )

    return {
        "mcu_ref": mcu_ref,
        "mcu_name": mcu_name,
        "board_family": board_family or "unknown",
        "board_title": BOARD_SPECS[board_family]["title"] if board_family in BOARD_SPECS else mcu_name,
        "default_language": default_language_for_project(project),
        "wired_pins": wired_pins,
    }


def analyze_project_code(
    project: dict[str, Any],
    code_source: str | None = None,
    code_language: str | None = None,
) -> dict[str, Any]:
    """Audit firmware code against the project's wiring map and MCU board pinout."""
    summary = build_wiring_summary(project)
    board_family = summary["board_family"]
    spec = BOARD_SPECS.get(board_family)
    mcu_ref = summary["mcu_ref"]

    src = project.get("code_source", "") if code_source is None else code_source
    if len(str(src or "")) > MAX_CODE_CHARS:
        raise ValueError(f"Code exceeds maximum length ({MAX_CODE_CHARS} characters)")
    lang = (code_language or project.get("code_language") or summary["default_language"] or "arduino").strip().lower()
    if lang not in CODE_LANGUAGES:
        lang = summary["default_language"]

    wired_by_pin: dict[str, dict[str, Any]] = {}
    for wp in summary["wired_pins"]:
        wired_by_pin.setdefault(wp["pin"], wp)

    raw_refs = extract_code_pin_references(src or "", lang, board_family if board_family != "unknown" else "")
    references: list[dict[str, Any]] = []
    lines_by_pin: dict[str, list[int]] = {}
    modes_by_pin: dict[str, set[str]] = {}

    for ref in raw_refs:
        pin = ref["pin"]
        wp = wired_by_pin.get(pin)
        lines_by_pin.setdefault(pin, [])
        if ref["line"] not in lines_by_pin[pin]:
            lines_by_pin[pin].append(ref["line"])
        modes_by_pin.setdefault(pin, set()).add(ref["mode"])
        references.append(
            {
                **ref,
                "matched": wp is not None,
                "net_id": wp["net_id"] if wp else "",
                "net_name": wp["net_name"] if wp else "",
                "node_refs": [n["ref"] for n in (wp["connected_nodes"] if wp else [])],
            }
        )

    pin_map: list[dict[str, Any]] = []
    for wp in summary["wired_pins"]:
        p = wp["pin"]
        pin_map.append(
            {
                **wp,
                "used_in_code": p in lines_by_pin,
                "code_lines": lines_by_pin.get(p, []),
                "code_modes": sorted(modes_by_pin.get(p, set())),
            }
        )

    issues: list[dict[str, Any]] = []

    if spec and lang == "micropython" and not spec["supports_micropython"]:
        issues.append(
            {
                "severity": "danger",
                "code": "unsupported_language",
                "title": f"{spec['title']} does not run MicroPython",
                "body": "Switch this project's language to Arduino C++ (ATmega328P doesn't have enough flash/RAM for MicroPython).",
                "line": None,
                "pin": "",
                "net_id": "",
                "node_refs": [mcu_ref] if mcu_ref else [],
            }
        )

    # Check every pin referenced in code
    for pin, line_list in sorted(lines_by_pin.items()):
        modes = modes_by_pin.get(pin, set())
        first_line = line_list[0]
        wp = wired_by_pin.get(pin)
        net_id = wp["net_id"] if wp else ""
        node_refs = ([mcu_ref] if mcu_ref else []) + ([n["ref"] for n in wp["connected_nodes"]] if wp else [])

        if spec and pin not in spec["valid_pins"]:
            issues.append(
                {
                    "severity": "danger",
                    "code": "invalid_board_pin",
                    "title": f"{pin} does not exist on {spec['title']}",
                    "body": f"Referenced on line {first_line}. Check the Bench pinout for valid pins on {spec['title']}.",
                    "line": first_line,
                    "pin": pin,
                    "net_id": net_id,
                    "node_refs": [mcu_ref] if mcu_ref else [],
                }
            )
            continue

        if spec and pin in spec["input_only"] and (modes & {"output", "pwm"}):
            issues.append(
                {
                    "severity": "danger",
                    "code": "input_only_output",
                    "title": f"{pin} is input-only on {spec['title']}",
                    "body": f"Line {first_line} tries to drive {pin} as an output/PWM. Move this output to a regular GPIO.",
                    "line": first_line,
                    "pin": pin,
                    "net_id": net_id,
                    "node_refs": node_refs,
                }
            )

        if spec and pin in spec["serial"]:
            issues.append(
                {
                    "severity": "check",
                    "code": "usb_serial_pin",
                    "title": f"{pin} is shared with the USB serial link",
                    "body": f"Used on line {first_line}. Using {pin} can interfere with uploading code or Serial Monitor output.",
                    "line": first_line,
                    "pin": pin,
                    "net_id": net_id,
                    "node_refs": node_refs,
                }
            )

        if spec and pin in spec["strap"]:
            issues.append(
                {
                    "severity": "check",
                    "code": "strapping_pin",
                    "title": f"{pin} is a boot strapping pin",
                    "body": f"Used on line {first_line}. Make sure external circuitry doesn't pull {pin} the wrong way at power-on.",
                    "line": first_line,
                    "pin": pin,
                    "net_id": net_id,
                    "node_refs": node_refs,
                }
            )

        if not wp and summary["wired_pins"]:
            issues.append(
                {
                    "severity": "check",
                    "code": "unwired_pin",
                    "title": f"{pin} is used in code, but not wired on the map",
                    "body": f"Referenced on line {first_line}. Add a wire to {pin} on the Map, or update the pin number in code.",
                    "line": first_line,
                    "pin": pin,
                    "net_id": "",
                    "node_refs": [mcu_ref] if mcu_ref else [],
                }
            )

    # Check wired pins that aren't used in code yet (only if code is non-empty)
    if (src or "").strip():
        for wp in summary["wired_pins"]:
            p = wp["pin"]
            if p not in lines_by_pin:
                targets = ", ".join(n["name"] for n in wp["connected_nodes"]) or wp["net_name"]
                issues.append(
                    {
                        "severity": "info",
                        "code": "unused_wired_pin",
                        "title": f"Wired pin {p} ({targets}) isn't used in code yet",
                        "body": f"Connected on wire '{wp['net_name']}'. Add it to your code if you want to control or read it.",
                        "line": None,
                        "pin": p,
                        "net_id": wp["net_id"],
                        "node_refs": [n["ref"] for n in wp["connected_nodes"]],
                    }
                )

    danger_count = sum(1 for i in issues if i["severity"] == "danger")
    check_count = sum(1 for i in issues if i["severity"] == "check")

    return {
        "ok": danger_count == 0,
        "language": lang,
        "board_family": board_family,
        "board_title": summary["board_title"],
        "mcu_ref": mcu_ref,
        "mcu_name": summary["mcu_name"],
        "line_count": len((src or "").splitlines()) if (src or "").strip() else 0,
        "wired_pin_count": len(summary["wired_pins"]),
        "matched_pin_count": sum(1 for pm in pin_map if pm["used_in_code"]),
        "danger_count": danger_count,
        "check_count": check_count,
        "pin_map": pin_map,
        "references": references,
        "issues": issues,
    }


def _slug_const(name: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", (name or "").upper()).strip("_")
    if not cleaned or cleaned[0].isdigit():
        cleaned = f"{fallback}_{cleaned}" if cleaned else fallback
    return cleaned[:28]


def _guess_direction(wp: dict[str, Any]) -> str:
    """Guess whether a wired signal pin is likely an input, output, adc, i2c, or spi."""
    kind = wp.get("net_kind") or "sig"
    if kind in ("i2c", "spi"):
        return kind
    hay = " ".join(
        [wp.get("net_name", "")]
        + [f"{n.get('name', '')} {n.get('category', '')} {n.get('pin', '')}" for n in (wp.get("connected_nodes") or [])]
    ).lower()
    if any(k in hay for k in ("button", "btn", "switch", "pir", "echo", "sensor", "dht", "reed", "hall", "ir ", "ldr", "pot", "mq-")):
        if any(k in hay for k in ("pot", "ldr", "analog", "aout", "ao", "moisture", "mq-")):
            return "adc"
        return "input"
    if any(k in hay for k in ("led", "relay", "buzzer", "servo", "motor", "trig", "neopixel", "ws2812", "fan", "pump")):
        return "output"
    return "output"


def generate_starter_code(project: dict[str, Any], language: str | None = None) -> dict[str, Any]:
    """Generate clean, beginner-friendly starter code directly from the project's wiring map."""
    summary = build_wiring_summary(project)
    board_family = summary["board_family"]
    spec = BOARD_SPECS.get(board_family)
    lang = (language or summary["default_language"] or "arduino").strip().lower()
    if lang not in CODE_LANGUAGES:
        lang = "arduino"
    if spec and lang == "micropython" and not spec["supports_micropython"]:
        lang = "arduino"

    proj_name = str(project.get("name") or "Pinbin Project").strip()
    board_title = summary["board_title"] or "Microcontroller"
    wired = summary["wired_pins"]

    i2c_sda: tuple[str, str] | None = None
    i2c_scl: tuple[str, str] | None = None
    i2c_devices: list[str] = []
    spi_sck: tuple[str, str] | None = None
    spi_mosi: tuple[str, str] | None = None
    spi_miso: tuple[str, str] | None = None
    spi_cs: list[tuple[str, str]] = []
    pin_entries: list[dict[str, Any]] = []
    used_const_names: set[str] = set()

    for wp in wired:
        pin = wp["pin"]
        nodes = wp.get("connected_nodes") or []
        target_label = nodes[0]["name"] if nodes else wp["net_name"]
        net_low = f"{wp['net_name']} {' '.join(n.get('pin', '') for n in nodes)}".lower()
        direction = _guess_direction(wp)

        base_name = f"PIN_{_slug_const(target_label, 'SIG')}"
        if direction == "i2c":
            has_sda = "sda" in net_low
            has_scl = "scl" in net_low
            if has_sda and not has_scl and i2c_sda is None:
                base_name = "PIN_I2C_SDA"
            elif has_scl and not has_sda and i2c_scl is None:
                base_name = "PIN_I2C_SCL"
            elif i2c_sda is None:
                # Combined SDA/SCL net (e.g. GPIO8/9 -> SDA/SCL): assign first to SDA, second to SCL
                base_name = "PIN_I2C_SDA"
            elif i2c_scl is None:
                base_name = "PIN_I2C_SCL"
            for n in nodes:
                addr = f" ({n['i2c']})" if n.get("i2c") else ""
                desc = f"{n['name']}{addr}"
                if desc not in i2c_devices:
                    i2c_devices.append(desc)
        elif direction == "spi":
            if any(k in net_low for k in ("sck", "clk", "sclk")) and spi_sck is None and not ("mosi" in net_low and "miso" in net_low):
                base_name = "PIN_SPI_SCK"
            elif any(k in net_low for k in ("mosi", "sdi", "din", "tx")) and spi_mosi is None and not ("miso" in net_low):
                base_name = "PIN_SPI_MOSI"
            elif any(k in net_low for k in ("miso", "sdo", "dout", "rx")) and spi_miso is None and not ("mosi" in net_low):
                base_name = "PIN_SPI_MISO"
            elif any(k in net_low for k in ("cs", "ss", "ce", "dc", "rst", "reset")):
                base_name = f"PIN_{_slug_const(target_label, 'SPI')}_CS"
            elif spi_sck is None:
                base_name = "PIN_SPI_SCK"
            elif spi_mosi is None:
                base_name = "PIN_SPI_MOSI"
            elif spi_miso is None:
                base_name = "PIN_SPI_MISO"
            else:
                base_name = f"PIN_{_slug_const(target_label, 'SPI')}_CS"

        const_name = base_name
        suffix = 2
        while const_name in used_const_names:
            const_name = f"{base_name}_{suffix}"
            suffix += 1
        used_const_names.add(const_name)

        if direction == "i2c":
            if base_name == "PIN_I2C_SDA" and i2c_sda is None:
                i2c_sda = (const_name, pin)
            elif base_name == "PIN_I2C_SCL" and i2c_scl is None:
                i2c_scl = (const_name, pin)
        elif direction == "spi":
            if base_name == "PIN_SPI_SCK" and spi_sck is None:
                spi_sck = (const_name, pin)
            elif base_name == "PIN_SPI_MOSI" and spi_mosi is None:
                spi_mosi = (const_name, pin)
            elif base_name == "PIN_SPI_MISO" and spi_miso is None:
                spi_miso = (const_name, pin)
            else:
                spi_cs.append((const_name, pin))

        caution = ""
        if spec and pin in spec["strap"]:
            caution = " [strapping pin]"
        elif spec and pin in spec["input_only"]:
            caution = " [input-only]"
            if direction == "output":
                direction = "input"

        pin_entries.append(
            {
                "const": const_name,
                "pin": pin,
                "literal": _pin_number_literal(pin, board_family, lang),
                "direction": direction,
                "comment": f"{pin} -> {target_label} ({wp['net_name']}){caution}",
            }
        )

    has_spi = bool(spi_sck or spi_mosi or spi_miso or spi_cs)
    out_entries = [e for e in pin_entries if e["direction"] == "output"]
    in_entries = [e for e in pin_entries if e["direction"] == "input"]
    adc_entries = [e for e in pin_entries if e["direction"] == "adc"]

    if lang == "micropython":
        imports = ["Pin"]
        if i2c_sda or i2c_scl:
            imports.append("I2C")
        if has_spi and (spi_sck or spi_mosi or spi_miso):
            imports.append("SPI")
        if adc_entries:
            imports.append("ADC")
        lines = [
            f"# {proj_name} — MicroPython starter",
            f"# Board: {board_title}",
            "# Generated from your Pinbin wiring map.",
            "",
            "import time",
            f"from machine import {', '.join(imports)}",
            "",
            "# --- Pin definitions (from wiring map) ---",
        ]
        if not pin_entries:
            lines.append("# No signal wires on the map yet — add wires or edit pins below.")
            led_lit = _pin_number_literal(spec["builtin_led"], board_family, lang) if spec else "2"
            lines.append(f"PIN_LED = {led_lit}")
            lines.append("led = Pin(PIN_LED, Pin.OUT)")
        else:
            for e in pin_entries:
                lines.append(f"{e['const']} = {e['literal']}  # {e['comment']}")
            lines.append("")
            lines.append("# --- Hardware setup ---")
            if i2c_sda and i2c_scl:
                if i2c_devices:
                    lines.append(f"# I2C devices: {', '.join(i2c_devices)}")
                lines.append(f"i2c = I2C(0, sda=Pin({i2c_sda[0]}), scl=Pin({i2c_scl[0]}), freq=400_000)")
                lines.append("print('I2C scan:', i2c.scan())")
            if spi_sck or spi_mosi or spi_miso:
                spi_parts = []
                if spi_sck:
                    spi_parts.append(f"sck=Pin({spi_sck[0]})")
                if spi_mosi:
                    spi_parts.append(f"mosi=Pin({spi_mosi[0]})")
                if spi_miso:
                    spi_parts.append(f"miso=Pin({spi_miso[0]})")
                lines.append(f"spi = SPI(0, {', '.join(spi_parts)})")
            for cs_const, _ in spi_cs:
                var = cs_const.lower().replace("pin_", "")
                lines.append(f"{var} = Pin({cs_const}, Pin.OUT)")
            for e in pin_entries:
                var = e["const"].lower().replace("pin_", "")
                if e["direction"] == "output":
                    lines.append(f"{var} = Pin({e['const']}, Pin.OUT)")
                elif e["direction"] == "input":
                    lines.append(f"{var} = Pin({e['const']}, Pin.IN, Pin.PULL_UP)")
                elif e["direction"] == "adc":
                    lines.append(f"{var} = ADC(Pin({e['const']}))")

        lines += [
            "",
            f'print("{proj_name} started")',
            "state = 0",
            "",
            "while True:",
            "    state = 1 - state",
        ]
        if not pin_entries:
            lines.append("    led.value(state)")
        else:
            for e in in_entries:
                var = e["const"].lower().replace("pin_", "")
                lines.append(f'    print("{var}:", {var}.value())')
            for e in adc_entries:
                var = e["const"].lower().replace("pin_", "")
                lines.append(f'    print("{var}:", {var}.read())')
            for e in out_entries:
                var = e["const"].lower().replace("pin_", "")
                lines.append(f"    {var}.value(state)")
        lines += [
            "    time.sleep(0.5)",
            "",
        ]
    else:
        lines = [
            f"// {proj_name} — Arduino C++ starter",
            f"// Board: {board_title}",
            "// Generated from your Pinbin wiring map.",
            "",
        ]
        if i2c_sda or i2c_scl:
            lines.append("#include <Wire.h>")
        if has_spi:
            lines.append("#include <SPI.h>")
        if i2c_sda or i2c_scl or has_spi:
            lines.append("")
        lines.append("// --- Pin definitions (from wiring map) ---")
        if not pin_entries:
            lines.append("// No signal wires on the map yet — add wires or edit pins below.")
            led_lit = _pin_number_literal(spec["builtin_led"], board_family, lang) if spec else "13"
            lines.append(f"#define PIN_LED {led_lit}")
        else:
            for e in pin_entries:
                lines.append(f"#define {e['const']} {e['literal']}  // {e['comment']}")

        lines += [
            "",
            "int tickState = LOW;",
            "",
            "void setup() {",
            "  Serial.begin(115200);",
            f'  Serial.println("{proj_name} started");',
        ]
        if i2c_sda and i2c_scl:
            if i2c_devices:
                lines.append(f"  // I2C devices: {', '.join(i2c_devices)}")
            if board_family in ("esp32", "c3"):
                lines.append(f"  Wire.begin({i2c_sda[0]}, {i2c_scl[0]});")
            else:
                lines.append("  Wire.begin();")
        if has_spi:
            if board_family in ("esp32", "c3") and spi_sck and spi_mosi:
                miso_arg = spi_miso[0] if spi_miso else "-1"
                cs_arg = spi_cs[0][0] if spi_cs else "-1"
                lines.append(f"  SPI.begin({spi_sck[0]}, {miso_arg}, {spi_mosi[0]}, {cs_arg});")
            else:
                lines.append("  SPI.begin();")
            for cs_const, _ in spi_cs:
                lines.append(f"  pinMode({cs_const}, OUTPUT);")
        if not pin_entries:
            lines.append("  pinMode(PIN_LED, OUTPUT);")
        else:
            for e in pin_entries:
                if e["direction"] == "output":
                    lines.append(f"  pinMode({e['const']}, OUTPUT);")
                elif e["direction"] == "input":
                    lines.append(f"  pinMode({e['const']}, INPUT_PULLUP);")
                elif e["direction"] == "adc":
                    lines.append(f"  pinMode({e['const']}, INPUT);")
        lines += [
            "}",
            "",
            "void loop() {",
            "  tickState = tickState == LOW ? HIGH : LOW;",
        ]
        if not pin_entries:
            lines.append("  digitalWrite(PIN_LED, tickState);")
        else:
            for e in in_entries:
                var = e["const"].lower().replace("pin_", "")
                lines.append(f"  int {var}Val = digitalRead({e['const']});")
                lines.append(f'  Serial.println("{var}: " + String({var}Val));')
            for e in adc_entries:
                var = e["const"].lower().replace("pin_", "")
                lines.append(f"  int {var}Val = analogRead({e['const']});")
                lines.append(f'  Serial.println("{var}: " + String({var}Val));')
            for e in out_entries:
                lines.append(f"  digitalWrite({e['const']}, tickState);")
        lines += [
            "  delay(500);",
            "}",
            "",
        ]

    code = "\n".join(lines)
    analysis = analyze_project_code(project, code_source=code, code_language=lang)
    return {
        "language": lang,
        "code": code,
        "analysis": analysis,
    }
