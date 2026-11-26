"""Stateless Streamable HTTP MCP (Model Context Protocol) server for Pinbin.

Implements JSON-RPC 2.0 over POST /mcp with:
- Optional Bearer token verification (MCP_API_TOKEN) in addition to Cloudflare Access.
- Read-only mode (MCP_READ_ONLY=true) that hides and blocks all mutating tools.
- Never exposes /api/restore, /api/backup, raw filesystem image paths, or server secrets.
"""
from __future__ import annotations

import hmac
import json
import re
from collections import Counter
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.config import CATEGORIES, Settings
from app.db import (
    CHECK_SEVERITIES,
    NET_KINDS,
    PROJECT_ITEM_ROLES,
    PROJECT_STATUSES,
    SHOPPING_STATUSES,
    add_project_item,
    add_shopping_offer,
    create_glossary_term,
    create_part,
    create_project,
    create_project_variant,
    create_shopping_item,
    delete_glossary_term,
    delete_part,
    delete_project,
    delete_project_item,
    delete_project_variant,
    delete_shopping_item,
    delete_shopping_offer,
    get_mcp_runtime_settings,
    get_part,
    get_shopping_item,
    is_image_referenced,
    list_glossary,
    list_parts,
    list_projects,
    list_retailers,
    list_shopping_items,
    move_shopping_item_to_inventory,
    optimize_shopping_carts,
    record_mcp_request,
    set_project_checks,
    set_project_nets,
    teardown_project,
    update_glossary_term,
    update_part,
    update_project,
    update_project_check,
    update_project_item,
    update_project_variant,
    update_shopping_item,
    update_shopping_offer,
    upsert_retailer,
)
from app.glossary_seed import GLOSSARY_CATEGORIES
from app.images import ImageError, safe_delete_image
from app.scraper import ScrapeError, scrape_url

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL_VERSION = "2025-03-26"
MAX_BATCH_UPDATES = 50
MAX_MCP_BODY_BYTES = 1024 * 1024
MAX_MCP_BATCH_SIZE = 30

SERVER_INSTRUCTIONS = (
    "Pinbin is a personal electronics workbench inventory, project planner, shopping list, and glossary. "
    "Use inventory_summary or list_parts to inspect available components, bins, and projects before suggesting builds. "
    "Keep inventory strictly for parts the user actually owns; never create quantity=0 inventory parts for unbought items. "
    "Instead, add unbought items to the shopping list (create_shopping_item, with fetch_metadata=true to grab product photos) "
    "and link both owned parts and shopping items into projects (create_project, add_project_item with role/ref/label) "
    "with project-scoped notes in project_notes. "
    "HARDWARE ACCURACY IS CRITICAL: Diagrams, pinouts, electrical_facts, and wiring notes are used to wire real physical hardware—"
    "inaccurate diagrams can destroy components or cause battery fires. NEVER guess pin numbers, left/right pin order, USB port "
    "orientation, voltage limits, I2C addresses, strapping pins, or deep-sleep wake pins from memory. Always verify against the "
    "exact board's top-view pinout (chip facing up) and component datasheets before calling set_project_wiring, set_project_checks, "
    "or writing electrical_facts/pinout_svg. If a detail (like a seller's exact pin order or module revision) cannot be confirmed, "
    "explicitly label it as unverified and add a safety check telling the user to inspect the board silkscreen first. "
    "Fill in verified electrical_facts (logic, interfaces, vin, io, i2c, out, vout, ma, reg_ma, mah, strap, wake, power) and care_notes "
    "([{severity: 'danger'|'check'|'info', text}]) on parts and shopping items so Pinbin's built-in compatibility and power-budget checks run automatically. "
    "You can attach part photos via image_url, pinout photos via pinout_image_url, and verified top-view board diagrams via pinout_svg. "
    "For projects, write wiring connections using set_project_wiring (and resolve every issue returned in verification_report) "
    "and beginner safety checks using set_project_checks. "
    "Each shopping item supports multiple retailer offers (pass offers=[...] on create_shopping_item or call add_shopping_offer). "
    "When planning a project shopping list, try to find parts on the same retailer(s) to minimize separate orders, attach alternative "
    "store offers when found, and call optimize_shopping_carts to check for consolidation opportunities or single-item straggler stores. "
    "All notes fields (notes, project_notes, why_needed) render as Markdown—write them in clean Markdown. "
    "When writing descriptions, warnings, notes, or glossary terms, prefer short, plain sentences. "
    f"Valid part categories: {', '.join(CATEGORIES)}. "
    f"Valid glossary categories: {', '.join(GLOSSARY_CATEGORIES)}."
)

COMPACT_PART_KEYS = (
    "id",
    "name",
    "subtitle",
    "category",
    "quantity",
    "low_stock_threshold",
    "location",
    "in_use_project",
    "what_it_does",
    "warning",
    "specs",
    "electrical_facts",
    "care_notes",
)

PART_WRITABLE_FIELDS = {
    "name",
    "subtitle",
    "category",
    "quantity",
    "low_stock_threshold",
    "location",
    "in_use_project",
    "what_it_does",
    "visual_tell",
    "warning",
    "notes",
    "source_url",
    "pinout_url",
    "pinout_svg",
    "specs",
    "electrical_facts",
    "care_notes",
}

SHOPPING_WRITABLE_FIELDS = {
    "name",
    "url",
    "price",
    "quantity",
    "notes",
    "retailer",
    "tag",
    "category",
    "specs",
    "electrical_facts",
    "care_notes",
    "status",
    "in_stock",
    "why_needed",
}
GLOSSARY_WRITABLE_FIELDS = {"term", "category", "summary", "rule_of_thumb", "keywords", "related_ids", "bench_tool", "figure_key"}


class McpToolError(Exception):
    """Raised when a tool call fails with a user/agent-readable message."""


class UnknownToolError(Exception):
    """Raised when an unknown MCP tool name is requested."""


def verify_mcp_access(request: Request, settings: Settings) -> JSONResponse | None:
    """Enforce MCP_ENABLED and optional Bearer token auth (SQLite-rotated or env MCP_API_TOKEN)."""
    if not settings.mcp_enabled:
        return JSONResponse(status_code=404, content={"detail": "MCP endpoint is disabled"})

    runtime = get_mcp_runtime_settings(settings)
    expected_token = str(runtime.get("token") or settings.mcp_api_token or "").strip()
    if expected_token:
        auth_header = request.headers.get("Authorization", "").strip()
        prefix = "Bearer "
        if not auth_header.startswith(prefix):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing Bearer token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        provided = auth_header[len(prefix) :].strip()
        if not hmac.compare_digest(provided.encode("utf-8"), expected_token.encode("utf-8")):
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid MCP API token"},
                headers={"WWW-Authenticate": "Bearer"},
            )

    return None


def _electrical_facts_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "description": (
            "Structured electrical facts used by built-in safety and power-budget checks: "
            "{logic: 'v33'|'v5'|'vboth'|'none', interfaces: ['I2C','SPI',...], vin: [minV, maxV], "
            "io: maxPinV, i2c: '0x3C', out: {'ECHO': 5}, vout: 4.2, ma: typicalOrPeakMa, "
            "reg_ma: board3v3RegulatorMaxMa, mah: batteryCapacityMah, strap: ['GPIO0'], wake: ['GPIO0'], "
            "power: {'VIN': [4.5, 12]}, pairs: ['part-id'], glyph: 'mcu'}."
        ),
    }


def _care_notes_schema() -> dict[str, Any]:
    return {
        "type": "array",
        "description": "Typed beginner care notes shown on the part and in projects.",
        "items": {
            "type": "object",
            "properties": {
                "severity": {"type": "string", "enum": ["danger", "check", "info"]},
                "text": {"type": "string"},
            },
            "required": ["severity", "text"],
        },
    }


