#!/usr/bin/env node
/**
 * Short 0 — the problem all three other Shorts answer.
 *
 *   node demo/shorts/short0-problem.mjs
 *
 * Posted first, it gives the series a cold open: what adding an MCP server to
 * your client actually costs you, before anyone mentions a fix. The other three
 * each take one of these three lines and go deeper.
 *
 * The environment count is read live from whoever runs it, so the number on
 * screen is that machine's real exposure rather than a figure we chose. The
 * context cost comes from the committed corpus snapshot, and the connect rate
 * from the published verification pass — both dated, neither invented here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beat, fmt, heading, ledger, rule, wrap } from "./_frame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Live, from this machine. The point of the number is that it is yours.
const envCount = Object.keys(process.env).length;

// Median real server schema, from the committed 91-server measurement.
let median = 2587;
let measuredAt = "";
try {
  const snap = JSON.parse(readFileSync(join(__dirname, "context-cost.json"), "utf8"));
  const t = snap.servers.map((s) => s.tokens).sort((a, b) => a - b);
  median = t[Math.floor(t.length / 2)];
  measuredAt = snap.measuredAt;
} catch {
  /* fall back to the published figure */
}

// From the verification pass published at mcprating.io/blog.
const ATTEMPTED = 182;
const ANSWERED = 65;

console.log(`\n${rule("━")}`);
console.log("  YOU ADD AN MCP SERVER");
console.log("  Everyone is doing this right now.");
console.log(rule("━"));
await beat(1.3);

heading("What it can reach");
console.log(ledger("variables in your shell", fmt(envCount)));
console.log(wrap("Including every API key in there.", "     "));
await beat(1.6);

heading("What it costs you");
console.log(ledger("tokens, every turn", fmt(median)));
console.log(wrap("Whether you use the server or not.", "     "));
await beat(1.6);

heading("Whether it even works");
console.log(ledger("servers we tried to start", fmt(ATTEMPTED)));
console.log(ledger("that answered", fmt(ANSWERED)));
await beat(1.6);

console.log(`\n${rule("━")}`);
console.log("  One in three starts.");
console.log("  All of them can read your keys.");
console.log(rule("━"));
console.log("  mcprating.io");
console.log();
process.exit(0);
