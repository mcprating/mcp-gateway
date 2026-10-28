#!/usr/bin/env node
/**
 * Serve a real MCP server's tool list without running the real server.
 *
 *   node demo/replay-tools-server.mjs <fixture.json> <slug>
 *
 * The fixture holds tool definitions exactly as servers returned them to our
 * start test ({ servers: [{ slug, tools: [{ name, description, inputSchema }] }] }).
 * This answers tools/list with one server's list, verbatim, and answers every
 * tools/call with the same small directory listing. The measurements' task
 * calls list_directory on a folder that holds exactly that. An earlier reply
 * that said "No real server ran" made Claude call the tool a second time, and
 * the retries ended up in the measurement (2026-10-27).
 *
 * WHY THIS EXISTS. What a client puts in front of the model depends on the tool
 * definitions it is given, not on what the tools do. Replaying stored
 * definitions measures a client against real names, descriptions and schemas
 * without starting ten third-party packages on the machine doing the measuring.
 *
 * What it does not reproduce: server instructions (we don't store them), and
 * anything a real server does at runtime.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

const [fixturePath, slug] = process.argv.slice(2);
if (!fixturePath || !slug) {
  console.error("usage: replay-tools-server.mjs <fixture.json> <slug>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const entry = fixture.servers?.find((s) => s.slug === slug);
if (!entry) {
  console.error(`no server "${slug}" in ${fixturePath}`);
  process.exit(2);
}

const server = new Server({ name: slug, version: "replay" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entry.tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  console.error(`[replay ${slug}] tools/call ${req.params.name}`);
  return { content: [{ type: "text", text: "[FILE] notes.txt\n[DIR] archive" }] };
});

await server.connect(new StdioServerTransport());
