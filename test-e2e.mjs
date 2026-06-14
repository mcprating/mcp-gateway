#!/usr/bin/env node
/**
 * End-to-end test for MCP Gateway.
 * Spawns the gateway, sends MCP messages, and verifies responses.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const gateway = spawn("node", ["--import", "tsx", "src/index.ts"], {
  cwd: import.meta.dirname,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MCP_GATEWAY_LOG_LEVEL: "warn" },
});

// Collect stderr for debugging
let stderrBuf = "";
gateway.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

const rl = createInterface({ input: gateway.stdout });
const responses = new Map();
const notifications = [];

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      responses.set(msg.id, msg);
    } else if (msg.method) {
      notifications.push(msg);
    }
  } catch {}
});

function send(msg) {
  gateway.stdin.write(JSON.stringify(msg) + "\n");
}

function waitForResponse(id, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (timeoutMs <= 0) return reject(new Error(`Timeout waiting for id=${id}`));
      timeoutMs -= 100;
      setTimeout(check, 100);
    };
    check();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

try {
  // 1. Initialize
  console.log("\n🔌 Step 1: MCP Initialize");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gateway-test", version: "1.0.0" },
    },
  });
  const initResp = await waitForResponse(1);
  assert(initResp.result?.serverInfo?.name === "mcp-gateway", "Server name is mcp-gateway");
  assert(initResp.result?.capabilities?.tools?.listChanged === true, "listChanged capability enabled");

  // Send initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(500);

  // 2. List tools (should have 7 meta-tools)
  console.log("\n🔧 Step 2: List Meta-Tools");
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResp = await waitForResponse(2);
  const toolNames = toolsResp.result?.tools?.map((t) => t.name) || [];
  assert(toolNames.includes("mcp_discover"), "mcp_discover registered");
  assert(toolNames.includes("mcp_connect"), "mcp_connect registered");
  assert(toolNames.includes("mcp_disconnect"), "mcp_disconnect registered");
  assert(toolNames.includes("mcp_list_active"), "mcp_list_active registered");
  assert(toolNames.includes("mcp_server_info"), "mcp_server_info registered");
  assert(toolNames.includes("mcp_call_tool"), "mcp_call_tool registered");
  assert(toolNames.includes("mcp_gateway_health"), "mcp_gateway_health registered");
  assert(toolNames.includes("mcp_profiles"), "mcp_profiles registered");
  assert(toolNames.includes("mcp_groups"), "mcp_groups registered");
  assert(toolNames.includes("mcp_usage"), "mcp_usage registered");
  assert(toolNames.includes("mcp_recommend"), "mcp_recommend registered");
  assert(toolNames.includes("mcp_sandbox"), "mcp_sandbox registered");
  assert(toolNames.includes("mcp_audit"), "mcp_audit registered");
  const META_TOOL_COUNT = 13;
  assert(toolNames.length === META_TOOL_COUNT, `Exactly ${META_TOOL_COUNT} meta-tools (got ${toolNames.length})`);

  // 3. List active (should be empty)
  console.log("\n📋 Step 3: List Active (empty)");
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "mcp_list_active", arguments: {} },
  });
  const listResp = await waitForResponse(3);
  assert(
    listResp.result?.content?.[0]?.text?.includes("No MCP servers"),
    "No servers connected initially",
  );

  // 3b. Gateway health (no connections)
  console.log("\n💊 Step 3b: Gateway Health (no connections)");
  send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "mcp_gateway_health", arguments: {} },
  });
  const healthResp0 = await waitForResponse(30);
  const healthText0 = healthResp0.result?.content?.[0]?.text || "";
  assert(!healthResp0.result?.isError, "Health tool succeeds");
  assert(healthText0.includes("MCP Gateway Health"), "Health output has header");
  assert(healthText0.includes("Version"), "Health output has version");
  assert(healthText0.includes("Uptime"), "Health output has uptime");
  assert(healthText0.includes("Registry"), "Health output has registry section");
  assert(healthText0.includes("No servers connected"), "Health shows no connections");

  // 4. HITL Confirmation: Connect without confirmed (should get warning)
  console.log("\n🛡️ Step 4: HITL Confirmation — Connect Without Confirmed");
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "mcp_connect",
      arguments: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
  });
  const confirmResp = await waitForResponse(4, 15000);
  const confirmText = confirmResp.result?.content?.[0]?.text || "";
  assert(!confirmResp.result?.isError, "Confirmation request is not an error");
  assert(confirmText.includes("unknown"), "Warning mentions unknown trust tier");
  assert(confirmText.includes("confirmed"), "Warning tells user to confirm");

  // Verify no connection was made
  send({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { name: "mcp_list_active", arguments: {} },
  });
  const listAfterWarn = await waitForResponse(40);
  assert(
    listAfterWarn.result?.content?.[0]?.text?.includes("No MCP servers"),
    "No servers connected after unconfirmed attempt",
  );

  // 5. Connect with confirmed: true
  console.log("\n🔗 Step 5: Connect with confirmed: true");
  notifications.length = 0; // reset notification counter
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "mcp_connect",
      arguments: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        confirmed: true,
      },
    },
  });
  const connectResp = await waitForResponse(5, 60000);
  assert(!connectResp.result?.isError, "Connect succeeded without error");
  const connectText = connectResp.result?.content?.[0]?.text || "";
  assert(connectText.includes("Connected"), "Response confirms connection");
  assert(connectText.includes("echo"), "Echo tool listed in response");

  // Wait for notifications to settle
  await sleep(2000);
  assert(
    notifications.some((n) => n.method === "notifications/tools/list_changed"),
    "Received tools/list_changed notification",
  );

  // 6. Verify tools list now includes proxied tools
  console.log("\n🔧 Step 6: Verify Proxied Tools");
  send({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
  const tools2Resp = await waitForResponse(6);
  const allTools = tools2Resp.result?.tools?.map((t) => t.name) || [];
  const proxiedTools = allTools.filter((n) => n.includes("__"));
  assert(proxiedTools.length > 0, `Proxied tools registered (${proxiedTools.length} found)`);
  assert(
    proxiedTools.some((n) => n.endsWith("__echo")),
    "Echo tool is proxied with namespace",
  );
  assert(allTools.length > META_TOOL_COUNT, `Total tools > ${META_TOOL_COUNT} meta-tools (got ${allTools.length})`);

  // 7. Call the proxied echo tool
  console.log("\n📞 Step 7: Call Proxied Echo Tool");
  const echoToolName = proxiedTools.find((n) => n.endsWith("__echo"));
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: echoToolName,
      arguments: { message: "Hello from MCP Gateway!" },
    },
  });
  const echoResp = await waitForResponse(7, 15000);
  assert(!echoResp.result?.isError, "Echo call succeeded");
  const echoText = echoResp.result?.content?.[0]?.text || "";
  assert(echoText.includes("Hello from MCP Gateway!"), `Echo returned our message: "${echoText.substring(0, 60)}"`);

  // 7b. Call via mcp_call_tool fallback
  console.log("\n📞 Step 7b: Call via mcp_call_tool");
  send({
    jsonrpc: "2.0",
    id: 70,
    method: "tools/call",
    params: {
      name: "mcp_call_tool",
      arguments: {
        name: echoToolName,
        arguments: { message: "Hello via call_tool!" },
      },
    },
  });
  const callToolResp = await waitForResponse(70, 15000);
  assert(!callToolResp.result?.isError, "mcp_call_tool succeeded");
  const callToolText = callToolResp.result?.content?.[0]?.text || "";
  assert(callToolText.includes("Hello via call_tool!"), "call_tool returned echo message");

  // 7c. Gateway health (with connection)
  console.log("\n💊 Step 7c: Gateway Health (with connection)");
  send({
    jsonrpc: "2.0",
    id: 71,
    method: "tools/call",
    params: { name: "mcp_gateway_health", arguments: {} },
  });
  const healthResp1 = await waitForResponse(71);
  const healthText1 = healthResp1.result?.content?.[0]?.text || "";
  assert(!healthResp1.result?.isError, "Health tool succeeds with connection");
  assert(healthText1.includes("**Connections:** 1"), "Health shows 1 connection");
  assert(healthText1.includes("ready"), "Health shows ready state");

  // 8. Disconnect
  console.log("\n🔌 Step 8: Disconnect");
  send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "mcp_disconnect",
      arguments: { slug: "npx-modelcontextprotocol-server-everything" },
    },
  });
  const disconnResp = await waitForResponse(8);
  assert(!disconnResp.result?.isError, "Disconnect succeeded");
  assert(
    disconnResp.result?.content?.[0]?.text?.includes("Disconnected"),
    "Disconnect confirmed",
  );

  // 9. Verify tools list is back to meta-tools only
  console.log("\n🔧 Step 9: Verify Tools After Disconnect");
  await sleep(1000);
  send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
  const tools3Resp = await waitForResponse(9);
  const finalTools = tools3Resp.result?.tools?.map((t) => t.name) || [];
  assert(finalTools.length === META_TOOL_COUNT, `Back to ${META_TOOL_COUNT} meta-tools (got ${finalTools.length})`);
  assert(
    !finalTools.some((n) => n.includes("__")),
    "No proxied tools remain",
  );

  // 10. Duplicate connection protection
  console.log("\n🚫 Step 10: Duplicate Connection Protection");
  // First connect (with confirmed)
  send({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "mcp_connect",
      arguments: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        confirmed: true,
      },
    },
  });
  await waitForResponse(10, 60000);
  // Try duplicate
  send({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "mcp_connect",
      arguments: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        confirmed: true,
      },
    },
  });
  const dupResp = await waitForResponse(11, 15000);
  assert(dupResp.result?.isError === true, "Duplicate connection returns error");
  assert(
    dupResp.result?.content?.[0]?.text?.includes("already connected"),
    "Error mentions already connected",
  );
  // Clean up
  send({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "mcp_disconnect",
      arguments: { slug: "npx-modelcontextprotocol-server-everything" },
    },
  });
  await waitForResponse(12);

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  gateway.kill();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error("\n💥 Test error:", err.message);
  if (stderrBuf) console.error("Gateway stderr:", stderrBuf.substring(0, 500));
  gateway.kill();
  process.exit(1);
}
