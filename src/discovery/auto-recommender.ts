import type { RegistryClient } from "../registry/registry-client.js";
import type { ConnectionManager } from "../connection/connection-manager.js";
import type { UsageTracker, ToolCallEvent } from "../analytics/usage-tracker.js";
import { log } from "../utils/logger.js";

// ── Recommendation Types ─────────────────────────────────────────────────────

export interface ServerRecommendation {
  slug: string;
  name: string;
  reason: string;
  qualityScore: number;
  relevanceScore: number;
}

// ── Auto-Recommender ─────────────────────────────────────────────────────────

/**
 * Analyzes tool call patterns and recommends relevant servers.
 */
export class AutoRecommender {
  constructor(
    private readonly registryClient: RegistryClient,
    private readonly connectionManager: ConnectionManager,
  ) {}

  /**
   * Intent-based recommendation: search the registry for servers matching
   * a free-text goal/query, ranked by quality + relevance.
   *
   * This is the agent-friendly path — the agent passes the user's actual
   * intent and gets back relevant servers regardless of past usage.
   * Server-side intent expansion (cloud storage → dropbox/gdrive/...)
   * runs transparently.
   */
  async recommendByQuery(
    query: string,
    options: { limit?: number; category?: string } = {},
  ): Promise<ServerRecommendation[]> {
    const limit = options.limit ?? 5;
    const connectedSlugs = new Set(
      this.connectionManager.listConnections().map((c) => c.slug),
    );

    try {
      // Over-fetch so we can filter out connected servers and still hit the cap
      const result = await this.registryClient.search(query, {
        limit: Math.max(limit * 3, 15),
        category: options.category,
      });

      const recommendations: ServerRecommendation[] = [];
      const queryTerms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

      for (const server of result.data) {
        if (connectedSlugs.has(server.slug)) continue;

        const relevance = this.computeRelevance(server, queryTerms);
        recommendations.push({
          slug: server.slug,
          name: server.name || server.slug,
          reason: this.buildIntentReason(server, query, queryTerms),
          qualityScore: server.qualityScore ?? 0,
          relevanceScore: relevance,
        });
      }

      // Sort by combined quality + relevance. For intent queries, registry
      // ranking already incorporates semantic + FTS + intent expansion, so
      // we lean slightly more on quality to break ties.
      return recommendations
        .sort(
          (a, b) =>
            b.qualityScore * 0.5 + b.relevanceScore * 0.5 -
            (a.qualityScore * 0.5 + a.relevanceScore * 0.5),
        )
        .slice(0, limit);
    } catch (err) {
      log.warn("Registry search failed for intent query", {
        query,
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Analyze recent tool calls and suggest relevant servers from the registry.
   */
  async recommend(
    recentCalls: ToolCallEvent[],
    usageTracker?: UsageTracker,
  ): Promise<ServerRecommendation[]> {
    // Extract keywords from recent tool usage patterns
    const keywords = this.extractKeywords(recentCalls);

    if (keywords.length === 0) {
      log.debug("No keywords extracted from recent calls, using general recommendations");
      keywords.push("popular", "tools");
    }

    log.debug("Recommending servers based on usage patterns", { keywords });

    // Search registry for each keyword set
    const allResults = new Map<string, ServerRecommendation>();
    const connectedSlugs = new Set(
      this.connectionManager.listConnections().map((c) => c.slug),
    );

    for (const keyword of keywords.slice(0, 5)) {
      try {
        const results = await this.registryClient.search(keyword, { limit: 10 });
        for (const server of results.data) {
          // Skip already-connected servers
          if (connectedSlugs.has(server.slug)) continue;

          // Skip if already found with a better score
          const existing = allResults.get(server.slug);
          const relevance = this.computeRelevance(server, keywords);
          if (existing && existing.relevanceScore >= relevance) continue;

          allResults.set(server.slug, {
            slug: server.slug,
            name: server.name || server.slug,
            reason: this.buildReason(server, keywords),
            qualityScore: server.qualityScore ?? 0,
            relevanceScore: relevance,
          });
        }
      } catch (err) {
        log.debug("Registry search failed for keyword", {
          keyword,
          error: String(err),
        });
      }
    }

    // Sort by combined relevance + quality score
    const recommendations = [...allResults.values()]
      .sort(
        (a, b) =>
          b.relevanceScore * 0.6 + b.qualityScore * 0.4 -
          (a.relevanceScore * 0.6 + a.qualityScore * 0.4),
      )
      .slice(0, 5);

    return recommendations;
  }

  /**
   * Extract keywords from tool call patterns.
   */
  private extractKeywords(calls: ToolCallEvent[]): string[] {
    const words = new Map<string, number>();

    for (const call of calls) {
      // Extract words from tool names
      const parts = call.toolName
        .replace(/[_-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);

      for (const part of parts) {
        const lower = part.toLowerCase();
        words.set(lower, (words.get(lower) || 0) + 1);
      }

      // Extract category hints from slug
      const slugParts = call.slug
        .replace(/[_\-@/.]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);

      for (const part of slugParts) {
        const lower = part.toLowerCase();
        words.set(lower, (words.get(lower) || 0) + 0.5);
      }
    }

    // Sort by frequency, take top keywords
    return [...words.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);
  }

  /**
   * Compute a relevance score for a server against the extracted keywords.
   */
  private computeRelevance(
    server: { name: string; description: string | null; slug: string },
    keywords: string[],
  ): number {
    let score = 0;
    const text = `${server.name} ${server.description || ""} ${server.slug}`.toLowerCase();

    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        score += 1;
      }
    }

    return score / Math.max(keywords.length, 1);
  }

  /**
   * Build a human-readable reason for the recommendation.
   */
  private buildReason(
    server: { name: string; description: string | null },
    keywords: string[],
  ): string {
    const matching = keywords.filter((k) =>
      `${server.name} ${server.description || ""}`.toLowerCase().includes(k),
    );

    if (matching.length > 0) {
      return `Related to your recent usage (${matching.slice(0, 3).join(", ")})`;
    }
    return "Popular server that may complement your workflow";
  }

  /**
   * Build a human-readable reason for an intent-based (query) recommendation.
   */
  private buildIntentReason(
    server: { name: string; description: string | null },
    query: string,
    queryTerms: string[],
  ): string {
    const text = `${server.name} ${server.description || ""}`.toLowerCase();
    const directHits = queryTerms.filter((t) => text.includes(t));
    if (directHits.length > 0) {
      return `Matches "${query}" (terms: ${directHits.slice(0, 3).join(", ")})`;
    }
    return `Surfaced via intent expansion for "${query}"`;
  }
}
