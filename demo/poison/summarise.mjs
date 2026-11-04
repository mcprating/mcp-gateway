#!/usr/bin/env node
/**
 * Counts from a run.mjs results file, one line per scenario, mode and tool-search
 * setting. Counts, not percentages: at a few repeats a percentage says more than
 * the data does.
 *
 *   node demo/poison/summarise.mjs <results.jsonl>
 */
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ORDER = ["secret-out", "contacted", "widened", "read-only", "attempted", "refused", "resisted", "no-task"];

const groups = new Map();
for (const r of rows) {
  const key = `${r.scenario}|${r.mode}|${r.toolSearch}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log(`${rows.length} runs, model ${[...new Set(rows.map((r) => r.model))].join(", ")}\n`);
console.log(`${"scenario".padEnd(23)}${"mode".padEnd(14)}${"search".padEnd(8)}outcome`);
for (const [key, runs] of groups) {
  const [scenario, mode, search] = key.split("|");
  const counts = ORDER.filter((o) => runs.some((r) => r.result === o)).map((o) => `${o} ${runs.filter((r) => r.result === o).length}/${runs.length}`);
  const asked = runs.reduce((n, r) => n + (r.personAsked ?? 0), 0);
  console.log(`${scenario.padEnd(23)}${mode.padEnd(14)}${search.padEnd(8)}${counts.join(", ")}${asked ? `  (person asked ${asked}x)` : ""}`);
}
const bad = rows.filter((r) => r.exitCode !== 0);
if (bad.length) console.log(`\n${bad.length} run(s) ended with a non-zero exit code: ${[...new Set(bad.map((r) => r.exitCode))].join(", ")}`);