def _part_properties_schema() -> dict[str, Any]:
    return {
        "name": {"type": "string", "description": "Part name (e.g. 'ESP32 DevKit v1')."},
        "subtitle": {"type": "string", "description": "Short subtitle or variant."},
        "category": {"type": "string", "enum": CATEGORIES},
        "quantity": {"type": "integer", "minimum": 0},
        "low_stock_threshold": {
            "type": ["integer", "null"],
            "minimum": 0,
            "description": "Alert threshold for low stock, or null to disable.",
        },
        "location": {"type": "string", "description": "Storage bin or drawer label (e.g. 'A1')."},
        "in_use_project": {
            "type": "string",
            "description": "Project name if currently deployed on the bench, or empty string.",
        },
        "what_it_does": {"type": "string", "description": "Beginner-friendly 1-2 sentence summary."},
        "visual_tell": {"type": "string", "description": "Concise physical clue to spot the part in a bin."},
        "warning": {"type": "string", "description": "Short primary caution (auto-synced with care_notes)."},
        "notes": {"type": "string", "description": "Pin-order, I2C/SPI address, or wiring notes (Markdown)."},
        "source_url": {"type": "string", "description": "Store or product reference URL."},
        "pinout_url": {"type": "string", "description": "Official documentation or pinout URL."},
        "image_url": {"type": "string", "description": "Direct image or product page URL to download and attach as the part photo."},
        "pinout_image_url": {"type": "string", "description": "Direct image or page URL to download and attach as the pinout photo."},
        "pinout_svg": {
            "type": "string",
            "description": (
                "Scalable <svg> board pinout diagram (sanitized server-side). MUST be top view (chip facing up) "
                "with verified physical left/right pin order and USB port position matching the real PCB."
            ),
        },
        "specs": {
            "type": "object",
            "additionalProperties": {"type": "string"},
            "description": "Flat key-value technical specs (e.g. {'Range': '2–400 cm'}).",
        },
        "electrical_facts": _electrical_facts_schema(),
        "care_notes": _care_notes_schema(),
    }


