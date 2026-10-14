import { describe, it, expect } from "vitest";
import { registerConnect } from "./connect.js";
import type { CapabilityManifest } from "../sandbox/types.js";
import type { TrustTier } from "../registry/types.js";

/**
 * The connect summary ends the Files line of a server outside a container with
 * what would contain it. It used to say "set MCP_GATEWAY_CONTAINER_ISOLATION=true"
 * even with that set, to a server that fell back to L1 for want of Docker or
 * Podman, or to a verified one its tier keeps on L1.
 */

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

const CONTAINED: CapabilityManifest = {
  version: 1,
  slug: "srv",
  enforcement: "l2-container",
  env: { allow: [], inheritDefaults: true },
  network: { mode: "none", allow: [] },
  filesystem: { read: [], write: [] },
  subprocess: false,
};
const ON_HOST: CapabilityManifest = { ...CONTAINED, enforcement: "l1-process" };

async function connectSummary(conn: {
  manifest: CapabilityManifest;
  resolvedManifest?: CapabilityManifest;
  trustTier: TrustTier;
}): Promise<string> {
  let handler!: Handler;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  registerConnect(
    server as never,
    {
      connect: async () => ({
        slug: "srv",
        displayName: "Srv",
        state: "ready",
        trustTier: conn.trustTier,
        transportType: "stdio",
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
      }),
      getConnection: () => ({
        slug: "srv",
        tools: new Map(),
        resources: new Map(),
        prompts: new Map(),
        ...conn,
      }),
      connectionCount: 1,
      manifestResolver: { containerIsolation: true, getOverride: () => undefined },
    } as never,
  );
  return (await handler({ command: "npx", args: ["-y", "srv"], confirmed: true })).content[0].text;
}

describe("mcp_connect summary, with container isolation on", () => {
  it("tells a server that fell back to L1 to start an engine", async () => {
    const text = await connectSummary({ manifest: ON_HOST, resolvedManifest: CONTAINED, trustTier: "unknown" });
    expect(text).toContain("### 🛡️ Sandbox (l1-process)");
    expect(text).toContain("no Docker or Podman was found; start one and reconnect to restrict");
    expect(text).not.toContain("MCP_GATEWAY_CONTAINER_ISOLATION");
  });

  it("points a verified server on L1 at an override", async () => {
    const text = await connectSummary({ manifest: ON_HOST, trustTier: "verified" });
    expect(text).toContain('mcp_sandbox({action: "set", slug: "srv", enforcement: "l2-container"})');
    expect(text).not.toContain("MCP_GATEWAY_CONTAINER_ISOLATION");
  });

  it("gives a contained server no hint", async () => {
    const text = await connectSummary({ manifest: CONTAINED, trustTier: "unknown" });
    expect(text).toContain("Files: nothing from the host is mounted");
    expect(text).not.toContain("to restrict");
  });
});
