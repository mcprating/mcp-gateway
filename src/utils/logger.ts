/**
 * Stderr-only logger for the MCP Gateway.
 *
 * CRITICAL: All output MUST go to stderr because stdout is reserved
 * for MCP JSON-RPC protocol messages. Writing anything else to stdout
 * would corrupt the protocol stream.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatMessage(level: LogLevel, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [mcp-gateway]`;
  if (data !== undefined) {
    return `${prefix} ${msg} ${JSON.stringify(data)}\n`;
  }
  return `${prefix} ${msg}\n`;
}

export const log = {
  debug(msg: string, data?: unknown): void {
    if (shouldLog("debug")) {
      process.stderr.write(formatMessage("debug", msg, data));
    }
  },

  info(msg: string, data?: unknown): void {
    if (shouldLog("info")) {
      process.stderr.write(formatMessage("info", msg, data));
    }
  },

  warn(msg: string, data?: unknown): void {
    if (shouldLog("warn")) {
      process.stderr.write(formatMessage("warn", msg, data));
    }
  },

  error(msg: string, data?: unknown): void {
    if (shouldLog("error")) {
      process.stderr.write(formatMessage("error", msg, data));
    }
  },
};
