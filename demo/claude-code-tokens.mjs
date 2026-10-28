#!/usr/bin/env node
/**
 * What does each configured MCP server cost Claude Code, per request?
 *
 *   CLAUDE_BIN=<path to claude> node demo/claude-code-tokens.mjs <fixture.json> [out.json]
 *
 * Runs `claude -p` once per configuration, with tool search on (the default)
 * and off (ENABLE_TOOL_SEARCH=false), and reads the prompt size from the
 * result's usage: input + cache-creation + cache-read tokens. The prompt asks
 * for one word, so it is one request and no tool runs.
 *
 * Configurations: no MCP servers (the baseline every other row is measured
 * against), the first 1, 3, 9 and 10 servers of the fixture replayed by
 * replay-tools-server.mjs, and the gateway alone.
 *
 * WHY THIS EXISTS. Our README said every statically configured server puts its
 * full tool schema in front of the model on every turn, and priced the gateway
 * against that. Claude Code now defers MCP tool definitions by default. This
 * measures what that leaves, in the client's own token counts.
 *
 * Runs in an empty working directory with a clean environment, so the
 * project, its CLAUDE.md and the calling session don't leak in. Your user-level
 * settings still load; they cost the same in every row and cancel out against
 * the baseline.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [fixtureArg, outArg] = process.argv.slice(2);
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.CC_MODEL || "sonnet";
const REPS = Number(process.env.CC_REPS || 1);
const GATEWAY = process.env.CC_GATEWAY || "@mcp-rating/gateway";
const PROMPT = "Reply with the single word OK.";
if (!fixtureArg) {
  console.error("usage: CLAUDE_BIN=<claude> node demo/claude-code-tokens.mjs <fixture.json> [out.json]");
  process.exit(2);
}
const fixture = resolve(fixtureArg);
const slugs = JSON.parse(readFileSync(fixture, "utf8")).servers.map((s) => s.slug);
const replay = join(__dirname, "replay-tools-server.mjs");

const work = join(tmpdir(), `cc-tokens-${process.pid}`);
const cwd = join(work, "empty");
mkdirSync(cwd, { recursive: true });

const replayed = (n) =>
  Object.fromEntries(slugs.slice(0, n).map((s) => [s, { command: "node", args: [replay, fixture, s] }]));
const configs = [
  { name: "none", servers: {} },
  { name: "1 server", servers: replayed(1) },
  { name: "3 servers", servers: replayed(3) },
  // 9 and 10 apart, so one very large server can be told from the rest.
  { name: "9 servers", servers: replayed(9) },
  { name: "10 servers", servers: replayed(10) },
  // npx is a .cmd shim on Windows, which a client can't spawn directly.
  { name: "gateway", servers: { gateway: process.platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", "-y", GATEWAY] }
      : { command: "npx", args: ["-y", GATEWAY] } } },
];
const modes = [
  { name: "tool search on", env: {} },
  { name: "tool search off", env: { ENABLE_TOOL_SEARCH: "false" } },
];

// Only what a fresh shell would have: no CLAUDECODE, no host session, no
// inherited ENABLE_TOOL_SEARCH.
const KEEP = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramData"];
const baseEnv = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

function run(config, mode) {
  const cfgPath = join(work, `${config.name.replace(/\W+/g, "-")}.json`);
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: config.servers }));
  const r = spawnSync(
    CLAUDE,
    ["-p", PROMPT, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
     "--mcp-config", cfgPath, "--model", MODEL, "--no-session-persistence"],
    { cwd, env: { ...baseEnv, ...mode.env }, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 },
  );
  const events = String(r.stdout || "").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result");
  if (!result || result.is_error) {
    throw new Error(`${config.name} / ${mode.name}: ${result?.result ?? (r.stderr || "no result").slice(0, 300)}`);
  }
  const u = result.usage;
  return {
    config: config.name,
    mode: mode.name,
    model: Object.keys(result.modelUsage ?? {}).join(","),
    servers: (init?.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`),
    toolsListed: init?.tools?.length ?? null,
    mcpToolsListed: (init?.tools ?? []).filter((t) => String(t).startsWith("mcp__")).length,
    turns: result.num_turns,
    prompt: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
    usage: { input: u.input_tokens, cacheCreation: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens, output: u.output_tokens },
    costUsd: result.total_cost_usd,
  };
}

const rows = [];
for (const mode of modes) {
  for (const config of configs) {
    for (let i = 0; i < REPS; i++) {
      const row = run(config, mode);
      rows.push(row);
      const notReady = row.servers.filter((s) => !s.endsWith(":connected"));
      console.error(
        `${mode.name.padEnd(16)} ${config.name.padEnd(11)} prompt ${String(row.prompt).padStart(7)} tokens` +
          `  mcp tools ${row.mcpToolsListed}  turns ${row.turns}` + (notReady.length ? `  NOT CONNECTED: ${notReady.join(" ")}` : ""),
      );
    }
  }
}

const base = Object.fromEntries(rows.filter((r) => r.config === "none").map((r) => [r.mode, r.prompt]));
console.log("\n| config | tool search on | tool search off |\n|---|--:|--:|");
for (const config of configs) {
  const cell = (mode) => {
    const r = rows.find((x) => x.config === config.name && x.mode === mode);
    return config.name === "none" ? `${r.prompt} (baseline)` : `+${r.prompt - base[mode]}`;
  };
  console.log(`| ${config.name} | ${cell("tool search on")} | ${cell("tool search off")} |`);
}

const out = outArg ? resolve(outArg) : join(work, "results.json");
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), claude: CLAUDE, model: MODEL, prompt: PROMPT, fixture, rows }, null, 2) + "\n");
console.error(`\nwrote ${out}`);
