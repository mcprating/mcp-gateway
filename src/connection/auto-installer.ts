import { execSync } from "node:child_process";
import { log } from "../utils/logger.js";

const INSTALL_TIMEOUT_MS = 60_000;

/**
 * Ensure that the required command/package is available before spawning.
 *
 * For npx commands: ensures the `-y` flag is present so npx auto-installs.
 * For other commands: checks if the binary exists on PATH.
 *
 * Does NOT actually install packages — we rely on npx -y for on-demand install.
 * This function logs warnings when commands are not found.
 */
export async function ensureInstalled(
  command: string,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  // For npx: ensure -y flag is present
  if (command === "npx") {
    if (!args.includes("-y") && !args.includes("--yes")) {
      log.debug("Adding -y flag to npx command for auto-install", {
        args,
      });
      return { command, args: ["-y", ...args] };
    }
    return { command, args };
  }

  // For other commands: check if binary exists
  if (!isCommandAvailable(command)) {
    log.warn("Command not found on PATH", { command });

    // Check if it looks like an npm package name (e.g., @scope/package or package-name)
    if (looksLikeNpmPackage(command)) {
      log.info("Command looks like an npm package, trying npx", { command });
      // Rewrite to npx -y <command> <args>
      return { command: "npx", args: ["-y", command, ...args] };
    }

    // Can't auto-install non-npm commands
    throw new Error(
      `Command "${command}" not found. Please install it manually and ensure it's on your PATH.`,
    );
  }

  return { command, args };
}

/**
 * Check if a command is available on PATH.
 */
function isCommandAvailable(command: string): boolean {
  try {
    const whereCmd = process.platform === "win32" ? "where" : "which";
    execSync(`${whereCmd} ${command}`, {
      timeout: 5_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Heuristic: does the string look like an npm package name?
 */
function looksLikeNpmPackage(name: string): boolean {
  // @scope/package or simple-package-name
  return /^@?[a-z0-9][\w.-]*\/?[\w.-]*$/i.test(name);
}
