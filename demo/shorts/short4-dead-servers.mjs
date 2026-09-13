#!/usr/bin/env node
/**
 * Short 4 — a capable model, free choice of the registry, and four dead servers.
 *
 *   node demo/shorts/short4-dead-servers.mjs
 *
 * The other Shorts argue for something. This one reports a result that is bad
 * for us: handed our own index of 63,000 servers and asked for a web search
 * server, gemma-4-31B tried four, every one failed, and it only succeeded by
 * abandoning the registry for a package it already knew from training.
 *
 * Publishing that is the point. It is the lived version of the 36% connect rate
 * we measured in September, arriving with no hostile harness to blame.
 *
 * UNLIKE THE OTHERS, THIS REPLAYS A RECORDED RUN. The trajectory came from a
 * model on hardware that is not on this machine, and the registry moves under
 * it, so re-running live would produce a different and unreproducible result.
 * The date is on screen for exactly that reason.
 */
import { beat, fmt, heading, rule, wrap } from "./_frame.mjs";

const RECORDED = "2026-09-13";
const MODEL = "gemma-4-31B";
const INDEX_SIZE = 63168;

// Verbatim from the run. Five runs produced this trajectory identically.
const ATTEMPTS = [
  ["duckduckgo-web-search", "Connection closed"],
  ["brave-search-mcp", "Connection closed"],
  ["pipeworx-brave-search", "No install command"],
  ["mcp-tavily", "Connection closed"],
];

console.log(`\n${rule("━")}`);
console.log("  I GAVE AN AI 63,000 MCP SERVERS");
console.log("  One task: find one that searches");
console.log("  the web, and connect to it.");
console.log(rule("━"));
await beat(1.4);

console.log(wrap(`A ${MODEL} model. Free choice, ranked by quality score.`));
await beat(1.5);

heading("What it tried");
for (const [slug, err] of ATTEMPTS) {
  console.log(`  ${slug}`);
  console.log(`     → ${err}`);
  await beat(0.55);
}
await beat(1.2);

console.log(`\n${rule("─")}`);
console.log("  Four servers. Four failures.");
console.log(rule("─"));
await beat(1.6);

heading("So it stopped using the registry");
console.log(wrap("It connected to a package it already knew from training instead. It was right to."));
await beat(1.8);

console.log(`\n${rule("━")}`);
console.log("  The model did nothing wrong.");
console.log("  It ran out of working servers");
console.log("  before it ran out of ideas.");
console.log(rule("━"));
console.log(`  ${fmt(INDEX_SIZE)} indexed · recorded ${RECORDED}`);
console.log("  mcprating.io");
console.log();
process.exit(0);
