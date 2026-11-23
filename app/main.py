from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.auth import CloudflareAccessMiddleware
from app.backup import BackupError, create_backup_zip_bytes, restore_backup_zip_bytes
from app.config import CATEGORIES, Settings, load_settings
from app.db import (
    create_part,
    delete_part,
    get_ai_usage_today,
    get_part,
    init_db,
    list_parts,
    seed_if_empty,
    update_part,
    utc_today_str,
)
from app.enricher import EnrichError, enrich_part
from app.images import (
    ImageError,
    process_and_save_image,
    resolve_safe_image_path,
    safe_delete_image,
)
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
            "categories": CATEGORIES,
        }

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
        candidates: list[dict[str, str]] = []
        if payload.fetch_image and (product_urls or image_search_query):
            candidates = await find_image_candidates(
                page_urls=product_urls,
                fallback_query=image_search_query,
                max_bytes=settings.max_upload_bytes,
                limit=6,
            )

        result["image_candidates"] = candidates
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

    return application


app = create_app()
