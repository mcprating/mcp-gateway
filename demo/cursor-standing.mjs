#!/usr/bin/env node
/**
 * What does each configured MCP server add to a Cursor chat's prompt?
 *
 *   node demo/cursor-standing.mjs <fixture.json> <gateway dist/index.js> <workspace dir> [out.json]
 *
 * Cursor keeps, for every chat, the token breakdown its context gauge shows:
 * composerData.promptTokenBreakdown in its state database, with categories
 * such as "Tool definitions" and "MCP & dynamic tools". These are Cursor's own
 * estimates ("estimatedTokens"), not billed tokens.
 *
 * A person sends the messages. This does the rest: it writes ~/.cursor/mcp.json
 * for one configuration, waits until Cursor has synced every server's tools
 * into ~/.cursor/projects/<project>/mcps/user-<server>/tools/, says READY,
 * then waits for a NEW chat to get a breakdown and records it. At the end it
 * puts mcp.json back exactly as it was. Open <workspace dir> in Cursor first.
 *
 * Send the same message each time, in a NEW chat:
 *   Reply with the single word OK.
 *
 * Configurations: none, the first 1, 3, 9 and 10 servers of the fixture
 * (replayed by replay-tools-server.mjs), and the gateway alone.
 * CURSOR_ONLY="none,9 servers" runs a subset.
 *
 * mcp.json is the user's own file and may hold keys: it is copied to
 * mcp.json.standing-backup before the first write and never printed. If this
 * script dies before restoring, copy the backup back by hand.
 *
 * The gateway's PATH holds no npx at all. It connects nothing here, but if it
 * tried, it could not fetch a package.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [fixtureArg, gatewayArg, workspaceArg, outArg] = process.argv.slice(2);
if (!fixtureArg || !gatewayArg || !existsSync(gatewayArg) || !workspaceArg || !existsSync(workspaceArg)) {
  console.error("usage: node demo/cursor-standing.mjs <fixture.json> <gateway dist/index.js> <workspace dir> [out.json]");
  process.exit(2);
}
const fixture = resolve(fixtureArg);
const fixtureData = JSON.parse(readFileSync(fixture, "utf8"));
const slugs = fixtureData.servers.map((s) => s.slug);
const mcpJson = join(homedir(), ".cursor", "mcp.json");
const backup = mcpJson + ".standing-backup";
// Cursor syncs tools into ~/.cursor/projects/<folder>/mcps/user-<server>/tools/
// for every open window, and the folder isn't always the workspace you opened:
// on 2026-10-28 Cursor restored earlier windows and wrote to "empty-window" and
// another project instead. So look in all of them. It deletes a server's folder
// when the server leaves mcp.json.
const projectsDir = join(homedir(), ".cursor", "projects");
const stateDb = process.platform === "win32"
  ? join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb")
  : process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");

const emptyPath = join(tmpdir(), "cursor-standing-nopath");
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
const only = (process.env.CURSOR_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
if (only.length) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.name)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolFiles = (name) => Math.max(-1, ...readdirSync(projectsDir).map((p) => {
  const d = join(projectsDir, p, "mcps", `user-${name}`, "tools");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).length : -1;
}));

// Every server's tools synced, and the counts steady for 3 s (a 375-tool
// server takes a moment to write).
async function waitSynced(names) {
  const deadline = Date.now() + 120000;
  let last = "", steady = 0;
  while (Date.now() < deadline) {
    const counts = names.map(toolFiles);
    const key = counts.join(",");
    steady = key === last ? steady + 1 : 0;
    last = key;
    if (counts.every((c) => c > 0) && steady >= 3) return Object.fromEntries(names.map((n, i) => [n, counts[i]]));
    await sleep(1000);
  }
  return Object.fromEntries(names.map((n) => [n, toolFiles(n)]));
}

// All chats, read fresh each time (Cursor writes through a WAL; a new
// read-only connection sees its latest commits).
function chats() {
  let db;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    return db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all().flatMap((r) => {
      try {
        const v = JSON.parse(r.value);
        return [{ id: r.key.slice("composerData:".length), createdAt: v.createdAt ?? 0, breakdown: v.promptTokenBreakdown ?? null,
          used: v.contextTokensUsed ?? null, model: v.modelConfig?.modelName ?? null,
          turns: (v.fullConversationHeadersOnly ?? []).map((h) => h.type) }];
      } catch { return []; }
    });
  } catch {
    return null; // busy or mid-write; try again
  } finally {
    db?.close();
  }
}

// The first chat created after `since` whose breakdown has settled: an
// assistant turn present and the total unchanged for 6 s. A breakdown that
// changes on an older chat means the message went to an old chat.
async function nextChat(since, before) {
  const warned = new Set();
  let last = null, steady = 0;
  for (;;) {
    await sleep(2000);
    const all = chats();
    if (!all) continue;
    for (const c of all) {
      const was = before.get(c.id);
      if (c.createdAt < since && was !== undefined && c.breakdown?.totalUsedTokens !== was && !warned.has(c.id)) {
        warned.add(c.id);
        console.log("  skipped: that message went to an existing chat. Open a new chat and send again.");
      }
    }
    const fresh = all.filter((c) => c.createdAt >= since && c.breakdown?.totalUsedTokens > 0).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!fresh) continue;
    const key = `${fresh.id}:${fresh.breakdown.totalUsedTokens}:${fresh.turns.length}`;
    steady = key === last ? steady + 1 : 0;
    last = key;
    if (fresh.turns.includes(2) && steady >= 3) return fresh;
  }
}

if (existsSync(backup)) {
  console.error(`refusing to run: ${backup} exists, so an earlier run may not have restored mcp.json. Check it and remove the backup first.`);
  process.exit(1);
}
const original = existsSync(mcpJson) ? readFileSync(mcpJson) : null;
if (original !== null) copyFileSync(mcpJson, backup);

const rows = [];
try {
  for (const [i, config] of configs.entries()) {
    writeFileSync(mcpJson, JSON.stringify({ mcpServers: config.servers }, null, 2) + "\n");
    const names = Object.keys(config.servers);
    const synced = names.length ? await waitSynced(names) : (await sleep(5000), {});
    const short = names.filter((n) => synced[n] <= 0);
    const before = new Map((chats() ?? []).map((c) => [c.id, c.breakdown?.totalUsedTokens]));
    const since = Date.now();
    console.log(`READY ${i + 1}/${configs.length}: ${config.name}` + (short.length ? ` (no tools synced yet for ${short.join(", ")} — check Cursor's MCP settings)` : "")
      + ` — open a new chat and send: Reply with the single word OK.`);
    const chat = await nextChat(since, before);
    const cat = Object.fromEntries((chat.breakdown.categories ?? []).map((c) => [c.id, c.estimatedTokens]));
    rows.push({ config: config.name, servers: names.length, syncedTools: synced, chat: chat.id, model: chat.model,
      total: chat.breakdown.totalUsedTokens, categories: cat, at: new Date().toISOString() });
    console.log(`  recorded ${config.name}: total ${chat.breakdown.totalUsedTokens}, MCP & dynamic tools ${cat.mcp ?? "?"}, tool definitions ${cat.tools ?? "?"} (model ${chat.model})`);
    await sleep(5000);
  }
} finally {
  if (original !== null) {
    writeFileSync(mcpJson, original);
    if (readFileSync(mcpJson).equals(original)) unlinkSync(backup);
    console.log("mcp.json restored");
  }
}

const base = rows.find((r) => r.config === "none");
const toolCount = (n) => fixtureData.servers.slice(0, n).reduce((a, s) => a + s.tools.length, 0);
const defChars = (n) => JSON.stringify(fixtureData.servers.slice(0, n).flatMap((s) => s.tools)).length;
console.log("\n| config | tools synced / in fixture | total | MCP & dynamic tools | added (MCP) | added (total) | tool definitions (chars) |\n|---|--:|--:|--:|--:|--:|--:|");
for (const r of rows) {
  const n = { "1 server": 1, "3 servers": 3, "9 servers": 9, "10 servers": 10 }[r.config];
  const synced = Object.values(r.syncedTools).reduce((a, b) => a + Math.max(b, 0), 0);
  const add = (x, y) => (base && r !== base ? "+" + (x - y) : "—");
  console.log(`| ${r.config} | ${synced} / ${n ? toolCount(n) : r.config === "gateway" ? "—" : 0} | ${r.total} | ${r.categories.mcp ?? "?"} | `
    + `${add(r.categories.mcp, base?.categories.mcp)} | ${add(r.total, base?.total)} | ${n ? defChars(n) : "—"} |`);
}
const out = outArg ? resolve(outArg) : join(tmpdir(), "cursor-standing.json");
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), workspace: resolve(workspaceArg), fixture, rows }, null, 2) + "\n");
console.log(`wrote ${out}`);
