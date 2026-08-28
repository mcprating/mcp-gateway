# MCP Gateway — client integration matrix

How to add the MCP Gateway to each MCP client, and what has actually been verified.

The Gateway is a normal MCP **stdio** server, so every desktop client uses the same two
values — a `command` and `args`. The only genuinely different surface is **HTTP daemon
mode**, for clients that can't spawn local processes (remote, containerised, mobile).

Since v0.2.0 the Gateway defaults to the **public registry**
(`https://mcprating.io/api/v1`), so no configuration is needed to get discovery working.
Set `MCP_GATEWAY_REGISTRY_URL` only to point at a local instance during development.

---

## Verified status

> **Install:** `npx -y @mcp-rating/gateway` — published on npm, no build required.

| Client | Config location | Status |
|---|---|---|
| **Claude Code** | `.mcp.json` / `claude mcp add` | ✅ **Verified live** — 13 tools, discovery against production, connect→call→disconnect |
| **Claude Desktop** | `claude_desktop_config.json` | ✅ **Verified** — config loads, gateway starts, tools listed |
| Cursor | `.cursor/mcp.json` (in-repo) | ⚙️ Config committed, same stdio contract — not separately exercised |
| VS Code (Copilot) | `.vscode/mcp.json` | ⚙️ Config documented below, untested |
| Cline | `cline_mcp_settings.json` | ⚙️ Config documented below, untested |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | ⚙️ Config documented below, untested |
| Zed | `settings.json` → `context_servers` | ⚙️ Config documented below, untested |
| Remote / mobile | HTTP daemon `/mcp` | ✅ **Verified locally** — token auth enforced (401 on missing/wrong), authed MCP client gets 13 tools, discovery works over HTTP. Not yet exposed publicly |

"⚙️" means the config shape follows each client's documented schema and the Gateway side
is identical to the verified clients — but nobody has clicked through that specific client
yet. Treated as unverified on purpose.

---

## The two deployment shapes

**1. Local stdio (default).** The client spawns the Gateway on the user's machine; the
Gateway spawns downstream servers. Full sandboxing available (L1 env scoping, L2
containers). This is what every desktop client below uses.

