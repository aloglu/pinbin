"""Stateless Streamable HTTP MCP (Model Context Protocol) server for Pinbin.

Implements JSON-RPC 2.0 over POST /mcp with:
- Optional Bearer token verification (MCP_API_TOKEN) in addition to Cloudflare Access.
- Read-only mode (MCP_READ_ONLY=true) that hides and blocks all mutating tools.
- Never exposes /api/restore, /api/backup, raw filesystem image paths, or server secrets.
"""
from __future__ import annotations

import hmac
import json
from collections import Counter
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.config import CATEGORIES, Settings
from app.db import (
    create_glossary_term,
    create_part,
    create_shopping_item,
    delete_glossary_term,
    delete_part,
    delete_shopping_item,
    get_part,
    list_glossary,
    list_parts,
    list_shopping_items,
    move_shopping_item_to_inventory,
    teardown_project,
    update_glossary_term,
    update_part,
    update_shopping_item,
)
from app.glossary_seed import GLOSSARY_CATEGORIES
from app.images import safe_delete_image

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL_VERSION = "2025-03-26"
MAX_BATCH_UPDATES = 50

SERVER_INSTRUCTIONS = (
    "Pinbin is a personal electronics workbench inventory, shopping list, and glossary. "
    "Use inventory_summary or list_parts to inspect available components, bins, and active projects "
    "before suggesting builds or making updates. "
    "When writing descriptions, warnings, notes, or glossary terms, prefer short, plain ASD-STE100 "
    "sentences (active voice, imperative mood for warnings/rules of thumb). "
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
    "specs",
}

SHOPPING_WRITABLE_FIELDS = {"name", "url", "price", "quantity", "notes"}
GLOSSARY_WRITABLE_FIELDS = {"term", "category", "summary", "rule_of_thumb", "keywords"}


class McpToolError(Exception):
    """Raised when a tool call fails with a user/agent-readable message."""


def verify_mcp_access(request: Request, settings: Settings) -> JSONResponse | None:
    """Enforce MCP_ENABLED and optional MCP_API_TOKEN Bearer auth.

    CloudflareAccessMiddleware has already validated Cloudflare Access JWTs
    (including Service Tokens) when LOCAL_DEV_MODE=false.
    """
    if not settings.mcp_enabled:
        return JSONResponse(status_code=404, content={"detail": "MCP endpoint is disabled"})

    if settings.mcp_api_token:
        auth_header = request.headers.get("Authorization", "").strip()
        prefix = "Bearer "
        if not auth_header.startswith(prefix):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing Bearer token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        provided = auth_header[len(prefix) :].strip()
        if not hmac.compare_digest(provided.encode("utf-8"), settings.mcp_api_token.encode("utf-8")):
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid MCP API token"},
                headers={"WWW-Authenticate": "Bearer"},
            )

    return None


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
        "location": {"type": "string", "description": "Storage bin or drawer label (e.g. 'Bin A2')."},
        "in_use_project": {
            "type": "string",
            "description": "Project name if currently deployed on the bench, or empty string.",
        },
        "what_it_does": {"type": "string", "description": "Beginner-friendly 1-2 sentence summary."},
        "visual_tell": {"type": "string", "description": "Concise physical clue to spot the part in a bin."},
        "warning": {"type": "string", "description": "Voltage, polarity, or lookalike caution."},
        "notes": {"type": "string", "description": "Pin-order, I2C/SPI address, or wiring notes."},
        "source_url": {"type": "string", "description": "Store or product reference URL."},
        "pinout_url": {"type": "string", "description": "Official documentation or pinout URL."},
        "specs": {
            "type": "object",
            "additionalProperties": {"type": "string"},
            "description": "Flat key-value technical specs (e.g. {'Voltage': '3.3V', 'Interface': 'I2C'}).",
        },
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
            "description": "List all active bench projects and the parts currently assigned to each project.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
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
                            "properties": {"part_id": {"type": "string"}, **part_props},
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
            "name": "teardown_project",
            "description": "Return all parts assigned to a project back to general inventory (clears in_use_project).",
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
            "description": "Add a part or supply to the Pinbin shopping list.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1, "default": 1},
                    "url": {"type": "string"},
                    "price": {"type": "string"},
                    "notes": {"type": "string"},
                },
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
            "name": "update_shopping_item",
            "description": "Update an existing shopping list item by item_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "url": {"type": "string"},
                    "price": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["item_id"],
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
        "read_only": settings.mcp_read_only,
    }


def _compact_part(part: dict[str, Any]) -> dict[str, Any]:
    return {k: part.get(k) for k in COMPACT_PART_KEYS}


def _strip_internal_image_paths(part: dict[str, Any]) -> dict[str, Any]:
    out = dict(part)
    out["has_photo"] = bool((out.pop("image_path", "") or "").strip())
    out["has_pinout_photo"] = bool((out.pop("pinout_image_path", "") or "").strip())
    return out


