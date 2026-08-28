# Using MCP Rating from Cursor — a walkthrough

A copy-paste session that covers: **discover → connect a web-published server → connect a
server that needs local install → call their tools → disconnect.**

Every output below was captured from a real run through the Gateway against the live
registry (`https://mcprating.io/api/v1`). Where behaviour is client-dependent, it says so.

---

## 0. Setup

`.cursor/mcp.json` is already committed in this repo:

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"],
      "env": { "MCP_GATEWAY_LOG_LEVEL": "info" }
    }
  }
}
```

1. Nothing to build — `npx` fetches the published package on first run.
2. Open this project in Cursor → **Settings → MCP** (or *Tools & Integrations*) — you
   should see **mcp-gateway** with **13 tools**. Toggle it on if it's disabled.
3. If it shows 0 tools, fully restart Cursor (it caches the server list).

No registry URL is needed — the Gateway defaults to the public registry.

---

## 1. Discover

**Type in Cursor's chat (Agent mode):**

> Use mcp_discover to find MCP servers for reading GitHub repository documentation.

The agent calls `mcp_discover({query: "...", limit: 5})`. Real output shape:

```
## MCP Server Search: "kubernetes"
Found 182 servers (showing 3)

### mcp-kubernetes-server
**Slug:** `feiskyer-mcp-kubernetes-server` · **Score:** 40/100 · **Trust:** [Community]
A Model Context Protocol (MCP) server that enables AI assistants to interact with
Kubernetes clusters...
📊 19 ★
→ Connect: `mcp_connect({slug: "feiskyer-mcp-kubernetes-server"})`
```

You get the **slug** (what you connect with), a **quality score**, a **trust tier**, and
stars. Trust tiers: `[Verified]` → `[Trusted]` → `[Community]` → `[Unverified]`.

Results also show **how you'd run it** and the install command:

```
📊 npx · 951/wk · Developer Tools
🔧 Install: `npx jaegis-github-mcp-server`
→ Connect: `mcp_connect({slug: "jaegis-github-mcp-server"})`
```

Hosted servers show `🌐 Hosted server — no install needed` instead. A server that needs
API keys shows `🔑 Requires: \`SOME_API_KEY\`` and a connect line pre-filled with the env
template — worth reading before you connect, since missing credentials are the most common
reason a connect fails.

---

## 2. Connect a **web-published** server (no install)

Some servers are already hosted — nothing to install, just a URL. Connect by `url`:

> Connect to the DeepWiki MCP server at https://mcp.deepwiki.com/mcp

```
mcp_connect({url: "https://mcp.deepwiki.com/mcp", confirmed: true})
```

**Real result:**
```
## ✅ Connected: mcp-deepwiki-com
**Trust:** [Unverified] · **Transport:** streamable-http · **Tools:** 3
**Server:** DeepWiki v2.14.3
### Available Tools
- `mcp-deepwiki-com__ask_question`
- `mcp-deepwiki-com__read_wiki_contents`
- `mcp-deepwiki-com__read_wiki_structure`
**Active connections:** 1
```

The Gateway detected `streamable-http` automatically. It's `[Unverified]` because a raw
URL isn't matched to a registry entry — connect by **slug** instead when you want the
trust tier and score applied.

### Call its tool

> Use the DeepWiki tools to show me the wiki structure for modelcontextprotocol/servers

```
mcp_call_tool({
  name: "mcp-deepwiki-com__read_wiki_structure",
  arguments: {"repoName": "modelcontextprotocol/servers"}
})
```

**Real result (truncated):**
```
Available pages for modelcontextprotocol/servers:
- 1 Introduction to Model Context Protocol Servers
  - 1.1 MCP Protocol and Architecture
- 2 Reference Servers Overview
  - 2.1 Everything Server
  ...
```

---

## 3. Connect a server that needs **local install**

Here the Gateway reads the install command from the registry and spawns the process for
you — you don't run `npm install` yourself.

> Connect to the server with slug modelcontextprotocol-server-sequential-thinking

```
mcp_connect({slug: "modelcontextprotocol-server-sequential-thinking", confirmed: true})
```

**Real result:**
```
## ✅ Connected: @modelcontextprotocol/server-sequential-thinking
**Trust:** [Unverified] · **Transport:** stdio · **Tools:** 1
**Server:** sequential-thinking-server v0.2.0
### Available Tools
- `modelcontextprotocol-server-sequential-thinking__sequentialthinking`
### 🛡️ Sandbox (l1-process)
- No environment variables (secrets) exposed
- No network access (declared)
**Active connections:** 2
```

