#!/usr/bin/env node
/**
 * Over a session of several turns, when does the gateway pay for itself?
 *
 *   CLAUDE_BIN=<claude> CC_GATEWAY_ENTRY=<gateway dist/index.js> \
 *     node demo/claude-code-session.mjs <fixture.json> <packages.json> [out.json]
 *
 * claude-code-whole-bill.mjs prices one task. But configured servers cost
 * something on every request, while the gateway's extra requests (search,
 * connect) are paid once. This runs one Claude Code process per session and
 * feeds it CC_TURNS user messages through stdin (--input-format stream-json),
 * so the gateway stays connected from turn to turn as it would in a real
 * session. Separate `claude -p --resume` calls would restart it every turn.
 *
 * Turn 1 is the whole-bill task: list a folder with the filesystem server's
 * list_directory. Each later turn lists a folder again with the same tool,
 * alternating between two folders that hold exactly what the replay returns.
 *
 * Configurations: the first 3, 9 and 10 servers of the fixture, replayed by
 * replay-tools-server.mjs, and the gateway alone, whose `npx` is
 * replay-npx.mjs. Tool search on (the default) and off.
 * CC_ONLY="10 servers,gateway" and CC_MODES="on" run a subset.
 *
 * Reports cumulative prompt tokens (input + cache-creation + cache-read)
 * after each turn, and the turn from which the gateway's session costs no
 * more than each static configuration's. Cost is Claude Code's own figure;
 * it depends on how warm the prompt cache is, so tokens are the measure.
 *
 * The gateway's searches reach MCP Rating like any user's: note when you ran it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [fixtureArg, packagesArg, outArg] = process.argv.slice(2);
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.CC_MODEL || "sonnet";
const TURNS = Number(process.env.CC_TURNS || 8);
const REPS = Number(process.env.CC_REPS || 1);
const GATEWAY_REPS = Number(process.env.CC_GATEWAY_REPS || 2);
const GATEWAY_ENTRY = resolve(process.env.CC_GATEWAY_ENTRY || join(__dirname, "..", "dist", "index.js"));
if (!fixtureArg || !packagesArg || !existsSync(GATEWAY_ENTRY)) {
  console.error("usage: CLAUDE_BIN=<claude> CC_GATEWAY_ENTRY=<gateway dist/index.js> node demo/claude-code-session.mjs <fixture.json> <packages.json> [out.json]");
  process.exit(2);
}
const fixture = resolve(fixtureArg);
const packages = resolve(packagesArg);
const slugs = JSON.parse(readFileSync(fixture, "utf8")).servers.map((s) => s.slug);
const EXPECT = "[FILE] notes.txt";

// Two folders, each holding exactly what the replay answers.
const work = join(tmpdir(), `cc-session-${process.pid}`);
const cwd = join(work, "empty");
const listing = join(work, "listing");
mkdirSync(cwd, { recursive: true });
for (const d of [listing, join(listing, "archive")]) {
  mkdirSync(join(d, "archive"), { recursive: true });
  writeFileSync(join(d, "notes.txt"), "");
}
const fwd = (p) => p.replace(/\\/g, "/");
const turnPrompt = (i) => i === 0
  ? `Use the list_directory tool from the filesystem MCP server to list the directory ${fwd(listing)}, then reply with exactly the text the tool returned. If that server isn't connected yet, you have my approval to find and connect it yourself.`
  : `Use the same list_directory tool again to list ${fwd(i % 2 ? join(listing, "archive") : listing)}, then reply with exactly the text the tool returned.`;

// The gateway's `npx`: a wrapper that hands everything to replay-npx.mjs.
const shimDir = join(work, "shim");
const shimLog = join(work, "npx.log");
mkdirSync(shimDir, { recursive: true });
writeFileSync(shimLog, "");
const shimArgs = [process.execPath, join(__dirname, "replay-npx.mjs"), fixture, packages, shimLog].map((p) => `"${p}"`).join(" ");
writeFileSync(join(shimDir, "npx.cmd"), `@${shimArgs} -- %*\r\n`);
writeFileSync(join(shimDir, "npx"), `#!/bin/sh\nexec ${shimArgs} -- "$@"\n`, { mode: 0o755 });

// Fail closed, as in claude-code-whole-bill.mjs: the gateway's PATH holds the
// wrapper and the system directory only, checked before anything runs.
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
  Object.fromEntries(slugs.slice(0, n).map((s) => [s, { command: process.execPath, args: [join(__dirname, "replay-tools-server.mjs"), fixture, s] }]));
const configs = [
  { name: "3 servers", servers: replayed(3) },
  { name: "9 servers", servers: replayed(9) },
  { name: "10 servers", servers: replayed(10) },
  { name: "gateway", servers: { gateway: { command: process.execPath, args: [GATEWAY_ENTRY], env: { PATH: gatewayPath, Path: gatewayPath } } } },
];
const modes = [
  { name: "tool search on", key: "on", env: {} },
  { name: "tool search off", key: "off", env: { ENABLE_TOOL_SEARCH: "false" } },
];
const only = (process.env.CC_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
if (only.length) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.name)));
const onlyModes = (process.env.CC_MODES || "").split(",").map((s) => s.trim()).filter(Boolean);
if (onlyModes.length) modes.splice(0, modes.length, ...modes.filter((m) => onlyModes.includes(m.key)));

// One PATH key only (process.env answers to both spellings on Windows).
const KEEP = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramData"];
const baseEnv = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

function session(config, mode) {
  const cfgPath = join(work, `${config.name.replace(/\W+/g, "-")}.json`);
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: config.servers }));
  const allowed = Object.keys(config.servers).map((s) => `mcp__${s}`);
  const started = new Date().toISOString();
  const child = spawn(CLAUDE,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
     "--mcp-config", cfgPath, "--model", MODEL, "--no-session-persistence", "--max-turns", "15",
     "--allowedTools", ...allowed],
    { cwd, env: { ...baseEnv, ...mode.env }, stdio: ["pipe", "pipe", "pipe"] });

  return new Promise((done, fail) => {
    const turns = [];
    let cur = null, buf = "", stderr = "";
    const seen = new Set();
    const timer = setTimeout(() => { child.kill(); fail(new Error(`${config.name} / ${mode.name}: timed out after ${turns.length} turns`)); }, 20 * 60000);
    const send = (i) => {
      cur = { turn: i + 1, requests: [], steps: [], at: new Date().toISOString() };
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: turnPrompt(i) } }) + "\n");
    };
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        // One request can arrive as several events, one per content block,
        // each repeating the request's usage. Count each message id once.
        if (e.type === "assistant" && e.message && cur) {
          if (!seen.has(e.message.id)) {
            seen.add(e.message.id);
            const u = e.message.usage;
            cur.requests.push({ prompt: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens });
          }
          for (const b of e.message.content ?? []) {
            if (b.type === "tool_use") {
              const arg = b.input?.slug ?? b.input?.query ?? b.input?.name ?? b.input?.path ?? "";
              cur.steps.push(arg ? `${b.name}(${String(arg).slice(-40)})` : b.name);
            }
          }
        }
        if (e.type === "result" && cur) {
          cur.succeeded = !e.is_error && String(e.result ?? "").includes(EXPECT);
          cur.resultCostUsd = e.total_cost_usd;
          cur.finalText = String(e.result ?? "").slice(0, 200);
          turns.push(cur);
          console.error(`  ${mode.name} ${config.name} turn ${cur.turn}: ${cur.succeeded ? "ok  " : "FAIL"} requests ${cur.requests.length} `
            + `prompt ${cur.requests.reduce((a, r) => a + r.prompt, 0)}  ${cur.steps.join(" > ")}`);
          cur = null;
          if (turns.length < TURNS) send(turns.length); else child.stdin.end();
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (turns.length < TURNS) return fail(new Error(`${config.name} / ${mode.name}: exited (${code}) after ${turns.length} turns. ${stderr.slice(0, 300)}`));
      // Claude Code's total_cost_usd may be per turn or running; take it as
      // running only if it never goes down.
      const costs = turns.map((t) => t.resultCostUsd ?? 0);
      const running = costs.every((c, i) => i === 0 || c >= costs[i - 1]);
      let cum = 0;
      for (const t of turns) {
        cum += t.requests.reduce((a, r) => a + r.prompt, 0);
        t.cumulativePrompt = cum;
      }
      done({ config: config.name, mode: mode.name, started, turns,
        requests: turns.reduce((a, t) => a + t.requests.length, 0),
        promptTokens: cum,
        outputTokens: turns.reduce((a, t) => a + t.requests.reduce((b, r) => b + r.output, 0), 0),
        costUsd: running ? costs.at(-1) : costs.reduce((a, b) => a + b, 0),
        allSucceeded: turns.every((t) => t.succeeded) });
    });
    send(0);
  });
}

const rows = [];
for (const mode of modes) {
  for (const config of configs) {
    const reps = config.name === "gateway" ? GATEWAY_REPS : REPS;
    for (let i = 0; i < reps; i++) {
      console.error(`${mode.name} / ${config.name} (${i + 1}/${reps})`);
      rows.push(await session(config, mode));
    }
  }
}

// With an even count, the mean of the middle two: taking the lower one would
// flatter whichever configuration was run twice.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const k = (n) => (n / 1000).toFixed(0) + "k";
for (const mode of modes) {
  const rs = rows.filter((r) => r.mode === mode.name);
  console.log(`\n${mode.name}: cumulative prompt tokens after each turn (median of runs)`);
  console.log(`| config | ok | ${Array.from({ length: TURNS }, (_, i) => `turn ${i + 1}`).join(" | ")} | requests | cost (USD) |`);
  console.log(`|---|--:|${"--:|".repeat(TURNS)}--:|--:|`);
  const curves = {};
  for (const config of configs) {
    const runs = rs.filter((r) => r.config === config.name);
    if (!runs.length) continue;
    curves[config.name] = Array.from({ length: TURNS }, (_, i) => median(runs.map((r) => r.turns[i].cumulativePrompt)));
    console.log(`| ${config.name} | ${runs.filter((r) => r.allSucceeded).length}/${runs.length} | ${curves[config.name].map(k).join(" | ")} | `
      + `${median(runs.map((r) => r.requests))} | ${median(runs.map((r) => r.costUsd)).toFixed(3)} |`);
  }
  const gw = curves.gateway;
  if (gw) for (const [name, c] of Object.entries(curves)) {
    if (name === "gateway") continue;
    const t = c.findIndex((v, i) => gw[i] <= v);
    console.log(`gateway vs ${name}: ${t < 0 ? `no break-even within ${TURNS} turns` : `no more than static from turn ${t + 1}`}`);
  }
}

const out = outArg ? resolve(outArg) : join(work, "results.json");
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), claude: CLAUDE, model: MODEL, turns: TURNS,
  prompts: Array.from({ length: TURNS }, (_, i) => turnPrompt(i)), gatewayEntry: GATEWAY_ENTRY, fixture,
  npxLog: readFileSync(shimLog, "utf8").split("\n").filter(Boolean), rows }, null, 2) + "\n");
console.error(`\nwrote ${out}`);
