from __future__ import annotations

import csv
import io
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import segno
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.auth import CloudflareAccessMiddleware, render_guest_locked_html
from app.backup import BackupError, create_backup_zip_bytes, restore_backup_zip_bytes
from app.config import CATEGORIES, Settings, load_settings
from app.db import (
    GUEST_COOKIE_NAME,
    PROJECT_STATUSES,
    add_project_item,
    add_project_net,
    add_shopping_offer,
    bulk_update_shopping_status_by_store,
    create_glossary_term,
    create_part,
    create_project,
    create_project_variant,
    create_shopping_item,
    delete_glossary_term,
    delete_part,
    delete_project,
    delete_project_check,
    delete_project_item,
    delete_project_net,
    delete_project_variant,
    delete_retailer,
    delete_shopping_item,
    delete_shopping_offer,
    get_ai_usage_today,
    get_guest_pass_settings,
    get_mcp_runtime_settings,
    get_part,
    get_project,
    get_shopping_item,
    get_storage_stats,
    get_ui_settings,
    import_parts_from_rows,
    init_db,
    issue_guest_session_cookie_value,
    list_glossary,
    list_mcp_activity,
    list_parts,
    list_projects,
    list_retailers,
    list_shopping_items,
    move_shopping_item_to_inventory,
    optimize_shopping_carts,
    record_backup_timestamp,
    record_guest_pass_use,
    rename_bin,
    rotate_guest_pass_token,
    rotate_mcp_token,
    seed_if_empty,
    set_project_checks,
    set_project_nets,
    teardown_project,
    update_glossary_term,
    update_guest_pass_settings,
    update_mcp_runtime_settings,
    update_part,
    update_project,
    update_project_check,
    update_project_item,
    update_project_variant,
    update_shopping_item,
    update_shopping_offer,
    update_ui_settings,
    upsert_retailer,
    upsert_suggested_glossary_terms,
    utc_today_str,
    verify_guest_pass_token,
    wipe_all_data,
)
from app.enricher import EnrichError, check_parts_compatibility_ai, enrich_part, explain_glossary_term
from app.glossary_seed import GLOSSARY_CATEGORIES
from app.images import (
    ImageError,
    process_and_save_image,
    resolve_safe_image_path,
    safe_delete_image,
)
from app.mcp import handle_mcp_post, verify_mcp_access
from app.scraper import ScrapeError, find_image_candidates, scrape_url

STATIC_DIR = Path(__file__).resolve().parent / "static"


class PartCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    subtitle: str = ""
    category: str = "Sensors"
    quantity: int = Field(default=1, ge=0)
    low_stock_threshold: int | None = Field(default=None, ge=0)
    location: str = ""
    in_use_project: str = ""
    what_it_does: str = ""
    visual_tell: str = ""
    warning: str = ""
    notes: str = ""
    source_url: str = ""
    image_path: str = ""
    pinout_image_path: str = ""
    pinout_url: str = ""
    pinout_svg: str = ""
    specs: dict[str, str] = Field(default_factory=dict)
    electrical_facts: dict[str, Any] = Field(default_factory=dict)
    care_notes: list[dict[str, str]] = Field(default_factory=list)


class PartPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    subtitle: str | None = None
    category: str | None = None
    quantity: int | None = Field(default=None, ge=0)
    low_stock_threshold: int | None = Field(default=None, ge=0)
    location: str | None = None
    in_use_project: str | None = None
    what_it_does: str | None = None
    visual_tell: str | None = None
    warning: str | None = None
    notes: str | None = None
    source_url: str | None = None
    image_path: str | None = None
    pinout_image_path: str | None = None
    pinout_url: str | None = None
    pinout_svg: str | None = None
    specs: dict[str, str] | None = None
    electrical_facts: dict[str, Any] | None = None
    care_notes: list[dict[str, str]] | None = None


class BinRenameRequest(BaseModel):
    old_bin: str = Field(..., min_length=1, max_length=64)
    new_bin: str = Field(..., min_length=1, max_length=64)


class ScrapeRequest(BaseModel):
    url: str = Field(..., min_length=1)
    part_id: str | None = None
    slot: str = "main"


class EnrichRequest(BaseModel):
    query: str = ""
    scraped_title: str = ""
    scraped_description: str = ""
    fetch_image: bool = True
    part_id: str | None = None


class UiSettingsPatch(BaseModel):
    theme: str | None = None
    font: str | None = None
    motion: str | None = None
    view_mode: str | None = None
    sort_by: str | None = None
    inline_tooltips: bool | None = None
    show_caution_badge: bool | None = None
    show_ok_checks: bool | None = None
    strap_pin_checks: bool | None = None
    currency: str | None = None
    logo_color: str | None = None


class McpSettingsPatch(BaseModel):
    access: str | None = None
    can_parts: bool | None = None
    can_projects: bool | None = None
    can_shopping: bool | None = None
    can_delete: bool | None = None


class GuestPassPatch(BaseModel):
    enabled: bool


class WipeRequest(BaseModel):
    confirm: str = Field(..., min_length=1, max_length=32)


class GlossaryCreate(BaseModel):
    term: str = Field(..., min_length=1, max_length=120)
    category: str = "Circuit Basics"
    summary: str = ""
    rule_of_thumb: str = ""
    keywords: str = ""
    related_ids: list[str] = Field(default_factory=list)
    bench_tool: str = ""
    figure_key: str = ""


