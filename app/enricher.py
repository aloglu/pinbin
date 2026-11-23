from __future__ import annotations

import json
import re
import sys
from typing import Any

import httpx

from app.config import CATEGORIES, Settings
from app.db import consume_ai_quota

SYSTEM_PROMPT = (
    "You are an electronics workbench assistant helping a hobbyist catalog parts. "
    "Given a part query and/or scraped product title & description, return ONLY a strict JSON object "
    "with these exact keys: "
    "name, subtitle, category, what_it_does, visual_tell, warning, notes, pinout_url, image_search_query, product_urls. "
    "All keys must be strings EXCEPT product_urls which is a JSON array of up to 4 real product or documentation page URLs "
    "(e.g. manufacturer product page, Adafruit, SparkFun, Waveshare, LastMinuteEngineers, RandomNerdTutorials, or store pages) "
    "that contain clear photos of this exact component. "
    f"category MUST be one of: {', '.join(CATEGORIES)}. "
    "Keep what_it_does beginner-friendly (1-2 sentences). "
    "Keep visual_tell a concise 1-line physical clue to recognize the part in a bin. "
    "Put voltage/pinout/lookalike cautions in warning (or empty string if none). "
    "Put concise pinout/pin-order, I2C/SPI address, or wiring reminders in notes (or empty string). "
    "For pinout_url, provide a direct, real official documentation or pinout reference URL if found; otherwise empty string. "
    "For image_search_query, provide the short canonical part code (e.g. 'ESP32', 'HC-SR04', 'LM35', 'RC522')."
)


class EnrichError(Exception):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1)
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            cleaned = cleaned[start : end + 1]
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("LLM response was not a JSON object")
    return parsed


def _normalize_result(raw: dict[str, Any], cited_urls: list[str] | None = None) -> dict[str, Any]:
    category = str(raw.get("category") or "Sensors").strip()
    if category not in CATEGORIES:
        category = "Sensors"

    raw_pinout_url = str(raw.get("pinout_url") or "").strip()
    if not (raw_pinout_url.startswith("http://") or raw_pinout_url.startswith("https://")):
        raw_pinout_url = ""

    product_urls: list[str] = []
    raw_urls = raw.get("product_urls")
    if isinstance(raw_urls, list):
        for u in raw_urls:
            s = str(u or "").strip()
            if s.startswith(("http://", "https://")) and s not in product_urls:
                product_urls.append(s)

    for u in cited_urls or []:
        s = str(u or "").strip()
        if s.startswith(("http://", "https://")) and s not in product_urls:
            product_urls.append(s)

    if raw_pinout_url and raw_pinout_url not in product_urls:
        product_urls.append(raw_pinout_url)

    return {
        "name": str(raw.get("name") or "").strip(),
        "subtitle": str(raw.get("subtitle") or "").strip(),
        "category": category,
        "what_it_does": str(raw.get("what_it_does") or "").strip(),
        "visual_tell": str(raw.get("visual_tell") or "").strip(),
        "warning": str(raw.get("warning") or "").strip(),
        "notes": str(raw.get("notes") or "").strip(),
        "pinout_url": raw_pinout_url,
        "image_search_query": str(raw.get("image_search_query") or "").strip(),
        "product_urls": product_urls[:5],
    }


async def _call_gemini(settings: Settings, user_prompt: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.ai_model}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.ai_api_key,
    }
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
        },
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)
        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            raise EnrichError("AI provider returned no candidates", status_code=502)
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(str(p.get("text", "")) for p in parts)
        if not text.strip():
            raise EnrichError("AI provider returned empty text", status_code=502)
        return text


async def _call_openai_responses_web(
    client: httpx.AsyncClient, base_url: str, headers: dict[str, str], settings: Settings, user_prompt: str
) -> tuple[str, list[str]] | None:
    """Use OpenAI Responses API with low-context web_search so token usage stays minimal."""
    prompt_with_json_hint = (
        f"{user_prompt}\n\n"
        "Search the web for this exact electronics part and include up to 4 real product or documentation "
        "page URLs (prefer manufacturer pages, Adafruit, SparkFun, Waveshare, Seeed, Pololu, Robotistan, "
        "Direnc.net, LastMinuteEngineers, RandomNerdTutorials). Return ONLY a valid JSON object."
    )

    for tool_type in ("web_search", "web_search_preview"):
        payload: dict[str, Any] = {
            "model": settings.ai_model,
            "instructions": SYSTEM_PROMPT,
            "input": prompt_with_json_hint,
            "tools": [{"type": tool_type, "search_context_size": "low"}],
        }
        if settings.ai_reasoning_effort:
            payload["reasoning"] = {"effort": settings.ai_reasoning_effort}

        resp = await client.post(f"{base_url}/responses", headers=headers, json=payload)
        if resp.status_code >= 400:
            err_preview = resp.text[:200].replace("\n", " ")
            print(
                f"[pinbin] OpenAI /responses ({tool_type}) returned HTTP {resp.status_code}: {err_preview}",
                file=sys.stderr,
            )
            continue

        data = resp.json()
        text_parts: list[str] = []
        cited_urls: list[str] = []

        if isinstance(data.get("output_text"), str) and data["output_text"].strip():
            text_parts.append(data["output_text"])

        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            for content in item.get("content") or []:
                if not isinstance(content, dict):
                    continue
                if not text_parts and isinstance(content.get("text"), str):
                    text_parts.append(content["text"])
                for ann in content.get("annotations") or []:
                    if isinstance(ann, dict) and ann.get("url"):
                        cited_urls.append(str(ann["url"]))

        full_text = "".join(text_parts).strip()
        if full_text:
            return full_text, cited_urls

    return None


