# Configuration, Backups, and Local Development

This page lists every setting in `.env`, explains how your data is stored and backed up, and shows how to run Pinbin directly with Python.

---

## Environment Variables (`.env`)

Copy `.env.example` to `.env` and edit the values you need. After editing `.env`, restart the container with `docker compose up -d`.

### Security & Access

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_DEV_MODE` | `false` | Set to `true` **only** on your own computer without Cloudflare Access. Disables login checks. |
| `CF_TEAM_DOMAIN` | *(empty)* | Your Cloudflare Zero Trust team URL (e.g. `https://myteam.cloudflareaccess.com`). Required when `LOCAL_DEV_MODE=false`. |
| `CF_POLICY_AUD` | *(empty)* | Your Cloudflare Access Application Audience (AUD) tag. Required when `LOCAL_DEV_MODE=false`. |

### Storage & Uploads

| Variable | Default | What it does |
| --- | --- | --- |
| `DATA_DIR` | `/data` | Folder where Pinbin stores `inventory.db` (SQLite) and the `images/` folder. |
| `SEED_FILE` | `/app/seed.json` | Optional JSON file imported on first boot when the database is empty. |
| `MAX_UPLOAD_MB` | `10` | Maximum allowed photo upload size in megabytes. Uploaded photos are converted to `.webp`. |

### Remote AI Assistant (MCP)

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_ENABLED` | `false` | Set to `true` to turn on the `/mcp` endpoint. See [Connect an AI Assistant](mcp.md). |
| `MCP_READ_ONLY` | `false` | Set to `true` to block all write and delete actions over MCP. |
| `MCP_API_TOKEN` | *(empty)* | Optional Bearer token checked on every `/mcp` request. |

### Optional Server-Side AI API

If you leave `AI_API_KEY` blank, built-in AI API endpoints stay disabled.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_PROVIDER` | `gemini` | Provider name: `gemini`, `openai`, `openrouter`, or `openai_compat`. |
| `AI_API_KEY` | *(empty)* | API key for the chosen provider. Never stored in SQLite or included in backups. |
| `AI_MODEL` | `gemini-3.5-flash-lite` | Model name sent to the provider. |
| `AI_BASE_URL` | *(empty)* | Custom API URL (only needed when `AI_PROVIDER=openai_compat`). |
| `AI_REASONING_EFFORT` | *(empty)* | Optional reasoning level (`low`, `medium`, `high`, or `none`). |
| `AI_DAILY_LIMIT` | `30` | Maximum API calls per day to protect your billing. |

---

## Data Storage and Backups

Pinbin keeps everything inside your `DATA_DIR` folder (`./data` when using `docker-compose.yml`):

- `inventory.db` — SQLite database holding parts, projects, wiring, shopping list, glossary, and settings.
- `images/` — Uploaded part photos and pinout images (`.webp`).

### Backup and Restore in the App

Open **Settings → Data and backup**:

- **Download full backup (`.zip`):** Saves a clean copy of `inventory.db` and all photos in `images/`.
- **Restore from `.zip`:** Replaces your database and images with a previous backup.
- **Export / Import CSV:** Move your parts list to or from a spreadsheet.

---

## Running Without Docker (Local Development)

Pinbin has **no frontend build step**. The interface uses plain CSS (`app/static/css/`) and vanilla JavaScript modules (`app/static/js/`), with all fonts self-hosted in `app/static/fonts/`.

1. Create a Python virtual environment and install dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Run the app locally with a test data folder:

   ```bash
   LOCAL_DEV_MODE=true DATA_DIR=./data uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
   ```

3. Open `http://127.0.0.1:8080`. Edit any file in `app/static/` and refresh the browser to see changes immediately.