Note the **sandbox block** — this is the containment story in practice: the spawned process
got no secrets from your environment and declares no network access.

### Call its tool
```
mcp_call_tool({
  name: "modelcontextprotocol-server-sequential-thinking__sequentialthinking",
  arguments: {
    "thought": "Testing the gateway proxy path",
    "thoughtNumber": 1, "totalThoughts": 1, "nextThoughtNeeded": false
  }
})
```
**Real result:** `{"thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false,"branches":[],"thoughtHistoryLength":1}`

### About `confirmed: true`
For untrusted or low-score servers the Gateway **refuses the first attempt** and returns a
warning (unknown provenance, or missing required env vars). Re-issue the same call with
`confirmed: true` to proceed. In Cursor you'll simply see the agent report the warning —
tell it "yes, connect anyway" and it will retry with the flag. That's a deliberate
speed-bump before running third-party code.

---

## 4. How Cursor sees the connected tools

Two ways, and this is the part that varies by client:

1. **`mcp_call_tool` — always works.** Pass the namespaced name
   `<slug>__<toolName>`. This is the reliable path and what the examples above use.
2. **As first-class tools — client-dependent.** The Gateway declares
   `tools.listChanged`, so a client that honours that notification will refresh its tool
   list and show `mcp-deepwiki-com__ask_question` alongside the built-ins.

> Verified: the full flow above works through `mcp_call_tool`. Whether Cursor *also*
> surfaces the newly-connected tools as its own selectable tools depends on its
> `listChanged` handling — if they don't appear in the tool list, use `mcp_call_tool`.
> This is exactly why that meta-tool exists.

Useful during a session:
- `mcp_list_active` — what's connected, tool counts, uptime
- `mcp_gateway_health` — version, uptime, registry reachability, per-server health

```
## Active MCP Connections (2)
### mcp-deepwiki-com
**Slug:** `mcp-deepwiki-com` · **Trust:** [Unverified] · **State:** ready
**Server:** DeepWiki v2.14.3 · **Tools:** 3 · **Connected:** 1m 13s
### @modelcontextprotocol/server-sequential-thinking
**Slug:** `modelcontextprotocol-server-sequential-thinking` · ... · **Connected:** 32s
```

---

## 5. Disconnect

> Disconnect the sequential thinking server

```
mcp_disconnect({slug: "modelcontextprotocol-server-sequential-thinking"})
```
```
## ✅ Disconnected: modelcontextprotocol-server-sequential-thinking
All tools from this server have been removed.
**Active connections:** 1
```

For a local (stdio) server this kills the spawned process; for a remote one it closes the
HTTP session. Its namespaced tools disappear from the Gateway immediately.

Connections also drop when Cursor stops the Gateway (closing Cursor, toggling the server
off) — nothing is left running in the background. To clear everything:

```
mcp_disconnect({slug: "mcp-deepwiki-com"})
→ **Active connections:** 0
```

---

## Full session, in order

```
mcp_discover({query: "github documentation", limit: 5})
mcp_connect({url: "https://mcp.deepwiki.com/mcp", confirmed: true})
mcp_call_tool({name: "mcp-deepwiki-com__read_wiki_structure",
               arguments: {"repoName": "modelcontextprotocol/servers"}})
mcp_connect({slug: "modelcontextprotocol-server-sequential-thinking", confirmed: true})
mcp_list_active({})
mcp_call_tool({name: "modelcontextprotocol-server-sequential-thinking__sequentialthinking",
               arguments: {"thought": "test", "thoughtNumber": 1, "totalThoughts": 1,
                           "nextThoughtNeeded": false}})
mcp_disconnect({slug: "modelcontextprotocol-server-sequential-thinking"})
mcp_disconnect({slug: "mcp-deepwiki-com"})
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Gateway shows 0 tools in Cursor | `pnpm gateway:build`, then fully restart Cursor |
| `spawn node ENOENT` | Use an absolute path to the node binary in `args[0]`/`command` |
| Connect returns a confirmation warning | Expected for untrusted servers — retry with `confirmed: true` |
| `server-crashed-on-start` | The server almost certainly needs API keys. Pass them: `mcp_connect({slug: "...", env: {"API_KEY": "..."}})`. Auth is the #1 cause of connect failures |
| Newly connected tools not in Cursor's tool list | Use `mcp_call_tool` with the `slug__tool` name |
| Discovery says "No install command recorded" | That server genuinely has none (often a `github-manual` entry). Connecting by slug still works — the Gateway resolves it at connect time |
