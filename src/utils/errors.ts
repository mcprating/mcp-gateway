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

export class DuplicateConnectionError extends GatewayError {
  constructor(public readonly serverSlug: string) {
    super(
      `Server "${serverSlug}" is already connected.`,
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
