import type { RegistryServer, TrustTier } from "./types.js";

/**
 * What MCP Rating knows about a server, as mcp_connect shows it before and
 * after starting it: score and tier, safety flags with their reasons, our own
 * start test, and when it was last released and worked on.
 *
 * The wording mirrors MCP Rating's (src/mcp/maintenance.ts, src/mcp/evidence.ts,
 * src/scoring/safety-scorer.ts): an agent should read the same facts from the
 * gateway as from the site or get_server. Keep them in step.
 */

export interface Maintenance {
  lastRelease: {
    version: string | null;
    date: string;
    registry: "npm" | "pypi" | "official-registry";
    releasesLastYear: number | null;
    checkedAt: string | null;
  } | null;
  lastCodePush: { date: string; checkedAt: string | null } | null;
  openIssuesAndPrs: number | null;
  archived: boolean;
  deprecated: boolean;
}

export interface TrustFacts {
  /** Who rated it ("mcprating.io"), or null when nobody has. */
  by: string | null;
  /** Whether MCP Rating was asked at all — it isn't when it's not one of the registries. */
  consulted: boolean;
  /** The rating's page. */
  url: string | null;
  qualityScore: number | null;
  tier: TrustTier;
  safetyScore: number | null;
  safetyFlags: string[];
  verification: RegistryServer["verification"];
  maintenance: Maintenance | null;
  delistedReason: string | null;
  trustWarning: string | null;
}

// ── Maintenance (mirrors MCP Rating's src/mcp/maintenance.ts) ───────────────

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function maintenanceFacts(s: { version?: string | null; metadata?: unknown }): Maintenance {
  const m = (s.metadata ?? {}) as Record<string, unknown>;
  const rel = m.latestRelease as Record<string, unknown> | undefined;
  let lastRelease: Maintenance["lastRelease"] = null;
  const relDate = iso(rel?.publishedAt);
  if (rel && relDate && (rel.registry === "npm" || rel.registry === "pypi")) {
    lastRelease = {
      version: typeof rel.version === "string" ? rel.version : null,
      date: relDate,
      registry: rel.registry,
      releasesLastYear: count(rel.releasesLastYear),
      checkedAt: iso(rel.checkedAt),
    };
  } else if (m.registryName && iso(m.publishedAt)) {
    lastRelease = {
      version: s.version ?? null,
      date: iso(m.publishedAt)!,
      registry: "official-registry",
      releasesLastYear: null,
      checkedAt: iso(m.registryCheckedAt),
    };
  }
  const pushed = iso(m.pushedAt);
  return {
    lastRelease,
    lastCodePush: pushed ? { date: pushed, checkedAt: iso(m.githubCheckedAt) } : null,
    openIssuesAndPrs: count(m.openIssuesCount),
    archived: m.archived === true,
    deprecated: m.deprecated === true || (typeof m.deprecated === "string" && m.deprecated.length > 0),
  };
}

const day = (isoDate: string) => isoDate.slice(0, 10);