**2. Hosted HTTP daemon.** The client speaks MCP over the network to a Gateway that runs
elsewhere and does the spawning. Required for clients that cannot run local processes —
mobile apps, browser clients, hosted agents. See [Remote clients](#remote-clients).

---

## Local stdio clients

Every client below uses the same two values — no clone, no build, no absolute paths:

```
command: "npx"
args:    ["-y", "@mcp-rating/gateway"]
```

`npx` fetches and caches the package on first run, and the Gateway defaults to the public
registry, so nothing else is required.

> **Developing on the Gateway itself?** Point at your own build instead: `command: "node"`,
> `args: ["<abs>/packages/gateway/dist/index.js"]` after `pnpm gateway:build`. On Windows,
> escape the backslashes in JSON (`D:\\Projects\\...`) or the client won't parse the file.

### Claude Code ✅
```bash
claude mcp add mcp-gateway -- npx -y @mcp-rating/gateway
```
Or commit a project-scoped `.mcp.json`:
```json
{
  "mcpServers": {
    "mcp-gateway": {
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"]
    }
  }
}
```

### Claude Desktop ✅
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"]
    }
  }
}
```

> **Claude Desktop must be fully quit to reload this file.** On Windows, closing the
> window leaves it running in the system tray, so the config is never re-read — exit from
> the tray icon (or kill the process) and start it again. Symptom: the gateway log under
> `%APPDATA%\Claude\logs\mcp-server-mcp-gateway.log` has no entries with today's date.

### Cursor
`.cursor/mcp.json` in the project (already committed in this repo), or
`~/.cursor/mcp.json` globally. Same `mcpServers` shape as Claude Desktop.

### VS Code (GitHub Copilot agent mode)
`.vscode/mcp.json` — note the key is **`servers`**, not `mcpServers`:
```json
{
  "servers": {
    "mcp-gateway": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"]
    }
  }
}
```

### Cline (VS Code extension)
Cline → MCP Servers → *Configure MCP Servers*, which opens `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "mcp-gateway": {
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"],
      "disabled": false
    }
  }
}
```

### Windsurf
`~/.codeium/windsurf/mcp_config.json`, same `mcpServers` shape.

### Zed
`settings.json` → `context_servers` (Zed's own key):
```json
{
  "context_servers": {
    "mcp-gateway": {
      "command": {
        "path": "npx",
        "args": ["-y", "@mcp-rating/gateway"]
      }
    }
  }
}
```

---

## Remote clients

Clients that cannot spawn processes connect to a Gateway **daemon** over HTTP instead.
Start it with:

```bash
MCP_GATEWAY_HTTP_PORT=8100 \
MCP_GATEWAY_HTTP_TOKEN=<strong-random-token> \
npx -y @mcp-rating/gateway
```

- Endpoint: `POST /mcp` (streamable HTTP / SSE)
- Every request must carry `Authorization: Bearer <token>` — the daemon refuses to start
  without at least one token (`MCP_GATEWAY_HTTP_TOKEN` or `MCP_GATEWAY_HTTP_TOKENS` for
  multi-tenant).
- Binds `127.0.0.1` by default. To expose it, put it behind TLS and set
  `MCP_GATEWAY_HTTP_ALLOWED_HOSTS` to the real hostname(s) — this is DNS-rebinding
  protection, and it will reject requests with an unexpected `Host` otherwise.

Verified end to end locally: requests with no token and with a wrong token are both
rejected with `401`, an authenticated MCP client over streamable HTTP sees all 13 tools,
and `mcp_discover` returns live registry results with real quality scores.

**Mobile note:** phones cannot run MCP servers locally (no Node, no process spawning), so
a hosted daemon is the *only* way a mobile client reaches the MCP ecosystem. That makes
this mode the natural fit for mobile — see the discussion in the project notes. It also
means the daemon holds users' downstream credentials, so isolation and the audit trail
matter more here than in local mode.

---

## Verifying an integration

1. **Tool count.** The client should list **13** gateway tools (`mcp_discover`,
   `mcp_connect`, `mcp_call_tool`, …). Fewer usually means a stale build.
2. **Registry reachability.** Run `mcp_discover({query: "github"})`. Thousands of
   results with non-zero scores means the live registry is reachable. Zero results, or
   an error mentioning `localhost`, means a stale `MCP_GATEWAY_REGISTRY_URL` is set.
3. **Full round trip.** This exercises spawn + proxy + teardown without needing any
   credentials:
   ```
   mcp_connect({command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], confirmed: true})
   mcp_call_tool({name: "<slug>__echo", arguments: {message: "hello"}})
   mcp_disconnect({slug: "<slug>"})
   ```
   Expect `Echo: hello`. (The tool is `get-sum`, not `add`, on that server.)
4. **Diagnostics.** `mcp_gateway_health` reports version, uptime, registry status and
   per-connection health.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Client shows no gateway tools | Client not fully restarted (see the Claude Desktop tray note), or JSON parse error — check for unescaped Windows backslashes |
| `spawn node ENOENT` | `node` is not on the PATH the client inherits; use an absolute path to the node binary |
| Discovery returns nothing | `MCP_GATEWAY_REGISTRY_URL` still points at a local instance that isn't running — remove it to use the public default |
| Scores all show `0/100 · Unverified` | Historic bug (search results dropped `qualityScore`), fixed; if seen again, purge the API response cache |
| `mcp_connect` warns about missing env vars | Working as intended — the server needs API keys; pass them via `env` |
| Downstream connect fails with "server-crashed-on-start" | Usually the server requires auth/config it didn't get. Auth is the single biggest cause of connect failures, not the Gateway |
