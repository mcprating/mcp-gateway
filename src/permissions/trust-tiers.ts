import type { TrustTier } from "../registry/types.js";

/** Human-readable label for tool description prefixes */
export const TRUST_LABELS: Record<TrustTier, string> = {
  verified: "Verified",
  trusted: "Trusted",
  community: "Community",
  unknown: "Unverified",
};

/** Default max concurrent tool calls per trust tier */
export const DEFAULT_MAX_CONCURRENT: Record<TrustTier, number> = {
  verified: 10,
  trusted: 5,
  community: 3,
  unknown: 1,
};

/** Policy controlling connection behavior per trust tier */
export interface TrustPolicy {
  /** Must the user explicitly confirm before connecting? */
  requiresConfirmation: boolean;
  /** Can this server be connected at all? */
  allowByDefault: boolean;
  /** Description shown to user in confirmation warnings */
  description: string;
}

/** Default trust policies per tier */
export const DEFAULT_TRUST_POLICIES: Record<TrustTier, TrustPolicy> = {
  verified: {
    requiresConfirmation: false,
    allowByDefault: true,
    description: "Verified server — high quality, officially reviewed.",
  },
  trusted: {
    requiresConfirmation: false,
    allowByDefault: true,
    description: "Trusted server — good quality with repository and install command.",
  },
  community: {
    requiresConfirmation: true,
    allowByDefault: true,
    description: "Community server — listed in registry with basic quality. User confirmation recommended.",
  },
  unknown: {
    requiresConfirmation: true,
    allowByDefault: true,
    description: "Unverified server — unknown origin. User confirmation required.",
  },
};

/** Get the trust policy for a given tier */
export function getTrustPolicy(tier: TrustTier): TrustPolicy {
  return DEFAULT_TRUST_POLICIES[tier];
}
