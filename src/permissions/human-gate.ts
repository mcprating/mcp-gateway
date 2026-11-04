import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuditLog } from "../audit/audit-log.js";
import { log } from "../utils/logger.js";

/**
 * A yes from the person, not from the model.
 *
 * `confirmed: true` on mcp_connect is a field the model fills in, so whatever
 * can talk the model round can fill it in too: a tool description or a tool
 * result from any connected server is enough (arXiv 2611.03555 measures how
 * often that works). The same goes for mcp_sandbox, which could widen a
 * server's limits on the model's word alone. So the things that start a
 * program or widen what a server gets go to the person, through MCP
 * elicitation: a request the client shows to them, which the model never sees
 * or answers.
 *
 * A client that doesn't support elicitation can't ask. What must have a person
 * is then refused rather than waved through, and the user can turn the gate
 * off in the gateway's own configuration. That setting isn't reachable from a
 * tool call.
 */

export type Approval =
  /** "person": they said yes. "setting": the gate is off. "agent": no way to ask, and this doesn't need a person. */
  | { approved: true; by: "person" | "setting" | "agent" }
  /**
   * "declined": they said no or dismissed it. "asked-before": they already had, so they
   * weren't asked again. "stopped-asking": they've refused enough this session that nothing
   * more goes to them. "no-answer": it failed or timed out. "no-prompt": this client can't ask.
   */
  | { approved: false; why: "declined" | "asked-before" | "stopped-asking" | "no-answer" | "no-prompt" };

export interface ApprovalRequest {
  /** The server concerned, for the audit trail. */
  slug: string;
  /** Identifies what is being approved, so the same request can be recognised. Held in memory only. */
  key: string;
  /** What is being approved, as the person will read it. Built by the gateway. */
  summary: string;
  /** True when this may not go ahead on the model's word if the client can't ask. */
  required: boolean;
}

/** How long a person gets to answer. The SDK's default of 60 seconds is too short to read a command. */
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/**
 * After this many different requests refused in a session, stop asking at all.
 * Remembering a no only covers the same request, and changing one argument makes
 * a new one. An agent that has been told no this often isn't asking for the
 * person's sake.
 */
export const MAX_REFUSALS = 3;
/** A longer summary is cut, saying so: a client's dialog is no place for a page of text. */
const MAX_SUMMARY = 1_500;

/**
 * Text fit to show a person: no control characters, and none of the invisible
 * or direction-changing ones that make text display as something else. This is
 * what they approve, and part of it comes from the model or a registry entry.
 */
export function plain(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]|[\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

export class HumanGate {
  /**
   * Requests the person said no to. An agent that keeps asking, misled or just
   * stuck, shouldn't get to wear them down until a dialog gets a yes, so the
   * same request isn't put to them twice. A timeout isn't a no: nobody saw it, or
   * nobody answered, so it can be asked again. A yes isn't kept at all: it covers
   * the one thing it was given for. Lasts as long as this gateway session.
   */
  private readonly declined = new Set<string>();

  constructor(
    /** The low-level MCP server, whose client gets the question. */
    private readonly server: Server | undefined,
    /** False only when the user turned it off in the gateway's configuration. */
    private readonly enabled: boolean,
    private readonly auditLog?: () => AuditLog | undefined,
  ) {}

  /** Whether the gate is on. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether the person has refused enough that nothing more goes to them this session. */
  get hasStoppedAsking(): boolean {
    return this.declined.size >= MAX_REFUSALS;
  }

  /** Whether a question put now would reach the person. */
  get canAsk(): boolean {
    return this.enabled && Boolean(this.server?.getClientCapabilities?.()?.elicitation);
  }

  async check(request: ApprovalRequest): Promise<Approval> {
    if (!this.enabled) return { approved: true, by: "setting" };
    if (!this.canAsk) {
      if (!request.required) return { approved: true, by: "agent" };
      this.record(request.slug, false, "this client can't ask a person");
      return { approved: false, why: "no-prompt" };
    }

    if (this.declined.has(request.key)) {
      this.record(request.slug, false, "declined earlier in this session, so not asked again");
      return { approved: false, why: "asked-before" };
    }
    // A refusal, not a fall back to the model's word: this is the client that can ask.
    if (this.hasStoppedAsking) {
      this.record(request.slug, false, `stopped asking after ${MAX_REFUSALS} refusals in this session`);
      return { approved: false, why: "stopped-asking" };
    }

    const message = plain(request.summary);
    try {
      const result = await this.server!.elicitInput(
        {
          mode: "form",
          message: message.length > MAX_SUMMARY ? `${message.slice(0, MAX_SUMMARY)}\n… (${message.length - MAX_SUMMARY} more characters not shown)` : message,
          requestedSchema: {
            type: "object",
            properties: {
              approve: { type: "boolean", title: "Yes, go ahead", default: false },
            },
            required: ["approve"],
          },
        },
        { timeout: ANSWER_TIMEOUT_MS },
      );
      // Both, so a client that accepts on the person's behalf with the defaults doesn't count.
      if (result.action === "accept" && result.content?.approve === true) {
        this.record(request.slug, true, "a person approved it");
        return { approved: true, by: "person" };
      }
      this.declined.add(request.key);
      this.record(request.slug, false, `a person answered "${result.action}"`);
      return { approved: false, why: "declined" };
    } catch (err) {
      log.warn("Approval request failed", { slug: request.slug, error: String(err) });
      this.record(request.slug, false, "the approval request failed or timed out");
      return { approved: false, why: "no-answer" };
    }
  }

  private record(slug: string, ok: boolean, reason: string): void {
    this.auditLog?.()?.record({ type: "approval", slug, ok, reason });
  }
}

/** The tool result for a refusal, for the model to pass on. It shouldn't simply try again. */
export function refusalMessage(what: string, why: Exclude<Approval, { approved: true }>["why"]): string {
  switch (why) {
    case "declined":
      return `${what} was declined by the person using this client. Don't try again unless they ask you to.`;
    case "asked-before":
      return `${what} was already declined in this session, so the person wasn't asked again. Don't try again. If they've changed their mind, they can restart their MCP client and ask you then.`;
    case "stopped-asking":
      return `${what} wasn't put to the person: they've declined ${MAX_REFUSALS} requests in this session, so the gateway has stopped asking. Don't try again. Tell them so. If they didn't expect those requests, something in a connected server's descriptions or results may be behind them. Restarting their MCP client lets the gateway ask again.`;
    case "no-answer":
      return `${what} needs a person's approval, and the request got no answer. Don't try again unless they ask you to.`;
    case "no-prompt":
      return `${what} needs a person's approval, and this client can't ask them (it doesn't support MCP elicitation). Tell them: to let the agent decide this instead, set MCP_GATEWAY_HUMAN_APPROVAL=off in the gateway's \`env\` in their MCP client config and restart the client.`;
  }
}

/**
 * Environment variables that change what a process runs, not just how it
 * behaves. Passing one to a known server is a raw launch by another route:
 * NODE_OPTIONS=--require /tmp/x.js makes `npx trusted-server` run x.js.
 */
const LAUNCHER_ENV =
  /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_[A-Z_]+|DYLD_[A-Z_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|COMSPEC|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|NPM_CONFIG_[A-Z_]+|UV_[A-Z_]+|PIP_[A-Z_]+)$/i;

/** The names in `env` that change what runs. */
export function launcherEnvNames(env: Record<string, string> | undefined): string[] {
  return Object.keys(env ?? {}).filter((name) => LAUNCHER_ENV.test(name));
}
