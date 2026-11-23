from __future__ import annotations

import csv
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import segno
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.auth import CloudflareAccessMiddleware
from app.backup import BackupError, create_backup_zip_bytes, restore_backup_zip_bytes
from app.config import CATEGORIES, Settings, load_settings
from app.db import (
    create_glossary_term,
    create_part,
    create_shopping_item,
    delete_glossary_term,
    delete_part,
    delete_shopping_item,
    get_ai_usage_today,
    get_part,
    get_ui_settings,
    import_parts_from_rows,
    init_db,
    list_glossary,
    list_parts,
    list_shopping_items,
    move_shopping_item_to_inventory,
    seed_if_empty,
    teardown_project,
    update_glossary_term,
    update_part,
    update_shopping_item,
    update_ui_settings,
    upsert_suggested_glossary_terms,
    utc_today_str,
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
    specs: dict[str, str] = Field(default_factory=dict)


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
    specs: dict[str, str] | None = None


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
    view_mode: str | None = None
    sort_by: str | None = None
    inline_tooltips: bool | None = None
    show_caution_badge: bool | None = None


class GlossaryCreate(BaseModel):
    term: str = Field(..., min_length=1, max_length=120)
    category: str = "Circuit Basics"
    summary: str = ""
    rule_of_thumb: str = ""
    keywords: str = ""


class GlossaryPatch(BaseModel):
    term: str | None = Field(default=None, min_length=1, max_length=120)
    category: str | None = None
    summary: str | None = None
    rule_of_thumb: str | None = None
    keywords: str | None = None


class GlossaryExplainRequest(BaseModel):
    term: str = Field(..., min_length=1, max_length=120)


class ProjectTeardownRequest(BaseModel):
    project: str = Field(..., min_length=1, max_length=200)


class ShoppingItemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    url: str = ""
    price: str = ""
    quantity: int = Field(default=1, ge=1)
    notes: str = ""
    image_path: str = ""


class ShoppingItemPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = None
    price: str | None = None
    quantity: int | None = Field(default=None, ge=1)
    notes: str | None = None
    image_path: str | None = None


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

    # Static assets
    application.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @application.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

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

    @application.post("/api/projects/teardown")
    async def api_teardown_project(payload: ProjectTeardownRequest) -> dict[str, Any]:
        cleared = teardown_project(settings.db_path, payload.project)
        return {"status": "ok", "project": payload.project, "parts_returned": cleared}

    @application.get("/api/shopping")
    async def api_list_shopping() -> list[dict[str, Any]]:
        return list_shopping_items(settings.db_path)

    @application.post("/api/shopping", status_code=201)
    async def api_create_shopping(payload: ShoppingItemCreate) -> dict[str, Any]:
        return create_shopping_item(settings.db_path, payload.model_dump())

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
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames)
        writer.writeheader()
        for p in parts:
            row = {k: p.get(k, "") for k in fieldnames}
            row["specs"] = json.dumps(p.get("specs") or {}, ensure_ascii=False)
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
        return create_part(settings.db_path, payload.model_dump())

    @application.patch("/api/parts/{part_id}")
    async def api_patch_part(part_id: str, payload: PartPatch) -> dict[str, Any]:
        updates = payload.model_dump(exclude_unset=True)
        try:
            updated = update_part(settings.db_path, part_id, updates)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
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
