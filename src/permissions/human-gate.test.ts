import { describe, it, expect, vi } from "vitest";
import { HumanGate, MAX_REFUSALS, launcherEnvNames, plain, refusalMessage } from "./human-gate.js";
import { AuditLog } from "../audit/audit-log.js";

type Elicit = (params: { message: string; requestedSchema: unknown }) => Promise<unknown>;

function client(elicit?: Elicit) {
  return {
    getClientCapabilities: () => (elicit ? { elicitation: { form: {} } } : {}),
    elicitInput: vi.fn(elicit ?? (async () => ({ action: "decline" }))),
  };
}

const REQUEST = { slug: "srv", key: "start-srv", summary: "Start it?", required: true };
const yes = async () => ({ action: "accept", content: { approve: true } });

function gate(server: ReturnType<typeof client>, enabled = true) {
  const audit = new AuditLog();
  return { gate: new HumanGate(server as never, enabled, () => audit), audit };
}

describe("HumanGate", () => {
  it("is approved only by an accept with the box ticked", async () => {
    expect(await gate(client(yes)).gate.check(REQUEST)).toEqual({ approved: true, by: "person" });
    for (const answer of [
      { action: "accept" },
      { action: "accept", content: {} },
      { action: "accept", content: { approve: false } },
      { action: "accept", content: { approve: "true" } },
      { action: "decline" },
      { action: "cancel" },
    ]) {
      expect(await gate(client(async () => answer)).gate.check(REQUEST)).toEqual({ approved: false, why: "declined" });
    }
  });

  it("takes a failed or timed-out request as no", async () => {
    const failing = client(async () => {
      throw new Error("timed out");
    });
    expect(await gate(failing).gate.check(REQUEST)).toEqual({ approved: false, why: "no-answer" });
  });

  it("refuses what needs a person when the client can't ask, and asks nothing", async () => {
    const server = client();
    expect(await gate(server).gate.check(REQUEST)).toEqual({ approved: false, why: "no-prompt" });
    expect(server.elicitInput).not.toHaveBeenCalled();
  });

  it("lets through what doesn't need a person when the client can't ask", async () => {
    expect(await gate(client()).gate.check({ ...REQUEST, required: false })).toEqual({ approved: true, by: "agent" });
  });

  it("asks where it can even when a person isn't strictly needed", async () => {
    const server = client(async () => ({ action: "decline" }));
    expect(await gate(server).gate.check({ ...REQUEST, required: false })).toEqual({ approved: false, why: "declined" });
    expect(server.elicitInput).toHaveBeenCalledOnce();
  });

  it("asks nothing when the user turned it off", async () => {
    const server = client(yes);
    const off = gate(server, false).gate;
    expect(off.canAsk).toBe(false);
    expect(await off.check(REQUEST)).toEqual({ approved: true, by: "setting" });
    expect(server.elicitInput).not.toHaveBeenCalled();
  });

  it("works with no server behind it, as a refusal", async () => {
    const orphan = new HumanGate(undefined, true);
    expect(orphan.canAsk).toBe(false);
    expect(await orphan.check(REQUEST)).toEqual({ approved: false, why: "no-prompt" });
  });

  it("records every outcome, and a refusal counts as security-relevant", async () => {
    const approved = gate(client(yes));
    await approved.gate.check(REQUEST);
    expect(approved.audit.query({ type: "approval" })[0]).toMatchObject({ slug: "srv", ok: true });
    expect(approved.audit.query({ securityRelevantOnly: true })).toHaveLength(0);

    const refused = gate(client());
    await refused.gate.check(REQUEST);
    expect(refused.audit.query({ securityRelevantOnly: true })[0]).toMatchObject({ type: "approval", ok: false });
  });

  it("shows the person plain text, with what doesn't fit cut and said to be cut", async () => {
    const server = client(yes);
    await gate(server).gate.check({ ...REQUEST, summary: `run${String.fromCodePoint(0x202e)}gpj.exe ${"x".repeat(2000)}` });
    const message = server.elicitInput.mock.calls[0][0].message;
    expect(message.startsWith("run gpj.exe")).toBe(true);
    expect(message).toMatch(/more characters not shown\)$/);
  });
});