class GlossaryPatch(BaseModel):
    term: str | None = Field(default=None, min_length=1, max_length=120)
    category: str | None = None
    summary: str | None = None
    rule_of_thumb: str | None = None
    keywords: str | None = None
    related_ids: list[str] | None = None
    bench_tool: str | None = None
    figure_key: str | None = None


class GlossaryExplainRequest(BaseModel):
    term: str = Field(..., min_length=1, max_length=120)


class ProjectTeardownRequest(BaseModel):
    project: str = Field(..., min_length=1, max_length=200)


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    description: str = ""
    option: str = ""
    tags: list[str] = Field(default_factory=list)
    status: str = "planning"
    notes: str = ""


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    option: str | None = None
    tags: list[str] | None = None
    status: str | None = None
    notes: str | None = None


class ProjectVariantCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = ""
    notes: str = ""
    is_selected: bool = False
    sort_order: int | None = None


class ProjectVariantPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    notes: str | None = None
    is_selected: bool | None = None
    sort_order: int | None = None


class ProjectItemCreate(BaseModel):
    variant_id: str | None = None
    part_id: str | None = None
    shopping_item_id: str | None = None
    ref: str = ""
    role: str = ""
    label: str = ""
    quantity_needed: int = Field(default=1, ge=1)
    project_notes: str = ""


class ProjectItemPatch(BaseModel):
    variant_id: str | None = None
    ref: str | None = None
    role: str | None = None
    label: str | None = None
    quantity_needed: int | None = Field(default=None, ge=1)
    project_notes: str | None = None


class ProjectNetsReplace(BaseModel):
    nets: list[dict[str, Any]] = Field(default_factory=list)


class ProjectNetCreate(BaseModel):
    name: str = ""
    kind: str = "sig"
    rail: float | None = None
    chain: bool = False
    wake: bool = False
    conns: list[Any] = Field(default_factory=list)


class ProjectChecksReplace(BaseModel):
    checks: list[dict[str, Any]] = Field(default_factory=list)


class ProjectCheckPatch(BaseModel):
    severity: str | None = None
    title: str | None = None
    body: str | None = None
    node_refs: list[str] | None = None
    net_ids: list[str] | None = None
    is_done: bool | None = None


class ShoppingItemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    url: str = ""
    price: str = ""
    quantity: int = Field(default=1, ge=1)
    notes: str = ""
    image_path: str = ""
    retailer: str = ""
    tag: str = ""
    category: str = ""
    specs: dict[str, str] = Field(default_factory=dict)
    electrical_facts: dict[str, Any] = Field(default_factory=dict)
    care_notes: list[dict[str, str]] = Field(default_factory=list)
    status: str = "order"
    in_stock: str = ""
    why_needed: str = ""
    project_id: str | None = None
    variant_id: str | None = None
    fetch_metadata: bool = False
    offers: list[dict[str, Any]] | None = None


class ShoppingStoreStatusRequest(BaseModel):
    retailer: str = ""
    status: str = Field(..., min_length=1, max_length=20)
    item_ids: list[str] | None = None


class ShoppingOfferCreate(BaseModel):
    url: str = ""
    retailer: str = ""
    price: str = ""
    in_stock: str = ""
    is_selected: bool = False
    notes: str = ""
    fetch_metadata: bool = False


class ShoppingOfferPatch(BaseModel):
    url: str | None = None
    retailer: str | None = None
    price: str | None = None
    in_stock: str | None = None
    is_selected: bool | None = None
    notes: str | None = None


class RetailerUpsert(BaseModel):
    name: str = ""
    shipping_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    free_shipping_threshold: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    currency: str = ""
    notes: str = ""


class ShoppingOptimizeRequest(BaseModel):
    item_ids: list[str] | None = None
    project_id: str | None = None
    tag: str | None = None
    mode: str = "fewest_orders"
    include_out_of_stock: bool = False
    include_inactive_variants: bool = False
    apply: bool = False


class ShoppingItemPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = None
    price: str | None = None
    quantity: int | None = Field(default=None, ge=1)
    notes: str | None = None
    image_path: str | None = None
    retailer: str | None = None
    tag: str | None = None
    category: str | None = None
    specs: dict[str, str] | None = None
    electrical_facts: dict[str, Any] | None = None
    care_notes: list[dict[str, str]] | None = None
    status: str | None = None
    in_stock: str | None = None
    why_needed: str | None = None


class CompatibilityRequest(BaseModel):
    part_ids: list[str] = Field(..., min_length=2, max_length=6)


