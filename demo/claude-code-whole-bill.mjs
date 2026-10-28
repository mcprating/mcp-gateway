#!/usr/bin/env node
/**
 * What does one task cost in Claude Code, all requests counted: with servers
 * configured statically, or with the gateway finding the server itself?
 *
 *   CLAUDE_BIN=<claude> CC_GATEWAY_ENTRY=<gateway dist/index.js> \
 *     node demo/claude-code-whole-bill.mjs <fixture.json> <packages.json> [out.json]
 *
 * The task needs one tool, list_directory from the filesystem server. It runs:
 *   - with the first 3, 9 and 10 servers of the fixture configured directly
 *     (replayed by replay-tools-server.mjs), the filesystem server among them;
 *   - with the gateway alone, which has to search the registry, connect the
 *     server and call it. Its `npx` is replay-npx.mjs, so the server it starts
 *     is the same replay, and no third-party package runs.
 * each with tool search on (the default) and off (ENABLE_TOOL_SEARCH=false).
 *
 * The bill is every request's prompt (input + cache-creation + cache-read
 * tokens) plus output, summed, and the run's cost as Claude Code reports it.
 * Cost matters as well as tokens: repeated prompt prefixes are read from the
 * cache at a fraction of the input price.
 *
 * WHY THIS EXISTS. Post 4 ("We said our gateway used 10× less context. We
 * measured the whole bill.") found the gateway breaks even at three to five
 * servers, against a client that sends every tool definition on every turn.
 * Claude Code no longer does by default. This redoes that comparison in it.
 *
 * The gateway's searches reach MCP Rating like any user's: note when you ran it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [fixtureArg, packagesArg, outArg] = process.argv.slice(2);
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.CC_MODEL || "sonnet";
const REPS = Number(process.env.CC_REPS || 1);
const GATEWAY_ENTRY = resolve(process.env.CC_GATEWAY_ENTRY || join(__dirname, "..", "dist", "index.js"));
if (!fixtureArg || !packagesArg || !existsSync(GATEWAY_ENTRY)) {
  console.error("usage: CLAUDE_BIN=<claude> CC_GATEWAY_ENTRY=<gateway dist/index.js> node demo/claude-code-whole-bill.mjs <fixture.json> <packages.json> [out.json]");
  process.exit(2);
}
const fixture = resolve(fixtureArg);
const packages = resolve(packagesArg);
const slugs = JSON.parse(readFileSync(fixture, "utf8")).servers.map((s) => s.slug);
// The folder the task lists holds what the replay answers, so the reply is
// true and gives the model no reason to check it.
const EXPECT = "[FILE] notes.txt";

const work = join(tmpdir(), `cc-bill-${process.pid}`);
const cwd = join(work, "empty");
const listing = join(work, "listing");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(listing, "archive"), { recursive: true });
writeFileSync(join(listing, "notes.txt"), "");
// The last sentence is there for the gateway. Without it, Claude (Sonnet 5.5,
// 2026-10-27) finds no filesystem server connected and stops, because
// connecting one would start a package the user hadn't approved. Every
// configuration gets the same prompt, so the bills compare.
const PROMPT = `Use the list_directory tool from the filesystem MCP server to list the directory ${listing.replace(/\\/g, "/")}, then reply with exactly the text the tool returned. If that server isn't connected yet, you have my approval to find and connect it yourself.`;

// The gateway's `npx`: a wrapper that hands everything to replay-npx.mjs.
const shimDir = join(work, "shim");
const shimLog = join(work, "npx.log");
mkdirSync(shimDir, { recursive: true });
writeFileSync(shimLog, "");
const shimArgs = [process.execPath, join(__dirname, "replay-npx.mjs"), fixture, packages, shimLog].map((p) => `"${p}"`).join(" ");
writeFileSync(join(shimDir, "npx.cmd"), `@${shimArgs} -- %*\r\n`);
writeFileSync(join(shimDir, "npx"), `#!/bin/sh\nexec ${shimArgs} -- "$@"\n`, { mode: 0o755 });

// Fail closed. The gateway's PATH holds the wrapper and the system directory,
// nothing else, so the real npx can't be found even if the wrapper is
// skipped. Node is started by absolute path. Both spellings of the key are set:
// on Windows a leftover "Path" beside "PATH" can win.
const sysDir = process.platform === "win32" ? join(process.env.SYSTEMROOT || "C:\\Windows", "System32") : "/usr/bin:/bin";
const gatewayPath = shimDir + delimiter + sysDir;
const found = spawnSync(process.platform === "win32" ? "where" : "which", ["-a", "npx"].slice(process.platform === "win32" ? 1 : 0),
  { env: { PATH: gatewayPath, SYSTEMROOT: process.env.SYSTEMROOT, PATHEXT: process.env.PATHEXT }, encoding: "utf8" });
const npxSeen = String(found.stdout || "").split(/\r?\n/).filter(Boolean);
if (npxSeen.length === 0 || npxSeen.some((p) => !resolve(p).toLowerCase().startsWith(shimDir.toLowerCase()))) {
  console.error(`refusing to run: on the gateway's PATH, npx resolves to ${JSON.stringify(npxSeen)}, not only the replay wrapper`);
  process.exit(1);
}

const replayed = (n) =>
  Object.fromEntries(slugs.slice(0, n).map((s) => [s, { command: "node", args: [join(__dirname, "replay-tools-server.mjs"), fixture, s] }]));
const configs = [
  { name: "3 servers", servers: replayed(3) },
  { name: "9 servers", servers: replayed(9) },
  { name: "10 servers", servers: replayed(10) },
  { name: "gateway", servers: { gateway: { command: process.execPath, args: [GATEWAY_ENTRY],
      env: { PATH: gatewayPath, Path: gatewayPath } } } },
];
const modes = [
  { name: "tool search on", env: {} },
  { name: "tool search off", env: { ENABLE_TOOL_SEARCH: "false" } },
];
// CC_ONLY="gateway" (comma-separated config names) runs a subset, to repeat
// the rows whose path varies without paying for the ones that don't.
const only = (process.env.CC_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
if (only.length) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.name)));

// One PATH key only (process.env answers to both spellings on Windows).
const KEEP = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramData"];
const baseEnv = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

function run(config, mode) {
  const cfgPath = join(work, `${config.name.replace(/\W+/g, "-")}.json`);
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: config.servers }));
  const allowed = Object.keys(config.servers).map((s) => `mcp__${s}`);
  const started = new Date().toISOString();
  const r = spawnSync(
    CLAUDE,
    ["-p", PROMPT, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
     "--mcp-config", cfgPath, "--model", MODEL, "--no-session-persistence", "--max-turns", "15",
     "--allowedTools", ...allowed],
    { cwd, env: { ...baseEnv, ...mode.env }, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
  );
  const events = String(r.stdout || "").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error(`${config.name} / ${mode.name}: no result. ${(r.stderr || "").slice(0, 300)}`);

  // One request can arrive as several events, one per content block, each
  // repeating the request's usage. Count each message id once.
  const requests = new Map();
  const steps = [];
  for (const e of events) {
    if (e.type !== "assistant" || !e.message) continue;
    requests.set(e.message.id, e.message.usage);
    for (const b of e.message.content ?? []) {
      if (b.type === "tool_use") {
        const arg = b.input?.slug ?? b.input?.query ?? b.input?.name ?? "";
        steps.push(arg ? `${b.name}(${String(arg).slice(0, 60)})` : b.name);
      }
    }
  }
  const perRequest = [...requests.values()].map((u) => ({
    prompt: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  }));
  return {
    config: config.name,
    mode: mode.name,
    started,
    model: Object.keys(result.modelUsage ?? {}).join(","),
    succeeded: !result.is_error && String(result.result ?? "").includes(EXPECT),
    requests: perRequest.length,
    promptTokens: perRequest.reduce((a, x) => a + x.prompt, 0),
    cacheReadTokens: perRequest.reduce((a, x) => a + x.cacheRead, 0),
    outputTokens: perRequest.reduce((a, x) => a + x.output, 0),
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    steps,
    denials: (result.permission_denials ?? []).map((d) => d.tool_name),
    perRequest,
    finalText: String(result.result ?? "").slice(0, 300),
  };
}

const rows = [];
for (const mode of modes) {
  for (const config of configs) {
    for (let i = 0; i < REPS; i++) {
      const row = run(config, mode);
      rows.push(row);
      console.error(
        `${mode.name.padEnd(16)} ${config.name.padEnd(11)} ${row.succeeded ? "ok  " : "FAIL"} ` +
          `requests ${row.requests}  prompt ${String(row.promptTokens).padStart(7)}  output ${String(row.outputTokens).padStart(5)}` +
          `  $${row.costUsd.toFixed(4)}  ${row.steps.join(" > ")}` + (row.denials.length ? `  DENIED ${row.denials.join(",")}` : ""),
      );
    }
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
console.log("\n| config | mode | ok | requests | prompt tokens | output | cost (USD) |\n|---|---|--:|--:|--:|--:|--:|");
for (const mode of modes) for (const config of configs) {
  const rs = rows.filter((x) => x.config === config.name && x.mode === mode.name);
  console.log(`| ${config.name} | ${mode.name} | ${rs.filter((x) => x.succeeded).length}/${rs.length} | ${median(rs.map((x) => x.requests))} | ` +
    `${median(rs.map((x) => x.promptTokens))} | ${median(rs.map((x) => x.outputTokens))} | ${median(rs.map((x) => x.costUsd)).toFixed(4)} |`);
}

const out = outArg ? resolve(outArg) : join(work, "results.json");
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), claude: CLAUDE, model: MODEL, prompt: PROMPT,
  gatewayEntry: GATEWAY_ENTRY, fixture, npxLog: readFileSync(shimLog, "utf8").split("\n").filter(Boolean), rows }, null, 2) + "\n");
console.error(`\nwrote ${out}`);
