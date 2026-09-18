#!/usr/bin/env node
/**
 * Measure an MCP CLIENT, by being a server it connects to.
 *
 * Add it to any client's config and start that client:
 *
 *   { "mcpServers": { "probe": { "command": "node",
 *       "args": ["<abs path>/demo/client-probe.mjs"] } } }
 *
 * It writes demo/client-probe-report.json and keeps running, so a report
 * appears even for GUI clients that cannot be driven from a script.
 *
 * WHY THIS EXISTS. The gateway's central mechanic is dynamic tool registration:
 * connect to a server and its tools appear, because the gateway sends
 * notifications/tools/list_changed and the host is expected to re-read
 * tools/list. If a client ignores that notification, the gateway silently does
 * not work there — connect succeeds, and the tools never become callable. We
 * ship a gateway to Claude Desktop, Cursor and Windsurf users and have never
 * verified which of them honour it.
 *
 * Clients also DECLARE their capabilities in the initialize handshake. Declared
 * is not implemented — that gap is the whole point of this project, pointed at
 * the other side of the protocol.
 *
 * Uses the low-level Server rather than McpServer so tools/list can be counted:
 * the count before and after the notification is the entire measurement.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT = process.env.PROBE_REPORT || join(__dirname, "client-probe-report.json");


const started = Date.now();
const since = () => Math.round(Date.now() - started);

const observed = {
  probeStarted: new Date().toISOString(),
  client: null,
  declaredCapabilities: null,
  toolsListCalls: [], // ms offsets
  toolCalls: [],
  listChangedSentAt: null,
  relistedAfterNotification: null, // the answer
};

function save() {
  // Re-read identity on every save rather than once after connect().
  // connect() resolves before the initialize handshake completes, so reading
  // these immediately after it returns null — which made the report claim "NO
  // CLIENT CONNECTED" for a client that was demonstrably connected and
  // re-listing. Cheap to re-read; wrong exactly once if you don't.
  if (!observed.client) {
    observed.client = server.getClientVersion() ?? null;
    observed.declaredCapabilities = server.getClientCapabilities() ?? null;
  }
  const o = { ...observed };
  o.relistedAfterNotification =
    o.listChangedSentAt === null
      ? null
      : o.toolsListCalls.some((t) => t > o.listChangedSentAt);
  o.verdict =
    o.client === null
      ? "NO CLIENT CONNECTED"
      : o.relistedAfterNotification === true
        ? "HONOURS tools/list_changed — the gateway works here"
        : o.relistedAfterNotification === false
          ? "IGNORED tools/list_changed — dynamic tools will NOT appear"
          : "notification not yet sent";
  try {
    writeFileSync(REPORT, JSON.stringify(o, null, 2) + "\n");
  } catch {
    /* a client may run us from a read-only cwd; the log line still carries it */
  }
}

const server = new Server(
  { name: "client-probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// The measurement: every tools/list is stamped. One before the notification is
// the client's initial read; one after means it honoured the notification.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  observed.toolsListCalls.push(since());
  save();
  return {
    tools: [
      {
        name: "probe_report",
        description:
          "Return what this probe has observed about your MCP client so far. " +
          "Call it to see whether your client honours tools/list_changed.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  observed.toolCalls.push({ name: req.params.name, at: since() });
  save();
  return { content: [{ type: "text", text: JSON.stringify(observed, null, 2) }] };
});

await server.connect(new StdioServerTransport());

// save() picks up client identity as soon as initialize completes.
save();

/**
 * Notify only AFTER the client's initial tools/list, never on a timer alone.
 *
 * The first version fired at a fixed 4s. Cursor's initial list arrived 4ms
 * later, and "a tools/list after the notification" scored it as honouring the
 * notification — a false pass produced entirely by a race in the instrument.
 * Waiting for the initial read makes the separation structural: once it has
 * happened, any further list is genuinely a response to the poke.
 *
 * GRACE_MS then leaves room for a slow client to finish its startup burst, so a
 * second initial-phase call is not miscounted either.
 */
const GRACE_MS = Number(process.env.PROBE_GRACE || 8000);

const LAZY_AFTER_MS = Number(process.env.PROBE_LAZY_AFTER || 30000);

async function notifyOnceListed(waitedMs = 0) {
  if (observed.toolsListCalls.length === 0) {
    // Waiting forever for an initial list deadlocks against a lazy client.
    // Cursor turned out to be one: it caches a tool list from an earlier
    // session and serves that to the model via its own dynamic-discovery layer,
    // so a restarted server may never be asked for tools at all.
    //
    // Poking anyway is not a weaker measurement, it is a cleaner one — with
    // zero lists beforehand, ANY list afterwards is unambiguously a response to
    // the notification. Recorded so the report says which path it took.
    if (waitedMs >= LAZY_AFTER_MS && observed.client) {
      observed.notifiedWithoutInitialList = true;
      // fall through and notify
    } else if (waitedMs > 180000) {
      observed.notifyError = "no client ever connected — nothing to measure";
      save();
      return;
    } else {
      // save() is what refreshes client identity, and the lazy branch above
      // gates on it — without a call here the poll loop never learns a client
      // connected, and waits out its full timeout against a live client.
      save();
      setTimeout(() => notifyOnceListed(waitedMs + 1000), 1000);
      return;
    }
  }
  // Seen the initial read. Let any startup burst settle, then poke.
  setTimeout(async () => {
    observed.listCallsBeforeNotification = observed.toolsListCalls.length;
    try {
      await server.sendToolListChanged();
      observed.listChangedSentAt = since();
      save();
    } catch (err) {
      observed.notifyError = String(err).split("\n")[0];
      save();
    }
    setTimeout(save, 10000); // a re-list lands within a second or two
  }, GRACE_MS);
}
notifyOnceListed();

// Stay alive. GUI clients hold the connection, and exiting would look like a crash.
setInterval(save, 15000);
