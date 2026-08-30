# @mcp-rating/gateway

**Run MCP servers without handing them your API keys.**

Adding an MCP server to your client today spawns somebody else's code with your
entire environment attached — `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`,
`DATABASE_URL`, everything in your shell. The gateway spawns them with a
constructed environment instead: `PATH`, `HOME`, and only the variables you or
its manifest name. Nothing else is there to read.

It is also a meta-server: one entry in your config gives you the whole registry,
connected on demand rather than pre-loaded.

```json
{ "mcpServers": { "gateway": { "command": "npx", "args": ["-y", "@mcp-rating/gateway"] } } }
```

## Why it uses less of your context

Every MCP server you configure statically injects its full tool schema into
every turn, whether you use it or not. The gateway exposes 13 meta-tools at a
fixed cost and loads a server's tools only once you connect to it.

| | measured |
|---|--:|
| Mean per real MCP server | **~1,500 tokens** |
| 10 servers configured statically | **~15,100 tokens, every turn** |
| Gateway, flat | **~2,800 tokens** |

Roughly **5× less** standing overhead at ten servers, and the gap widens with
each one you add.

*Honest about the method:* measured from 6 servers this project connected to and
introspected, sized as `chars / 4`. It is an estimate from a small sample, not a
benchmark. And it is standing overhead only — connecting to a server pays that
server's schema cost at connect time. The saving is real precisely because most
configured servers sit unused in most conversations.

## How It Works

```
┌────────────────────┐       ┌──────────────┐       ┌──────────────────┐
│  Claude Desktop /  │ stdio │              │ stdio  │ MCP Server A     │
│  Cursor / Windsurf │◄─────►│  MCP Gateway │◄──────►│ (e.g. filesystem)│
│  (host client)     │       │              │◄──┐    └──────────────────┘
└────────────────────┘       └──────────────┘   │    ┌──────────────────┐
                                    │           └───►│ MCP Server B     │
                                    ▼                │ (e.g. github)    │
                             ┌──────────────┐        └──────────────────┘
                             │ MCP-Rating   │
                             │ Registry API │
                             └──────────────┘
```

Instead of manually configuring each MCP server in your client, the Gateway:

1. **Discovers** servers via the MCP-Rating registry
2. **Connects** to them on-demand (spawns as child processes)
3. **Proxies** their tools through namespaced names (`servername__toolname`)
4. **Notifies** your client when tools are added/removed

## Quick Start

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "npx",
      "args": ["-y", "@mcp-rating/gateway"]
    }
  }
}
```

Then ask Claude:
- *"Search for MCP servers that work with databases"* (uses `mcp_discover`)
- *"Connect to the sqlite server"* (uses `mcp_connect`)
- *"Query my database"* (calls the proxied tool directly)

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "gateway": { "command": "npx", "args": ["-y", "@mcp-rating/gateway"] }
  }
}
```

### Claude Code

