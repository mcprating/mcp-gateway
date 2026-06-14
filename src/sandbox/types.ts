/**
 * Sandbox capability model.
 *
 * A CapabilityManifest declares what a downstream MCP server is permitted to
 * access. It is the security contract between the gateway and an untrusted
 * server.
 *
 * Enforcement is layered:
 *  - **L1 (this release)**: environment-variable scoping is enforced at process
 *    spawn (cross-platform, in-process). Network / filesystem / subprocess
 *    fields are DECLARED and surfaced to the user via HITL, with hard
 *    enforcement delegated to L2 (container/microVM) and L3 (WASM).
 *  - **L2 / L3 (future)**: network egress filtering, filesystem jails,
 *    subprocess blocking, and resource limits become enforced.
 *
 * Declaring a capability today (even before it is hard-enforced) is valuable:
 * it makes the security posture visible, gives the user an informed consent
 * prompt, and means the manifest format is stable when enforcement lands.
 */

/** How a server may reach the network. */
export type NetworkMode = "none" | "allowlist" | "all";

/** Enforcement level actually applied to a running connection. */
export type EnforcementLevel =
  | "none" // No isolation (legacy behavior)
  | "l1-process" // Env scoping enforced; network/fs declared only
  | "l2-container" // Container/microVM isolation (future)
  | "l3-wasm"; // WASM isolation (future)

/** Environment-variable access policy. */
export interface EnvPolicy {
  /**
   * Explicit allowlist of environment variable NAMES the server may receive.
   * Anything not listed is stripped before spawn. Example: ["GITHUB_TOKEN"].
   */
  allow: string[];
  /**
   * When true, also inherit the SDK's safe default vars (PATH, HOME, etc.)
   * needed for the process to start. The allowlist is layered on top.
   */
  inheritDefaults: boolean;
}

/** Network egress policy. */
export interface NetworkPolicy {
  mode: NetworkMode;
  /**
   * Host:port patterns the server may reach when mode is "allowlist".
   * Example: ["api.github.com:443", "*.githubusercontent.com:443"].
   * Declared in L1; enforced in L2+.
   */
  allow: string[];
}

/** Filesystem access policy. Declared in L1; enforced in L2+. */
export interface FilesystemPolicy {
  /** Absolute paths (or globs) the server may read. */
  read: string[];
  /** Absolute paths (or globs) the server may write. */
  write: string[];
}

/** Optional resource limits. Declared in L1; enforced in L2+. */
export interface ResourceLimits {
  maxMemoryMb?: number;
  maxCpuPercent?: number;
  /** Wall-clock timeout for a single tool call, ms. */
  toolCallTimeoutMs?: number;
}

/**
 * The complete capability contract for one downstream server.
 */
export interface CapabilityManifest {
  /** Schema version for forward-compatibility. */
  version: 1;
  /** Server slug this manifest applies to. */
  slug: string;
  /** Enforcement level the gateway will actually apply. */
  enforcement: EnforcementLevel;
  env: EnvPolicy;
  network: NetworkPolicy;
  filesystem: FilesystemPolicy;
  /** Whether the server may spawn subprocesses. Declared in L1; enforced L2+. */
  subprocess: boolean;
  limits?: ResourceLimits;
}

/**
 * Human-readable summary of a manifest's notable grants, for display in the
 * HITL confirmation prompt. Each entry is a short risk-relevant statement.
 */
export interface ManifestSummary {
  enforcement: EnforcementLevel;
  /** e.g. "Read 1 environment variable: GITHUB_TOKEN" */
  lines: string[];
  /** True if the manifest grants anything the user should scrutinize. */
  hasSensitiveGrants: boolean;
}
