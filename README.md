# Pinbin

Single-user, photo-first, self-hosted electronics workbench inventory web app backed by SQLite, designed to run behind Cloudflare Tunnel + Cloudflare Access Passkeys.

## Features

- **Photo-first gallery** (dark mode default, light mode toggle) with `/` instant search, category filters, clickable bin tags, and `Needs Photo` / `In Use` / `Low Stock` chips
- **Preview & Edit drawer** with full-size image lightbox, inline quantity steppers, beginner-friendly *What It Does* notes, warning callouts, and dedicated Pinout / Wiring Reference slot
- **Fast photo capture:** file/phone camera upload, `Ctrl+V` clipboard paste, SSRF-safe store URL fetch, and automatic EXIF-fixed `.webp` conversion (max `1000px`)
- **Optional AI Smart Autofill:** server-side only (`openai`, `openrouter`, or `gemini`) with daily SQLite rate limiting and web-grounded candidate thumbnail picker
- **Zero-trust security:** localhost-only port binding, fail-closed Cloudflare Access RS256 JWT middleware, SSRF protection, and WAL-safe `.zip` backup & validated restore

---

## Deploying from GitHub Container Registry (GHCR)

Every push to `main` builds a multi-arch (`linux/amd64`, `linux/arm64`) Docker image via `.github/workflows/docker.yml`.

1. On your host machine, create a folder containing `docker-compose.yml`, `seed.json`, and `.env` (copied from `.env.example`):
   ```bash
   cp .env.example .env
   ```
2. In `.env`, set your image and Cloudflare Access settings:
   ```dotenv
   PINBIN_IMAGE=ghcr.io/<your-github-username>/pinbin:latest
   LOCAL_DEV_MODE=false
   CF_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com
   CF_POLICY_AUD=<your-application-aud-tag>
   ```
   *(If your GHCR package is private, run `docker login ghcr.io` once with a GitHub PAT that has `read:packages`.)*
3. Pull and start:
   ```bash
   docker compose pull
   docker compose up -d
   ```

---

## Local Development

```bash
cp .env.example .env
# Set LOCAL_DEV_MODE=true in .env
docker compose up -d --build
```

Open `http://127.0.0.1:8080`. All 65 parts from `seed.json` are auto-imported on first boot.

---

## Optional AI Smart Autofill

Leave `AI_API_KEY` blank to keep AI disabled. To enable it, configure `.env` and run `docker compose up -d`:

```dotenv
# OpenAI
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-6.1-terra
AI_REASONING_EFFORT=low
AI_DAILY_LIMIT=30
```

```dotenv
# OpenRouter
AI_PROVIDER=openrouter
AI_API_KEY=sk-or-...
AI_MODEL=google/gemini-2.5-flash-lite
AI_DAILY_LIMIT=30
```

`AI_API_KEY` is read strictly from environment variables and is never stored in SQLite, exported in backups, or returned by the API.
