#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGatewayServer } from "./gateway-server.js";
import { runHttpDaemon } from "./http-daemon.js";
import { loadConfig } from "./config/gateway-config.js";
import { setLogLevel, log } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // HTTP daemon mode: when a port is configured, run as a long-running HTTP
  // server that many MCP clients can connect to. Otherwise, classic stdio.
  if (config.httpPort) {
    log.info("Starting MCP Gateway (HTTP daemon mode)", {
      registryApiUrl: config.registryApiUrl,
      port: config.httpPort,
      host: config.httpHost,
    });
    const hasToken =
      Boolean(config.httpToken) ||
      (config.httpTokens && Object.keys(config.httpTokens).length > 0);
    if (!hasToken) {
      process.stderr.write(
        "MCP Gateway HTTP daemon requires MCP_GATEWAY_HTTP_TOKEN or MCP_GATEWAY_HTTP_TOKENS to be set.\n",
      );
      process.exit(1);
    }
    await runHttpDaemon(config, {
      port: config.httpPort,
      host: config.httpHost || "127.0.0.1",
      token: config.httpToken,
      tokens: config.httpTokens,
      allowedHosts: config.httpAllowedHosts,
      allowedOrigins: config.httpAllowedOrigins,
    });
    return;
  }

  log.info("Starting MCP Gateway", {
    registryApiUrl: config.registryApiUrl,
    maxConnections: config.maxConnections,
  });

  const { mcpServer, connectionManager } = createGatewayServer(config);
  const transport = new StdioServerTransport();

  // Graceful shutdown — only run once
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Gateway shutting down...");
    try {
      await connectionManager.disconnectAll();
    } catch (err) {
      log.warn("Error during disconnectAll", { error: String(err) });
    }
    try {
      await mcpServer.close();
    } catch (err) {
      log.warn("Error closing MCP server", { error: String(err) });
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Safety nets for unhandled errors — log but don't crash the gateway
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", { error: String(err), stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", { reason: String(reason) });
  });

  await mcpServer.connect(transport);
  log.info("MCP Gateway connected and ready");

  // Start health monitoring
  connectionManager.startHealthChecks();

  // Auto-connect from saved profiles (fire-and-forget)
  connectionManager.autoConnectFromProfiles().catch((err) => {
    log.warn("Error during auto-connect from profiles", { error: String(err) });
  });
}

main().catch((err) => {
  process.stderr.write(`MCP Gateway fatal error: ${String(err)}\n`);
  process.exit(1);
});
