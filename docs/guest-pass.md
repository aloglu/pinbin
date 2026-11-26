# Share Read-Only Access (Guest Pass)

Guest Pass lets you share a private link so someone can browse your Pinbin workbench without logging into your Cloudflare Access account and without editing anything.

---

## What Guests Can and Cannot Do

| Allowed | Blocked |
| --- | --- |
| Browse Inventory, Projects, Shopping, Glossary, and Bench | Add, edit, or delete any item |
| Open part details, wiring maps, pinouts, and calculators | Open Settings or change preferences |
| See stock counts (read-only) | Change quantities, export backups, restore data, or access `/mcp` |

---

## 1. Add a Cloudflare Access Bypass Rule

If you host Pinbin behind Cloudflare Access, Cloudflare blocks `/guest` until you allow it through:

1. Open **Cloudflare Zero Trust → Access → Applications**.
2. Create a new **Self-hosted** application (or add a path) for your Pinbin hostname with the path **`/guest/*`** (entered as `guest` in Cloudflare's path box, e.g. `pinbin.yourdomain.com/guest`).
3. Add a policy with Action set to **Bypass** and Include set to **Everyone**.
4. Save the application.

This only lets requests under `/guest/*` bypass Cloudflare Access. Your main app (`/`) and `/mcp` remain locked behind your login policy.

> **Do not worry about open access:** Pinbin checks its own secret guest key on every `/guest/*` request. Anyone without your link sees a locked page.

---

## 2. Create and Share the Link

1. Open Pinbin and go to **Settings → Guest pass**.
2. Turn **Guest pass** on.
3. Click **Copy link** and send the link to your guest.

When a guest opens the link (`/guest/pass/<token>`), Pinbin verifies the token, saves a read-only session cookie for `/guest`, and redirects them to a clean `/guest/inventory` URL so the token does not stay in the address bar.

---

## 3. Revoke Access

Go to **Settings → Guest pass** at any time:

- **Rotate link:** Creates a new secret key and immediately signs out anyone using the old link.
- **Turn off Guest pass:** Disables `/guest` completely until you turn it back on.
