import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GatewayConfig, RegistryConfig } from "./types.js";

const GATEWAY_DIR = join(homedir(), ".mcp-gateway");
const DEFAULT_CONFIG_PATH = join(GATEWAY_DIR, "config.json");
const DEFAULT_PERMISSIONS_PATH = join(GATEWAY_DIR, "permissions.json");
const DEFAULT_PROFILES_PATH = join(GATEWAY_DIR, "profiles.json");

const DEFAULTS: GatewayConfig = {
  // Public hosted registry. Point at a local instance for development with
  // MCP_GATEWAY_REGISTRY_URL=http://localhost:3000/api/v1
  registryApiUrl: "https://mcprating.io/api/v1",
  proxyTimeoutMs: 30_000,
  maxConnections: 10,
  logLevel: "info",
  permissionsPath: DEFAULT_PERMISSIONS_PATH,
  configPath: DEFAULT_CONFIG_PATH,
  profilesPath: DEFAULT_PROFILES_PATH,
  registryCacheTtlMs: 300_000,
  reconnectMaxAttempts: 5,
  reconnectBaseDelayMs: 1_000,
  healthCheckIntervalMs: 30_000,
};

/**
 * Load gateway configuration from file + environment variables.
 * Priority: env vars > config file > defaults
 */
export function loadConfig(): GatewayConfig {
  const configPath =
    process.env.MCP_GATEWAY_CONFIG_PATH || DEFAULT_CONFIG_PATH;

  // Ensure gateway directory exists
  if (!existsSync(GATEWAY_DIR)) {
    mkdirSync(GATEWAY_DIR, { recursive: true });
  }

  // Load config file if it exists
  let fileConfig: Partial<GatewayConfig> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
    } catch {
      // Ignore malformed config file — use defaults
    }
  }

  // Merge: defaults < file < env vars
  return {
    registryApiUrl:
      process.env.MCP_GATEWAY_REGISTRY_URL ||
      fileConfig.registryApiUrl ||
      DEFAULTS.registryApiUrl,

    registries:
      parseRegistryList(parseCsvEnv("MCP_GATEWAY_REGISTRIES")) ??
      parseRegistryList(fileConfig.registries as Array<string | RegistryConfig> | undefined) ??
      undefined,

    minQualityScore: parseMinScore(process.env.MCP_GATEWAY_MIN_SCORE ?? fileConfig.minQualityScore),

    proxyTimeoutMs: parseIntEnv("MCP_GATEWAY_TIMEOUT") ??
      fileConfig.proxyTimeoutMs ??
      DEFAULTS.proxyTimeoutMs,

    maxConnections: parseIntEnv("MCP_GATEWAY_MAX_CONNECTIONS") ??
      fileConfig.maxConnections ??
      DEFAULTS.maxConnections,

    logLevel: (process.env.MCP_GATEWAY_LOG_LEVEL as GatewayConfig["logLevel"]) ||
      fileConfig.logLevel ||
      DEFAULTS.logLevel,

    permissionsPath: fileConfig.permissionsPath || DEFAULTS.permissionsPath,
    configPath,
    profilesPath: fileConfig.profilesPath || DEFAULTS.profilesPath,

    registryCacheTtlMs: parseIntEnv("MCP_GATEWAY_CACHE_TTL") ??
      fileConfig.registryCacheTtlMs ??
      DEFAULTS.registryCacheTtlMs,

    reconnectMaxAttempts: fileConfig.reconnectMaxAttempts ?? DEFAULTS.reconnectMaxAttempts,
    reconnectBaseDelayMs: fileConfig.reconnectBaseDelayMs ?? DEFAULTS.reconnectBaseDelayMs,
    healthCheckIntervalMs: fileConfig.healthCheckIntervalMs ?? DEFAULTS.healthCheckIntervalMs,

    partnerKey:
      process.env.MCP_GATEWAY_PARTNER_KEY ||
      fileConfig.partnerKey ||
      undefined,

    enableAdTracking:
      process.env.MCP_GATEWAY_AD_TRACKING === "false"
        ? false
        : fileConfig.enableAdTracking ?? undefined,

    enableContainerIsolation:
      process.env.MCP_GATEWAY_CONTAINER_ISOLATION === "true"
        ? true
        : process.env.MCP_GATEWAY_CONTAINER_ISOLATION === "false"
          ? false
          : fileConfig.enableContainerIsolation ?? undefined,

    auditLogPath:
      process.env.MCP_GATEWAY_AUDIT_LOG || fileConfig.auditLogPath || undefined,

    httpPort: parseIntEnv("MCP_GATEWAY_HTTP_PORT") ?? fileConfig.httpPort ?? undefined,
    httpHost:
      process.env.MCP_GATEWAY_HTTP_HOST || fileConfig.httpHost || "127.0.0.1",
    httpToken:
      process.env.MCP_GATEWAY_HTTP_TOKEN || fileConfig.httpToken || undefined,
    httpTokens:
      parseTokensEnv("MCP_GATEWAY_HTTP_TOKENS") ??
      fileConfig.httpTokens ??
      undefined,
    httpAllowedHosts:
      parseCsvEnv("MCP_GATEWAY_HTTP_ALLOWED_HOSTS") ??
      fileConfig.httpAllowedHosts ??
      undefined,
    httpAllowedOrigins:
      parseCsvEnv("MCP_GATEWAY_HTTP_ALLOWED_ORIGINS") ??
      fileConfig.httpAllowedOrigins ??
      undefined,
  };
}

