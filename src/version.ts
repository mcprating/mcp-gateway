import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The gateway's version, read from package.json at runtime.
 *
 * Its own module so there is exactly one copy. It previously lived inline in
 * gateway-server.ts, and meta-tools/health.ts carried a second, hardcoded copy
 * that drifted to "0.1.0" while the package shipped 0.2.2 — so `mcp_gateway_health`,
 * the tool whose entire job is diagnostics, reported a version two minor
 * releases stale in every bug report.
 *
 * gateway-server.ts imports health.ts, so health.ts cannot import back from it
 * without a cycle; a leaf module both can depend on is what keeps them honest.
 *
 * Resolves the package root from either dist/ or src/, so tsx and the built
 * output agree.
 */
export const GATEWAY_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version;
  } catch {
    return "0.0.0-unknown";
  }
})();
