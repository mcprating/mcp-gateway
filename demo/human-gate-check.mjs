#!/usr/bin/env node
/**
 * The human gate end to end: the built gateway over stdio, driven by a real MCP
 * client that plays the part of a person who says yes, a person who says no, or
 * a client that can't ask. Unit tests fake the client; this one doesn't.
 *
 *   npm run build && node demo/human-gate-check.mjs
 *
 * Runs with a throwaway home directory, so it never reads or writes your
 * ~/.mcp-gateway, and a registry address nothing answers on, so it never asks
 * mcprating.io about anything. What it starts is demo/env-probe-server.mjs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayEntry = resolve(here, "..", "dist", "index.js");
const probe = join(here, "env-probe-server.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

/** A gateway in its own home, and a client whose "person" answers with `answer`. */
async function session({ answer, env = {} }) {
  const home = mkdtempSync(join(tmpdir(), "gate-check-"));
  const reports = join(home, "reports");
  const asked = [];
  const client = new Client({ name: "gate-check", version: "1.0.0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return answer;
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [gatewayEntry],
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      PATHEXT: process.env.PATHEXT ?? "",
      COMSPEC: process.env.COMSPEC ?? "",
      HOME: home,
      USERPROFILE: home,
      MCP_GATEWAY_REGISTRY_URL: "http://127.0.0.1:9/api/v1",
      MCP_GATEWAY_LOG_LEVEL: "error",
      ...env,
    },
    stderr: "ignore",
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: result.content?.map((c) => c.text).join("\n") ?? "" };
  };
  const launch = { command: "node", args: [probe, "--label", "gate", "--out", reports] };
  const started = () => existsSync(reports) && readdirSync(reports).length > 0;
  const manifestsFile = () => {
    const dir = join(home, ".mcp-gateway");
    const names = existsSync(dir) ? readdirSync(dir).filter((f) => /manifest|sandbox/i.test(f)) : [];
    return names.length ? readFileSync(join(dir, names[0]), "utf8") : "";
  };
  return {
    call,
    launch,
    started,
    asked,
    manifestsFile,
    close: async () => {
      await client.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const YES = { action: "accept", content: { approve: true } };
const NO = { action: "decline" };

{
  const s = await session({ answer: YES });
  const r = await s.call("mcp_connect", s.launch);
  check("a person's yes starts a raw command", !r.error && s.started(), r.text.split("\n")[0].slice(0, 60));
  check("the person saw the exact command", s.asked[0]?.includes("env-probe-server.mjs"), `${s.asked.length} question(s)`);
  await s.close();
}
{
  const s = await session({ answer: NO });
  const r = await s.call("mcp_connect", { ...s.launch, confirmed: true });
  check("a person's no stops it, and confirmed: true changes nothing", r.error && !s.started(), r.text.slice(0, 70));
  const retry = await s.call("mcp_connect", { ...s.launch, confirmed: true });
  check("asking again doesn't reach the person", retry.error && !s.started() && s.asked.length === 1 && /already declined/.test(retry.text), retry.text.slice(0, 70));
  await s.call("mcp_connect", { ...s.launch, args: [...s.launch.args, "--other"] });
  check("a different request still does", s.asked.length === 2);
  await s.close();
}
{
  const s = await session({ answer: { action: "accept" } });
  const r = await s.call("mcp_connect", s.launch);
  check("an accept without the box ticked is not a yes", r.error && !s.started());
  await s.close();
}
{
  const s = await session({});
  const r = await s.call("mcp_connect", { ...s.launch, confirmed: true });
  check("a client that can't ask gets a refusal naming the setting", r.error && !s.started() && /MCP_GATEWAY_HUMAN_APPROVAL=off/.test(r.text));

  const add = await s.call("mcp_profiles", { action: "add_server", name: "work", ...s.launch });
  const created = await s.call("mcp_profiles", { action: "create", name: "work" });
  const addAgain = await s.call("mcp_profiles", { action: "add_server", name: "work", ...s.launch });
  const switched = await s.call("mcp_profiles", { action: "switch", name: "work" });
  check("mcp_profiles can't smuggle a raw command in", add.error && addAgain.error && !created.error && !s.started(), switched.text.split("\n")[0].slice(0, 50));

  await s.call("mcp_groups", { action: "create", name: "g" });
  const group = await s.call("mcp_groups", { action: "add_server", name: "g", ...s.launch });
  await s.call("mcp_groups", { action: "connect", name: "g" });
  check("mcp_groups can't either", group.error && !s.started());

  const widen = await s.call("mcp_sandbox", { action: "set", slug: "some-server", envAllow: ["AWS_SECRET_ACCESS_KEY"] });
  check("mcp_sandbox can't widen without a person", widen.error && !s.manifestsFile().includes("AWS_SECRET_ACCESS_KEY"));
  const tighten = await s.call("mcp_sandbox", { action: "set", slug: "some-server", network: "none" });
  check("mcp_sandbox can still tighten", !tighten.error);

  const health = await s.call("mcp_gateway_health", {});
  check("health says the client can't ask", /can't ask/.test(health.text));
  await s.close();
}
{
  const s = await session({ answer: NO });
  const widen = await s.call("mcp_sandbox", { action: "set", slug: "some-server", envAllow: ["AWS_SECRET_ACCESS_KEY"], network: "all" });
  check("a person's no stops a widening", widen.error && !s.manifestsFile().includes("AWS_SECRET_ACCESS_KEY"));
  check("they were told exactly what would widen", /AWS_SECRET_ACCESS_KEY/.test(s.asked[0] ?? "") && /Network goes from/.test(s.asked[0] ?? ""));
  await s.close();
}
{
  const s = await session({ answer: YES });
  const widen = await s.call("mcp_sandbox", { action: "set", slug: "some-server", envAllow: ["GITHUB_TOKEN"] });
  check("a person's yes saves it", !widen.error && s.manifestsFile().includes("GITHUB_TOKEN"));
  await s.close();
}
{
  const s = await session({ env: { MCP_GATEWAY_HUMAN_APPROVAL: "off" } });
  const warned = await s.call("mcp_connect", s.launch);
  const r = await s.call("mcp_connect", { ...s.launch, confirmed: true });
  check("with the gate off the model decides, as before", !warned.error && /confirmed: true/.test(warned.text) && !r.error && s.started());
  await s.close();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