def _build_tool_definitions(read_only: bool) -> list[dict[str, Any]]:
    read_tools: list[dict[str, Any]] = [
        {
            "name": "inventory_summary",
            "description": (
                "Get a high-level overview of the Pinbin workbench: counts by category, storage bins/locations, "
                "active projects, low-stock count, shopping list count, glossary count, and valid category names."
            ),
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "list_parts",
            "description": (
                "Search and filter electronics parts in inventory. Returns compact part objects by default "
                "to save context; set compact=false for full fields (notes, visual_tell, URLs)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": {"type": "string", "description": "Case-insensitive search across name, specs, notes, bin, etc."},
                    "category": {"type": "string", "enum": ["All", *CATEGORIES]},
                    "location": {"type": "string", "description": "Exact bin/location match (case-insensitive)."},
                    "needs_photo": {"type": "boolean", "default": False},
                    "in_use": {"type": "boolean", "default": False},
                    "low_stock": {"type": "boolean", "default": False},
                    "compact": {"type": "boolean", "default": True},
                },
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "get_part",
            "description": "Get full details for a single part by its ID.",
            "inputSchema": {
                "type": "object",
                "properties": {"part_id": {"type": "string"}},
                "required": ["part_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "list_projects",
            "description": "List all projects with their status, sub-project variants, owned and to-buy items, project notes, and readiness summary.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "scrape_product_url",
            "description": "Fetch a store product page safely to inspect its title, price, retailer, and stock status.",
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        },
        {
            "name": "list_shopping",
            "description": "List shopping/wishlist items and optionally low-stock inventory parts that may need reordering.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_low_stock": {"type": "boolean", "default": True},
                },
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "list_glossary",
            "description": "Search or list workbench glossary terms.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": {"type": "string", "description": "Optional search filter on term, summary, or keywords."},
                    "category": {"type": "string", "enum": ["All", *GLOSSARY_CATEGORIES]},
                },
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "list_retailers",
            "description": "List saved retailer shipping rules (shipping_cost, free_shipping_threshold, currency).",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "optimize_shopping_carts",
            "description": (
                "Analyze shopping items across their saved retailer offers to minimize separate orders (fewest_orders) "
                "or minimize total landed cost including shipping (lowest_cost), and identify single-item straggler stores."
                + ("" if read_only else " Set apply=true to switch selected offers to the recommended plan.")
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "Optional project_id to scope optimization to."},
                    "tag": {"type": "string", "description": "Optional project/tag name filter."},
                    "mode": {"type": "string", "enum": ["fewest_orders", "lowest_cost"], "default": "fewest_orders"},
                    "include_out_of_stock": {"type": "boolean", "default": False},
                    "include_inactive_variants": {"type": "boolean", "default": False},
                    **({} if read_only else {"apply": {"type": "boolean", "default": False}}),
                },
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": read_only,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
    ]

    if read_only:
        return read_tools

    part_props = _part_properties_schema()
    write_tools: list[dict[str, Any]] = [
        {
            "name": "create_part",
            "description": "Create a new part in the Pinbin inventory.",
            "inputSchema": {
                "type": "object",
                "properties": part_props,
                "required": ["name"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        },
        {
            "name": "update_part",
            "description": "Update one or more fields on an existing part by part_id.",
            "inputSchema": {
                "type": "object",
                "properties": {"part_id": {"type": "string"}, **part_props},
                "required": ["part_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "batch_update_parts",
            "description": (
                f"Update up to {MAX_BATCH_UPDATES} parts in one call (e.g. moving a bin, "
                "assigning parts to a project, or filling in missing specs/warnings)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "updates": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_BATCH_UPDATES,
                        "items": {
                            "type": "object",
                            "properties": {
                                "part_id": {"type": "string"},
                                **{k: v for k, v in part_props.items() if k not in ("image_url", "pinout_image_url")},
                            },
                            "required": ["part_id"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["updates"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "delete_part",
            "description": "Permanently delete a part (and its stored images) by part_id.",
            "inputSchema": {
                "type": "object",
                "properties": {"part_id": {"type": "string"}},
                "required": ["part_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "create_project",
            "description": "Create a new project (planning, active, completed, or archived) with optional build option label and tags.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "option": {"type": "string", "description": "Short build option label (e.g. 'Color IPS screen')."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Lowercase tags (e.g. ['wearable', 'battery'])."},
                    "status": {"type": "string", "enum": list(PROJECT_STATUSES), "default": "planning"},
                    "notes": {"type": "string"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False},
        },
        {
            "name": "update_project",
            "description": "Update a project's name, description, option, tags, status, or notes by project_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "option": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "status": {"type": "string", "enum": list(PROJECT_STATUSES)},
                    "notes": {"type": "string"},
                },
                "required": ["project_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "delete_project",
            "description": "Delete a project and its variant/item links (does not delete owned inventory parts or shopping items).",
            "inputSchema": {
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "create_project_variant",
            "description": "Create a sub-project / build option inside a project (e.g. 'Color IPS Build' vs 'E-Ink Build').",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "notes": {"type": "string", "description": "Sub-build-specific Markdown notes (wiring tables, pinouts, build steps)."},
                    "is_selected": {"type": "boolean", "default": False},
                },
                "required": ["project_id", "name"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False},
        },
        {
            "name": "update_project_variant",
            "description": "Update or select a project variant (sub-project).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "variant_id": {"type": "string"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "notes": {"type": "string", "description": "Sub-build-specific Markdown notes (supports tables)."},
                    "is_selected": {"type": "boolean"},
                },
                "required": ["project_id", "variant_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "delete_project_variant",
            "description": "Delete a project variant by variant_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "variant_id": {"type": "string"},
                },
                "required": ["project_id", "variant_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "add_project_item",
            "description": "Link an owned inventory part (part_id) OR a shopping list item (shopping_item_id) to a project with optional role, ref, label, and project-specific notes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "variant_id": {"type": ["string", "null"], "description": "Omit or null for Core/shared items."},
                    "part_id": {"type": "string"},
                    "shopping_item_id": {"type": "string"},
                    "ref": {"type": "string", "description": "Short node ref used in wiring nets (e.g. 'mcu', 'rtc', 'bat')."},
                    "role": {"type": "string", "enum": list(PROJECT_ITEM_ROLES), "description": "power | mcu | periph | material"},
                    "label": {"type": "string", "description": "Short display label inside this project."},
                    "quantity_needed": {"type": "integer", "minimum": 1, "default": 1},
                    "project_notes": {"type": "string", "description": "Notes shown only inside this project."},
                },
                "required": ["project_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "update_project_item",
            "description": "Update project_notes, quantity_needed, role, ref, label, or variant_id for a linked project item.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "variant_id": {"type": ["string", "null"]},
                    "ref": {"type": "string"},
                    "role": {"type": "string", "enum": list(PROJECT_ITEM_ROLES)},
                    "label": {"type": "string"},
                    "quantity_needed": {"type": "integer", "minimum": 1},
                    "project_notes": {"type": "string"},
                },
                "required": ["project_id", "item_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "set_project_wiring",
            "description": (
                "Set the complete list of wiring nets for a project (feeds Map, One part, Lines, and built-in safety checks). "
                "Double-check every pin number, power rail voltage, strapping pin, wake pin, and I2C address against real datasheets "
                "before calling. Returns a verification_report auditing pin conflicts, invalid board pins, voltage mismatches, and missing checks."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "nets": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "kind": {"type": "string", "enum": list(NET_KINDS)},
                                "rail": {"type": ["number", "null"]},
                                "chain": {"type": "boolean"},
                                "wake": {"type": "boolean"},
                                "conns": {
                                    "type": "array",
                                    "items": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2},
                                },
                            },
                            "required": ["name", "kind", "conns"],
                        },
                    },
                },
                "required": ["project_id", "nets"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "set_project_checks",
            "description": "Set the assistant safety checks/warnings attached to nodes or nets in a project.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "checks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "severity": {"type": "string", "enum": list(CHECK_SEVERITIES)},
                                "title": {"type": "string"},
                                "body": {"type": "string"},
                                "node_refs": {"type": "array", "items": {"type": "string"}},
                                "net_ids": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["severity", "title"],
                        },
                    },
                },
                "required": ["project_id", "checks"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "update_project_check",
            "description": "Update a project safety check (e.g. mark is_done or refine wording).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "check_id": {"type": "string"},
                    "severity": {"type": "string", "enum": list(CHECK_SEVERITIES)},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "node_refs": {"type": "array", "items": {"type": "string"}},
                    "net_ids": {"type": "array", "items": {"type": "string"}},
                    "is_done": {"type": "boolean"},
                },
                "required": ["project_id", "check_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "remove_project_item",
            "description": "Unlink a part or shopping item from a project.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "item_id": {"type": "string"},
                },
                "required": ["project_id", "item_id"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False},
        },
        {
            "name": "teardown_project",
            "description": "Return all parts assigned to a project back to general inventory (clears in_use_project and sets active project to planning).",
            "inputSchema": {
                "type": "object",
                "properties": {"project": {"type": "string"}},
                "required": ["project"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "create_shopping_item",
            "description": "Add a part or supply to the Pinbin shopping list. Set fetch_metadata=true (default) with a store URL to auto-download the product image and fill retailer/price/stock.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1, "default": 1},
                    "url": {"type": "string"},
                    "price": {"type": "string"},
                    "retailer": {"type": "string"},
                    "tag": {"type": "string", "description": "Group/project tag (e.g. 'weather-station')."},
                    "category": {"type": "string", "enum": ["", *CATEGORIES]},
                    "status": {"type": "string", "enum": list(SHOPPING_STATUSES), "default": "order"},
                    "in_stock": {"type": "string", "enum": ["", "in_stock", "out_of_stock"]},
                    "why_needed": {"type": "string", "description": "Short reason why this item is on the list."},
                    "notes": {"type": "string"},
                    "specs": {"type": "object", "additionalProperties": {"type": "string"}},
                    "electrical_facts": _electrical_facts_schema(),
                    "care_notes": _care_notes_schema(),
                    "image_url": {"type": "string", "description": "Optional direct image URL to attach as product photo."},
                    "project_id": {"type": "string", "description": "Optional project_id to link this shopping item to immediately."},
                    "variant_id": {"type": ["string", "null"], "description": "Optional variant_id inside project_id (null for Core)."},
                    "fetch_metadata": {"type": "boolean", "default": True},
                    "offers": {
                        "type": "array",
                        "description": "Optional list of retailer offers ({url, retailer, price, in_stock, is_selected, notes}).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "url": {"type": "string"},
                                "retailer": {"type": "string"},
                                "price": {"type": "string"},
                                "in_stock": {"type": "string", "enum": ["", "in_stock", "out_of_stock"]},
                                "is_selected": {"type": "boolean"},
                                "notes": {"type": "string"},
                            },
                        },
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": True,
            },
        },
        {
            "name": "update_shopping_item",
            "description": "Update an existing shopping list item by item_id. Set fetch_metadata=true to refresh its product image/stock from url.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "url": {"type": "string"},
                    "price": {"type": "string"},
                    "retailer": {"type": "string"},
                    "tag": {"type": "string"},
                    "category": {"type": "string", "enum": ["", *CATEGORIES]},
                    "status": {"type": "string", "enum": list(SHOPPING_STATUSES)},
                    "in_stock": {"type": "string", "enum": ["", "in_stock", "out_of_stock"]},
                    "why_needed": {"type": "string"},
                    "notes": {"type": "string"},
                    "specs": {"type": "object", "additionalProperties": {"type": "string"}},
                    "electrical_facts": _electrical_facts_schema(),
                    "care_notes": _care_notes_schema(),
                    "image_url": {"type": "string"},
                    "fetch_metadata": {"type": "boolean", "default": False},
                },
                "required": ["item_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": True,
            },
        },
        {
            "name": "delete_shopping_item",
            "description": "Remove an item from the shopping list by item_id.",
            "inputSchema": {
                "type": "object",
                "properties": {"item_id": {"type": "string"}},
                "required": ["item_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "add_shopping_offer",
            "description": "Add an alternative retailer listing (offer) to an existing shopping item. Set fetch_metadata=true to scrape price/stock from url.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "url": {"type": "string"},
                    "retailer": {"type": "string"},
                    "price": {"type": "string"},
                    "in_stock": {"type": "string", "enum": ["", "in_stock", "out_of_stock"]},
                    "is_selected": {"type": "boolean", "default": False},
                    "notes": {"type": "string"},
                    "fetch_metadata": {"type": "boolean", "default": True},
                },
                "required": ["item_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": True,
            },
        },
        {
            "name": "select_shopping_offer",
            "description": "Switch a shopping item's active retailer to a saved offer_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "offer_id": {"type": "string"},
                },
                "required": ["item_id", "offer_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "remove_shopping_offer",
            "description": "Delete a saved retailer offer from a shopping item.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "offer_id": {"type": "string"},
                },
                "required": ["item_id", "offer_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "upsert_retailer",
            "description": "Save optional shipping_cost and free_shipping_threshold metadata for a retailer domain (e.g. 'store.example.com').",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "domain": {"type": "string"},
                    "name": {"type": "string"},
                    "shipping_cost": {"type": ["number", "null"], "minimum": 0},
                    "free_shipping_threshold": {"type": ["number", "null"], "minimum": 0},
                    "currency": {"type": "string", "description": "e.g. TRY, USD, EUR"},
                    "notes": {"type": "string"},
                },
                "required": ["domain"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "move_shopping_to_inventory",
            "description": "Move a purchased shopping list item into the main inventory.",
            "inputSchema": {
                "type": "object",
                "properties": {"item_id": {"type": "string"}},
                "required": ["item_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        },
        {
            "name": "create_glossary_term",
            "description": "Add a new electronics glossary term.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "category": {"type": "string", "enum": GLOSSARY_CATEGORIES, "default": "Circuit Basics"},
                    "summary": {"type": "string"},
                    "rule_of_thumb": {"type": "string"},
                    "keywords": {"type": "string", "description": "Comma-separated lowercase keywords to link parts."},
                },
                "required": ["term"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        },
        {
            "name": "update_glossary_term",
            "description": "Update an existing glossary term by term_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "term_id": {"type": "string"},
                    "term": {"type": "string"},
                    "category": {"type": "string", "enum": GLOSSARY_CATEGORIES},
                    "summary": {"type": "string"},
                    "rule_of_thumb": {"type": "string"},
                    "keywords": {"type": "string"},
                },
                "required": ["term_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "delete_glossary_term",
            "description": "Delete a glossary term by term_id.",
            "inputSchema": {
                "type": "object",
                "properties": {"term_id": {"type": "string"}},
                "required": ["term_id"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
    ]
    return read_tools + write_tools


def _filter_tools_for_runtime(tools: list[dict[str, Any]], runtime: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in tools if _check_tool_permission(t["name"], runtime) is None]


def _compute_inventory_summary(settings: Settings) -> dict[str, Any]:
    parts = list_parts(settings.db_path)
    shopping = list_shopping_items(settings.db_path)
    glossary = list_glossary(settings.db_path)

    category_counts = Counter(p.get("category") or "Uncategorized" for p in parts)
    location_counts = Counter((p.get("location") or "").strip() for p in parts if (p.get("location") or "").strip())
    project_counts = Counter(
        (p.get("in_use_project") or "").strip() for p in parts if (p.get("in_use_project") or "").strip()
    )
    low_stock_count = sum(
        1
        for p in parts
        if p.get("low_stock_threshold") is not None and int(p.get("quantity") or 0) <= int(p["low_stock_threshold"])
    )
    needs_photo_count = sum(1 for p in parts if not (p.get("image_path") or "").strip())
    runtime = get_mcp_runtime_settings(settings)

    return {
        "total_parts": len(parts),
        "total_units": sum(int(p.get("quantity") or 0) for p in parts),
        "needs_photo_count": needs_photo_count,
        "low_stock_count": low_stock_count,
        "in_use_parts_count": sum(project_counts.values()),
        "shopping_items_count": len(shopping),
        "glossary_terms_count": len(glossary),
        "by_category": dict(sorted(category_counts.items())),
        "by_location": dict(sorted(location_counts.items())),
        "active_projects": dict(sorted(project_counts.items())),
        "valid_categories": CATEGORIES,
        "valid_glossary_categories": GLOSSARY_CATEGORIES,
        "read_only": runtime.get("access") == "ro",
    }


_KNOWN_BOARD_PINS: dict[str, set[str]] = {
    "c3": {
        "5V", "GND", "3V3",
        "GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7",
        "GPIO8", "GPIO9", "GPIO10", "GPIO20", "GPIO21",
    },
    "esp32": {
        "EN", "VIN", "GND", "3V3",
        "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO12", "GPIO13", "GPIO14", "GPIO15",
        "GPIO16", "GPIO17", "GPIO18", "GPIO19", "GPIO21", "GPIO22", "GPIO23", "GPIO25",
        "GPIO26", "GPIO27", "GPIO32", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO39",
        "TX0", "RX0", "TX2", "RX2", "VP", "VN",
    },
    "pico": {
        "VBUS", "VSYS", "GND", "3V3_EN", "3V3", "ADC_VREF", "RUN", "AGND",
        *(f"GP{i}" for i in range(23)), "GP26", "GP27", "GP28",
    },
    "uno": {
        "IOREF", "RESET", "3.3V", "3V3", "5V", "GND", "VIN", "AREF", "SDA", "SCL",
        *(f"A{i}" for i in range(6)), *(f"D{i}" for i in range(14)),
    },
}


def _detect_board_family(name: str) -> str:
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


def _expand_pin_tokens(pin_str: str) -> list[str]:
    raw = (pin_str or "").strip()
    if not raw:
        return []
    m = re.match(r"^(GPIO|GP|D|A)(\d+(?:/\d+)+)$", raw, re.IGNORECASE)
    if m:
        prefix = m.group(1).upper()
        return [f"{prefix}{num}" for num in m.group(2).split("/")]
    return [tok.strip().upper() for tok in re.split(r"[,/]", raw) if tok.strip()]


def _audit_project_wiring(project: dict[str, Any]) -> dict[str, Any]:
    """Programmatically verify wiring nets against project items, board pinouts, and electrical facts."""
    errors: list[str] = []
    warnings: list[str] = []

    items = project.get("items") or []
    by_ref = {str(it.get("ref") or ""): it for it in items if it.get("ref")}
    nets = project.get("nets") or []
    checks = project.get("checks") or []

    # Track pin usage per node across distinct nets to detect pin collisions
    pin_owners: dict[tuple[str, str], str] = {}
    has_power_hazard_net = False
    touches_strap = False

    for net in nets:
        net_name = str(net.get("name") or net.get("id") or "net")
        kind = str(net.get("kind") or "sig")
        if kind in ("bat", "v5"):
            has_power_hazard_net = True
        conns = net.get("conns") or []
        if len(conns) < 2:
            warnings.append(f"Net '{net_name}' has fewer than 2 endpoints.")

        i2c_addrs: dict[str, str] = {}
        seen_on_net: set[tuple[str, str]] = set()

        for pair in conns:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            ref, pin_raw = str(pair[0]), str(pair[1] or "")
            item = by_ref.get(ref)
            if not item:
                errors.append(f"Net '{net_name}' references unknown item ref '{ref}'.")
                continue

            item_name = str(item.get("label") or item.get("name") or ref)
            facts = item.get("electrical_facts") or {}
            tokens = _expand_pin_tokens(pin_raw)

            # Danger check: battery or 5V connected directly to a 3.3V pin
            if kind in ("bat", "v5") and any(t in ("3V3", "3.3V") for t in tokens):
                errors.append(
                    f"DANGER on '{net_name}': {kind.upper()} power connects to 3.3 V pin '{pin_raw}' on {item_name}."
                )

            # Board-specific pin validation (prevents hallucinated GPIOs)
            board_family = _detect_board_family(str(item.get("name") or ""))
            if board_family and (item.get("role") == "mcu" or item.get("category") == "Microcontrollers"):
                valid_pins = _KNOWN_BOARD_PINS[board_family]
                for tok in tokens:
                    if tok not in valid_pins:
                        errors.append(
                            f"Invalid pin '{tok}' on {item_name} (net '{net_name}'): not a real exposed pin on this board."
                        )

            # Pin conflict across different nets on the same board/MCU
            if item.get("role") == "mcu" or item.get("category") == "Microcontrollers":
                for tok in tokens:
                    key = (ref, tok)
                    if key in seen_on_net:
                        continue
                    seen_on_net.add(key)
                    if key in pin_owners and tok not in ("GND", "3V3", "3.3V", "5V", "VIN", "VBUS", "VSYS"):
                        errors.append(
                            f"Pin conflict on {item_name}: '{tok}' is wired to both '{pin_owners[key]}' and '{net_name}'."
                        )
                    else:
                        pin_owners[key] = net_name

            # Wake pin verification
            wake_pins = {str(p).upper() for p in (facts.get("wake") or [])}
            if net.get("wake") and wake_pins:
                for tok in tokens:
                    if tok.startswith(("GPIO", "GP")) and tok not in wake_pins:
                        errors.append(
                            f"Wake net '{net_name}' uses '{tok}' on {item_name}, which cannot wake it from deep sleep "
                            f"(valid wake pins: {', '.join(sorted(wake_pins))})."
                        )

            # Strapping pin reminder
            strap_pins = {str(p).upper() for p in (facts.get("strap") or [])}
            for tok in tokens:
                if tok in strap_pins:
                    touches_strap = True
                    warnings.append(
                        f"Net '{net_name}' uses strapping pin '{tok}' on {item_name} — verify its power-on boot level."
                    )

            # I2C address collision check
            if kind == "i2c" and facts.get("i2c"):
                addr = str(facts["i2c"]).strip().lower()
                if addr in i2c_addrs and i2c_addrs[addr] != item_name:
                    errors.append(
                        f"I2C address conflict on '{net_name}': both {i2c_addrs[addr]} and {item_name} use {addr}."
                    )
                else:
                    i2c_addrs[addr] = item_name

    if (has_power_hazard_net or touches_strap) and not checks:
        warnings.append(
            "Project has battery/5V power or strapping pins but no safety checks yet — call set_project_checks."
        )

    return {
        "status": "issues_found" if errors else "ok",
        "errors": errors,
        "warnings": warnings,
        "double_check_required": (
            "Before presenting this wiring map to the user, double-check every pin name, voltage rail, "
            "and physical top-view board orientation against official datasheets and product silkscreens."
        ),
    }


def _compact_part(part: dict[str, Any]) -> dict[str, Any]:
    return {k: part.get(k) for k in COMPACT_PART_KEYS}


def _strip_internal_image_paths(part: dict[str, Any]) -> dict[str, Any]:
    out = dict(part)
    out["has_photo"] = bool((out.pop("image_path", "") or "").strip())
    out["has_pinout_photo"] = bool((out.pop("pinout_image_path", "") or "").strip())
    out["has_pinout_svg"] = bool((out.get("pinout_svg") or "").strip())
    return out


def _strip_project_image_paths(proj: dict[str, Any]) -> dict[str, Any]:
    out = dict(proj)
    clean_items = []
    for it in out.get("items") or []:
        c = dict(it)
        c["has_photo"] = bool((c.pop("image_path", "") or "").strip())
        clean_items.append(c)
    out["items"] = clean_items
    return out


async def _fetch_optional_image(settings: Settings, url: str) -> str:
    clean = str(url or "").strip()
    if not clean:
        return ""
    try:
        scraped = await scrape_url(clean, settings.images_dir, settings.max_upload_bytes)
        return str(scraped.get("image_path") or "")
    except ScrapeError as exc:
        raise McpToolError(f"Could not download image from URL: {exc}") from exc


_PART_WRITE_TOOLS = {"create_part", "update_part", "batch_update_parts"}
_PROJECT_WRITE_TOOLS = {
    "create_project",
    "update_project",
    "create_project_variant",
    "update_project_variant",
    "add_project_item",
    "update_project_item",
    "set_project_wiring",
    "set_project_checks",
    "update_project_check",
    "teardown_project",
}
_SHOPPING_WRITE_TOOLS = {
    "create_shopping_item",
    "update_shopping_item",
    "add_shopping_offer",
    "select_shopping_offer",
    "remove_shopping_offer",
    "upsert_retailer",
    "move_shopping_to_inventory",
}
_DELETE_TOOLS = {
    "delete_part",
    "delete_project",
    "delete_project_variant",
    "remove_project_item",
    "delete_shopping_item",
    "remove_shopping_offer",
    "delete_glossary_term",
}
_GLOSSARY_WRITE_TOOLS = {"create_glossary_term", "update_glossary_term"}
_ALL_WRITE_TOOLS = (
    _PART_WRITE_TOOLS
    | _PROJECT_WRITE_TOOLS
    | _SHOPPING_WRITE_TOOLS
    | _DELETE_TOOLS
    | _GLOSSARY_WRITE_TOOLS
)


def _check_tool_permission(name: str, runtime: dict[str, Any]) -> str | None:
    if name not in _ALL_WRITE_TOOLS:
        return None
    if runtime.get("access") == "ro":
        return "Assistant is in read-only mode (Settings → Assistant)."
    if name == "move_shopping_to_inventory":
        if not runtime.get("can_shopping", True):
            return "Managing shopping is turned off in Settings → Assistant."
        if not runtime.get("can_parts", True):
            return "Editing parts is turned off in Settings → Assistant."
    if name in _DELETE_TOOLS and not runtime.get("can_delete", False):
        return "Deleting items is turned off in Settings → Assistant."
    if name in _PART_WRITE_TOOLS and not runtime.get("can_parts", True):
        return "Editing parts is turned off in Settings → Assistant."
    if name in _PROJECT_WRITE_TOOLS and not runtime.get("can_projects", True):
        return "Editing projects is turned off in Settings → Assistant."
    if name in _SHOPPING_WRITE_TOOLS and not runtime.get("can_shopping", True):
        return "Managing shopping is turned off in Settings → Assistant."
    if name in _GLOSSARY_WRITE_TOOLS and not (
        runtime.get("can_parts", True)
        or runtime.get("can_projects", True)
        or runtime.get("can_shopping", True)
    ):
        return "Write permissions are turned off in Settings → Assistant."
    return None


async def _execute_tool(settings: Settings, name: str, args: dict[str, Any]) -> Any:
    runtime = get_mcp_runtime_settings(settings)
    is_read_only = runtime.get("access") == "ro"
    deny_reason = _check_tool_permission(name, runtime)
    if deny_reason:
        raise McpToolError(deny_reason)

    record_mcp_request(settings.db_path)

    # --- Read tools ---
    if name == "inventory_summary":
        return _compute_inventory_summary(settings)

    if name == "list_retailers":
        return {"retailers": list_retailers(settings.db_path)}

    if name == "optimize_shopping_carts":
        apply_flag = bool(args.get("apply", False))
        if apply_flag and (is_read_only or not runtime.get("can_shopping", True)):
            raise McpToolError("Cannot apply optimization without shopping write permission.")
        res = optimize_shopping_carts(
            settings.db_path,
            project_id=args.get("project_id"),
            tag=args.get("tag"),
            mode=str(args.get("mode") or "fewest_orders"),
            include_out_of_stock=bool(args.get("include_out_of_stock", False)),
            include_inactive_variants=bool(args.get("include_inactive_variants", False)),
            apply=apply_flag,
        )
        if apply_flag and res.get("changes_count"):
            record_mcp_request(
                settings.db_path, name, "Shopping", f"Consolidated {res['changes_count']} shopping items across stores"
            )
        return res

    if name == "list_parts":
        parts = list_parts(
            settings.db_path,
            q=args.get("q"),
            category=args.get("category"),
            location=args.get("location"),
            needs_photo=bool(args.get("needs_photo", False)),
            in_use=bool(args.get("in_use", False)),
            low_stock=bool(args.get("low_stock", False)),
        )
        compact = bool(args.get("compact", True))
        items = [_compact_part(p) if compact else _strip_internal_image_paths(p) for p in parts]
        return {"count": len(items), "parts": items}

    if name == "get_part":
        part_id = str(args.get("part_id") or "").strip()
        if not part_id:
            raise McpToolError("part_id is required")
        part = get_part(settings.db_path, part_id)
        if part is None:
            raise McpToolError(f"Part not found: {part_id}")
        return _strip_internal_image_paths(part)

    if name == "list_projects":
        projs = [_strip_project_image_paths(p) for p in list_projects(settings.db_path)]
        return {"project_count": len(projs), "projects": projs}

    if name == "scrape_product_url":
        url = str(args.get("url") or "").strip()
        if not url:
            raise McpToolError("url is required")
        try:
            scraped = await scrape_url(url, settings.images_dir, settings.max_upload_bytes)
        except ScrapeError as exc:
            raise McpToolError(str(exc)) from exc
        # Do not keep an orphaned image on a read-only probe
        if scraped.get("image_path"):
            safe_delete_image(scraped["image_path"], settings.images_dir)
        return {
            "title": scraped.get("title", ""),
            "description": scraped.get("description", ""),
            "price": scraped.get("price", ""),
            "in_stock": scraped.get("in_stock", ""),
            "retailer": scraped.get("retailer", ""),
            "has_image": bool(scraped.get("image_path")),
            "source_url": scraped.get("source_url", url),
        }

    if name == "list_shopping":
        shopping = []
        for item in list_shopping_items(settings.db_path):
            c = dict(item)
            c["has_photo"] = bool((c.pop("image_path", "") or "").strip())
            shopping.append(c)
        result: dict[str, Any] = {"shopping_count": len(shopping), "shopping_items": shopping}
        if bool(args.get("include_low_stock", True)):
            low = [_compact_part(p) for p in list_parts(settings.db_path, low_stock=True)]
            result["low_stock_count"] = len(low)
            result["low_stock_parts"] = low
        return result

    if name == "list_glossary":
        terms = list_glossary(settings.db_path)
        cat = str(args.get("category") or "").strip()
        if cat and cat != "All":
            terms = [t for t in terms if t.get("category") == cat]
        q = str(args.get("q") or "").strip().lower()
        if q:
            terms = [
                t
                for t in terms
                if q in (t.get("term") or "").lower()
                or q in (t.get("summary") or "").lower()
                or q in (t.get("rule_of_thumb") or "").lower()
                or q in (t.get("keywords") or "").lower()
            ]
        return {"count": len(terms), "terms": terms}

    # --- Write tools ---
    if name == "create_part":
        part_name = str(args.get("name") or "").strip()
        if not part_name:
            raise McpToolError("name is required")
        data = {k: v for k, v in args.items() if k in PART_WRITABLE_FIELDS}
        data["name"] = part_name
        new_main_img = await _fetch_optional_image(settings, args.get("image_url", ""))
        try:
            new_pin_img = await _fetch_optional_image(settings, args.get("pinout_image_url", ""))
        except Exception:
            if new_main_img:
                safe_delete_image(new_main_img, settings.images_dir)
            raise
        if new_main_img:
            data["image_path"] = new_main_img
        if new_pin_img:
            data["pinout_image_path"] = new_pin_img
            if "pinout_svg" not in args:
                data["pinout_svg"] = ""
        try:
            created = create_part(settings.db_path, data)
        except (ValueError, ImageError) as exc:
            if new_main_img:
                safe_delete_image(new_main_img, settings.images_dir)
            if new_pin_img:
                safe_delete_image(new_pin_img, settings.images_dir)
            raise McpToolError(str(exc)) from exc
        record_mcp_request(settings.db_path, name, "Inventory", f"Added part {created['name']}")
        return _strip_internal_image_paths(created)

    if name == "update_part":
        part_id = str(args.get("part_id") or "").strip()
        if not part_id:
            raise McpToolError("part_id is required")
        existing = get_part(settings.db_path, part_id)
        if existing is None:
            raise McpToolError(f"Part not found: {part_id}")
        updates = {k: v for k, v in args.items() if k in PART_WRITABLE_FIELDS}
        new_main_img = await _fetch_optional_image(settings, args.get("image_url", ""))
        try:
            new_pin_img = await _fetch_optional_image(settings, args.get("pinout_image_url", ""))
        except Exception:
            if new_main_img:
                safe_delete_image(new_main_img, settings.images_dir)
            raise
        if new_main_img:
            updates["image_path"] = new_main_img
        if new_pin_img:
            updates["pinout_image_path"] = new_pin_img
            if "pinout_svg" not in args:
                updates["pinout_svg"] = ""
        try:
            updated = update_part(settings.db_path, part_id, updates)
        except (ValueError, ImageError) as exc:
            if new_main_img:
                safe_delete_image(new_main_img, settings.images_dir)
            if new_pin_img:
                safe_delete_image(new_pin_img, settings.images_dir)
            raise McpToolError(str(exc)) from exc
        if updated is None:
            if new_main_img:
                safe_delete_image(new_main_img, settings.images_dir)
            if new_pin_img:
                safe_delete_image(new_pin_img, settings.images_dir)
            raise McpToolError(f"Part not found: {part_id}")
        if new_main_img and existing.get("image_path") and existing["image_path"] != new_main_img:
            if not is_image_referenced(settings.db_path, existing["image_path"]):
                safe_delete_image(existing["image_path"], settings.images_dir)
        if new_pin_img and existing.get("pinout_image_path") and existing["pinout_image_path"] != new_pin_img:
            if not is_image_referenced(settings.db_path, existing["pinout_image_path"]):
                safe_delete_image(existing["pinout_image_path"], settings.images_dir)
        record_mcp_request(settings.db_path, name, "Inventory", f"Updated {updated['name']}")
        return _strip_internal_image_paths(updated)

    if name == "batch_update_parts":
        raw_updates = args.get("updates")
        if not isinstance(raw_updates, list) or not raw_updates:
            raise McpToolError("updates must be a non-empty list")
        if len(raw_updates) > MAX_BATCH_UPDATES:
            raise McpToolError(f"At most {MAX_BATCH_UPDATES} updates allowed per batch call")
        results: list[dict[str, Any]] = []
        updated_count = 0
        for entry in raw_updates:
            if not isinstance(entry, dict):
                results.append({"status": "error", "detail": "Entry must be an object"})
                continue
            pid = str(entry.get("part_id") or "").strip()
            if not pid:
                results.append({"status": "error", "detail": "Missing part_id"})
                continue
            patch = {k: v for k, v in entry.items() if k in PART_WRITABLE_FIELDS}
            try:
                updated = update_part(settings.db_path, pid, patch)
            except (ValueError, ImageError) as exc:
                results.append({"part_id": pid, "status": "error", "detail": str(exc)})
                continue
            if updated is None:
                results.append({"part_id": pid, "status": "not_found"})
            else:
                updated_count += 1
                results.append({"part_id": pid, "status": "updated", "name": updated["name"]})
        if updated_count:
            record_mcp_request(settings.db_path, name, "Inventory", f"Updated {updated_count} parts")
        return {"updated_count": updated_count, "results": results}

    if name == "delete_part":
        part_id = str(args.get("part_id") or "").strip()
        if not part_id:
            raise McpToolError("part_id is required")
        deleted = delete_part(settings.db_path, part_id)
        if deleted is None:
            raise McpToolError(f"Part not found: {part_id}")
        for img_fn in (deleted.get("image_path", ""), deleted.get("pinout_image_path", "")):
            if img_fn and not is_image_referenced(settings.db_path, img_fn):
                safe_delete_image(img_fn, settings.images_dir)
        record_mcp_request(settings.db_path, name, "Inventory", f"Removed {deleted.get('name', 'part')}")
        return {"status": "deleted", "id": part_id, "name": deleted.get("name", "")}

    if name == "create_project":
        try:
            created = create_project(settings.db_path, {k: v for k, v in args.items() if k != "id"})
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        record_mcp_request(settings.db_path, name, created["name"], f"Created project {created['name']}")
        return _strip_project_image_paths(created)

    if name == "update_project":
        project_id = str(args.get("project_id") or "").strip()
        if not project_id:
            raise McpToolError("project_id is required")
        try:
            updated = update_project(settings.db_path, project_id, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Project not found: {project_id}")
        record_mcp_request(settings.db_path, name, updated["name"], f"Updated project {updated['name']}")
        return _strip_project_image_paths(updated)

    if name == "delete_project":
        project_id = str(args.get("project_id") or "").strip()
        if not project_id:
            raise McpToolError("project_id is required")
        deleted = delete_project(settings.db_path, project_id)
        if deleted is None:
            raise McpToolError(f"Project not found: {project_id}")
        record_mcp_request(settings.db_path, name, "Projects", f"Deleted project {deleted.get('name', '')}")
        return {"status": "deleted", "id": project_id, "name": deleted.get("name", "")}

    if name == "create_project_variant":
        project_id = str(args.get("project_id") or "").strip()
        if not project_id:
            raise McpToolError("project_id is required")
        try:
            created = create_project_variant(
                settings.db_path, project_id, {k: v for k, v in args.items() if k != "id"}
            )
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if created is None:
            raise McpToolError(f"Project not found: {project_id}")
        return created

    if name == "update_project_variant":
        project_id = str(args.get("project_id") or "").strip()
        variant_id = str(args.get("variant_id") or "").strip()
        if not project_id or not variant_id:
            raise McpToolError("project_id and variant_id are required")
        try:
            updated = update_project_variant(settings.db_path, project_id, variant_id, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Variant not found: {variant_id}")
        return updated

    if name == "delete_project_variant":
        project_id = str(args.get("project_id") or "").strip()
        variant_id = str(args.get("variant_id") or "").strip()
        if not project_id or not variant_id:
            raise McpToolError("project_id and variant_id are required")
        if not delete_project_variant(settings.db_path, project_id, variant_id):
            raise McpToolError(f"Variant not found: {variant_id}")
        return {"status": "deleted", "id": variant_id}

    if name == "add_project_item":
        project_id = str(args.get("project_id") or "").strip()
        if not project_id:
            raise McpToolError("project_id is required")
        try:
            created = add_project_item(settings.db_path, project_id, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if created is None:
            raise McpToolError(f"Project not found: {project_id}")
        return created

    if name == "update_project_item":
        project_id = str(args.get("project_id") or "").strip()
        item_id = str(args.get("item_id") or "").strip()
        if not project_id or not item_id:
            raise McpToolError("project_id and item_id are required")
        try:
            updated = update_project_item(settings.db_path, project_id, item_id, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Project item not found: {item_id}")
        return updated

    if name == "remove_project_item":
        project_id = str(args.get("project_id") or "").strip()
        item_id = str(args.get("item_id") or "").strip()
        if not project_id or not item_id:
            raise McpToolError("project_id and item_id are required")
        if not delete_project_item(settings.db_path, project_id, item_id):
            raise McpToolError(f"Project item not found: {item_id}")
        return {"status": "deleted", "id": item_id}

    if name == "set_project_wiring":
        project_id = str(args.get("project_id") or "").strip()
        nets = args.get("nets")
        if not project_id or not isinstance(nets, list):
            raise McpToolError("project_id and nets list are required")
        updated = set_project_nets(settings.db_path, project_id, nets)
        if updated is None:
            raise McpToolError(f"Project not found: {project_id}")
        record_mcp_request(
            settings.db_path, name, updated["name"], f"Wrote {len(updated['nets'])} wiring connections"
        )
        result = _strip_project_image_paths(updated)
        result["verification_report"] = _audit_project_wiring(updated)
        return result

    if name == "set_project_checks":
        project_id = str(args.get("project_id") or "").strip()
        checks = args.get("checks")
        if not project_id or not isinstance(checks, list):
            raise McpToolError("project_id and checks list are required")
        updated = set_project_checks(settings.db_path, project_id, checks)
        if updated is None:
            raise McpToolError(f"Project not found: {project_id}")
        record_mcp_request(
            settings.db_path, name, updated["name"], f"Wrote {len(updated['checks'])} safety checks"
        )
        return _strip_project_image_paths(updated)

    if name == "update_project_check":
        project_id = str(args.get("project_id") or "").strip()
        check_id = str(args.get("check_id") or "").strip()
        if not project_id or not check_id:
            raise McpToolError("project_id and check_id are required")
        try:
            updated = update_project_check(settings.db_path, project_id, check_id, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Check not found: {check_id}")
        return _strip_project_image_paths(updated)

    if name == "teardown_project":
        project = str(args.get("project") or "").strip()
        if not project:
            raise McpToolError("project is required")
        cleared = teardown_project(settings.db_path, project)
        return {"status": "ok", "project": project, "parts_returned": cleared}

    if name == "create_shopping_item":
        item_name = str(args.get("name") or "").strip()
        if not item_name:
            raise McpToolError("name is required")
        data = {k: v for k, v in args.items() if k in SHOPPING_WRITABLE_FIELDS}
        data["name"] = item_name
        if isinstance(args.get("offers"), list):
            data["offers"] = args["offers"]
        saved_img = ""
        if args.get("image_url"):
            explicit_img = await _fetch_optional_image(settings, args["image_url"])
            if explicit_img:
                saved_img = explicit_img
                data["image_path"] = explicit_img
        fetch_meta = bool(args.get("fetch_metadata", True))
        if fetch_meta and data.get("url"):
            try:
                scraped = await scrape_url(
                    str(data["url"]),
                    settings.images_dir,
                    settings.max_upload_bytes,
                    download_image=not bool(data.get("image_path")),
                )
                if not data.get("image_path") and scraped.get("image_path"):
                    saved_img = scraped["image_path"]
                    data["image_path"] = saved_img
                if not data.get("price") and scraped.get("price"):
                    data["price"] = scraped["price"]
                if not data.get("retailer") and scraped.get("retailer"):
                    data["retailer"] = scraped["retailer"]
                if not data.get("in_stock") and scraped.get("in_stock"):
                    data["in_stock"] = scraped["in_stock"]
            except ScrapeError:
                pass
        try:
            created = create_shopping_item(settings.db_path, data)
        except ValueError as exc:
            if saved_img:
                safe_delete_image(saved_img, settings.images_dir)
            raise McpToolError(str(exc)) from exc
        record_mcp_request(settings.db_path, name, "Shopping", f"Added {created['name']} to shopping list")
        project_id = str(args.get("project_id") or "").strip()
        if project_id:
            try:
                add_project_item(
                    settings.db_path,
                    project_id,
                    {
                        "shopping_item_id": created["id"],
                        "variant_id": args.get("variant_id"),
                        "quantity_needed": created["quantity"],
                        "project_notes": data.get("why_needed") or "",
                    },
                )
                refreshed = get_shopping_item(settings.db_path, created["id"])
                if refreshed:
                    created = refreshed
            except ValueError:
                pass
        created["has_photo"] = bool((created.pop("image_path", "") or "").strip())
        return created

    if name == "update_shopping_item":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        existing = get_shopping_item(settings.db_path, item_id)
        if existing is None:
            raise McpToolError(f"Shopping item not found: {item_id}")
        updates = {k: v for k, v in args.items() if k in SHOPPING_WRITABLE_FIELDS}
        fetch_meta = bool(args.get("fetch_metadata", False))
        target_url = str(updates.get("url") or existing.get("url") or "").strip()
        old_img = existing.get("image_path") or ""
        new_img = ""
        if args.get("image_url"):
            new_img = await _fetch_optional_image(settings, args["image_url"])
            if new_img:
                updates["image_path"] = new_img
        if fetch_meta and target_url:
            try:
                scraped = await scrape_url(
                    target_url,
                    settings.images_dir,
                    settings.max_upload_bytes,
                    download_image=not bool(new_img),
                )
                if not new_img and scraped.get("image_path"):
                    new_img = scraped["image_path"]
                    updates["image_path"] = new_img
                if not updates.get("price") and not existing.get("price") and scraped.get("price"):
                    updates["price"] = scraped["price"]
                if scraped.get("retailer"):
                    updates["retailer"] = scraped["retailer"]
                if scraped.get("in_stock") and "in_stock" not in updates:
                    updates["in_stock"] = scraped["in_stock"]
            except ScrapeError:
                pass
        try:
            updated = update_shopping_item(settings.db_path, item_id, updates)
        except ValueError as exc:
            if new_img:
                safe_delete_image(new_img, settings.images_dir)
            raise McpToolError(str(exc)) from exc
        if updated is None:
            if new_img:
                safe_delete_image(new_img, settings.images_dir)
            raise McpToolError(f"Shopping item not found: {item_id}")
        if new_img and old_img and old_img != new_img:
            if not is_image_referenced(settings.db_path, old_img):
                safe_delete_image(old_img, settings.images_dir)
        updated["has_photo"] = bool((updated.pop("image_path", "") or "").strip())
        return updated

    if name == "delete_shopping_item":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        deleted = delete_shopping_item(settings.db_path, item_id)
        if deleted is None:
            raise McpToolError(f"Shopping item not found: {item_id}")
        del_img = deleted.get("image_path", "")
        if del_img and not is_image_referenced(settings.db_path, del_img):
            safe_delete_image(del_img, settings.images_dir)
        return {"status": "deleted", "id": item_id, "name": deleted.get("name", "")}

    if name == "add_shopping_offer":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        offer_data: dict[str, Any] = {
            "url": str(args.get("url") or "").strip(),
            "retailer": str(args.get("retailer") or "").strip(),
            "price": str(args.get("price") or "").strip(),
            "in_stock": str(args.get("in_stock") or "").strip(),
            "is_selected": bool(args.get("is_selected", False)),
            "notes": str(args.get("notes") or "").strip(),
        }
        scraped_img = ""
        if bool(args.get("fetch_metadata", True)) and offer_data["url"]:
            try:
                scraped = await scrape_url(offer_data["url"], settings.images_dir, settings.max_upload_bytes)
                if not offer_data["price"] and scraped.get("price"):
                    offer_data["price"] = scraped["price"]
                if not offer_data["retailer"] and scraped.get("retailer"):
                    offer_data["retailer"] = scraped["retailer"]
                if not offer_data["in_stock"] and scraped.get("in_stock"):
                    offer_data["in_stock"] = scraped["in_stock"]
                scraped_img = scraped.get("image_path") or ""
            except ScrapeError:
                pass
        try:
            updated = add_shopping_offer(settings.db_path, item_id, offer_data)
        except ValueError as exc:
            if scraped_img:
                safe_delete_image(scraped_img, settings.images_dir)
            raise McpToolError(str(exc)) from exc
        if updated is None:
            if scraped_img:
                safe_delete_image(scraped_img, settings.images_dir)
            raise McpToolError(f"Shopping item not found: {item_id}")
        if scraped_img:
            if not updated.get("image_path"):
                updated = update_shopping_item(settings.db_path, item_id, {"image_path": scraped_img}) or updated
            else:
                safe_delete_image(scraped_img, settings.images_dir)
        updated["has_photo"] = bool((updated.pop("image_path", "") or "").strip())
        return updated

    if name == "select_shopping_offer":
        item_id = str(args.get("item_id") or "").strip()
        offer_id = str(args.get("offer_id") or "").strip()
        if not item_id or not offer_id:
            raise McpToolError("item_id and offer_id are required")
        updated = update_shopping_offer(settings.db_path, item_id, offer_id, {"is_selected": True})
        if updated is None:
            raise McpToolError(f"Offer not found: {offer_id}")
        updated["has_photo"] = bool((updated.pop("image_path", "") or "").strip())
        return updated

    if name == "remove_shopping_offer":
        item_id = str(args.get("item_id") or "").strip()
        offer_id = str(args.get("offer_id") or "").strip()
        if not item_id or not offer_id:
            raise McpToolError("item_id and offer_id are required")
        updated = delete_shopping_offer(settings.db_path, item_id, offer_id)
        if updated is None:
            raise McpToolError(f"Offer not found: {offer_id}")
        updated["has_photo"] = bool((updated.pop("image_path", "") or "").strip())
        return updated

    if name == "upsert_retailer":
        domain = str(args.get("domain") or "").strip()
        if not domain:
            raise McpToolError("domain is required")
        try:
            return upsert_retailer(settings.db_path, domain, args)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc

    if name == "move_shopping_to_inventory":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        created_part = move_shopping_item_to_inventory(settings.db_path, item_id)
        if created_part is None:
            raise McpToolError(f"Shopping item not found: {item_id}")
        return _strip_internal_image_paths(created_part)

    if name == "create_glossary_term":
        term = str(args.get("term") or "").strip()
        if not term:
            raise McpToolError("term is required")
        data = {k: v for k, v in args.items() if k in GLOSSARY_WRITABLE_FIELDS}
        data["term"] = term
        return create_glossary_term(settings.db_path, data)

    if name == "update_glossary_term":
        term_id = str(args.get("term_id") or "").strip()
        if not term_id:
            raise McpToolError("term_id is required")
        updates = {k: v for k, v in args.items() if k in GLOSSARY_WRITABLE_FIELDS}
        try:
            updated = update_glossary_term(settings.db_path, term_id, updates)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Glossary term not found: {term_id}")
        return updated

    if name == "delete_glossary_term":
        term_id = str(args.get("term_id") or "").strip()
        if not term_id:
            raise McpToolError("term_id is required")
        if not delete_glossary_term(settings.db_path, term_id):
            raise McpToolError(f"Glossary term not found: {term_id}")
        return {"status": "deleted", "id": term_id}

    raise UnknownToolError(f"Unknown tool: {name}")


RESOURCES = [
    {
        "uri": "pinbin://inventory/summary",
        "name": "Workbench Inventory Summary",
        "description": "Counts, categories, storage bins, and active projects.",
        "mimeType": "application/json",
    },
    {
        "uri": "pinbin://inventory/parts",
        "name": "All Inventory Parts (Compact)",
        "description": "Compact list of every part currently in Pinbin.",
        "mimeType": "application/json",
    },
    {
        "uri": "pinbin://shopping",
        "name": "Shopping List",
        "description": "Wishlist / shopping items and low-stock parts.",
        "mimeType": "application/json",
    },
    {
        "uri": "pinbin://glossary",
        "name": "Workbench Glossary",
        "description": "All ASD-STE100 electronics glossary terms.",
        "mimeType": "application/json",
    },
]


async def _read_resource(settings: Settings, uri: str) -> dict[str, Any]:
    if uri == "pinbin://inventory/summary":
        payload: Any = _compute_inventory_summary(settings)
    elif uri == "pinbin://inventory/parts":
        payload = [_compact_part(p) for p in list_parts(settings.db_path)]
    elif uri == "pinbin://shopping":
        payload = await _execute_tool(settings, "list_shopping", {"include_low_stock": True})
    elif uri == "pinbin://glossary":
        payload = list_glossary(settings.db_path)
    else:
        raise KeyError(f"Unknown resource URI: {uri}")

    return {
        "contents": [
            {
                "uri": uri,
                "mimeType": "application/json",
                "text": json.dumps(payload, ensure_ascii=False, indent=2),
            }
        ]
    }


def _jsonrpc_result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _jsonrpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def _handle_single_rpc(settings: Settings, msg: Any) -> dict[str, Any] | None:
    """Process one JSON-RPC 2.0 message. Returns None for notifications."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        req_id = msg.get("id") if isinstance(msg, dict) else None
        return _jsonrpc_error(req_id, -32600, "Invalid JSON-RPC 2.0 request")

    is_notification = "id" not in msg
    req_id = msg.get("id")
    method = msg["method"]
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    if is_notification:
        # e.g. notifications/initialized, notifications/cancelled
        return None

    if method == "initialize":
        requested_version = str(params.get("protocolVersion") or "").strip()
        negotiated = (
            requested_version if requested_version in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
        )
        return _jsonrpc_result(
            req_id,
            {
                "protocolVersion": negotiated,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"subscribe": False, "listChanged": False},
                },
                "serverInfo": {"name": "pinbin", "version": "1.1.0"},
                "instructions": SERVER_INSTRUCTIONS,
            },
        )

    if method == "ping":
        return _jsonrpc_result(req_id, {})

    if method == "tools/list":
        runtime = get_mcp_runtime_settings(settings)
        tools = _filter_tools_for_runtime(_build_tool_definitions(runtime.get("access") == "ro"), runtime)
        return _jsonrpc_result(req_id, {"tools": tools})

    if method == "tools/call":
        tool_name = str(params.get("name") or "").strip()
        raw_args = params.get("arguments")
        if raw_args is None:
            tool_args: dict[str, Any] = {}
        elif isinstance(raw_args, dict):
            tool_args = raw_args
        else:
            return _jsonrpc_error(req_id, -32602, "Tool arguments must be a JSON object")

        try:
            result = await _execute_tool(settings, tool_name, tool_args)
            return _jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                    "isError": False,
                },
            )
        except UnknownToolError:
            return _jsonrpc_error(req_id, -32602, f"Unknown tool: {tool_name}")
        except McpToolError as exc:
            return _jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                },
            )
        except Exception:
            return _jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": f"Internal error while running tool '{tool_name}'"}],
                    "isError": True,
                },
            )

    if method == "resources/list":
        return _jsonrpc_result(req_id, {"resources": RESOURCES})

    if method == "resources/read":
        uri = str(params.get("uri") or "").strip()
        try:
            return _jsonrpc_result(req_id, await _read_resource(settings, uri))
        except KeyError:
            return _jsonrpc_error(req_id, -32602, f"Unknown resource: {uri}")

    return _jsonrpc_error(req_id, -32601, f"Method not found: {method}")


async def handle_mcp_post(request: Request, settings: Settings) -> Response:
    auth_err = verify_mcp_access(request, settings)
    if auth_err is not None:
        return auth_err

    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_MCP_BODY_BYTES:
        return JSONResponse(status_code=413, content=_jsonrpc_error(None, -32600, "Request body too large"))

    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > MAX_MCP_BODY_BYTES:
            return JSONResponse(status_code=413, content=_jsonrpc_error(None, -32600, "Request body too large"))
    raw_body = bytes(chunks)
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        return JSONResponse(status_code=400, content=_jsonrpc_error(None, -32700, "Parse error: invalid JSON"))

    if isinstance(payload, list):
        if not payload:
            return JSONResponse(
                status_code=400, content=_jsonrpc_error(None, -32600, "Invalid Request: empty batch")
            )
        if len(payload) > MAX_MCP_BATCH_SIZE:
            return JSONResponse(
                status_code=400,
                content=_jsonrpc_error(None, -32600, f"Batch exceeds maximum size of {MAX_MCP_BATCH_SIZE}"),
            )
        responses = []
        for item in payload:
            r = await _handle_single_rpc(settings, item)
            if r is not None:
                responses.append(r)
        if not responses:
            return Response(status_code=202)
        return JSONResponse(status_code=200, content=responses)

    response_obj = await _handle_single_rpc(settings, payload)
    if response_obj is None:
        return Response(status_code=202)
    return JSONResponse(status_code=200, content=response_obj)
