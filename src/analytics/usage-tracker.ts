import { log } from "../utils/logger.js";

// ── Event Types ──────────────────────────────────────────────────────────────

export interface ToolCallEvent {
  slug: string;
  toolName: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ToolAggregates {
  key: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastCalledAt: number;
  /** Recent latencies for p95 calculation (last 100) */
  latencies: number[];
}

export interface ServerAggregates {
  slug: string;
  totalCalls: number;
  totalErrors: number;
  avgLatencyMs: number;
}

export interface UsageStats {
  totalCalls: number;
  totalErrors: number;
  avgLatencyMs: number;
  topToolsByCalls: ToolAggregates[];
  slowestTools: ToolAggregates[];
  perServer: ServerAggregates[];
  recentCalls: ToolCallEvent[];
}

// ── Usage Tracker ────────────────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 10_000;
const LATENCY_WINDOW = 100; // Keep last 100 latencies for p95 calculation

/**
 * In-memory usage analytics tracker.
 * Uses a ring buffer for events and maintains per-tool aggregates.
 */
export class UsageTracker {
  private events: ToolCallEvent[] = [];
  private maxEvents: number;
  private insertIdx = 0;
  private totalInserted = 0;

  /** Per-tool aggregates keyed by "slug::toolName" */
  private toolAggregates = new Map<string, ToolAggregates>();

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.maxEvents = bufferSize;
  }

  /**
   * Record a completed tool call event.
   */
  recordCall(event: ToolCallEvent): void {
    // Ring buffer insert
    if (this.totalInserted < this.maxEvents) {
      this.events.push(event);
    } else {
      this.events[this.insertIdx] = event;
    }
    this.insertIdx = (this.insertIdx + 1) % this.maxEvents;
    this.totalInserted++;

    // Update aggregates
    const key = `${event.slug}::${event.toolName}`;
    let agg = this.toolAggregates.get(key);
    if (!agg) {
      agg = {
        key,
        callCount: 0,
        errorCount: 0,
        totalDurationMs: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        lastCalledAt: 0,
        latencies: [],
      };
      this.toolAggregates.set(key, agg);
    }

    agg.callCount++;
    if (!event.success) agg.errorCount++;
    agg.totalDurationMs += event.durationMs;
    agg.avgLatencyMs = agg.totalDurationMs / agg.callCount;
    agg.lastCalledAt = event.startedAt;

    // Track latencies for p95 (rolling window)
    agg.latencies.push(event.durationMs);
    if (agg.latencies.length > LATENCY_WINDOW) {
      agg.latencies.shift();
    }
    agg.p95LatencyMs = percentile(agg.latencies, 95);
  }

  /**
   * Get overall usage statistics.
   */
  getStats(slug?: string): UsageStats {
    const allAggregates = [...this.toolAggregates.values()];
    const filtered = slug
      ? allAggregates.filter((a) => a.key.startsWith(`${slug}::`))
      : allAggregates;

    const totalCalls = filtered.reduce((s, a) => s + a.callCount, 0);
    const totalErrors = filtered.reduce((s, a) => s + a.errorCount, 0);
    const totalDuration = filtered.reduce((s, a) => s + a.totalDurationMs, 0);
    const avgLatencyMs = totalCalls > 0 ? totalDuration / totalCalls : 0;

    // Top tools by call count
    const topToolsByCalls = [...filtered]
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    // Slowest tools by avg latency (min 5 calls to be relevant)
    const slowestTools = [...filtered]
      .filter((a) => a.callCount >= 5)
      .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
      .slice(0, 10);

    // Per-server aggregates
    const serverMap = new Map<string, { totalCalls: number; totalErrors: number; totalDuration: number }>();
    for (const agg of filtered) {
      const aggSlug = agg.key.split("::")[0];
      const server = serverMap.get(aggSlug) || { totalCalls: 0, totalErrors: 0, totalDuration: 0 };
      server.totalCalls += agg.callCount;
      server.totalErrors += agg.errorCount;
      server.totalDuration += agg.totalDurationMs;
      serverMap.set(aggSlug, server);
    }
    const perServer: ServerAggregates[] = [...serverMap.entries()].map(
      ([s, v]) => ({
        slug: s,
        totalCalls: v.totalCalls,
        totalErrors: v.totalErrors,
        avgLatencyMs: v.totalCalls > 0 ? v.totalDuration / v.totalCalls : 0,
      }),
    );

    return {
      totalCalls,
      totalErrors,
      avgLatencyMs,
      topToolsByCalls,
      slowestTools,
      perServer,
      recentCalls: this.getRecentCalls(20),
    };
  }

  /**
   * Get the most recent tool call events.
   */
  getRecentCalls(limit = 20): ToolCallEvent[] {
    const len = Math.min(this.events.length, limit);
    const recent: ToolCallEvent[] = [];

    // Read backwards from the insertion point
    for (let i = 0; i < len; i++) {
      const idx = (this.insertIdx - 1 - i + this.events.length) % this.events.length;
      if (idx >= 0 && idx < this.events.length) {
        recent.push(this.events[idx]);
      }
    }

    return recent;
  }

  /**
   * Get tool calls that exceeded a latency threshold.
   */
  getSlowCalls(thresholdMs = 5000): ToolCallEvent[] {
    return this.events.filter((e) => e.durationMs >= thresholdMs);
  }

  /**
   * Reset all analytics data.
   */
  reset(): void {
    this.events = [];
    this.insertIdx = 0;
    this.totalInserted = 0;
    this.toolAggregates.clear();
    log.info("Usage analytics reset");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