/**
 * Registries from MCP_GATEWAY_REGISTRIES or the config file's `registries`.
 * Each is a URL, or `mcprating=URL` / `mcp-registry=URL` to say which API it
 * speaks. A bare URL ending in /api/v1 is MCP Rating's API; anything else is
 * taken to speak the official MCP Registry API (v0.1), as the official
 * registry, MCP Rating's feed and spec-following private registries do.
 * Entries that aren't http(s) URLs are dropped with a warning. Undefined when
 * nothing usable is left, so the default (MCP Rating alone) applies.
 */
export function parseRegistryList(items: Array<string | RegistryConfig> | undefined): RegistryConfig[] | undefined {
  if (!items?.length) return undefined;
  const out: RegistryConfig[] = [];
  for (const item of items) {
    let type: RegistryConfig["type"] | undefined;
    let url: string;
    if (typeof item === "string") {
      const m = item.trim().match(/^(mcprating|mcp-registry)=(.+)$/);
      type = m?.[1] as RegistryConfig["type"] | undefined;
      url = (m?.[2] ?? item).trim();
    } else {
      type = item?.type;
      url = String(item?.url ?? "").trim();
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      process.stderr.write(`[mcp-gateway] ignoring registry "${url}": not a URL\n`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      process.stderr.write(`[mcp-gateway] ignoring registry "${url}": only http(s) registries are supported\n`);
      continue;
    }
    const clean = url.replace(/\/+$/, "");
    out.push({ type: type ?? (/\/api\/v1$/.test(clean) ? "mcprating" : "mcp-registry"), url: clean });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a per-tenant token env var of the form "tenant1:token1,tenant2:token2"
 * into a { tenant: token } record. The token may itself contain colons (only
 * the first colon separates tenant from token). Returns undefined if empty.
 */
function parseTokensEnv(name: string): Record<string, string> | undefined {
  const val = process.env[name];
  if (!val) return undefined;
  const out: Record<string, string> = {};
  for (const pair of val.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue; // need a non-empty tenant before the colon
    const tenant = trimmed.slice(0, idx).trim();
    const token = trimmed.slice(idx + 1).trim();
    if (tenant && token) out[tenant] = token;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a comma-separated env var into a trimmed string array (or undefined). */
function parseCsvEnv(name: string): string[] | undefined {
  const val = process.env[name];
  if (!val) return undefined;
  const items = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * The minimum-score rule from MCP_GATEWAY_MIN_SCORE or `minQualityScore`.
 * Unset is no rule. A value that isn't a whole number from 0 to 100 fails
 * closed — read as 100, which refuses everything — rather than quietly
 * meaning "no rule": a typo in a safety setting should be noticed.
 */
export function parseMinScore(v: unknown): number | undefined {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return undefined;
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    process.stderr.write(
      `[mcp-gateway] minimum score "${String(v)}" isn't a whole number from 0 to 100; refusing every connect (treating it as 100) until it's fixed\n`,
    );
    return 100;
  }
  return n;
}

function parseIntEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined) return undefined;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? undefined : num;
}