/** "today", "12 days ago", "16 months ago", "3 years ago". */
export function ago(isoDate: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(isoDate)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365.25)} years ago`;
}

const REGISTRY_NAME = { npm: "npm", pypi: "PyPI", "official-registry": "official MCP registry" } as const;

export function maintenanceLines(m: Maintenance, now: Date = new Date()): string[] {
  const lines: string[] = [];
  if (m.lastRelease) {
    const r = m.lastRelease;
    const v = r.version ? `${r.version} on ` : "";
    const cadence =
      r.releasesLastYear !== null
        ? `; ${r.releasesLastYear} release${r.releasesLastYear === 1 ? "" : "s"} in the 12 months before we checked`
        : "";
    lines.push(`Last release: ${v}${day(r.date)}, ${ago(r.date, now)} (${REGISTRY_NAME[r.registry]}${cadence}).`);
  }
  if (m.lastCodePush) {
    const checked = m.lastCodePush.checkedAt ? `checked ${day(m.lastCodePush.checkedAt)}` : "as of an earlier crawl";
    lines.push(`Last code push: ${day(m.lastCodePush.date)}, ${ago(m.lastCodePush.date, now)} (GitHub, ${checked}).`);
  }
  if (m.archived) lines.push("The source repository is archived.");
  if (m.deprecated) lines.push("Marked deprecated by its publisher.");
  if (!lines.length) lines.push("No release or activity dates for this server.");
  return lines;
}

// ── Start test (mirrors MCP Rating's src/mcp/evidence.ts) ───────────────────

export function startTestLine(v: RegistryServer["verification"]): string {
  if (!v) return "Not tested by MCP Rating yet — no evidence either way.";
  const when = String(v.lastAttemptedAt).slice(0, 10);
  const tally = `${v.verifiedCount} of ${v.attemptCount} attempt${v.attemptCount === 1 ? "" : "s"} started`;
  switch (v.latestOutcome) {
    case "verified":
      return `✓ Started in MCP Rating's test (${when}); ${tally}.`;
    case "failed_to_start":
      return `✗ Didn't start in MCP Rating's latest test (${when}, no credentials given); ${tally}.`;
    case "needs_credentials":
      return `Needs credentials to start; MCP Rating's test (${when}) gives none, so it stopped there — not a failure.`;
    case "unsupported":
      return `MCP Rating can't run this one in its test (${when}) — no evidence either way.`;
    default:
      return `Attempted in MCP Rating's test (${when}); ${tally}.`;
  }
}

// ── Safety (mirrors MCP Rating's src/scoring/safety-scorer.ts) ──────────────

const FLAG_REASONS: Record<string, string> = {
  archived: "Source repository is archived (no longer maintained).",
  abandoned: "No activity for over a year — likely abandoned.",
  deprecated: "Package is marked deprecated by its publisher.",
  "install-script-risk": "Install command uses a shell-pipe pattern (e.g. curl | bash) — review before running.",
  "possible-typosquat": "Name closely resembles a popular package — verify it is the one you intend.",
  "no-repository": "No public source repository to inspect.",
  stale: "No activity for over 6 months.",
  "no-license": "No license declared.",
  "no-install-command": "No install command available — provenance unclear.",
  "unverified-publisher": "No author/owner attribution.",
  "low-adoption": "Effectively no usage signal (very new or unused).",
};

/** safe ≥ 80, caution 50–79, risk < 50 — as the site's badge. */
export function safetyBand(score: number): "safe" | "caution" | "risk" {
  if (score >= 80) return "safe";
  if (score >= 50) return "caution";
  return "risk";
}

export function safetyLines(score: number | null, flags: string[]): string[] {
  if (score === null) return [];
  const head = `Safety: ${score}/100 (${safetyBand(score)})${flags.length ? "" : ", no flags"}.`;
  return [head, ...flags.map((f) => `- ${f}: ${FLAG_REASONS[f] ?? "flagged by MCP Rating."}`)];
}

// ── Together ────────────────────────────────────────────────────────────────

/** The "What MCP Rating knows" block, as markdown lines. */
export function trustLines(f: TrustFacts, now: Date = new Date()): string[] {
  const lines: string[] = [];
  if (f.delistedReason) lines.push(`⛔ ${f.by ?? "MCP Rating"}: ${f.delistedReason}`);
  if (f.trustWarning) lines.push(`⚠️ ${f.trustWarning}`);
  if (!f.by) {
    lines.push(
      f.consulted
        ? "MCP Rating has no record of this package: no score, no safety screen, no start test."
        : "Not rated: MCP Rating isn't one of the configured registries, so nothing was checked.",
    );
    return lines;
  }
  lines.push(`Score: ${f.qualityScore === null ? "unrated" : `${f.qualityScore}/100`} · Trust: ${f.tier}${f.url ? ` · ${f.url}` : ""}`);
  lines.push(...safetyLines(f.safetyScore, f.safetyFlags));
  lines.push(startTestLine(f.verification));
  if (f.maintenance) lines.push(...maintenanceLines(f.maintenance, now));
  return lines;
}
