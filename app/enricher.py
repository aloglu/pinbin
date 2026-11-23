from __future__ import annotations

import json
import re
import sys
from typing import Any

import httpx

from app.config import CATEGORIES, Settings
from app.db import consume_ai_quota
from app.glossary_seed import GLOSSARY_CATEGORIES

SYSTEM_PROMPT = (
    "You are an electronics workbench assistant helping a hobbyist catalog parts. "
    "Write ALL descriptions, clues, warnings, and notes strictly in ASD-STE100 (Simplified Technical English): "
    "use short sentences (max 20 words for instructions/warnings, max 25 words for descriptions), "
    "active voice, present tense, imperative mood for warnings (e.g. 'Do not connect 5V to GPIO pins.'), "
    "one idea per sentence, and plain unambiguous words (use 'use', 'check', 'connect', 'remove' — avoid 'utilize', 'ensure', 'verify', 'terminate'). "
    "Given a part query and/or scraped product title & description, return ONLY a strict JSON object "
    "with these exact keys: "
    "name, subtitle, category, what_it_does, visual_tell, warning, notes, pinout_url, image_search_query, product_urls, specs, suggested_glossary_terms. "
    "All keys must be strings EXCEPT: "
    "product_urls (JSON array of up to 4 real product/docs page URLs), "
    "specs (flat JSON object of 3-5 concise key-value hardware specs such as "
    "{'Voltage': '3.3V', 'Interface': 'I2C (0x3C)', 'Package': '4-pin PCB', 'Logic': '3.3V / 5V'}), "
    "and suggested_glossary_terms (JSON array of 1-3 beginner electronics terms introduced by this part, "
    "each an object {term, category, summary, rule_of_thumb, keywords} written in ASD-STE100, where category is one of: "
    f"{', '.join(GLOSSARY_CATEGORIES)}). "
    f"category MUST be one of: {', '.join(CATEGORIES)}. "
    "Keep what_it_does beginner-friendly (1-2 short sentences). "
    "Keep visual_tell a concise 1-line physical clue to identify the part in a bin. "
    "Put voltage, polarity, or lookalike cautions in warning (or empty string if none). "
    "Put brief pin-order, I2C/SPI address, or wiring facts in notes formatted as clean Markdown (short bullet points and inline `code` for pins/addresses, or empty string). "
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

    raw_specs = raw.get("specs")
    specs: dict[str, str] = {}
    if isinstance(raw_specs, dict):
        for k, v in list(raw_specs.items())[:8]:
            ks = str(k or "").strip()[:60]
            vs = str(v or "").strip()[:120]
            if ks and vs:
                specs[ks] = vs

    suggested_glossary_terms: list[dict[str, str]] = []
    raw_terms = raw.get("suggested_glossary_terms")
    if isinstance(raw_terms, list):
        for entry in raw_terms[:3]:
            if not isinstance(entry, dict):
                continue
            t = str(entry.get("term") or "").strip()
            s = str(entry.get("summary") or "").strip()
            if not t or not s:
                continue
            gcat = str(entry.get("category") or "Circuit Basics").strip()
            if gcat not in GLOSSARY_CATEGORIES:
                gcat = "Circuit Basics"
            suggested_glossary_terms.append(
                {
                    "term": t[:120],
                    "category": gcat,
                    "summary": s[:500],
                    "rule_of_thumb": str(entry.get("rule_of_thumb") or "").strip()[:400],
                    "keywords": str(entry.get("keywords") or t.lower()).strip()[:300],
                }
            )

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
        "specs": specs,
        "suggested_glossary_terms": suggested_glossary_terms,
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


GLOSSARY_SYSTEM_PROMPT = (
    "You explain electronics terms for a hobbyist workbench glossary. "
    "Write strictly in ASD-STE100 (Simplified Technical English): "
    "short sentences (max 20 words for instructions, max 25 words for descriptions), "
    "active voice, present tense, imperative mood for rules of thumb, one idea per sentence, "
    "and plain approved words (use 'use', 'check', 'connect', 'remove' — avoid 'utilize', 'ensure', 'verify'). "
    "Return ONLY a strict JSON object with keys: term, category, summary, rule_of_thumb, keywords. "
    f"category MUST be one of: {', '.join(GLOSSARY_CATEGORIES)}. "
    "summary: 1-2 short beginner sentences. "
    "rule_of_thumb: 1-2 short practical bench instructions. "
    "keywords: comma-separated lowercase terms/part codes to link matching inventory items."
)


async def explain_glossary_term(settings: Settings, term: str) -> dict[str, str]:
    if not settings.ai_enabled:
        raise EnrichError("AI enrichment is disabled (AI_API_KEY is not configured)", status_code=503)

    cleaned = term.strip()
    if not cleaned:
        raise EnrichError("Enter a term to explain", status_code=400)

    allowed, _remaining = consume_ai_quota(settings.db_path, settings.ai_daily_limit)
    if not allowed:
        raise EnrichError("Daily AI enrichment limit reached", status_code=429)

    user_prompt = f"Explain this electronics term for a beginner workbench glossary: {cleaned}"

    try:
        if settings.ai_provider in ("openai_compat", "openai", "openrouter"):
            base_url = (
                settings.ai_base_url
                or ("https://openrouter.ai/api/v1" if settings.ai_provider == "openrouter" else "https://api.openai.com/v1")
            )
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.ai_api_key}",
            }
            payload: dict[str, Any] = {
                "model": settings.ai_model,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": GLOSSARY_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            }
            if settings.ai_reasoning_effort:
                payload["reasoning_effort"] = settings.ai_reasoning_effort
            else:
                payload["temperature"] = 0.2

            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                if resp.status_code == 400 and "temperature" in payload:
                    payload.pop("temperature", None)
                    resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                if resp.status_code >= 400:
                    raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)
                choices = resp.json().get("choices") or []
                raw_text = str((choices[0].get("message") or {}).get("content") or "") if choices else ""
        else:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.ai_model}:generateContent"
            headers = {"Content-Type": "application/json", "x-goog-api-key": settings.ai_api_key}
            payload = {
                "systemInstruction": {"parts": [{"text": GLOSSARY_SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
            }
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code >= 400:
                    raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)
                candidates = resp.json().get("candidates") or []
                parts = (candidates[0].get("content") or {}).get("parts") or [] if candidates else []
                raw_text = "".join(str(p.get("text", "")) for p in parts)

        parsed = _extract_json_object(raw_text)
        cat = str(parsed.get("category") or "Circuit Basics").strip()
        if cat not in GLOSSARY_CATEGORIES:
            cat = "Circuit Basics"
        return {
            "term": str(parsed.get("term") or cleaned).strip(),
            "category": cat,
            "summary": str(parsed.get("summary") or "").strip(),
            "rule_of_thumb": str(parsed.get("rule_of_thumb") or "").strip(),
            "keywords": str(parsed.get("keywords") or cleaned.lower()).strip(),
        }
    except EnrichError:
        raise
    except httpx.TimeoutException as exc:
        raise EnrichError("AI provider request timed out", status_code=504) from exc
    except Exception as exc:
        raise EnrichError("Failed to generate glossary explanation", status_code=502) from exc


COMPAT_SYSTEM_PROMPT = (
    "You are an electronics workbench safety & wiring assistant. "
    "Write strictly in ASD-STE100 (Simplified Technical English): short sentences (max 20 words), "
    "active voice, imperative mood for warnings and wiring steps, one idea per sentence. "
    "Given a list of selected parts from a hobbyist inventory, check voltage/logic compatibility, "
    "power requirements, missing driver boards or resistors, and shared bus (I2C/SPI) notes. "
    "Return ONLY a strict JSON object with keys: "
    "status ('ok', 'caution', or 'danger'), summary (1-2 short sentences), "
    "issues (array of short warning strings), wiring_steps (array of 2-5 short imperative wiring steps)."
)


async def check_parts_compatibility_ai(settings: Settings, parts: list[dict[str, Any]]) -> dict[str, Any]:
    if not settings.ai_enabled:
        raise EnrichError("AI compatibility check is disabled (AI_API_KEY is blank)", status_code=503)
    if len(parts) < 2:
        raise EnrichError("Select at least 2 parts to check compatibility", status_code=400)

    allowed, _remaining = consume_ai_quota(settings.db_path, settings.ai_daily_limit)
    if not allowed:
        raise EnrichError("Daily AI limit reached", status_code=429)

    compact_parts = [
        {
            "name": p.get("name", ""),
            "category": p.get("category", ""),
            "specs": p.get("specs") or {},
            "warning": p.get("warning", ""),
        }
        for p in parts[:6]
    ]
    user_prompt = f"Check wiring compatibility for these parts:\n{json.dumps(compact_parts, ensure_ascii=False)}"

    try:
        if settings.ai_provider in ("openai_compat", "openai", "openrouter"):
            base_url = (
                settings.ai_base_url
                or ("https://openrouter.ai/api/v1" if settings.ai_provider == "openrouter" else "https://api.openai.com/v1")
            )
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.ai_api_key}",
            }
            payload: dict[str, Any] = {
                "model": settings.ai_model,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": COMPAT_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            }
            if settings.ai_reasoning_effort:
                payload["reasoning_effort"] = settings.ai_reasoning_effort
            else:
                payload["temperature"] = 0.2
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                if resp.status_code == 400 and "temperature" in payload:
                    payload.pop("temperature", None)
                    resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                if resp.status_code >= 400:
                    raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)
                choices = resp.json().get("choices") or []
                raw_text = str((choices[0].get("message") or {}).get("content") or "") if choices else ""
        else:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.ai_model}:generateContent"
            headers = {"Content-Type": "application/json", "x-goog-api-key": settings.ai_api_key}
            payload = {
                "systemInstruction": {"parts": [{"text": COMPAT_SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
            }
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code >= 400:
                    raise EnrichError(f"AI provider returned HTTP {resp.status_code}", status_code=502)
                candidates = resp.json().get("candidates") or []
                parts_out = (candidates[0].get("content") or {}).get("parts") or [] if candidates else []
                raw_text = "".join(str(p.get("text", "")) for p in parts_out)

        parsed = _extract_json_object(raw_text)
        status = str(parsed.get("status") or "caution").strip().lower()
        if status not in ("ok", "caution", "danger"):
            status = "caution"
        return {
            "status": status,
            "summary": str(parsed.get("summary") or "").strip(),
            "issues": [str(x).strip() for x in (parsed.get("issues") or []) if str(x).strip()][:8],
            "wiring_steps": [str(x).strip() for x in (parsed.get("wiring_steps") or []) if str(x).strip()][:8],
        }
    except EnrichError:
        raise
    except httpx.TimeoutException as exc:
        raise EnrichError("AI provider request timed out", status_code=504) from exc
    except Exception as exc:
        raise EnrichError("Failed to run AI compatibility check", status_code=502) from exc
