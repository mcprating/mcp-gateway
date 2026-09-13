/**
 * Typed error classes for the MCP Gateway.
 */

export class GatewayError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export class ConnectionError extends GatewayError {
  constructor(
    message: string,
    public readonly serverSlug: string,
  ) {
    super(message, "CONNECTION_ERROR");
    this.name = "ConnectionError";
  }
}

export class RegistryError extends GatewayError {
  constructor(message: string) {
    super(message, "REGISTRY_ERROR");
    this.name = "RegistryError";
  }
}

export class TimeoutError extends GatewayError {
  constructor(
    message: string,
    public readonly serverSlug: string,
    public readonly timeoutMs: number,
  ) {
    super(message, "TIMEOUT_ERROR");
    this.name = "TimeoutError";
  }
}

export class MaxConnectionsError extends GatewayError {
  constructor(public readonly maxConnections: number) {
    super(
      `Maximum connections (${maxConnections}) reached. Disconnect a server first.`,
      "MAX_CONNECTIONS",
    );
    this.name = "MaxConnectionsError";
  }
}

/**
 * Note this reads as success, not failure, and says what to do next.
 *
 * The old text was `Server "X" is already connected.` — true, and a dead end.
 * Observed once: gemma-4-31B connected successfully, then re-issued the
 * identical mcp_connect six times, since nothing in that sentence said the goal
 * was met. Tool results are read by a model, so a bare statement of fact reads
 * as a prompt to retry; naming the exit costs nothing.
 *
 * Honest about the evidence: an A/B with the old wording restored did NOT
 * reproduce the loop — the model terminated cleanly either way. That run
 * diverged for another reason (mcp_discover hits the live registry, so the
 * model's inputs are not fixed between runs). This wording is justified as
 * design, not as a proven fix, and the loop it was written for remains
 * unexplained.
 */
export class DuplicateConnectionError extends GatewayError {
  constructor(public readonly serverSlug: string) {
    super(
      `Server "${serverSlug}" is already connected — nothing further is needed ` +
        `to connect it. Its tools are available now: call one directly, or use ` +
        `mcp_list_active to see what it exposes.`,
      "DUPLICATE_CONNECTION",
    );
    this.name = "DuplicateConnectionError";
  }
}

export class PermissionDeniedError extends GatewayError {
  constructor(
    public readonly serverSlug: string,
    message?: string,
  ) {
    super(
      message || `Connection to "${serverSlug}" was denied by trust policy.`,
      "PERMISSION_DENIED",
    );
    this.name = "PermissionDeniedError";
  }
}

/** Format any error as an MCP tool error result */
export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