describe("a no, remembered", () => {
  it("doesn't put the same request to the person twice", async () => {
    const server = client(async () => ({ action: "decline" }));
    const { gate: g, audit } = gate(server);
    expect(await g.check(REQUEST)).toEqual({ approved: false, why: "declined" });
    expect(await g.check(REQUEST)).toEqual({ approved: false, why: "asked-before" });
    expect(await g.check({ ...REQUEST, summary: "Worded differently" })).toEqual({ approved: false, why: "asked-before" });
    expect(server.elicitInput).toHaveBeenCalledOnce();
    expect(audit.query({ type: "approval" })[0].reason).toMatch(/not asked again/);
  });

  it("counts a dismissal and an empty accept as a no", async () => {
    for (const answer of [{ action: "cancel" }, { action: "accept" }]) {
      const server = client(async () => answer);
      const { gate: g } = gate(server);
      await g.check(REQUEST);
      await g.check(REQUEST);
      expect(server.elicitInput).toHaveBeenCalledOnce();
    }
  });

  it("still asks about a different request", async () => {
    const server = client(async () => ({ action: "decline" }));
    const { gate: g } = gate(server);
    await g.check(REQUEST);
    expect(await g.check({ ...REQUEST, key: "start-other" })).toEqual({ approved: false, why: "declined" });
    expect(server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it("doesn't take a timeout for a no: the question can be put again", async () => {
    let calls = 0;
    const server = client(async () => {
      if (++calls === 1) throw new Error("timed out");
      return { action: "accept", content: { approve: true } };
    });
    const { gate: g } = gate(server);
    expect(await g.check(REQUEST)).toEqual({ approved: false, why: "no-answer" });
    expect(await g.check(REQUEST)).toEqual({ approved: true, by: "person" });
  });

  it("doesn't keep a yes: it covers one request, once", async () => {
    const server = client(yes);
    const { gate: g } = gate(server);
    await g.check(REQUEST);
    await g.check(REQUEST);
    expect(server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it("forgets with the session: a new gate asks again", async () => {
    const server = client(async () => ({ action: "decline" }));
    await gate(server).gate.check(REQUEST);
    await gate(server).gate.check(REQUEST);
    expect(server.elicitInput).toHaveBeenCalledTimes(2);
  });
});

describe("the refusal cap", () => {
  const no = async () => ({ action: "decline" });
  const refuseThree = async (g: HumanGate) => {
    for (const key of ["one", "two", "three"]) await g.check({ ...REQUEST, key });
  };

  it("is three", () => {
    expect(MAX_REFUSALS).toBe(3);
  });

  it("stops asking after three different requests are refused, however the next is worded", async () => {
    const server = client(no);
    const { gate: g, audit } = gate(server);
    await refuseThree(g);
    expect(g.hasStoppedAsking).toBe(true);
    expect(await g.check({ ...REQUEST, key: "four" })).toEqual({ approved: false, why: "stopped-asking" });
    expect(server.elicitInput).toHaveBeenCalledTimes(3);
    expect(audit.query({ type: "approval" })[0].reason).toMatch(/stopped asking after 3 refusals/);
  });

  it("still asks up to the third", async () => {
    const server = client(no);
    const { gate: g } = gate(server);
    await g.check({ ...REQUEST, key: "one" });
    await g.check({ ...REQUEST, key: "two" });
    expect(g.hasStoppedAsking).toBe(false);
    expect(await g.check({ ...REQUEST, key: "three" })).toEqual({ approved: false, why: "declined" });
    expect(server.elicitInput).toHaveBeenCalledTimes(3);
  });

  it("doesn't fall back to the model for what would not otherwise need a person", async () => {
    const { gate: g } = gate(client(no));
    await refuseThree(g);
    expect(await g.check({ ...REQUEST, key: "four", required: false })).toEqual({ approved: false, why: "stopped-asking" });
  });

  it("keeps saying a repeat was already declined", async () => {
    const { gate: g } = gate(client(no));
    await refuseThree(g);
    expect(await g.check({ ...REQUEST, key: "two" })).toEqual({ approved: false, why: "asked-before" });
  });

  it("counts a request once, however often it's retried", async () => {
    const server = client(no);
    const { gate: g } = gate(server);
    for (let i = 0; i < 5; i++) await g.check(REQUEST);
    expect(g.hasStoppedAsking).toBe(false);
    await g.check({ ...REQUEST, key: "other" });
    expect(server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it("doesn't count a yes or a timeout", async () => {
    const answers = [
      { action: "accept", content: { approve: true } },
      new Error("timed out"),
      { action: "accept", content: { approve: true } },
      new Error("timed out"),
    ];
    const server = client(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    const { gate: g } = gate(server);
    for (const key of ["a", "b", "c", "d"]) await g.check({ ...REQUEST, key });
    expect(g.hasStoppedAsking).toBe(false);
    expect(server.elicitInput).toHaveBeenCalledTimes(4);
  });

  it("ends with the session", async () => {
    const server = client(no);
    await refuseThree(gate(server).gate);
    expect(gate(server).gate.hasStoppedAsking).toBe(false);
  });

  it("has nothing to stop where the gate is off or the client can't ask", async () => {
    const server = client();
    const { gate: g } = gate(server);
    for (const key of ["one", "two", "three", "four"]) {
      expect(await g.check({ ...REQUEST, key })).toEqual({ approved: false, why: "no-prompt" });
    }
    expect(g.hasStoppedAsking).toBe(false);
  });
});

describe("plain", () => {
  it("keeps line breaks and removes what would display as something else", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zeroWidth = String.fromCodePoint(0x200b);
    const tagA = String.fromCodePoint(0xe0041);
    const lineSeparator = String.fromCodePoint(0x2028);
    expect(plain(`a\r\nb\rc\nd`)).toBe("a\nb\nc\nd");
    expect(plain(`a${rlo}b${zeroWidth}c${tagA}d${lineSeparator}e\u0007f`)).toBe("a b c d e f");
  });
});

describe("launcherEnvNames", () => {
  it("finds what changes what runs, in any case, and leaves ordinary keys alone", () => {
    expect(launcherEnvNames({ NODE_OPTIONS: "x", LD_PRELOAD: "x", path: "x", GITHUB_TOKEN: "x", npm_config_registry: "x" })).toEqual([
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "path",
      "npm_config_registry",
    ]);
    expect(launcherEnvNames(undefined)).toEqual([]);
  });
});

describe("refusalMessage", () => {
  it("tells the model not to retry a no, and how the user lifts the gate where the client can't ask", () => {
    expect(refusalMessage("Starting x", "declined")).toMatch(/Don't try again unless they ask/);
    expect(refusalMessage("Starting x", "asked-before")).toMatch(/wasn't asked again.*restart their MCP client/);
    expect(refusalMessage("Starting x", "stopped-asking")).toMatch(/declined 3 requests.*stopped asking.*Restarting their MCP client/);
    expect(refusalMessage("Starting x", "no-prompt")).toMatch(/MCP_GATEWAY_HUMAN_APPROVAL=off/);
  });
});
