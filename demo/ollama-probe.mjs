#!/usr/bin/env node
/**
 * Can a local model actually drive the gateway?
 *
 *   node demo/ollama-probe.mjs [model]
 *
 * The gateway's pitch is that it trades context for reasoning: instead of every
 * server's tools sitting in the window, the model has to orchestrate
 * discover -> connect -> call. That trade is obviously good on a 200k frontier
 * model. On an 8B model with an 8k window it is an open question, and the honest
 * way to answer it is to run it rather than to assert it.
 *
 * This is what a bridge like ollmcp does internally — MCP over stdio on one
 * side, Ollama's /api/chat on the other — reduced to something scriptable so
 * the result is a number instead of an anecdote.
 *
 * It also reports Ollama's real prompt_eval_count, which is a genuine tokenizer
 * count rather than the chars/4 estimate used everywhere else in this repo. That
 * makes it a check on the estimate as well as on the model.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] || "gemma4:latest";
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";
const NUM_CTX = Number(process.env.NUM_CTX || 16384);
// Generous by default. At 8 the 31B run was still making sensible progress —
// re-querying with new search terms after each dead server — and got cut off
// mid-strategy, which the verdict then reported as the model failing to finish.
// A ceiling that terminates the run has to be high enough that hitting it is
// evidence about the model rather than about this constant.
const MAX_TURNS = Number(process.env.MAX_TURNS || 20);
const RUNAWAY_LIMIT = Number(process.env.RUNAWAY_LIMIT || 25);

/**
 * Hard ceiling on generated tokens per turn.
 *
 * RUNAWAY_LIMIT bounds what we EXECUTE, which is not the same thing and does not
 * bound the clock at all: with stream:false the server generates the whole reply
 * before returning, so llama3.2's 8,620-call answer cost ~9 hours before the cap
 * could look at it. Capping generation server-side is what actually makes a
 * failed run cheap — a legitimate multi-tool reply is a few hundred tokens, so
 * 2048 truncates only pathology.
 */
const MAX_GEN = Number(process.env.MAX_GEN || 2048);
const API_KEY = process.env.API_KEY || "";

/**
 * Ollama's native API or an OpenAI-compatible one (vLLM, SGLang, llama.cpp
 * --api, LM Studio). Set API=openai, or it is inferred from a /v1 host.
 *
 * The two differ in ways that silently corrupt a run rather than erroring:
 * OpenAI nests the reply under choices[], serialises tool-call arguments as a
 * JSON *string* where Ollama sends an object, and requires tool results to cite
 * tool_call_id. Getting any of those wrong looks like the model failing.
 */
const API =
  process.env.API || (/\/v1\/?$/.test(OLLAMA) ? "openai" : "ollama");

const TASK =
  process.env.TASK ||
  "Find an MCP server that can search the web, then connect to it. " +
    "Use the tools available to you. When you have connected, say DONE and " +
    "name the server you connected to.";

const log = (...a) => console.log(...a);

/**
 * POST to Ollama over node:http rather than fetch.
 *
 * fetch() goes through undici, whose headersTimeout is 300s and is not
 * adjustable without importing undici directly. A local 8B model chewing
 * through 2,600 tokens of tool schema on CPU can take longer than that to
 * produce its first byte, and the run dies with UND_ERR_HEADERS_TIMEOUT — a
 * transport error that looks exactly like the model failing the task. Raw http
 * has no such deadline, so a slow answer stays an answer.
 */
