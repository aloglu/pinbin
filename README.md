# Pinbin

Single-user, photo-first, self-hosted electronics workbench inventory web app backed by SQLite, designed to run behind Cloudflare Tunnel + Cloudflare Access Passkeys.

## Features

- **Photo-first Inventory (Grid & List views):** Dark and light modes, `/` instant search, category & quick-toggle filters (`Needs Photo`, `In Use`, `Low Stock`, clickable `Bin:` tags), and sorting (`Recent`, `Name`, `Bin / Location`, `Quantity`, `Needs Photo`).
- **Tabbed Preview & Edit Drawer:** Compact photo header with full-size lightbox, **Overview** (`Caution`, `What It Does`, `Visual Tell`), **Specs & Pinout** (key–value tech specs, pinout diagram, datasheet/store links), **Notes**, and 4-tab Edit mode (`Basics`, `Media & AI`, `Details`, `Specs`) with a unified footer mode toggle.
- **Fast Photo Capture:** File/phone camera upload, `Ctrl+V` clipboard paste (main & pinout slots), 1-click Google Images shortcut, SSRF-safe store URL fetch, and automatic EXIF-fixed `.webp` conversion (max `1000px`).
- **Optional AI Smart Autofill (ASD-STE100):** Server-side only (`openai`, `openrouter`, or `gemini`) with daily SQLite rate limiting, web-grounded candidate thumbnail picker, automatic Tech Specs extraction, and automatic Glossary term discovery.
- **Dynamic ASD-STE100 Glossary:** 60+ foundational & workbench terms in a compact Master-Detail layout linked live to matching parts in your inventory, plus optional inline glossary tooltips in Part Preview.
- **Projects & Shopping Views:** Group parts currently in use by project with 1-click tear down; track low-stock items and paste store URLs to add wishlist items (with price & photo) and move purchased items straight into inventory.
- **Workbench Tools (`Bench` tab):**
  - **Interactive SVG Guides:** Breadboard rail explorer, 4-band & 5-band resistor color decoder, multimeter dial guide, and inventory-aware board pinout explorers (**Raspberry Pi Pico / Pico 2**, **ESP32 30-Pin**, **Arduino Uno**).
  - **Calculators:** LED series resistor (E12), Voltage Divider, and Ohm's Law.
  - **Compatibility & Wiring Check:** Instant offline safety rules + optional Deep AI wiring check.
  - **Printable Bin QR Labels:** Vector SVG QR codes linking directly to `/?bin=<BinName>`.
- **Zero-Trust Security & Portability:** Localhost-only port binding, fail-closed Cloudflare Access RS256 JWT middleware, SSRF protection, SQLite-synced Settings, WAL-safe `.zip` backup/restore, and CSV export/import.

---

## Deploying from GitHub Container Registry (GHCR)

Every push to `main` builds a multi-arch (`linux/amd64`, `linux/arm64`) Docker image via `.github/workflows/docker.yml`.

1. On your host machine, create a folder containing `docker-compose.yml`, `seed.json`, and `.env` (copied from `.env.example`):
   ```bash
   cp .env.example .env
   ```
2. In `.env`, set your image and Cloudflare Access settings:
   ```dotenv
   PINBIN_IMAGE=ghcr.io/aloglu/pinbin:latest
   LOCAL_DEV_MODE=false
   CF_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com
   CF_POLICY_AUD=<your-application-aud-tag>
   ```
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

Open `http://127.0.0.1:8080`. All 65 starter parts (with Tech Specs) and 60 ASD-STE100 glossary terms are auto-imported on first boot.

---

## Styles

The page loads no styles or fonts from the internet. Fonts are in `app/static/fonts` (SIL Open Font License).

`app/static/tailwind.css` is a built file. The Docker build makes it automatically. If you run the app without Docker, or change classes in `index.html`, `app.js` or `workbench.js`, build it again:

```bash
npm ci
npm run build:css
```

Write each class name in full in the code (for example `'sm:grid-cols-5'`). The build cannot see a class name that is put together at run time.

## Logo files

The logo is "pinbin" and "pb" drawn on a perfboard. `app/static/brand.js` draws it. The header logo and the browser tab icon are made from this file when the page opens. They follow the **Logo color** setting (Settings > Appearance). The drawing is black or white, whichever reads better on the chosen color.

The files in `app/static/brand/` are made from `brand.js` too. If you change `brand.js`, make them again:

```bash
node scripts/make_brand_files.js
```

This writes the SVG files. The PNG home-screen icons (`apple-touch-icon.png` at 180 px, `icon-192.png`, and `icon-512.png`, in the default green) are rendered from `app-icon.svg` (e.g. with `rsvg-convert -w 192 -h 192 app/static/brand/app-icon.svg -o app/static/brand/icon-192.png`). `pinbin-mark.svg` and `pinbin-wordmark.svg` are one-color masters for use outside the app.

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

---

## Remote MCP Endpoint (`/mcp`)

Pinbin includes an opt-in, stateless Streamable HTTP **MCP (Model Context Protocol)** server at `POST /mcp` so external AI agents can search your inventory, suggest builds from parts on hand, manage your shopping list, run batch updates, and maintain glossary terms.

Enable it in `.env`:

```dotenv
MCP_ENABLED=true
# Optional: set to true to expose only read/search/planning tools
MCP_READ_ONLY=false
# Optional: require Authorization: Bearer <token> in addition to Cloudflare Access
MCP_API_TOKEN=replace-with-a-long-random-secret
```

### Security & Cloudflare Access

- When `LOCAL_DEV_MODE=false`, `/mcp` stays behind `CloudflareAccessMiddleware` (fail-closed RS256 JWT verification).
- Create a **Cloudflare Access Service Token** and allow it in your Pinbin Access policy so agents can authenticate with `CF-Access-Client-Id` and `CF-Access-Client-Secret` without weakening passkey login for browsers.
- Adding `MCP_API_TOKEN` enforces a second-layer Bearer token check (`Authorization: Bearer ...`) using constant-time comparison.
- High-impact endpoints (`/api/restore`, `/api/backup`, secrets, and raw image file paths) are never exposed to MCP.

### Example MCP Client Config

```json
{
  "mcpServers": {
    "pinbin": {
      "url": "https://pinbin.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "<your-cf-client-id>",
        "CF-Access-Client-Secret": "<your-cf-client-secret>",
        "Authorization": "Bearer <your-mcp-api-token>"
      }
    }
  }
}
```
