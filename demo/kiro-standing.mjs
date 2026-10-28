#!/usr/bin/env node
/**
 * What does each configured MCP server add to a Kiro chat request?
 *
 *   node demo/kiro-standing.mjs <fixture.json> <gateway dist/index.js> [out.json]
 *
 * Kiro has no headless mode, so a person sends the messages. This does the
 * rest: it writes ~/.kiro/settings/mcp.json for one configuration, waits until
 * Kiro has connected every server in it (mcp.log), says READY, then waits for
 * the next chat request in kiro.log and records its size. Kiro logs every
 * request as "Request payload: N chars, M history messages". Then it moves to
 * the next configuration. At the end it puts mcp.json back as it was.
 *
 * Send the same message each time, in a NEW chat tab so no history rides along:
 *   Reply with the single word OK.
 *
 * Configurations: none, the first 1, 3, 9 and 10 servers of the fixture
 * (replayed by replay-tools-server.mjs), and the gateway alone.
 * KIRO_ONLY="none,9 servers" runs a subset.
 *
 * Kiro reports characters, not tokens: what its client sends to its backend.
 * Compare each row with the fixture's own size to see whether Kiro sends whole
 * tool definitions or only names.
 *
 * A new chat tab sends two requests. The first, with no history, asks a small
 * model for the tab's title. The second is the agent's (conversationId sess_…,
 * 2 history messages in a fresh tab). Only the second is recorded. A message
 * sent in an old tab carries more history and is not recorded; send it again.
 *
 * The gateway's PATH holds no npx at all. It connects nothing here, but if it
 * tried, it could not fetch a package.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [fixtureArg, gatewayArg, outArg] = process.argv.slice(2);
if (!fixtureArg || !gatewayArg || !existsSync(gatewayArg)) {
  console.error("usage: node demo/kiro-standing.mjs <fixture.json> <gateway dist/index.js> [out.json]");
  process.exit(2);
}
const fixture = resolve(fixtureArg);
const fixtureData = JSON.parse(readFileSync(fixture, "utf8"));
const slugs = fixtureData.servers.map((s) => s.slug);
const mcpJson = join(homedir(), ".kiro", "settings", "mcp.json");
const logsRoot = join(homedir(), ".kiro", "logs");
const logDir = join(logsRoot, readdirSync(logsRoot).filter((d) => statSync(join(logsRoot, d)).isDirectory()).sort().at(-1));
const kiroLog = join(logDir, "kiro.log");
const mcpLog = join(logDir, "mcp.log");

const emptyPath = join(tmpdir(), "kiro-standing-nopath");
mkdirSync(emptyPath, { recursive: true });
const sysDir = process.platform === "win32" ? join(process.env.SYSTEMROOT || "C:\\Windows", "System32") : "/usr/bin:/bin";
const gatewayPath = emptyPath + delimiter + sysDir;

const replayed = (n) =>
  Object.fromEntries(slugs.slice(0, n).map((s) => [s, { command: process.execPath, args: [join(__dirname, "replay-tools-server.mjs"), fixture, s] }]));
const configs = [
  { name: "none", servers: {} },
  { name: "1 server", servers: replayed(1) },
  { name: "3 servers", servers: replayed(3) },
  { name: "9 servers", servers: replayed(9) },
  { name: "10 servers", servers: replayed(10) },
  { name: "gateway", servers: { gateway: { command: process.execPath, args: [resolve(gatewayArg)], env: { PATH: gatewayPath, Path: gatewayPath } } } },
];
const only = (process.env.KIRO_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
if (only.length) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.name)));

const size = (f) => (existsSync(f) ? statSync(f).size : 0);
const readFrom = (f, offset) => readFileSync(f).subarray(offset).toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const original = existsSync(mcpJson) ? readFileSync(mcpJson, "utf8") : null;

// Servers Kiro has connected right now, from the whole of mcp.log. When
// mcp.json grows, Kiro keeps the servers it already has and logs only the new
// ones, so a log read from the write onward misses them.
function connectedNow() {
  const live = new Set();
  for (const l of readFrom(mcpLog, 0).split("\n")) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.message === "mcp.listTools.ok") live.add(e.serverName);
    if (e.message === "mcp.closeConnection.ok") live.delete(e.serverName);
  }
  return live;
}

async function waitConnected(names) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const live = connectedNow();
    if (live.size === names.length && names.every((n) => live.has(n))) return true;
    await sleep(1000);
  }
  return false;
}

// Agent requests logged since `since`. Title requests (conversationId without
// sess_) don't match. The HTTP body length, when Kiro logs it, is on a
// create_response line right after the request's own line; not every request
// gets one, so it only attaches to the request just before it.
function agentRequests(since) {
  const reqs = [];
  for (const l of readFrom(kiroLog, since).split("\n")) {
    const m = l.match(/Request payload: (\d+) chars, (\d+) history messages, conversationId=(sess_[\w-]+)/);
    if (m) { reqs.push({ chars: Number(m[1]), history: Number(m[2]), conversationId: m[3], bodyLength: null, closed: false }); continue; }
    const last = reqs.at(-1);
    if (!last || last.closed) continue;
    const b = l.match(/q\.create_response\.request .*?bodyLength\\":(\d+)/);
    if (b) { last.bodyLength = Number(b[1]); last.closed = true; }
  }
  return reqs;
}

// The next agent request from a fresh tab (2 history messages). Requests from
// old tabs are reported and skipped.
async function nextRequest(since) {
  let seen = 0;
  for (;;) {
    const reqs = agentRequests(since);
    for (const [k, req] of reqs.entries()) {
      if (k < seen) continue;
      if (req.history === 2) {
        await sleep(2000); // the body-length line follows within milliseconds
        const { closed, ...done } = agentRequests(since)[k];
        return done;
      }
      console.log(`  skipped: that request carried ${req.history} history messages, so the tab wasn't new. Open a new chat tab and send again.`);
      seen = k + 1;
    }
    await sleep(1000);
  }
}

const rows = [];
try {
  for (const [i, config] of configs.entries()) {
    writeFileSync(mcpJson, JSON.stringify({ mcpServers: config.servers }, null, 2) + "\n");
    const names = Object.keys(config.servers);
    const connected = await waitConnected(names);
    console.log(`READY ${i + 1}/${configs.length}: ${config.name}${connected ? "" : " (Kiro's connected servers don't match — check the MCP panel)"}`
      + ` — open a new chat tab and send: Reply with the single word OK.`);
    const req = await nextRequest(size(kiroLog));
    rows.push({ config: config.name, servers: names.length, connected, ...req, at: new Date().toISOString() });
    console.log(`  recorded ${config.name}: ${req.chars} chars (body ${req.bodyLength}), ${req.history} history messages`);
    await sleep(8000); // let the turn finish before the config changes under it
  }
} finally {
  if (original !== null) writeFileSync(mcpJson, original);
  console.log("mcp.json restored");
}

const base = rows.find((r) => r.config === "none")?.chars;
const defChars = (n) => JSON.stringify(fixtureData.servers.slice(0, n).flatMap((s) => s.tools)).length;
const nameChars = (n) => fixtureData.servers.slice(0, n).flatMap((s) => s.tools.map((t) => s.slug.length + 2 + t.name.length)).reduce((a, b) => a + b, 0);
console.log("\n| config | request chars | added | tool definitions (chars) | server::tool ids (chars) |\n|---|--:|--:|--:|--:|");
for (const r of rows) {
  const n = { "1 server": 1, "3 servers": 3, "9 servers": 9, "10 servers": 10 }[r.config];
  const added = r.config === "none" || base === undefined ? "—" : "+" + (r.chars - base);
  console.log(`| ${r.config} | ${r.chars} | ${added} | ${n ? defChars(n) : "—"} | ${n ? nameChars(n) : "—"} |`);
}
const out = outArg ? resolve(outArg) : join(tmpdir(), "kiro-standing.json");
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), logDir, fixture, rows }, null, 2) + "\n");
console.log(`wrote ${out}`);