async def _call_openai_compat(settings: Settings, user_prompt: str) -> tuple[str, list[str]]:
    if settings.ai_base_url:
        base_url = settings.ai_base_url
    elif settings.ai_provider == "openrouter":
        base_url = "https://openrouter.ai/api/v1"
    else:
        base_url = "https://api.openai.com/v1"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.ai_api_key}",
    }

    is_openai_official = "api.openai.com" in base_url
    is_openrouter = "openrouter.ai" in base_url or settings.ai_provider == "openrouter"

    async with httpx.AsyncClient(timeout=35.0) as client:
        # 1. On official OpenAI API, prefer Responses API with low-context web_search
        if is_openai_official:
            try:
                web_res = await _call_openai_responses_web(client, base_url, headers, settings, user_prompt)
                if web_res is not None:
                    return web_res
            except Exception:
                pass

        # 2. Chat Completions (with OpenRouter lightweight web plugin when on OpenRouter)
        url = f"{base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": settings.ai_model,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        }
        if settings.ai_reasoning_effort:
            payload["reasoning_effort"] = settings.ai_reasoning_effort
        else:
            payload["temperature"] = 0.2

        if is_openrouter:
            payload["plugins"] = [{"id": "web", "max_results": 4}]

        resp = await client.post(url, headers=headers, json=payload)
        # Fallback if reasoning model rejects temperature or provider rejects plugins
        if resp.status_code == 400 and ("temperature" in payload or "plugins" in payload):
            payload.pop("temperature", None)
            payload.pop("plugins", None)
            resp = await client.post(url, headers=headers, json=payload)

        if resp.status_code >= 400:
            raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise EnrichError("AI provider returned no choices", status_code=502)

        message = choices[0].get("message") or {}
        text = str(message.get("content") or "")
        if not text.strip():
            raise EnrichError("AI provider returned empty content", status_code=502)

        cited_urls: list[str] = []
        for ann in message.get("annotations") or []:
            if not isinstance(ann, dict):
                continue
            url_cit = ann.get("url_citation")
            if isinstance(url_cit, dict) and url_cit.get("url"):
                cited_urls.append(str(url_cit["url"]))
            elif ann.get("url"):
                cited_urls.append(str(ann["url"]))

        return text, cited_urls


async def enrich_part(
    settings: Settings,
    *,
    query: str = "",
    scraped_title: str = "",
    scraped_description: str = "",
) -> dict[str, Any]:
    if not settings.ai_enabled:
        raise EnrichError("AI enrichment is disabled (AI_API_KEY is not configured)", status_code=503)

    if not (query.strip() or scraped_title.strip() or scraped_description.strip()):
        raise EnrichError("Provide a query, scraped_title, or scraped_description", status_code=400)

    allowed, _remaining = consume_ai_quota(settings.db_path, settings.ai_daily_limit)
    if not allowed:
        raise EnrichError("Daily AI enrichment limit reached", status_code=429)

    user_prompt = (
        f"Part query: {query.strip()}\n"
        f"Scraped product title: {scraped_title.strip()}\n"
        f"Scraped product description: {scraped_description.strip()}"
    )

    try:
        cited_urls: list[str] = []
        if settings.ai_provider in ("openai_compat", "openai", "openrouter"):
            raw_text, cited_urls = await _call_openai_compat(settings, user_prompt)
        else:
            raw_text = await _call_gemini(settings, user_prompt)
        parsed = _extract_json_object(raw_text)
        return _normalize_result(parsed, cited_urls=cited_urls)
    except EnrichError:
        raise
    except httpx.TimeoutException as exc:
        raise EnrichError("AI provider request timed out", status_code=504) from exc
    except Exception as exc:
        # Never leak secrets or raw provider errors
        raise EnrichError("Failed to enrich part metadata from AI provider", status_code=502) from exc