```bash
claude mcp add gateway -- npx -y @mcp-rating/gateway
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, same shape as Cursor:

```json
{
  "mcpServers": {
    "gateway": { "command": "npx", "args": ["-y", "@mcp-rating/gateway"] }
  }
}
```

### Any other MCP client

```json
{ "command": "npx", "args": ["-y", "@mcp-rating/gateway"] }
```

Restart the client after editing its config — most read it only at startup.

## Meta-Tools

The gateway exposes 13 built-in tools:

| Tool | Description |
|------|-------------|
| `mcp_discover` | Search the MCP-Rating registry for MCP servers |
| `mcp_connect` | Connect to a server and make its tools available |
| `mcp_disconnect` | Disconnect a server and remove its tools |
| `mcp_list_active` | List connected servers and their tools |
| `mcp_server_info` | Detailed info about a server, from the registry or a live connection |
| `mcp_call_tool` | Call a tool on a connected server |
| `mcp_gateway_health` | Diagnostics: version, uptime, connection and registry status |
| `mcp_sandbox` | View or customise a server's sandbox manifest (env/network/filesystem) |
| `mcp_audit` | The safety audit trail — what sandboxed servers actually did |
| `mcp_profiles` | Named connection profiles (work, personal, …) |
| `mcp_groups` | Atomic connect/disconnect of server sets |
| `mcp_usage` | Call counts, latency and error rates for connected servers |
| `mcp_recommend` | Server recommendations based on usage |

## Trust Tiers

Every connected server is labeled with a trust tier based on its MCP-Rating quality score:

- **[Verified]** — High quality + officially verified
- **[Trusted]** — Good quality with repository and install command
- **[Community]** — Listed in registry with basic quality
- **[Unverified]** — Unknown origin (manually connected)

## Configuration

The gateway reads config from `~/.mcp-gateway/config.json`:

```json
{
  "registryApiUrl": "https://mcprating.io/api/v1",
  "proxyTimeoutMs": 30000,
  "maxConnections": 10,
  "logLevel": "info"
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_GATEWAY_REGISTRY_URL` | MCP-Rating API base URL | `https://mcprating.io/api/v1` |
| `MCP_GATEWAY_TIMEOUT` | Proxy timeout (ms) | `30000` |
| `MCP_GATEWAY_MAX_CONNECTIONS` | Max simultaneous connections | `10` |
| `MCP_GATEWAY_LOG_LEVEL` | Log level (debug/info/warn/error) | `info` |
| `MCP_GATEWAY_CONTAINER_ISOLATION` | Force L2 container isolation on/off | manifest decides |
| `MCP_GATEWAY_AUDIT_LOG` | Path for the forensic audit log | disabled |
| `MCP_GATEWAY_PARTNER_KEY` | Partner attribution key — **enables ad telemetry** | unset |
| `MCP_GATEWAY_AD_TRACKING` | Set to `false` to disable ad telemetry outright | unset |
| `MCP_GATEWAY_HTTP_TOKEN` | Bearer token for HTTP daemon mode | unset |

## Security model

The gateway exists because plain MCP hands every server your whole environment.
Two layers push back, and it is worth being precise about what each one does and
does not do.

### L1 — environment scoping (always on, for stdio servers)

A downstream server receives `PATH`, `HOME` and friends, plus only the variable
**names** its manifest allowlists or you pass at connect time. Everything else in
the parent environment — `AWS_*`, `OPENAI_API_KEY`, `DATABASE_URL` — is withheld.
Exported shell functions (`BASH_FUNC_*`) are dropped rather than forwarded.

This is genuine enforcement: the child process is spawned with a constructed
environment, so there is nothing to opt out of or bypass.

### L2 — container isolation (opt-in)

When a manifest requests it, or `MCP_GATEWAY_CONTAINER_ISOLATION=true`, the
server runs under `docker`/`podman` with an ephemeral container.

### Network allowlists: read this before relying on them

`network: "allowlist"` starts an in-process forward proxy and points the child at
it via `HTTP_PROXY`/`HTTPS_PROXY`.

**This filters proxy-aware clients only.** Node's fetch/undici, axios, and Python
requests all honour those variables, which covers most real servers. A program
that opens raw TCP sockets, or a compiled binary that ignores proxy environment
variables, **is not filtered**. Treat allowlists in L1 as a guard rail against
honest code, not a containment boundary against hostile code — for that you need
L2 with container network namespacing.

Allowlist patterns fail **closed**: a malformed pattern such as `*example.com`
(missing dot) matches nothing rather than everything. The gateway warns at
startup about patterns that will not do what their author intended, including
over-broad ones like `*.com`.

### What is not covered

If the host client is `SIGKILL`ed, the gateway cannot run its shutdown path and
spawned child processes may be left behind. `SIGINT`/`SIGTERM` are handled and
disconnect everything cleanly; `SIGKILL` is untrappable by definition.

## Telemetry

**Off unless you turn it on.** The ad tracker is constructed only when
`MCP_GATEWAY_PARTNER_KEY` is set — with no partner key there is no partner
telemetry, and nothing is posted about your connects or tool calls.

If a partner key is set (you are earning attribution revenue), connect and
tool-execution events are sent to mcprating.io. Disable it while keeping the key
with `MCP_GATEWAY_AD_TRACKING=false`.

Separately, the gateway calls the MCP-Rating registry API for `mcp_discover` and
`mcp_recommend` — that is the lookup you asked for, not background reporting.
Usage analytics (`mcp_usage`) are an in-memory ring buffer and never leave the
process.

## Development

```bash
npm install
npm run dev        # watch mode
npm run typecheck
npm run build
npm test           # sandbox unit tests (env scoping + egress allowlist)
```

## Architecture

The gateway is built on the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) and uses:

- **StdioServerTransport** — communicates with the host client
- **StdioClientTransport** — spawns and communicates with downstream servers
- **Dynamic tool registration** — `McpServer.registerTool()` + `sendToolListChanged()`
- **Tool namespacing** — `slug__toolname` pattern prevents collisions
- **Passthrough Zod schemas** — preserves parameter names for host client UI while letting downstream servers validate

## License

ISC
