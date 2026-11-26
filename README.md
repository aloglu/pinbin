# Pinbin

Pinbin is a self-hosted web app for tracking your electronics parts, projects, and shopping lists. It runs on your own computer or server, stores everything in one local folder, and works well on both desktop and mobile.

## What You Can Do

- **Inventory:** Track parts with photos, quantities, bin labels, voltage tags, care notes, and pinouts.
- **Projects:** Plan builds with interactive wiring maps, automatic safety checks (such as voltage mismatches), and checklists.
- **Shopping:** Group items by store, compare offers, combine orders to save on shipping, and move arrived items straight to inventory.
- **Glossary:** Look up electronics terms in plain English, linked directly to parts in your inventory and projects.
- **Bench:** Use interactive board pinouts, breadboard and resistor guides, basic calculators, and printable bin QR labels.
- **Share & AI Assistant:** Share a read-only link with [Guest Pass](docs/guest-pass.md), or connect an AI assistant through [MCP](docs/mcp.md).

## Try It on Your Computer

You need [Docker](https://docs.docker.com/get-docker/) installed.

1. Clone this repository and enter the folder:

   ```bash
   git clone https://github.com/aloglu/pinbin.git
   cd pinbin
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Open `.env` and set `LOCAL_DEV_MODE=true`.

4. Start Pinbin:

   ```bash
   docker compose up -d --build
   ```

5. Open `http://127.0.0.1:8080` in your browser.

On first boot, Pinbin imports starter parts and glossary terms from `seed.json`. You can edit or remove them at any time.

## Guides

- [Deploy with Docker and Cloudflare](docs/deploy.md) — Host Pinbin safely behind Cloudflare Tunnel and Cloudflare Access.
- [Share Read-Only Access (Guest Pass)](docs/guest-pass.md) — Let someone browse your workbench without giving edit access.
- [Connect an AI Assistant (MCP)](docs/mcp.md) — Let an AI tool search your parts, plan projects, and update lists.
- [Configuration, Backups, and Local Dev](docs/configuration.md) — Environment variables, `.zip`/CSV backups, and running without Docker.

## License

Released under the [MIT License](https://github.com/aloglu/pinbin/blob/main/LICENSE).
