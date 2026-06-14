import { appendFileSync } from "node:fs";
import { log } from "../utils/logger.js";

/**
 * Safety audit trail — a forensics record of what sandboxed MCP servers
 * actually did, and what the sandbox blocked.
 *
 * This is deliberately NOT generic observability (tool-call telemetry exists
 * in UsageTracker). It's a *security* artifact: the evidence that containment
 * worked. A security team reviewing "did this untrusted server try anything?"
 * reads this log — it records sandbox-relevant events (calls under an
 * enforcement level, blocked egress, blocked tools, connects with their
 * granted capability envelope), not performance metrics.
 *
 * Storage: an in-memory ring buffer (always) plus optional append-only JSONL
 * file (for durable forensics / SIEM ingestion).
 */

export type AuditEventType =
  | "connect" // a server was connected, with its enforcement level + granted capabilities
  | "tool_call" // a proxied tool ran (records success/error, not args/results)
  | "tool_blocked" // a tool call was blocked (by permission policy or plugin)
  | "egress_blocked" // an outbound network attempt was refused by the allowlist
  | "egress_allowed" // an allowlisted outbound connection was permitted (L2 allowlist mode)
  | "disconnect";

export interface AuditEvent {
  /** ISO timestamp. */
  ts: string;
  type: AuditEventType;
  /** Downstream server slug the event concerns. */
  slug: string;
  /** Sandbox enforcement level in effect (none | l1-process | l2-container | l3-wasm). */
  enforcement?: string;
  /** Tool name, for tool_* events. */
  tool?: string;
  /** Target host:port, for egress_* events. */
  target?: string;
  /** Whether the action succeeded (tool_call) — false on downstream error. */
  ok?: boolean;
  /** Short reason (block cause, error class). Never contains args/secrets. */
  reason?: string;
  /** Session id (multi-tenant daemon), if available. */
  sessionId?: string;
}

export interface AuditLogOptions {
  /** Max events kept in memory (ring buffer). Default 5000. */
  bufferSize?: number;
  /** Optional JSONL file path for durable, append-only forensics. */
  filePath?: string;
}

/**
 * Append-only safety audit log. Recording never throws — a forensics logger
 * must not break the thing it observes.
 */
export class AuditLog {
  private readonly buffer: AuditEvent[] = [];
  private readonly bufferSize: number;
  private readonly filePath?: string;
  private counts: Record<AuditEventType, number> = {
    connect: 0,
    tool_call: 0,
    tool_blocked: 0,
    egress_blocked: 0,
    egress_allowed: 0,
    disconnect: 0,
  };

  constructor(opts: AuditLogOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 5000;
    this.filePath = opts.filePath;
  }

  /** Record an event. Caller supplies everything except the timestamp. */
  record(event: Omit<AuditEvent, "ts">): void {
    try {
      const full: AuditEvent = { ts: new Date().toISOString(), ...event };

      this.buffer.push(full);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
      this.counts[full.type] = (this.counts[full.type] ?? 0) + 1;

      // Durable append (best-effort). JSONL = one event per line.
      if (this.filePath) {
        try {
          appendFileSync(this.filePath, JSON.stringify(full) + "\n", "utf-8");
        } catch (err) {
          log.debug("Audit file append failed", { error: String(err) });
        }
      }
    } catch (err) {
      // A logger must never break the caller.
      log.debug("Audit record failed", { error: String(err) });
    }
  }

  /**
   * Query recent events, newest first. Filterable by slug, type, and a
   * "security-relevant only" flag (blocks + errors — the events a reviewer
   * actually cares about).
   */
  query(opts: {
    slug?: string;
    type?: AuditEventType;
    securityRelevantOnly?: boolean;
    limit?: number;
  } = {}): AuditEvent[] {
    const limit = opts.limit ?? 100;
    let events = [...this.buffer].reverse();

    if (opts.slug) events = events.filter((e) => e.slug === opts.slug);
    if (opts.type) events = events.filter((e) => e.type === opts.type);
    if (opts.securityRelevantOnly) {
      events = events.filter(
        (e) =>
          e.type === "tool_blocked" ||
          e.type === "egress_blocked" ||
          (e.type === "tool_call" && e.ok === false),
      );
    }
    return events.slice(0, limit);
  }

  /** Aggregate counts by event type (for the summary view). */
  summary(): {
    counts: Record<AuditEventType, number>;
    total: number;
    /** Count of security-relevant events (blocks + errors). */
    securityEvents: number;
  } {
    const total = Object.values(this.counts).reduce((a, b) => a + b, 0);
    const securityEvents =
      this.counts.tool_blocked + this.counts.egress_blocked;
    return { counts: { ...this.counts }, total, securityEvents };
  }
}