function ollamaPost(path, payload) {
  const url = new URL(path.replace(/^\//, ""), OLLAMA.endsWith("/") ? OLLAMA : OLLAMA + "/");
  const body = JSON.stringify(payload);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
        },
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(`bad JSON from Ollama: ${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(0);
    req.end(body);
  });
}

// ── Bring the gateway up ─────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: [join(__dirname, "..", "dist", "index.js")],
  env: { ...process.env, MCP_GATEWAY_LOG_LEVEL: "error" },
});
const mcp = new Client({ name: "ollama-probe", version: "1.0.0" });
await mcp.connect(transport);
let { tools } = await mcp.listTools();
const baseToolNames = new Set(tools.map((t) => t.name));

/**
 * PRECONNECT=<slug> simulates a statically configured client.
 *
 * The comparison the gateway's pitch actually rests on is not "13 meta-tools vs
 * N server schemas" — it is the whole conversation. Connecting up front puts a
 * server's tools in the window from turn one, exactly as a hand-written
 * mcpServers config would, so the same task can be run both ways and the bills
 * compared. Without this the gateway only ever gets measured against itself.
 */
if (process.env.PRECONNECT) {
  await mcp.callTool({
    name: "mcp_connect",
    arguments: { slug: process.env.PRECONNECT, confirmed: true },
  });
  tools = (await mcp.listTools()).tools;
  log(`preconnected:  ${process.env.PRECONNECT} (simulating a static config)`);
}

/**
 * Re-read the tool list after every turn.
 *
 * The gateway's whole point is that a server's tools appear only once you
 * connect to it — it fires tools/list_changed and the host refreshes. An earlier
 * version of this probe fetched the list once at startup, so the proxied tools
 * never reached the model and the only way to touch a connected server was the
 * mcp_call_tool meta-tool. That is not how a real client behaves, and it made
 * "can a model use a server it just connected to?" untestable by construction.
 */
async function refreshTools() {
  const next = (await mcp.listTools()).tools;
  const added = next.filter((t) => !tools.some((o) => o.name === t.name));
  tools = next;
  return added;
}

/** MCP tool schemas -> the OpenAI-style shape both APIs expect. */
const asOllamaTools = () =>
  tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

const schemaChars = JSON.stringify(
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
).length;

log(`model:        ${MODEL}`);
log(`gateway tools: ${tools.length}`);
log(`schema est:   ${Math.round(schemaChars / 4)} tok (chars/4)`);
log(`api:          ${API} @ ${OLLAMA}`);
log(`task:         ${TASK}\n${"─".repeat(60)}`);

// ── Drive the loop ───────────────────────────────────────────────────────────
const messages = [{ role: "user", content: TASK }];
const calls = [];
let promptTokens = null;
let done = false;
let turn = 0;
let runaway = 0;
const turnCosts = [];

for (; turn < MAX_TURNS && !done; turn++) {
  const started = Date.now();
  const res = await ollamaPost(
    API === "openai" ? "chat/completions" : "api/chat",
    API === "openai"
      ? {
          model: MODEL,
          messages,
          tools: asOllamaTools(),
          stream: false,
          temperature: 0,
          max_tokens: MAX_GEN,
        }
      : {
          model: MODEL,
          messages,
          tools: asOllamaTools(),
          stream: false,
          options: { num_ctx: NUM_CTX, temperature: 0, num_predict: MAX_GEN },
        },
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (res.error) {
    const e = res.error;
    log(`\nAPI ERROR: ${typeof e === "string" ? e : JSON.stringify(e).slice(0, 300)}`);
    break;
  }
  // First turn carries the whole tool schema, so this is the standing cost.
  const pt = res.prompt_eval_count ?? res.usage?.prompt_tokens ?? null;
  const ct = res.eval_count ?? res.usage?.completion_tokens ?? null;
  if (promptTokens === null) promptTokens = pt;
  // Per-turn accounting. Standing overhead is what the schema costs once; the
  // bill is every turn's prompt re-read plus what the model wrote. The gateway
  // trades schema for turns, and only the running total shows whether that is
  // a saving — discovery output in particular stays in the transcript for the
  // rest of the conversation.
  turnCosts.push({ turn: turn + 1, prompt: pt ?? 0, completion: ct ?? 0 });

  const msg = (API === "openai" ? res.choices?.[0]?.message : res.message) || {};
  messages.push(msg);

  let toolCalls = msg.tool_calls || [];

  // Cap what we execute from a single response.
  //
  // llama3.2 returned 8,620 tool calls in ONE message — discover, connect, then
  // `list_active -> call_tool -> disconnect` 2,872 times over with junk
  // arguments, never terminating. Without a cap the harness dutifully executed
  // all of them, which is how a failed run masqueraded as a nine-hour success.
  // A real client would not do this either: ollmcp gates tool calls behind
  // human-in-the-loop, so a person would have stopped it at the first one.
  if (toolCalls.length > RUNAWAY_LIMIT) {
    runaway = toolCalls.length;
    log(`[turn ${turn + 1}] RUNAWAY: model emitted ${runaway} tool calls in one response`);
    toolCalls = toolCalls.slice(0, RUNAWAY_LIMIT);
  }

  if (toolCalls.length === 0) {
    const text = (msg.content || "").trim();
    log(`[turn ${turn + 1}, ${elapsed}s] no tool call. said: ${text.slice(0, 220)}`);
    if (/\bDONE\b/i.test(text)) done = true;
    break;
  }

  for (const tc of toolCalls) {
    const name = tc.function?.name;
    // OpenAI serialises tool-call arguments as a JSON *string*; Ollama sends an
    // object. A raw string reaching callTool fails schema validation, which
    // reads as the model emitting bad arguments when it did nothing wrong.
    let args = tc.function?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args || "{}");
      } catch {
        args = {};
      }
    }
    calls.push(name);
    log(`[turn ${turn + 1}, ${elapsed}s] -> ${name}(${JSON.stringify(args).slice(0, 120)})`);

    let out;
    try {
      // Unknown tool names are the interesting failure: a model that invents a
      // tool has not understood the surface, and that is a result, not a crash.
      const r = await mcp.callTool({ name, arguments: args });
      out = (r.content || []).map((c) => c.text ?? "").join("\n").slice(0, 1500);
    } catch (err) {
      out = `ERROR: ${String(err).split("\n")[0]}`;
    }
    log(`           <- ${out.replace(/\s+/g, " ").slice(0, 180)}`);
    messages.push(
      // OpenAI requires the result to cite the call it answers.
      API === "openai"
        ? { role: "tool", tool_call_id: tc.id, content: out }
        : { role: "tool", content: out },
    );
  }

  // A connect makes that server's tools available; pick them up like a real
  // client would, so the model can actually call them on the next turn.
  const added = await refreshTools();
  if (added.length) {
    log(`           ++ ${added.length} new tool(s) now callable: ${added.slice(0, 4).map((t) => t.name).join(", ")}`);
  }

  if (runaway) break;
}

// ── Verdict ──────────────────────────────────────────────────────────────────
/**
 * Ground truth, not string-matching and not call history.
 *
 * Two earlier versions of this verdict were wrong in different ways: the first
 * counted reaching mcp_connect as success while the model was in an 8,620-call
 * loop, the second reported "connected: yes" for a run whose connect returned
 * "MCP error -32000: Connection closed". Asking the gateway what it is actually
 * connected to is the only reading that cannot drift from reality.
 */
let liveConnections = [];
try {
  const r = await mcp.callTool({ name: "mcp_list_active", arguments: {} });
  const text = (r.content || []).map((c) => c.text ?? "").join("\n");
  liveConnections = [...text.matchAll(/`([a-z0-9][a-z0-9-]{2,})`/gi)].map((m) => m[1]);
  if (/no mcp servers are currently connected/i.test(text)) liveConnections = [];
} catch {
  /* leave empty — a failed check is not evidence of a connection */
}

const attemptedConnect = calls.includes("mcp_connect");
const connected = liveConnections.length > 0;
const discovered = calls.includes("mcp_discover");

/**
 * Did it actually USE a server, or just reach one?
 *
 * Either route counts: calling a proxied tool that appeared after connecting
 * (a name outside the 13 the gateway starts with), or going through the
 * mcp_call_tool meta-tool. Connecting and stopping is the weaker result, and
 * conflating the two would overstate what the gateway has been shown to do.
 */
const proxiedCalls = calls.filter((c) => !baseToolNames.has(c));
const usedATool = proxiedCalls.length > 0 || calls.includes("mcp_call_tool");
// `tools` is the CURRENT list, so proxied tools that appeared after a connect
// are legitimate. Only a name that never existed at any point is invented.
const invented = calls.filter((c) => !tools.some((t) => t.name === c) && !baseToolNames.has(c));

/**
 * Reaching mcp_connect is not success, and reporting it as success is how the
 * first run of this probe announced ORCHESTRATED for a model that had in fact
 * locked into an 8,620-call loop and never answered. A run counts only if the
 * model also STOPPED — got what it asked for and said so.
 */
/**
 * Two independent axes, because conflating them is what produced the last two
 * wrong verdicts. The model can drive the protocol perfectly and still end up
 * with nothing connected, because roughly a third of registry servers start
 * unattended at all — a fact this project measured and published. That is an
 * ecosystem result, not a model result, and the probe must not blame the model
 * for it.
 */
// With PRECONNECT the model is not asked to discover or connect — that is the
// point of the baseline — so requiring those steps scored a run that called a
// tool successfully as "never engaged the tools".
const orchestrationExpected = !process.env.PRECONNECT;
const droveWell =
  !runaway &&
  done &&
  invented.length === 0 &&
  (!orchestrationExpected || (discovered && attemptedConnect));
const verdict = runaway
  ? "RUNAWAY — model could not stop"
  : droveWell && connected && usedATool
    ? "FULL LOOP — discovered, connected, and used a tool"
    : droveWell && connected
      ? "CONNECTED ONLY — reached a server but never called a tool on it"
      : droveWell
      ? "MODEL OK, TASK FAILED — correct protocol, no server would start"
      : discovered || attemptedConnect
        ? "PARTIAL — started the flow, did not finish cleanly"
        : "FAILED — never engaged the tools";

// Longest immediately-repeating cycle at the tail — the signature of a model
// that cannot terminate, as distinct from one doing real repeated work.
let cycle = null;
for (let n = 1; n <= 4 && !cycle; n++) {
  const unit = calls.slice(-n).join(",");
  let reps = 0;
  for (let i = calls.length; i - n >= 0; i -= n) {
    if (calls.slice(i - n, i).join(",") !== unit) break;
    reps++;
  }
  if (reps >= 3) cycle = `${unit.replace(/,/g, " -> ")} x${reps}`;
}

log("─".repeat(60));
log(`turns used:      ${turn}`);
log(`tool calls:      ${calls.length}`);
log(`opening moves:   ${calls.slice(0, 4).join(" -> ") || "(none)"}`);
if (cycle) log(`repeating cycle: ${cycle}`);
if (runaway) log(`runaway:         ${runaway} calls in a single response`);
log(`invented tools:  ${invented.length ? invented.join(", ") : "none"}`);
log(`discovered:      ${discovered ? "yes" : "no"}`);
log(`connect tried:   ${attemptedConnect ? "yes" : "no"}`);
log(`actually live:   ${connected ? liveConnections.join(", ") : "nothing connected"}`);
log(`terminated:      ${done ? "yes" : "NO — never produced a final answer"}`);
log(`used a tool:     ${usedATool ? (proxiedCalls.length ? proxiedCalls.join(", ") : "via mcp_call_tool") : "no"}`);
log(`prompt tokens:   ${promptTokens ?? "?"} (real tokenizer, first turn)`);
if (turnCosts.length) {
  const billed = turnCosts.reduce((a, t) => a + t.prompt + t.completion, 0);
  log(`per-turn prompt: ${turnCosts.map((t) => t.prompt).join(" -> ")}`);
  log(`TOTAL BILLED:    ${billed} tok across ${turnCosts.length} turn(s)`);
}
if (promptTokens) {
  const est = Math.round(schemaChars / 4);
  log(`chars/4 est:     ${est}  -> ratio ${(promptTokens / est).toFixed(2)}x`);
}
log(`VERDICT:         ${verdict}`);

await mcp.close();
process.exit(0);
