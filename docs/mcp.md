# Connect an AI Assistant (MCP)

Pinbin includes an optional **MCP (Model Context Protocol)** endpoint at `/mcp`. MCP is a standard way for AI assistants (such as Claude, ChatGPT, or coding agents) to read and update your workbench tools directly.

With MCP enabled, you can ask your assistant to:

- Search your inventory and suggest builds from parts you already own.
- Add new parts, fill in specs, or update bin locations in bulk.
- Plan a project's parts list, wiring connections, and safety checks.
- Track shopping list items, compare store offers, and maintain glossary terms.

---

## 1. Enable MCP in `.env`

MCP is off by default. Add these lines to `.env` and restart Pinbin (`docker compose up -d`):

```dotenv
MCP_ENABLED=true
# Optional: set to true to allow reading and searching only (blocks all edits and deletes)
MCP_READ_ONLY=false
# Optional: require a secret Bearer token on every /mcp request
MCP_API_TOKEN=replace-with-a-long-random-secret
```

You can also view the current MCP status and switch read-only mode from **Settings → Assistant** inside the app.

---

## 2. Allow Your Assistant Through Cloudflare Access

When `LOCAL_DEV_MODE=false`, `/mcp` stays protected by Cloudflare Access. Because an AI client cannot click through a browser passkey prompt, give it a **Service Token**:

1. Open **Cloudflare Zero Trust → Access → Service Auth → Service Tokens**.
2. Click **Create Service Token**, name it (for example, `pinbin-mcp`), and copy the **Client ID** and **Client Secret**.
3. Open your Pinbin application under **Access → Applications** and add a **Service Auth** policy that allows this Service Token.

This keeps passkey login unchanged for browsers while letting your AI assistant authenticate safely.

---

## 3. Configure Your MCP Client

Add Pinbin to your AI client's MCP configuration file:

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

- If you left `MCP_API_TOKEN` blank, omit the `Authorization` header.
- If you are testing locally with `LOCAL_DEV_MODE=true`, use `http://127.0.0.1:8080/mcp` and omit the Cloudflare headers.

---

## Security Notes

- **Extra token layer:** Setting `MCP_API_TOKEN` adds a second check on top of Cloudflare Access.
- **Read-only mode:** Set `MCP_READ_ONLY=true` if you only want the assistant to answer questions and suggest projects without changing data.
- **Protected actions:** Backup download, restore upload, app secrets, and raw server paths are never exposed through MCP.
