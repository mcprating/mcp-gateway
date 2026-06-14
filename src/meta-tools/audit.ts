import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditLog } from "../audit/audit-log.js";
import { toolError } from "../utils/errors.js";

/**
 * Register the `mcp_audit` meta-tool — the safety forensics view.
 *
 * Surfaces the audit trail of what sandboxed servers actually did and what the
 * sandbox blocked: tool calls (under their enforcement level), blocked tools,
 * blocked/allowed network egress, connects (with granted capability envelope),
 * and disconnects. This is the "did this untrusted server try anything?"
 * artifact a security reviewer reads — distinct from usage analytics.
 */
export function registerAudit(server: McpServer, auditLog: AuditLog): void {
  server.tool(
    "mcp_audit",
    "View the safety audit trail — a forensics log of what sandboxed MCP servers did and what the sandbox blocked (tool calls, blocked tools, blocked/allowed network egress, connects with granted capabilities). Use `securityOnly: true` to see only blocks and errors.",
    {
      slug: z
        .string()
        .optional()
        .describe("Filter to a single server slug"),
      event: z
        .enum([
          "connect",
          "tool_call",
          "tool_blocked",
          "egress_blocked",
          "egress_allowed",
          "disconnect",
        ])
        .optional()
        .describe("Filter to a single event type"),
      securityOnly: z
        .boolean()
        .optional()
        .describe("Show only security-relevant events (blocks + errored calls)"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Max events to return (default 50, newest first)"),
    },
    async ({ slug, event, securityOnly, limit = 50 }) => {
      try {
        const events = auditLog.query({
          slug,
          type: event,
          securityRelevantOnly: securityOnly,
          limit,
        });
        const summary = auditLog.summary();

        const lines: string[] = [
          "## 🛡️ Safety Audit Trail",
          "",
          `**Totals:** ${summary.total} events · ${summary.securityEvents} security-relevant (blocks)`,
          `**By type:** ` +
            Object.entries(summary.counts)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => `${t}=${n}`)
              .join(", "),
          "",
        ];

        if (events.length === 0) {
          lines.push("_No matching events recorded yet._");
        } else {
          lines.push(`### Recent events (${events.length})`, "");
          for (const e of events) {
            const icon =
              e.type === "tool_blocked" || e.type === "egress_blocked"
                ? "🚫"
                : e.type === "tool_call" && e.ok === false
                  ? "⚠️"
                  : e.type === "egress_allowed"
                    ? "🌐"
                    : e.type === "connect"
                      ? "🔗"
                      : e.type === "disconnect"
                        ? "🔌"
                        : "•";
            const parts = [
              `${icon} \`${e.ts}\``,
              `**${e.type}**`,
              e.slug,
              e.tool ? `tool=${e.tool}` : "",
              e.target ? `target=${e.target}` : "",
              e.enforcement ? `[${e.enforcement}]` : "",
              e.reason ? `— ${e.reason}` : "",
            ].filter(Boolean);
            lines.push("- " + parts.join(" · "));
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: { summary, events },
        };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
