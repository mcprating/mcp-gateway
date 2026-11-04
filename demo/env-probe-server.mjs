#!/usr/bin/env node
/**
 * An MCP server that reports which environment variables its client started
 * it with: NAMES ONLY, never a value.
 *
 * The gateway's main argument is environment scoping: a server it starts gets
 * a short allowlist plus the variables you name, not your whole environment.
 * That only matters if clients pass their whole environment in the first
 * place. The official SDKs pass a short allowlist by default
 * (DEFAULT_INHERITED_ENV_VARS, imported below), so whether a client does is a
 * per-client fact, and this measures it. Driven by demo/client-env.mjs.
 *
 *   node demo/env-probe-server.mjs --label cursor --out <dir> [--compare <names.json>]
 *
 * Writes <dir>/<label>-<pid>.json at start and again once the client has
 * identified itself. What it records:
 *  - how many variables it got, and which of the SDK's default allowlist;
 *  - two variables the driver plants in the client's own environment,
 *    MCP_ENV_PROBE_CANARY and MCP_ENV_PROBE_FAKE_API_KEY: present with the
 *    planted value, or not (compared here, never written);
 *  - with --compare, how many of the names the client was launched with
 *    reached the server (counts only);
 *  - names the client itself adds (VSCODE_*, ELECTRON_*, CLAUDECODE, ...), since
 *    those are the client's, not yours;
 *  - for everything else, a count, and how many names look like credentials.
 *    Those names are yours, so they are counted, not listed.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CANARY = { name: "MCP_ENV_PROBE_CANARY", value: "planted-by-env-probe" };
export const FAKE_KEY = { name: "MCP_ENV_PROBE_FAKE_API_KEY", value: "fake-key-planted-by-env-probe" };

/** Variable names a client sets for itself. Listed by name: they are the client's. */
const CLIENT_NAME = /^(VSCODE_|ELECTRON_|CURSOR|KIRO|CLAUDECODE$|CLAUDE_CODE_|AMD_ENTRYPOINT$|PIPE_LOGGING$|VERBOSE_LOGGING$|APPLICATION_INSIGHTS_|ORIGINAL_XDG_|CHROME_CRASHPAD_)/i;
/** Names that look like a credential. Counted, never listed. */
const CREDENTIAL_LIKE = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const label = arg("--label") ?? "client";
const outDir = arg("--out") ?? process.cwd();
const compareFile = arg("--compare");

function environmentReport() {
  const names = Object.keys(process.env);
  const upper = new Set(names.map((n) => n.toUpperCase()));
  const planted = new Set([CANARY.name, FAKE_KEY.name]);
  const sdkDefault = DEFAULT_INHERITED_ENV_VARS.filter((n) => upper.has(n.toUpperCase()));
  const clientAdded = names.filter((n) => CLIENT_NAME.test(n)).sort();
  const sdkUpper = new Set(DEFAULT_INHERITED_ENV_VARS.map((n) => n.toUpperCase()));
  const rest = names.filter((n) => !planted.has(n) && !CLIENT_NAME.test(n) && !sdkUpper.has(n.toUpperCase()));
  const report = {
    total: names.length,
    canaryReached: process.env[CANARY.name] === CANARY.value,
    fakeKeyReached: process.env[FAKE_KEY.name] === FAKE_KEY.value,
    sdkDefaultAllowlist: { size: DEFAULT_INHERITED_ENV_VARS.length, present: sdkDefault.length },
    clientAdded,
    otherNames: rest.length,
    otherCredentialLike: rest.filter((n) => CREDENTIAL_LIKE.test(n)).length,
  };
  if (compareFile) {
    try {
      // The names the client was launched with, written by the driver. Matched
      // case-insensitively, as Windows does.
      const launched = JSON.parse(readFileSync(compareFile, "utf8"));
      const seen = launched.filter((n) => upper.has(String(n).toUpperCase()));
      const launchedUpper = new Set(launched.map((n) => String(n).toUpperCase()));
      report.launchEnvironment = {
        total: launched.length,
        reachedServer: seen.length,
        // Not in what the client was started with, so the client set them: safe to list.
        addedByClient: names.filter((n) => !launchedUpper.has(n.toUpperCase())).sort(),
      };
    } catch (err) {
      report.launchEnvironment = { error: String(err).split("\n")[0] };
    }
  }
  return report;
}

const record = {
  label,
  startedAt: new Date().toISOString(),
  pid: process.pid,
  ppid: process.ppid,
  platform: process.platform,
  client: null,
  clientCapabilities: null,
  environment: environmentReport(),
};
const file = join(outDir, `${label}-${process.pid}.json`);

function save() {
  if (!record.client) record.client = server.getClientVersion() ?? null;
  if (!record.clientCapabilities) record.clientCapabilities = server.getClientCapabilities() ?? null;
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  } catch {
    /* nothing to report to: stdout is the protocol channel */
  }
}

const server = new Server({ name: "env-probe", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  save();
  return {
    tools: [
      {
        name: "env_probe_report",
        description: "Report which environment variables this server was started with (names and counts, no values).",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async () => {
  save();
  return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
});

await server.connect(new StdioServerTransport());
save();
// Pick up the client's name once initialize completes; then stay alive, as a GUI client expects.
setTimeout(save, 2000);
setInterval(save, 15000);
