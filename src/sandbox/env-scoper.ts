import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "../utils/logger.js";
import type { EnvPolicy } from "./types.js";

/**
 * Build the scoped environment for a downstream stdio process.
 *
 * This is the first hard-enforced sandbox control (L1). Instead of passing the
 * full inherited environment (which can leak API keys, cloud credentials, and
 * tokens sitting in the parent process's env), we pass ONLY:
 *
 *   1. The SDK's safe default vars (PATH, HOME, etc.) — when `inheritDefaults`
 *      is true and the process needs them to start.
 *   2. The explicitly allowlisted var NAMES from the manifest.
 *   3. The user-supplied env values for this connection (always honored — the
 *      user clearly intends those to flow to this server).
 *
 * Everything else in `process.env` is withheld.
 *
 * @param policy        Env policy from the resolved capability manifest
 * @param userEnv       Env values the user passed at connect time
 * @param sourceEnv     The environment to scope from (defaults to process.env)
 * @returns The scoped environment object to hand to StdioClientTransport
 */
export function buildScopedEnvironment(
  policy: EnvPolicy,
  userEnv: Record<string, string> | undefined,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const scoped: Record<string, string> = {};

  // 1. Safe defaults required for the process to launch (PATH, HOME, etc.)
  if (policy.inheritDefaults) {
    Object.assign(scoped, getDefaultEnvironment());
  }

  // 2. Allowlisted variable names pulled from the source environment.
  let leakedBlocked = 0;
  for (const name of policy.allow) {
    const value = sourceEnv[name];
    if (value !== undefined && !value.startsWith("()")) {
      scoped[name] = value;
    }
  }

  // 3. User-supplied env always flows (explicit intent for this connection).
  if (userEnv) {
    Object.assign(scoped, userEnv);
  }

  // Diagnostics: how many parent-env vars were withheld (not the values).
  const withheld = Object.keys(sourceEnv).filter(
    (k) => !(k in scoped),
  );
  leakedBlocked = withheld.length;
  log.debug("Scoped downstream environment", {
    allowed: Object.keys(scoped).length,
    withheld: leakedBlocked,
    inheritDefaults: policy.inheritDefaults,
  });

  return scoped;
}

/**
 * Returns the names of environment variables that WOULD have been exposed
 * under the old "inherit everything" behavior but are now withheld. Used for
 * surfacing the security improvement to the user / logs without ever printing
 * the values themselves.
 */
export function withheldEnvNames(
  scoped: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(sourceEnv).filter((k) => !(k in scoped));
}
