# @mcp-rating/gateway

**MCP Gateway** is a meta-MCP server that auto-discovers, connects, and proxies other MCP servers. Add one line to your AI desktop client config and get dynamic access to the entire MCP ecosystem.

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

### With Any MCP Client

```json
{
  "command": "npx",
  "args": ["-y", "@mcp-rating/gateway"]
}
```

## Meta-Tools

The gateway exposes 5 built-in tools:

| Tool | Description |
|------|-------------|
| `mcp_discover` | Search the MCP-Rating registry for servers |
| `mcp_connect` | Connect to a server (by slug or explicit command) |
| `mcp_disconnect` | Disconnect a server and remove its tools |
| `mcp_list_active` | List all connected servers |
| `mcp_server_info` | Get detailed info about a server |

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
  "registryApiUrl": "https://mcp-rating.example.com/api/v1",
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

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Type check
pnpm typecheck

# Build
pnpm build
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