def _execute_tool(settings: Settings, name: str, args: dict[str, Any]) -> Any:
    write_tool_names = {
        "create_part",
        "update_part",
        "batch_update_parts",
        "delete_part",
        "teardown_project",
        "create_shopping_item",
        "update_shopping_item",
        "delete_shopping_item",
        "move_shopping_to_inventory",
        "create_glossary_term",
        "update_glossary_term",
        "delete_glossary_term",
    }
    if settings.mcp_read_only and name in write_tool_names:
        raise McpToolError("MCP server is in read-only mode (MCP_READ_ONLY=true).")

    # --- Read tools ---
    if name == "inventory_summary":
        return _compute_inventory_summary(settings)

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
        parts = list_parts(settings.db_path, in_use=True)
        grouped: dict[str, list[dict[str, Any]]] = {}
        for p in parts:
            proj = (p.get("in_use_project") or "").strip()
            if proj:
                grouped.setdefault(proj, []).append(_compact_part(p))
        return {"project_count": len(grouped), "projects": grouped}

    if name == "list_shopping":
        shopping = [
            {k: v for k, v in item.items() if k != "image_path"}
            for item in list_shopping_items(settings.db_path)
        ]
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
        created = create_part(settings.db_path, data)
        return _strip_internal_image_paths(created)

    if name == "update_part":
        part_id = str(args.get("part_id") or "").strip()
        if not part_id:
            raise McpToolError("part_id is required")
        updates = {k: v for k, v in args.items() if k in PART_WRITABLE_FIELDS}
        try:
            updated = update_part(settings.db_path, part_id, updates)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Part not found: {part_id}")
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
            except ValueError as exc:
                results.append({"part_id": pid, "status": "error", "detail": str(exc)})
                continue
            if updated is None:
                results.append({"part_id": pid, "status": "not_found"})
            else:
                updated_count += 1
                results.append({"part_id": pid, "status": "updated", "name": updated["name"]})
        return {"updated_count": updated_count, "results": results}

    if name == "delete_part":
        part_id = str(args.get("part_id") or "").strip()
        if not part_id:
            raise McpToolError("part_id is required")
        deleted = delete_part(settings.db_path, part_id)
        if deleted is None:
            raise McpToolError(f"Part not found: {part_id}")
        safe_delete_image(deleted.get("image_path", ""), settings.images_dir)
        safe_delete_image(deleted.get("pinout_image_path", ""), settings.images_dir)
        return {"status": "deleted", "id": part_id, "name": deleted.get("name", "")}

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
        created = create_shopping_item(settings.db_path, data)
        created.pop("image_path", None)
        return created

    if name == "update_shopping_item":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        updates = {k: v for k, v in args.items() if k in SHOPPING_WRITABLE_FIELDS}
        try:
            updated = update_shopping_item(settings.db_path, item_id, updates)
        except ValueError as exc:
            raise McpToolError(str(exc)) from exc
        if updated is None:
            raise McpToolError(f"Shopping item not found: {item_id}")
        updated.pop("image_path", None)
        return updated

    if name == "delete_shopping_item":
        item_id = str(args.get("item_id") or "").strip()
        if not item_id:
            raise McpToolError("item_id is required")
        deleted = delete_shopping_item(settings.db_path, item_id)
        if deleted is None:
            raise McpToolError(f"Shopping item not found: {item_id}")
        safe_delete_image(deleted.get("image_path", ""), settings.images_dir)
        return {"status": "deleted", "id": item_id, "name": deleted.get("name", "")}

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

    raise KeyError(f"Unknown tool: {name}")


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


def _read_resource(settings: Settings, uri: str) -> dict[str, Any]:
    if uri == "pinbin://inventory/summary":
        payload: Any = _compute_inventory_summary(settings)
    elif uri == "pinbin://inventory/parts":
        payload = [_compact_part(p) for p in list_parts(settings.db_path)]
    elif uri == "pinbin://shopping":
        payload = _execute_tool(settings, "list_shopping", {"include_low_stock": True})
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


def _handle_single_rpc(settings: Settings, msg: Any) -> dict[str, Any] | None:
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
                "serverInfo": {"name": "pinbin", "version": "1.0.0"},
                "instructions": SERVER_INSTRUCTIONS,
            },
        )

    if method == "ping":
        return _jsonrpc_result(req_id, {})

    if method == "tools/list":
        return _jsonrpc_result(req_id, {"tools": _build_tool_definitions(settings.mcp_read_only)})

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
            result = _execute_tool(settings, tool_name, tool_args)
            return _jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                    "isError": False,
                },
            )
        except KeyError:
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
            return _jsonrpc_result(req_id, _read_resource(settings, uri))
        except KeyError:
            return _jsonrpc_error(req_id, -32602, f"Unknown resource: {uri}")

    return _jsonrpc_error(req_id, -32601, f"Method not found: {method}")


async def handle_mcp_post(request: Request, settings: Settings) -> Response:
    auth_err = verify_mcp_access(request, settings)
    if auth_err is not None:
        return auth_err

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content=_jsonrpc_error(None, -32700, "Parse error: invalid JSON"))

    if isinstance(payload, list):
        if not payload:
            return JSONResponse(
                status_code=400, content=_jsonrpc_error(None, -32600, "Invalid Request: empty batch")
            )
        responses = [r for r in (_handle_single_rpc(settings, item) for item in payload) if r is not None]
        if not responses:
            return Response(status_code=202)
        return JSONResponse(status_code=200, content=responses)

    response_obj = _handle_single_rpc(settings, payload)
    if response_obj is None:
        return Response(status_code=202)
    return JSONResponse(status_code=200, content=response_obj)
