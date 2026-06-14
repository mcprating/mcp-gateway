import { log } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

export interface AdEvent {
  serverSlug: string;
  eventType: "connect" | "tool_usage";
  toolName?: string;
  sessionId: string;
  timestamp: Date;
}

/**
 * Tracks connect and tool-usage events for promoted servers.
 * Reports events back to the MCP-Rating API via fire-and-forget HTTP POST.
 */
export class AdTracker {
  /** Unique session ID for this gateway instance */
  readonly sessionId: string;

  /** In-memory event log for diagnostics */
  private events: AdEvent[] = [];

  /** Count of tracked events by type */
  private eventCounts = { connect: 0, tool_usage: 0 };

  constructor(
    private readonly registryApiUrl: string,
    private readonly partnerKey: string,
  ) {
    this.sessionId = randomUUID();
    log.info("Ad tracker initialized", {
      sessionId: this.sessionId,
      registryApiUrl,
    });
  }

  /**
   * Track a server connect event.
   * Records as high-value click (click_type: 'install') in the ad network.
   */
  async trackConnect(serverSlug: string): Promise<void> {
    this.events.push({
      serverSlug,
      eventType: "connect",
      sessionId: this.sessionId,
      timestamp: new Date(),
    });
    this.eventCounts.connect++;

    // Trim in-memory log to last 500 events
    if (this.events.length > 500) {
      this.events = this.events.slice(-500);
    }

    // Fire-and-forget report to API
    this.reportEvent("install", serverSlug).catch((err) => {
      log.debug("Failed to report connect event", {
        serverSlug,
        error: String(err),
      });
    });
  }

  /**
   * Track a proxied tool usage event.
   * Records as action (CPA event) in the ad network.
   */
  async trackToolUsage(
    serverSlug: string,
    toolName: string,
  ): Promise<void> {
    this.events.push({
      serverSlug,
      eventType: "tool_usage",
      toolName,
      sessionId: this.sessionId,
      timestamp: new Date(),
    });
    this.eventCounts.tool_usage++;

    // Trim in-memory log
    if (this.events.length > 500) {
      this.events = this.events.slice(-500);
    }

    // Fire-and-forget report to API
    this.reportEvent("action_completed", serverSlug).catch((err) => {
      log.debug("Failed to report tool usage event", {
        serverSlug,
        toolName,
        error: String(err),
      });
    });
  }

  /**
   * Get partner earnings from the registry API.
   */
  async getPartnerEarnings(): Promise<{
    totalGrossCents: number;
    totalPartnerShareCents: number;
    eventCount: number;
  } | null> {
    try {
      const res = await fetch(`${this.registryApiUrl}/partners/me/revenue`, {
        headers: {
          "x-partner-key": this.partnerKey,
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as {
        totalGross: number;
        totalPartnerShare: number;
        count: number;
      };

      return {
        totalGrossCents: data.totalGross,
        totalPartnerShareCents: data.totalPartnerShare,
        eventCount: data.count,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get diagnostics info for the ad status meta-tool.
   */
  getStatus() {
    return {
      sessionId: this.sessionId,
      partnerKeyConfigured: true,
      eventCounts: { ...this.eventCounts },
      totalEvents: this.events.length,
      recentEvents: this.events.slice(-10).map((e) => ({
        serverSlug: e.serverSlug,
        eventType: e.eventType,
        toolName: e.toolName,
        timestamp: e.timestamp.toISOString(),
      })),
    };
  }

  /**
   * Report an ad event to the MCP-Rating API.
   * Fire-and-forget — errors are logged but don't propagate.
   */
  private async reportEvent(
    clickType: string,
    serverSlug: string,
  ): Promise<void> {
    const url = `${this.registryApiUrl}/partners/report-click`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-partner-key": this.partnerKey,
      },
      body: JSON.stringify({
        serverSlug,
        clickType,
        sessionId: this.sessionId,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      log.debug("Ad event report failed", {
        status: res.status,
        clickType,
        serverSlug,
      });
    }
  }
}
