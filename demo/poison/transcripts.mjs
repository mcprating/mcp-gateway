#!/usr/bin/env node
/**
 * Turns a run.mjs results folder into transcripts fit to publish: one text file
 * per scenario, every run in it, plus the results and a summary.
 *
 *   node demo/poison/transcripts.mjs <results folder> <out folder>
 *
 * What a transcript keeps: the task, what the model said, every tool call with
 * its arguments, every result, each question the gateway put to the person, the
 * final answer, the verdict. What it drops: everything else a client logs about
 * the machine it ran on. Claude Code's first event lists the working directory,
 * session, API key source and the user's plugins, skills and commands, none of
 * which a reader needs.
 *
 * Paths under your home directory, the run's temporary folder, your user name
 * and private network addresses are replaced, and the script refuses to write a
 * file that still holds one.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { SCENARIOS, TASK } from "./scenarios.mjs";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("usage: transcripts.mjs <results folder> <out folder>");

const user = userInfo().username;
const SEP = "[\\\\/]+";
const RUN_DIR = new RegExp(`[A-Za-z]:${SEP}Users${SEP}[^\\\\/\\s"'\`]+${SEP}AppData${SEP}Local${SEP}Temp${SEP}poison-[A-Za-z0-9]+`, "gi");
const WIN_HOME = new RegExp(`[A-Za-z]:${SEP}Users${SEP}[^\\\\/\\s"'\`]+`, "gi");
const PRIVATE_HOST = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\b/g;

function redact(text) {
  return String(text)
    .replace(RUN_DIR, "<run dir>")
    .replace(/(?:\/tmp|\/private\/var\/folders\/[^\s"']+|\/var\/folders\/[^\s"']+)\/poison-[A-Za-z0-9]+/g, "<run dir>")
    .replace(WIN_HOME, "<home>")
    .replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "<home>")
    .replaceAll(homedir(), "<home>")
    .replace(PRIVATE_HOST, "<model host>")
    .replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "<user>");
}

function assertClean(file, text) {
  const left = [[homedir(), "home directory"], [user, "user name"]].filter(([s]) => s && text.toLowerCase().includes(s.toLowerCase()));
  PRIVATE_HOST.lastIndex = 0;
  if (PRIVATE_HOST.test(text)) left.push(["", "private address"]);
  if (left.length) throw new Error(`${file} still holds: ${left.map(([, what]) => what).join(", ")}`);
}

const MAX_RESULT = 2_000;
const cut = (text) => (text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)} … (${text.length - MAX_RESULT} more characters)` : text);
const json = (value) => JSON.stringify(value ?? {});

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return json(content);
  return content.map((block) => (block.type === "text" ? block.text : block.type === "tool_reference" ? `[tool loaded: ${block.tool_name}]` : json(block))).join("\n");
}

/** Claude Code's stream-json, as run.mjs saves it. */
function claudeLines(stream) {
  const lines = [];
  for (const raw of stream.split("\n")) {
    if (!raw.trim()) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") lines.push(`client: Claude Code ${event.claude_code_version}, model ${event.model}`);
    else if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text.trim()) lines.push(`model said: ${block.text.trim()}`);
        if (block.type === "thinking" && block.thinking?.trim()) lines.push(`model thought: ${block.thinking.trim()}`);
        if (block.type === "tool_use") lines.push(`call: ${block.name} ${json(block.input)}`);
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result") lines.push(`result${block.is_error ? " (error)" : ""}: ${cut(resultText(block.content))}`);
      }
    } else if (event.type === "control_request" && event.request?.subtype === "elicitation") {
      lines.push(`gateway asked the person: ${event.request.message}`);
    } else if (event.type === "result") {
      lines.push(`final answer (${event.num_turns} turns): ${String(event.result ?? "").trim()}`);
    }
  }
  return lines;
}

/** local-client.mjs's log. It keeps the first 400 characters of each result, and not the questions' text. */
function localLines(stream) {
  const lines = [];
  for (const raw of stream.split("\n")) {
    if (!raw.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.error) lines.push(`error: ${entry.error}`);
    if (entry.text?.trim()) lines.push(`${entry.calls?.length ? "model said" : "final answer"}: ${entry.text.trim()}`);
    for (const call of entry.calls ?? []) lines.push(`call: ${call.name} ${json(call.input)}`);
    if (entry.result !== undefined) lines.push(`result: ${entry.result}`);
  }
  return lines;
}

const rows = readFileSync(join(from, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Before run.mjs named streams by variant and person, a later run with the same
// scenario, mode and repeat overwrote an earlier one's. Only the last such run's
// stream is its own.
const oldName = (r) => `${r.scenario}-${r.mode}-${r.toolSearch}-${r.repeat}`;
const lastWithOldName = new Map(rows.map((r, i) => [oldName(r), i]));

mkdirSync(to, { recursive: true });
const byScenario = new Map();
rows.forEach((r, i) => {
  if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
  byScenario.get(r.scenario).push([r, i]);
});

let missing = 0;
for (const [id, runs] of byScenario) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  const task = (scenario?.task ?? TASK).replaceAll("{beacon}", "<run dir>/beacon.mjs").replaceAll("{canary}", "http://127.0.0.1:<canary port>");
  const out = [`Scenario: ${id}${scenario ? ` (${scenario.surface})` : ""}`, scenario?.note ?? "", `Task given to the model: ${task}`, ""];
  for (const [r, i] of runs) {
    const name = r.stream ?? (lastWithOldName.get(oldName(r)) === i ? oldName(r) : null);
    const file = name ? join(from, "streams", `${name}.jsonl`) : null;
    out.push("=".repeat(72));
    out.push(`mode ${r.mode} · tool search ${r.toolSearch} · repeat ${r.repeat}${r.variant ? ` · variant ${r.variant}` : ""} · person ${r.person}`);
    out.push(`verdict: ${r.result} · task done: ${r.taskDone ? "yes" : "no"} · person asked: ${r.personAsked ?? 0} · ${r.seconds} s · exit ${r.exitCode}`);
    out.push(`client: ${r.client === "local" ? "our local test client" : "Claude Code"} · model ${r.model ?? r.requestedModel}`);
    out.push("-".repeat(72));
    if (file && existsSync(file)) {
      const stream = readFileSync(file, "utf8");
      out.push(...(r.client === "local" ? localLines(stream) : claudeLines(stream)));
    } else {
      missing++;
      out.push("(transcript not kept: a later run with the same scenario, mode and repeat overwrote it. The verdict above is from results.jsonl.)");
    }
    out.push("");
  }
  const text = redact(out.join("\n"));
  assertClean(id, text);
  writeFileSync(join(to, `${id}.txt`), text);
}

const results = redact(readFileSync(join(from, "results.jsonl"), "utf8"));
assertClean("results.jsonl", results);
writeFileSync(join(to, "results.jsonl"), results);
console.log(`${rows.length} runs, ${byScenario.size} scenarios, ${missing} transcript(s) not kept → ${to}`);
