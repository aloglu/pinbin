# Deploy with Docker and Cloudflare

Pinbin is built for a single user. By default, it only listens on `127.0.0.1:8080` (localhost), so nothing on your local network or the internet can reach it directly.

The recommended way to access Pinbin from your phone or another computer is through **Cloudflare Tunnel** (creates a private outbound connection to Cloudflare) and **Cloudflare Access** (puts a login screen in front of the app).

---

## 1. Prepare Your Server Folder

Create a folder on your server and place these three files inside it:

- `docker-compose.yml`
- `seed.json` (optional starter data for first boot)
- `.env` (copied from `.env.example`)

```bash
cp .env.example .env
```

---

## 2. Set Up Cloudflare Tunnel and Access

1. In the **Cloudflare Zero Trust** dashboard, create a Tunnel on your server and point a public hostname (for example, `pinbin.yourdomain.com`) to `http://127.0.0.1:8080`.
2. In **Access → Applications**, add a **Self-hosted** application for that same hostname.
3. Add an **Allow** policy for yourself (for example, your email address or passkey login).
4. Copy two values from the Cloudflare dashboard:
   - **Team domain:** `https://<your-team>.cloudflareaccess.com`
   - **Application Audience (AUD) Tag:** found in the application's Overview tab.

---

## 3. Configure `.env`

Open `.env` and set these values:

```dotenv
PINBIN_IMAGE=ghcr.io/aloglu/pinbin:latest
LOCAL_DEV_MODE=false
CF_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com
CF_POLICY_AUD=<your-application-aud-tag>
```

> **How security works:** When `LOCAL_DEV_MODE=false`, Pinbin checks the signed login token that Cloudflare sends with every request. If `CF_TEAM_DOMAIN` or `CF_POLICY_AUD` is missing, Pinbin blocks all traffic rather than opening the app unprotected.

---

## 4. Start Pinbin

Pull the prebuilt Docker image and start the container:

```bash
docker compose pull
docker compose up -d
```

Every push to `main` builds a new image for both Intel/AMD (`linux/amd64`) and ARM/Raspberry Pi (`linux/arm64`).

---

## 5. Update to a Newer Version

Run these two commands in your server folder:

```bash
docker compose pull
docker compose up -d
```

Your database and photos live in the `./data` folder outside the container, so updates keep all your data intact.

---

## Install on Your Phone (Optional)

Pinbin works as a Home Screen web app (PWA):

- **iPhone (Safari):** Open your Pinbin URL, tap **Share**, then tap **Add to Home Screen**.
- **Android (Chrome):** Open your Pinbin URL, tap the menu button, then tap **Install app** or **Add to Home screen**.