def create_app(custom_settings: Settings | None = None) -> FastAPI:
    settings = custom_settings or load_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        settings.validate_security()
        init_db(settings)
        seed_if_empty(settings)
        yield

    application = FastAPI(
        title="Pinbin",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    application.state.settings = settings
    application.add_middleware(CloudflareAccessMiddleware, settings=settings)

    # Static assets (owner + isolated guest prefix)
    application.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    application.mount("/guest/static", StaticFiles(directory=str(STATIC_DIR)), name="guest_static")

    _GEAR_LINK_RE = re.compile(r'<a[^>]*id="gearBtn"[^>]*>.*?</a>', re.DOTALL)

    def _render_guest_shell_html() -> str:
        raw = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        raw = raw.replace('href="/manifest.webmanifest"', 'href="/guest/manifest.webmanifest"')
        raw = raw.replace('href="/static/', 'href="/guest/static/')
        raw = raw.replace('src="/static/', 'src="/guest/static/')
        raw = raw.replace('href="/inventory"', 'href="/guest/inventory"')
        raw = _GEAR_LINK_RE.sub('<span class="tag guest-pill">Read-only</span>', raw)
        return raw

    @application.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/manifest.webmanifest")
    async def manifest() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "manifest.webmanifest",
            media_type="application/manifest+json",
        )

    @application.get("/apple-touch-icon.png")
    @application.get("/apple-touch-icon-precomposed.png")
    async def apple_touch_icon() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "brand" / "apple-touch-icon.png",
            media_type="image/png",
        )

    @application.get("/")
    @application.get("/inventory")
    @application.get("/parts/new")
    @application.get("/parts/{part_id}/edit")
    @application.get("/projects")
    @application.get("/projects/new")
    @application.get("/projects/{project_id}")
    @application.get("/projects/{project_id}/edit")
    @application.get("/shopping")
    @application.get("/shopping/new")
    @application.get("/shopping/{item_id}/edit")
    @application.get("/glossary")
    @application.get("/bench")
    @application.get("/bench/{subtab}")
    @application.get("/settings")
    async def index(
        part_id: str | None = None,
        project_id: str | None = None,
        item_id: str | None = None,
        subtab: str | None = None,
    ) -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    # --- Isolated read-only Guest Pass routes (/guest/*) ---
    @application.get("/guest/pass/{token}")
    async def guest_pass_redeem(token: str, next: str | None = Query(default=None)) -> Response:
        if not verify_guest_pass_token(settings.db_path, token):
            resp = HTMLResponse(status_code=403, content=render_guest_locked_html())
            resp.delete_cookie(GUEST_COOKIE_NAME, path="/guest")
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["Referrer-Policy"] = "no-referrer"
            return resp

        cookie_val = issue_guest_session_cookie_value(settings.db_path)
        if not cookie_val:
            resp = HTMLResponse(status_code=403, content=render_guest_locked_html())
            resp.headers["Cache-Control"] = "no-store"
            return resp

        record_guest_pass_use(settings.db_path)
        target = "/guest/inventory"
        if (
            next
            and next.startswith("/guest/")
            and not next.startswith("/guest/pass/")
            and "//" not in next
            and "\r" not in next
            and "\n" not in next
        ):
            target = next

        resp = RedirectResponse(url=target, status_code=302)
        resp.set_cookie(
            key=GUEST_COOKIE_NAME,
            value=cookie_val,
            max_age=60 * 60 * 24 * 30,
            path="/guest",
            httponly=True,
            samesite="lax",
            secure=not settings.local_dev_mode,
        )
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @application.get("/guest/logout")
    async def guest_logout() -> Response:
        resp = HTMLResponse(
            status_code=200,
            content=render_guest_locked_html(
                "Signed out of guest view",
                "Open your guest link again to browse in read-only mode.",
            ),
        )
        resp.delete_cookie(GUEST_COOKIE_NAME, path="/guest")
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @application.get("/guest/manifest.webmanifest")
    async def guest_manifest() -> JSONResponse:
        raw = json.loads((STATIC_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
        raw["start_url"] = "/guest/inventory"
        raw["scope"] = "/guest/"
        for icon in raw.get("icons", []):
            src = str(icon.get("src") or "")
            if src.startswith("/static/"):
                icon["src"] = f"/guest{src}"
        return JSONResponse(content=raw, media_type="application/manifest+json")

    @application.get("/guest/apple-touch-icon.png")
    async def guest_apple_touch_icon() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "brand" / "apple-touch-icon.png",
            media_type="image/png",
        )

    @application.get("/guest")
    @application.get("/guest/")
    @application.get("/guest/inventory")
    @application.get("/guest/projects")
    @application.get("/guest/projects/{project_id}")
    @application.get("/guest/shopping")
    @application.get("/guest/glossary")
    @application.get("/guest/bench")
    @application.get("/guest/bench/{subtab}")
    async def guest_index(project_id: str | None = None, subtab: str | None = None) -> HTMLResponse:
        return HTMLResponse(
            content=_render_guest_shell_html(),
            headers={"Cache-Control": "no-store"},
        )

    @application.get("/guest/images/{filename}")
    async def guest_serve_image(filename: str) -> FileResponse:
        img_path = resolve_safe_image_path(filename, settings.images_dir)
        if img_path is None:
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(
            img_path,
            media_type="image/webp",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @application.get("/guest/api/config")
    async def guest_api_config() -> dict[str, Any]:
        ui = dict(get_ui_settings(settings.db_path))
        ui.pop("last_backup_at", None)
        return {
            "guest_mode": True,
            "categories": CATEGORIES,
            "glossary_categories": GLOSSARY_CATEGORIES,
            "ui_settings": ui,
        }

    @application.get("/guest/api/parts")
    async def guest_api_list_parts(
        q: str | None = Query(default=None),
        category: str | None = Query(default=None),
        location: str | None = Query(default=None),
        needs_photo: bool = Query(default=False),
        in_use: bool = Query(default=False),
        low_stock: bool = Query(default=False),
    ) -> list[dict[str, Any]]:
        return list_parts(
            settings.db_path,
            q=q,
            category=category,
            location=location,
            needs_photo=needs_photo,
            in_use=in_use,
            low_stock=low_stock,
        )

    @application.get("/guest/api/projects")
    async def guest_api_list_projects() -> list[dict[str, Any]]:
        return list_projects(settings.db_path)

    @application.get("/guest/api/shopping")
    async def guest_api_list_shopping() -> list[dict[str, Any]]:
        return list_shopping_items(settings.db_path)

    @application.get("/guest/api/retailers")
    async def guest_api_list_retailers() -> list[dict[str, Any]]:
        return list_retailers(settings.db_path)

    @application.get("/guest/api/glossary")
    async def guest_api_list_glossary() -> list[dict[str, Any]]:
        return list_glossary(settings.db_path)

    @application.get("/images/{filename}")
    async def serve_image(filename: str) -> FileResponse:
        img_path = resolve_safe_image_path(filename, settings.images_dir)
        if img_path is None:
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(
            img_path,
            media_type="image/webp",
            headers={"Cache-Control": "private, max-age=31536000, immutable"},
        )

    @application.get("/api/config")
    async def api_config() -> dict[str, Any]:
        used = get_ai_usage_today(settings.db_path)
        remaining = max(0, settings.ai_daily_limit - used) if settings.ai_enabled else 0
        return {
            "guest_mode": False,
            "ai_enabled": settings.ai_enabled,
            "ai_remaining_today": remaining,
            "local_dev_mode": settings.local_dev_mode,
            "mcp_enabled": settings.mcp_enabled,
            "mcp_read_only": settings.mcp_read_only,
            "categories": CATEGORIES,
            "glossary_categories": GLOSSARY_CATEGORIES,
            "ui_settings": get_ui_settings(settings.db_path),
        }

    @application.get("/api/glossary")
    async def api_list_glossary() -> list[dict[str, Any]]:
        return list_glossary(settings.db_path)

    @application.post("/api/glossary", status_code=201)
    async def api_create_glossary(payload: GlossaryCreate) -> dict[str, Any]:
        return create_glossary_term(settings.db_path, payload.model_dump())

    @application.patch("/api/glossary/{term_id}")
    async def api_patch_glossary(term_id: str, payload: GlossaryPatch) -> dict[str, Any]:
        try:
            updated = update_glossary_term(settings.db_path, term_id, payload.model_dump(exclude_unset=True))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Glossary term not found")
        return updated

    @application.delete("/api/glossary/{term_id}")
    async def api_delete_glossary(term_id: str) -> dict[str, str]:
        if not delete_glossary_term(settings.db_path, term_id):
            raise HTTPException(status_code=404, detail="Glossary term not found")
        return {"status": "deleted", "id": term_id}

    @application.post("/api/glossary/explain")
    async def api_explain_glossary(payload: GlossaryExplainRequest) -> dict[str, str]:
        try:
            return await explain_glossary_term(settings, payload.term)
        except EnrichError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @application.get("/api/projects")
    async def api_list_projects() -> list[dict[str, Any]]:
        return list_projects(settings.db_path)

    @application.post("/api/projects", status_code=201)
    async def api_create_project(payload: ProjectCreate) -> dict[str, Any]:
        try:
            return create_project(settings.db_path, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @application.patch("/api/projects/{project_id}")
    async def api_patch_project(project_id: str, payload: ProjectPatch) -> dict[str, Any]:
        try:
            updated = update_project(settings.db_path, project_id, payload.model_dump(exclude_unset=True))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return updated

    @application.delete("/api/projects/{project_id}")
    async def api_delete_project(project_id: str) -> dict[str, str]:
        deleted = delete_project(settings.db_path, project_id)
        if deleted is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return {"status": "deleted", "id": project_id}

    @application.post("/api/projects/{project_id}/variants", status_code=201)
    async def api_create_project_variant(project_id: str, payload: ProjectVariantCreate) -> dict[str, Any]:
        try:
            created = create_project_variant(settings.db_path, project_id, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if created is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return created

    @application.patch("/api/projects/{project_id}/variants/{variant_id}")
    async def api_patch_project_variant(
        project_id: str, variant_id: str, payload: ProjectVariantPatch
    ) -> dict[str, Any]:
        try:
            updated = update_project_variant(
                settings.db_path, project_id, variant_id, payload.model_dump(exclude_unset=True)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Variant not found")
        return updated

    @application.delete("/api/projects/{project_id}/variants/{variant_id}")
    async def api_delete_project_variant(project_id: str, variant_id: str) -> dict[str, str]:
        if not delete_project_variant(settings.db_path, project_id, variant_id):
            raise HTTPException(status_code=404, detail="Variant not found")
        return {"status": "deleted", "id": variant_id}

    @application.post("/api/projects/{project_id}/items", status_code=201)
    async def api_add_project_item(project_id: str, payload: ProjectItemCreate) -> dict[str, Any]:
        try:
            created = add_project_item(settings.db_path, project_id, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if created is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return created

    @application.patch("/api/projects/{project_id}/items/{item_id}")
    async def api_patch_project_item(
        project_id: str, item_id: str, payload: ProjectItemPatch
    ) -> dict[str, Any]:
        try:
            updated = update_project_item(
                settings.db_path, project_id, item_id, payload.model_dump(exclude_unset=True)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Project item not found")
        return updated

    @application.delete("/api/projects/{project_id}/items/{item_id}")
    async def api_delete_project_item(project_id: str, item_id: str) -> dict[str, str]:
        if not delete_project_item(settings.db_path, project_id, item_id):
            raise HTTPException(status_code=404, detail="Project item not found")
        return {"status": "deleted", "id": item_id}

    @application.put("/api/projects/{project_id}/nets")
    async def api_replace_project_nets(project_id: str, payload: ProjectNetsReplace) -> dict[str, Any]:
        updated = set_project_nets(settings.db_path, project_id, payload.nets)
        if updated is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return updated

    @application.post("/api/projects/{project_id}/nets", status_code=201)
    async def api_add_project_net(project_id: str, payload: ProjectNetCreate) -> dict[str, Any]:
        try:
            updated = add_project_net(settings.db_path, project_id, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return updated

    @application.delete("/api/projects/{project_id}/nets/{net_id}")
    async def api_delete_project_net(project_id: str, net_id: str) -> dict[str, str]:
        if not delete_project_net(settings.db_path, project_id, net_id):
            raise HTTPException(status_code=404, detail="Net not found")
        return {"status": "deleted", "id": net_id}

    @application.put("/api/projects/{project_id}/checks")
    async def api_replace_project_checks(project_id: str, payload: ProjectChecksReplace) -> dict[str, Any]:
        updated = set_project_checks(settings.db_path, project_id, payload.checks)
        if updated is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return updated

    @application.patch("/api/projects/{project_id}/checks/{check_id}")
    async def api_patch_project_check(
        project_id: str, check_id: str, payload: ProjectCheckPatch
    ) -> dict[str, Any]:
        try:
            updated = update_project_check(
                settings.db_path, project_id, check_id, payload.model_dump(exclude_unset=True)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Check not found")
        return updated

    @application.delete("/api/projects/{project_id}/checks/{check_id}")
    async def api_delete_project_check(project_id: str, check_id: str) -> dict[str, str]:
        if not delete_project_check(settings.db_path, project_id, check_id):
            raise HTTPException(status_code=404, detail="Check not found")
        return {"status": "deleted", "id": check_id}

    @application.post("/api/projects/teardown")
    async def api_teardown_project(payload: ProjectTeardownRequest) -> dict[str, Any]:
        cleared = teardown_project(settings.db_path, payload.project)
        return {"status": "ok", "project": payload.project, "parts_returned": cleared}

    @application.get("/api/shopping")
    async def api_list_shopping() -> list[dict[str, Any]]:
        return list_shopping_items(settings.db_path)

    @application.post("/api/shopping", status_code=201)
    async def api_create_shopping(payload: ShoppingItemCreate) -> dict[str, Any]:
        data = payload.model_dump()
        project_id = data.pop("project_id", None)
        variant_id = data.pop("variant_id", None)
        fetch_meta = bool(data.pop("fetch_metadata", False))
        if fetch_meta and data.get("url"):
            try:
                scraped = await scrape_url(data["url"], settings.images_dir, settings.max_upload_bytes)
                if not data.get("image_path") and scraped.get("image_path"):
                    data["image_path"] = scraped["image_path"]
                if not data.get("price") and scraped.get("price"):
                    data["price"] = scraped["price"]
                if not data.get("retailer") and scraped.get("retailer"):
                    data["retailer"] = scraped["retailer"]
                if not data.get("in_stock") and scraped.get("in_stock"):
                    data["in_stock"] = scraped["in_stock"]
            except ScrapeError:
                pass
        created = create_shopping_item(settings.db_path, data)
        if project_id:
            try:
                add_project_item(
                    settings.db_path,
                    project_id,
                    {
                        "shopping_item_id": created["id"],
                        "variant_id": variant_id,
                        "quantity_needed": created["quantity"],
                        "project_notes": data.get("why_needed") or "",
                    },
                )
                refreshed = get_shopping_item(settings.db_path, created["id"])
                if refreshed:
                    created = refreshed
            except ValueError:
                pass
        return created

    @application.post("/api/shopping/{item_id}/fetch")
    async def api_fetch_shopping_metadata(item_id: str) -> dict[str, Any]:
        item = get_shopping_item(settings.db_path, item_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Shopping item not found")
        if not item.get("url"):
            raise HTTPException(status_code=400, detail="Shopping item has no URL to fetch")
        try:
            scraped = await scrape_url(item["url"], settings.images_dir, settings.max_upload_bytes)
        except ScrapeError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        updates: dict[str, Any] = {}
        old_img = item.get("image_path") or ""
        new_img = scraped.get("image_path") or ""
        if new_img:
            updates["image_path"] = new_img
        if scraped.get("price") and not item.get("price"):
            updates["price"] = scraped["price"]
        if scraped.get("retailer"):
            updates["retailer"] = scraped["retailer"]
        if scraped.get("in_stock"):
            updates["in_stock"] = scraped["in_stock"]
        try:
            updated = update_shopping_item(settings.db_path, item_id, updates)
        except Exception:
            if new_img:
                safe_delete_image(new_img, settings.images_dir)
            raise
        if new_img and old_img and old_img != new_img:
            safe_delete_image(old_img, settings.images_dir)
        return updated or item

    @application.patch("/api/shopping/{item_id}")
    async def api_patch_shopping(item_id: str, payload: ShoppingItemPatch) -> dict[str, Any]:
        try:
            updated = update_shopping_item(settings.db_path, item_id, payload.model_dump(exclude_unset=True))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Shopping item not found")
        return updated

    @application.delete("/api/shopping/{item_id}")
    async def api_delete_shopping(item_id: str) -> dict[str, str]:
        deleted = delete_shopping_item(settings.db_path, item_id)
        if deleted is None:
            raise HTTPException(status_code=404, detail="Shopping item not found")
        safe_delete_image(deleted.get("image_path", ""), settings.images_dir)
        return {"status": "deleted", "id": item_id}

    @application.post("/api/shopping/{item_id}/move-to-inventory")
    async def api_move_shopping_to_inventory(item_id: str) -> dict[str, Any]:
        created_part = move_shopping_item_to_inventory(settings.db_path, item_id)
        if created_part is None:
            raise HTTPException(status_code=404, detail="Shopping item not found")
        return created_part

    @application.post("/api/shopping/{item_id}/offers", status_code=201)
    async def api_add_shopping_offer(item_id: str, payload: ShoppingOfferCreate) -> dict[str, Any]:
        data = payload.model_dump()
        fetch_meta = bool(data.pop("fetch_metadata", False))
        scraped_img = ""
        if fetch_meta and data.get("url"):
            try:
                scraped = await scrape_url(data["url"], settings.images_dir, settings.max_upload_bytes)
                if not data.get("price") and scraped.get("price"):
                    data["price"] = scraped["price"]
                if not data.get("retailer") and scraped.get("retailer"):
                    data["retailer"] = scraped["retailer"]
                if not data.get("in_stock") and scraped.get("in_stock"):
                    data["in_stock"] = scraped["in_stock"]
                scraped_img = scraped.get("image_path") or ""
            except ScrapeError:
                pass
        try:
            updated = add_shopping_offer(settings.db_path, item_id, data)
        except ValueError as exc:
            if scraped_img:
                safe_delete_image(scraped_img, settings.images_dir)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            if scraped_img:
                safe_delete_image(scraped_img, settings.images_dir)
            raise HTTPException(status_code=404, detail="Shopping item not found")
        if scraped_img:
            if not updated.get("image_path"):
                updated = update_shopping_item(settings.db_path, item_id, {"image_path": scraped_img}) or updated
            else:
                safe_delete_image(scraped_img, settings.images_dir)
        return updated

    @application.patch("/api/shopping/{item_id}/offers/{offer_id}")
    async def api_patch_shopping_offer(
        item_id: str, offer_id: str, payload: ShoppingOfferPatch
    ) -> dict[str, Any]:
        try:
            updated = update_shopping_offer(
                settings.db_path, item_id, offer_id, payload.model_dump(exclude_unset=True)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Offer not found")
        return updated

    @application.delete("/api/shopping/{item_id}/offers/{offer_id}")
    async def api_delete_shopping_offer(item_id: str, offer_id: str) -> dict[str, Any]:
        updated = delete_shopping_offer(settings.db_path, item_id, offer_id)
        if updated is None:
            raise HTTPException(status_code=404, detail="Offer not found")
        return updated

    @application.post("/api/shopping/store-status")
    async def api_shopping_store_status(payload: ShoppingStoreStatusRequest) -> dict[str, Any]:
        try:
            updated = bulk_update_shopping_status_by_store(
                settings.db_path, payload.retailer, payload.status, item_ids=payload.item_ids
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"updated_count": len(updated), "items": updated}

    @application.post("/api/shopping/optimize")
    async def api_optimize_shopping(payload: ShoppingOptimizeRequest) -> dict[str, Any]:
        return optimize_shopping_carts(
            settings.db_path,
            item_ids=payload.item_ids,
            project_id=payload.project_id,
            tag=payload.tag,
            mode=payload.mode,
            include_out_of_stock=payload.include_out_of_stock,
            include_inactive_variants=payload.include_inactive_variants,
            apply=payload.apply,
        )

    @application.get("/api/retailers")
    async def api_list_retailers() -> list[dict[str, Any]]:
        return list_retailers(settings.db_path)

    @application.put("/api/retailers/{domain}")
    async def api_upsert_retailer(domain: str, payload: RetailerUpsert) -> dict[str, Any]:
        try:
            return upsert_retailer(settings.db_path, domain, payload.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @application.delete("/api/retailers/{domain}")
    async def api_delete_retailer(domain: str) -> dict[str, str]:
        if not delete_retailer(settings.db_path, domain):
            raise HTTPException(status_code=404, detail="Retailer not found")
        return {"status": "deleted", "domain": domain}

    @application.post("/api/compatibility")
    async def api_compatibility_check(payload: CompatibilityRequest) -> dict[str, Any]:
        selected: list[dict[str, Any]] = []
        for pid in payload.part_ids:
            p = get_part(settings.db_path, pid)
            if p is not None:
                selected.append(p)
        if len(selected) < 2:
            raise HTTPException(status_code=400, detail="Select at least 2 valid parts")
        try:
            return await check_parts_compatibility_ai(settings, selected)
        except EnrichError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @application.get("/api/qr")
    async def api_qr_svg(text: str = Query(..., min_length=1, max_length=300)) -> Response:
        qr = segno.make(text, error="m")
        buf = io.BytesIO()
        qr.save(buf, kind="svg", xmldecl=False, scale=4, border=1, dark="#111318", light="#FFFFFF")
        return Response(
            content=buf.getvalue(),
            media_type="image/svg+xml",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    @application.get("/api/export/csv")
    async def api_export_csv() -> Response:
        parts = list_parts(settings.db_path)
        fieldnames = [
            "id", "name", "subtitle", "category", "quantity", "low_stock_threshold",
            "location", "in_use_project", "what_it_does", "visual_tell", "warning",
            "notes", "source_url", "pinout_url", "specs",
        ]
        def _csv_safe(val: Any) -> Any:
            if isinstance(val, str) and val and val[0] in ("=", "+", "-", "@", "\t", "\r"):
                return "'" + val
            return val

        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames)
        writer.writeheader()
        for p in parts:
            row = {k: _csv_safe(p.get(k, "")) for k in fieldnames}
            row["specs"] = _csv_safe(json.dumps(p.get("specs") or {}, ensure_ascii=False))
            writer.writerow(row)
        # UTF-8 with BOM for clean Excel compatibility
        csv_bytes = ("\ufeff" + buf.getvalue()).encode("utf-8")
        filename = f"pinbin-inventory-{utc_today_str()}.csv"
        return Response(
            content=csv_bytes,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @application.post("/api/import/csv")
    async def api_import_csv(file: UploadFile = File(...)) -> dict[str, Any]:
        raw_bytes = await file.read(settings.max_upload_bytes + 1)
        if len(raw_bytes) > settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="CSV file exceeds maximum upload size")
        try:
            text = raw_bytes.decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(text))
            rows = [dict(r) for r in reader]
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid CSV file format") from exc
        imported = import_parts_from_rows(settings.db_path, rows)
        return {"status": "ok", "imported": imported}

    @application.get("/api/settings")
    async def api_get_settings() -> dict[str, Any]:
        return get_ui_settings(settings.db_path)

    @application.patch("/api/settings")
    async def api_patch_settings(payload: UiSettingsPatch) -> dict[str, Any]:
        updates = payload.model_dump(exclude_unset=True)
        return update_ui_settings(settings.db_path, updates)

    @application.get("/api/mcp-settings")
    async def api_get_mcp_settings() -> dict[str, Any]:
        rt = get_mcp_runtime_settings(settings)
        return {
            "enabled": settings.mcp_enabled,
            **rt,
            "activity": list_mcp_activity(settings.db_path, limit=25),
        }

    @application.patch("/api/mcp-settings")
    async def api_patch_mcp_settings(payload: McpSettingsPatch) -> dict[str, Any]:
        rt = update_mcp_runtime_settings(settings, payload.model_dump(exclude_unset=True))
        return {
            "enabled": settings.mcp_enabled,
            **rt,
            "activity": list_mcp_activity(settings.db_path, limit=25),
        }

    @application.post("/api/mcp-settings/rotate-token")
    async def api_rotate_mcp_token() -> dict[str, Any]:
        rt = rotate_mcp_token(settings)
        return {
            "enabled": settings.mcp_enabled,
            **rt,
            "activity": list_mcp_activity(settings.db_path, limit=25),
        }

    @application.get("/api/guest-pass")
    async def api_get_guest_pass() -> dict[str, Any]:
        return get_guest_pass_settings(settings.db_path)

    @application.patch("/api/guest-pass")
    async def api_patch_guest_pass(payload: GuestPassPatch) -> dict[str, Any]:
        return update_guest_pass_settings(settings.db_path, payload.enabled)

    @application.post("/api/guest-pass/rotate")
    async def api_rotate_guest_pass() -> dict[str, Any]:
        return rotate_guest_pass_token(settings.db_path)

    @application.post("/api/bins/rename")
    async def api_rename_bin(payload: BinRenameRequest) -> dict[str, Any]:
        try:
            moved = rename_bin(settings.db_path, payload.old_bin, payload.new_bin)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"status": "ok", "old_bin": payload.old_bin.strip(), "new_bin": payload.new_bin.strip(), "moved": moved}

    @application.get("/api/stats")
    async def api_storage_stats() -> dict[str, Any]:
        return get_storage_stats(settings)

    @application.post("/api/wipe")
    async def api_wipe_all(payload: WipeRequest) -> dict[str, Any]:
        if payload.confirm.strip().lower() != "delete":
            raise HTTPException(status_code=400, detail="Type 'delete' to confirm")
        return wipe_all_data(settings)

    @application.get("/api/parts")
    async def api_list_parts(
        q: str | None = Query(default=None),
        category: str | None = Query(default=None),
        location: str | None = Query(default=None),
        needs_photo: bool = Query(default=False),
        in_use: bool = Query(default=False),
        low_stock: bool = Query(default=False),
    ) -> list[dict[str, Any]]:
        return list_parts(
            settings.db_path,
            q=q,
            category=category,
            location=location,
            needs_photo=needs_photo,
            in_use=in_use,
            low_stock=low_stock,
        )

    @application.post("/api/parts", status_code=201)
    async def api_create_part(payload: PartCreate) -> dict[str, Any]:
        try:
            return create_part(settings.db_path, payload.model_dump())
        except (ValueError, ImageError) as exc:
            status = exc.status_code if isinstance(exc, ImageError) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @application.patch("/api/parts/{part_id}")
    async def api_patch_part(part_id: str, payload: PartPatch) -> dict[str, Any]:
        updates = payload.model_dump(exclude_unset=True)
        try:
            updated = update_part(settings.db_path, part_id, updates)
        except (ValueError, ImageError) as exc:
            status = exc.status_code if isinstance(exc, ImageError) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Part not found")
        return updated

    @application.delete("/api/parts/{part_id}")
    async def api_delete_part(part_id: str) -> dict[str, str]:
        deleted = delete_part(settings.db_path, part_id)
        if deleted is None:
            raise HTTPException(status_code=404, detail="Part not found")
        safe_delete_image(deleted.get("image_path", ""), settings.images_dir)
        safe_delete_image(deleted.get("pinout_image_path", ""), settings.images_dir)
        return {"status": "deleted", "id": part_id}

    @application.post("/api/parts/{part_id}/photo")
    async def api_upload_photo(
        part_id: str,
        file: UploadFile = File(...),
        slot: str = Form("main"),
    ) -> dict[str, Any]:
        slot_clean = slot.strip().lower()
        if slot_clean not in ("main", "pinout"):
            raise HTTPException(status_code=400, detail="slot must be 'main' or 'pinout'")

        part = get_part(settings.db_path, part_id)
        if part is None:
            raise HTTPException(status_code=404, detail="Part not found")

        raw_bytes = await file.read(settings.max_upload_bytes + 1)
        try:
            filename = process_and_save_image(raw_bytes, settings.images_dir, settings.max_upload_bytes)
        except ImageError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

        col = "image_path" if slot_clean == "main" else "pinout_image_path"
        old_filename = part.get(col, "")
        updated = update_part(settings.db_path, part_id, {col: filename})
        if old_filename and old_filename != filename:
            safe_delete_image(old_filename, settings.images_dir)
        return updated  # type: ignore[return-value]

    @application.delete("/api/parts/{part_id}/photo")
    async def api_delete_photo(
        part_id: str,
        slot: str = Query(default="main"),
    ) -> dict[str, Any]:
        slot_clean = slot.strip().lower()
        if slot_clean not in ("main", "pinout"):
            raise HTTPException(status_code=400, detail="slot must be 'main' or 'pinout'")

        part = get_part(settings.db_path, part_id)
        if part is None:
            raise HTTPException(status_code=404, detail="Part not found")

        col = "image_path" if slot_clean == "main" else "pinout_image_path"
        old_filename = part.get(col, "")
        updated = update_part(settings.db_path, part_id, {col: ""})
        if old_filename:
            safe_delete_image(old_filename, settings.images_dir)
        return updated  # type: ignore[return-value]

    @application.post("/api/scrape")
    async def api_scrape(payload: ScrapeRequest) -> dict[str, Any]:
        slot_clean = payload.slot.strip().lower()
        if slot_clean not in ("main", "pinout"):
            raise HTTPException(status_code=400, detail="slot must be 'main' or 'pinout'")

        try:
            result = await scrape_url(payload.url, settings.images_dir, settings.max_upload_bytes)
        except ScrapeError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

        if payload.part_id and result.get("image_path"):
            part = get_part(settings.db_path, payload.part_id)
            if part is not None:
                col = "image_path" if slot_clean == "main" else "pinout_image_path"
                old_filename = part.get(col, "")
                update_part(settings.db_path, payload.part_id, {col: result["image_path"]})
                if old_filename and old_filename != result["image_path"]:
                    safe_delete_image(old_filename, settings.images_dir)

        return result

    @application.post("/api/enrich")
    async def api_enrich(payload: EnrichRequest) -> JSONResponse:
        try:
            result = await enrich_part(
                settings,
                query=payload.query,
                scraped_title=payload.scraped_title,
                scraped_description=payload.scraped_description,
            )
        except EnrichError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

        image_search_query = result.pop("image_search_query", "") or result.get("name") or payload.query
        product_urls = result.pop("product_urls", [])
        suggested_terms = result.pop("suggested_glossary_terms", [])
        added_terms = upsert_suggested_glossary_terms(settings.db_path, suggested_terms)

        candidates: list[dict[str, str]] = []
        if payload.fetch_image and (product_urls or image_search_query):
            candidates = await find_image_candidates(
                page_urls=product_urls,
                fallback_query=image_search_query,
                max_bytes=settings.max_upload_bytes,
                limit=6,
            )

        result["image_candidates"] = candidates
        result["added_glossary_terms"] = [t["term"] for t in added_terms]
        return JSONResponse(status_code=200, content=result)

    @application.get("/api/backup")
    async def api_backup() -> Response:
        zip_bytes = create_backup_zip_bytes(settings)
        record_backup_timestamp(settings.db_path)
        filename = f"pinbin-backup-{utc_today_str()}.zip"
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @application.post("/api/restore")
    async def api_restore(file: UploadFile = File(...)) -> dict[str, Any]:
        # Allow up to 250MB for backup restore archives containing many webp images
        raw_bytes = await file.read(250 * 1024 * 1024 + 1)
        if len(raw_bytes) > 250 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Backup archive is too large")
        try:
            if settings.db_path.exists():
                snapshot = create_backup_zip_bytes(settings)
                (settings.data_dir / "pre-restore-backup.zip").write_bytes(snapshot)
        except Exception:
            pass
        try:
            return restore_backup_zip_bytes(raw_bytes, settings)
        except BackupError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @application.post("/mcp")
    async def mcp_post(request: Request) -> Response:
        return await handle_mcp_post(request, settings)

    @application.api_route("/mcp", methods=["GET", "DELETE"])
    async def mcp_unsupported_method(request: Request) -> Response:
        auth_err = verify_mcp_access(request, settings)
        if auth_err is not None:
            return auth_err
        return Response(status_code=405, headers={"Allow": "POST"})

    return application


app = create_app()
