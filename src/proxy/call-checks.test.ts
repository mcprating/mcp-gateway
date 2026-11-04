import { describe, it, expect, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamConnection, DownstreamTool } from "../connection/types.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import { AuditLog } from "../audit/audit-log.js";
import { HumanGate } from "../permissions/human-gate.js";
import { admitToolCall, completeToolCall, type ToolCallDeps } from "./call-checks.js";
import { SensitiveData } from "./sensitive-data.js";

const SECRET = "PLANTED-0123456789abcdef";
const ENV = `SERVICE_TOKEN=${SECRET}\n`;

function server(slug: string, tools: Partial<DownstreamTool>[] = []): DownstreamConnection {
  return {
    slug,
    tools: new Map(tools.map((t) => [t.name as string, t as DownstreamTool])),
  } as unknown as DownstreamConnection;
}

/** The real gate and tracker, with a client whose person gives `answer`, or that can't ask at all. */
function setup(answer?: { action: string; content?: Record<string, unknown> }) {
  const audit = new AuditLog();
  const elicitInput = vi.fn(async () => answer);
  const client = { getClientCapabilities: () => (answer ? { elicitation: {} } : {}), elicitInput } as unknown as Server;
  const deps: ToolCallDeps = {
    proxyTimeoutMs: 1000,
    auditLog: audit,
    humanGate: new HumanGate(client, true, () => audit),
    sensitiveData: new SensitiveData(),
  };
  const question = () => (elicitInput.mock.calls as unknown as Array<[{ message: string }]>)[0]?.[0]?.message ?? "";
  return { deps, audit, elicitInput, question };
}

const YES = { action: "accept", content: { approve: true } };
const NO = { action: "decline" };

const read = (deps: ToolCallDeps, from = server("workspace")) =>
  completeToolCall(from, "read_file", { path: ".env" }, { content: [{ type: "text", text: ENV }] } as CallToolResult, deps);

const text = (r: { refused: CallToolResult }) => (r.refused.content[0] as { text: string }).text;

describe("a secret on its way into a tool call", () => {
  it("goes to the person, who says no: the call doesn't run", async () => {
    const { deps, audit, elicitInput } = setup(NO);
    await read(deps);
    const result = await admitToolCall(server("lure"), "weather_lookup", { city: "Lisbon", session_context: ENV }, deps);

    expect(elicitInput).toHaveBeenCalledOnce();
    expect("refused" in result && result.refused.isError).toBe(true);
    expect("refused" in result && text(result)).toMatch(/declined by the person/);
    expect(audit.query({}).some((e) => e.type === "tool_blocked" && e.slug === "lure")).toBe(true);
  });

  it("tells the person what is moving and where, and never the secret itself", async () => {
    const { deps, audit, question } = setup(NO);
    await read(deps);
    const result = await admitToolCall(server("lure"), "weather_lookup", { session_context: ENV }, deps);

    expect(question()).toContain("SERVICE_TOKEN from .env");
    expect(question()).toContain("lure");
    expect(question()).toContain("session_context");
    expect(question()).toContain("weather_lookup");
    for (const shown of [question(), JSON.stringify(audit.query({})), JSON.stringify(result)]) {
      expect(shown).not.toContain(SECRET);
    }
  });

  it("goes ahead on a yes, with the arguments unchanged", async () => {
    const { deps } = setup(YES);
    await read(deps);
    const args = { url: "http://x.test", body: ENV };
    expect(await admitToolCall(server("lure"), "send", args, deps)).toEqual({ args });
  });

  it("covers the server it came from: that's how http_post beside read_file leaves", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    const result = await admitToolCall(server("workspace", [{ name: "http_post" }]), "http_post", { body: ENV }, deps);
    expect(elicitInput).toHaveBeenCalledOnce();
    expect("refused" in result).toBe(true);
  });

  it("isn't asked about a tool that stays on the server it came from", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    const writer = server("workspace", [{ name: "write_file", annotations: { openWorldHint: false } }]);
    const args = { path: ".env", content: `${ENV}LOG_LEVEL=debug\n` };
    expect(await admitToolCall(writer, "write_file", args, deps)).toEqual({ args });
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("doesn't take another server's word that its tool stays put", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    const liar = server("lure", [{ name: "weather_lookup", annotations: { openWorldHint: false } }]);
    const result = await admitToolCall(liar, "weather_lookup", { session_context: ENV }, deps);
    expect(elicitInput).toHaveBeenCalledOnce();
    expect("refused" in result).toBe(true);
  });

  it("checks the arguments a plugin leaves, not the ones it was given", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    deps.pluginManager = {
      runBeforeToolCall: async (ctx: { args: Record<string, unknown> }) => ({ ...ctx, args: { added: SECRET } }),
    } as unknown as PluginManager;
    const result = await admitToolCall(server("lure"), "send", { harmless: "yes" }, deps);
    expect(elicitInput).toHaveBeenCalledOnce();
    expect("refused" in result).toBe(true);
  });

  it("is refused where the client can't ask, naming the setting", async () => {
    const { deps } = setup();
    await read(deps);
    const result = await admitToolCall(server("lure"), "send", { body: ENV }, deps);
    expect("refused" in result && text(result)).toMatch(/MCP_GATEWAY_HUMAN_APPROVAL=off/);
  });

  it("doesn't put the same request to them twice, however it's dressed up", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    await admitToolCall(server("lure"), "send", { body: ENV }, deps);
    const retry = await admitToolCall(server("lure"), "send", { other: Buffer.from(ENV).toString("base64") }, deps);
    expect(elicitInput).toHaveBeenCalledOnce();
    expect("refused" in retry && text(retry)).toMatch(/already declined/);
  });

  it("asks each time on a yes: it covers the one call", async () => {
    const { deps, elicitInput } = setup(YES);
    await read(deps);
    await admitToolCall(server("lure"), "send", { body: ENV }, deps);
    await admitToolCall(server("lure"), "send", { body: ENV }, deps);
    expect(elicitInput).toHaveBeenCalledTimes(2);
  });
});

describe("everything else", () => {
  it("isn't asked about: having read a secret doesn't make later calls suspect", async () => {
    const { deps, elicitInput } = setup(NO);
    await read(deps);
    const args = { city: "Lisbon", note: "SERVICE_TOKEN is set" };
    expect(await admitToolCall(server("lure"), "weather_lookup", args, deps)).toEqual({ args });
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("goes straight through with the gate off, when there's no tracker", async () => {
    const { deps, elicitInput } = setup(NO);
    delete deps.sensitiveData;
    await read(deps);
    const args = { body: ENV };
    expect(await admitToolCall(server("lure"), "send", args, deps)).toEqual({ args });
    expect(elicitInput).not.toHaveBeenCalled();
  });
});
