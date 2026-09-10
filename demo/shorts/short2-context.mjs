#!/usr/bin/env node
/**
 * Short 2 — "where did your context window go?"
 *
 * Measures what MCP servers actually cost you in standing context, from real
 * tool schemas served by the public MCP-Rating API.
 *
 *   node demo/shorts/short2-context.mjs             record from the snapshot
 *   node demo/shorts/short2-context.mjs --refresh   re-measure, rewrite snapshot
 *
 * WHY A SNAPSHOT: measuring the full corpus is one API call per server and takes
 * roughly a minute — fine for a script, useless in front of a camera. The
 * snapshot makes takes instant and identical. It also carries the date it was
 * measured, and that date is printed on screen: a figure that has gone stale
 * shows up as stale rather than quietly becoming a lie. (This project has
 * already shipped one hardcoded number that went stale within a day.)
 *
 * METHOD: for each server we sum `{name, description, inputSchema}` per tool —
 * exactly what a client receives from tools/list and hands to the model — and
 * size it as chars/4. Same estimator as the README and the blog. It is an
 * estimate, not a tokenizer, and the video says so.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beat, fmt, heading, ledger, rule, wrap } from "./_frame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(__dirname, "context-cost.json");
const API = "https://mcprating.io/api/v1";
// Most-downloaded N; only servers we have verified carry stored schemas.
// NB: the param is `sortBy`, not `sort` — the API silently ignores unknown
// query params, so `sort=downloads` returned the default order with no error
// and quietly produced a corpus that was not download-ranked at all.
const SCAN_DEPTH = 300;

/** Sum the wire cost of a server's tool list. */
const wireTokens = (tools) =>
  Math.round(
    JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ).length / 4,
  );

/**
 * Stay under the registry's published rate limit.
 *
 * A refresh is ~300 sequential detail requests. The API allows 100 requests per
 * minute per IP, so anything faster than 600ms per call gets shed partway
 * through — which silently truncates the corpus and moves the median. 700ms
 * gives ~85/min and leaves headroom for the page fetches. A full refresh takes
 * about four minutes; it is meant to be run rarely, not before every take.
 */
const POLITE_MS = 700;
const politely = async (url) => {
  await new Promise((r) => setTimeout(r, POLITE_MS));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

async function refresh() {
  console.log(`Measuring the ${SCAN_DEPTH} most-downloaded servers…`);
  const listed = [];
  for (let offset = 0; offset < SCAN_DEPTH; offset += 100) {
    const page = await politely(`${API}/servers?limit=100&offset=${offset}&sortBy=downloads`);
    listed.push(...page.data);
  }

  const servers = [];
  const failed = [];
  for (const s of listed) {
    // Retry once, then record the miss. Swallowing fetch errors silently would
    // shrink the corpus on a flaky connection and move the median with no
    // signal at all — observed: two runs an hour apart differing by four
    // servers. A number that feeds a published video has to be reproducible.
    let srv = null;
    for (let attempt = 0; attempt < 2 && !srv; attempt++) {
      try {
        const full = await politely(`${API}/servers/${s.slug}`);
        srv = full?.data || full;
      } catch {
        if (attempt === 1) failed.push(s.slug);
      }
    }
    // Only servers we have actually connected to have stored schemas. The rest
    // are unmeasurable, not free — an important distinction the video keeps.
    if (!Array.isArray(srv?.tools) || srv.tools.length === 0) continue;
    servers.push({ slug: srv.slug, tools: srv.tools.length, tokens: wireTokens(srv.tools) });
    process.stdout.write(`\r  measured ${servers.length}…`);
  }

  if (failed.length) {
    console.error(`\nRefusing to write: ${failed.length} server(s) unreachable — ${failed.slice(0, 5).join(", ")}`);
    console.error("The corpus would be incomplete and the median wrong. Re-run when the network is stable.");
    process.exit(1);
  }

  servers.sort((a, b) => a.tokens - b.tokens);
  const snap = { measuredAt: new Date().toISOString().slice(0, 10), scanned: listed.length, servers };
  writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + "\n");
  console.log(`\nWrote ${SNAPSHOT} — ${servers.length} servers with schemas.`);
  return snap;
}

/** The gateway's own cost, measured live — it is local, so it is always current. */
async function measureGateway() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(__dirname, "..", "..", "dist", "index.js")],
    env: { ...process.env, MCP_GATEWAY_LOG_LEVEL: "error" },
  });
  const client = new Client({ name: "measure", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return { count: tools.length, tokens: wireTokens(tools) };
}

// ─────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--refresh")) {
  await refresh();
  process.exit(0);
}

let snap;
try {
  snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
} catch {
  console.error("No snapshot yet. Run:  node demo/shorts/short2-context.mjs --refresh");
  process.exit(1);
}

const { servers } = snap;
const median = servers[Math.floor(servers.length / 2)];
const heaviest = servers.at(-1);
const cheapest = servers[0];
const gw = await measureGateway();

const TEN = median.tokens * 10;
const CLAUDE_CONTEXT = 200_000;

console.log(`\n${rule("━")}`);
console.log("  WHERE DID YOUR CONTEXT GO?");
console.log(rule("━"));
console.log(wrap("Every MCP server you configure injects its whole tool schema — every turn, used or not."));
await beat(1.4);

heading(`Cost per server (${servers.length} measured)`);
console.log(ledger("cheapest", `${fmt(cheapest.tokens)} tok`));
await beat(0.5);
console.log(ledger("median", `${fmt(median.tokens)} tok`));
await beat(0.5);
console.log(ledger("heaviest", `${fmt(heaviest.tokens)} tok`));
await beat(1.5);

heading("Configure 10 typical servers");
console.log(ledger("standing cost", `${fmt(TEN)} tok`));
await beat(0.8);
console.log(ledger("through the gateway", `${fmt(gw.tokens)} tok`));
await beat(1.2);
console.log(`\n  ${Math.round(TEN / gw.tokens)}× less. Every single turn.`);
await beat(1.8);

heading("And the heaviest one?");
console.log(wrap(`${heaviest.slug} exposes ${heaviest.tools} tools.`));
console.log(ledger("its tool list", `${fmt(heaviest.tokens)} tok`));
console.log(ledger("Claude's whole window", `${fmt(CLAUDE_CONTEXT)} tok`));
await beat(1.4);
// Derived, never hardcoded. Which server tops the corpus changes between
// refreshes, and a fixed closing line ("cannot fit in the context window")
// silently became false the first time the ranking shifted to a lighter one.
const share = Math.round((heaviest.tokens / CLAUDE_CONTEXT) * 100);
console.log(
  heaviest.tokens > CLAUDE_CONTEXT
    ? wrap("One server that cannot fit in the context window it is asking to join.")
    : wrap(`${share}% of the whole window — spent before you type a single word.`),
);
await beat(1.8);

console.log(`\n${rule("━")}`);
console.log(wrap(`Measured ${snap.measuredAt} from public schemas.`));
console.log(wrap("Sized as chars/4 — an estimate, not a tokenizer."));
console.log("  github.com/mcprating/mcp-gateway");
console.log(`${rule("━")}\n`);
process.exit(0);
