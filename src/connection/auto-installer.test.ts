import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstalled, isCommandAvailable, missingCommandMessage } from "./auto-installer.js";

describe("ensureInstalled", () => {
  it("adds -y to npx so it never waits on an install prompt", async () => {
    expect(await ensureInstalled("npx", ["pkg"])).toEqual({ command: "npx", args: ["-y", "pkg"] });
    expect(await ensureInstalled("npx", ["-y", "pkg"])).toEqual({ command: "npx", args: ["-y", "pkg"] });
  });

  it("passes through a command that is on PATH", async () => {
    expect(await ensureInstalled("node", ["server.js"])).toEqual({ command: "node", args: ["server.js"] });
  });

  // The regression this file exists for: a missing launcher used to be
  // rewritten to `npx -y <command>`, running whatever npm package shares its
  // name (`docker` → the npm package "docker").
  it("never substitutes an npm package for a missing command", async () => {
    const missing = "mcp-gateway-test-not-installed-zz9";
    await expect(ensureInstalled(missing, ["run"])).rejects.toThrow(`"${missing}" is not installed`);
  });
});

describe("isCommandAvailable", () => {
  it("does not run shell syntax embedded in the command name", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-inject-"));
    const marker = join(dir, "ran").replace(/\\/g, "/");
    try {
      // Through a shell, `which x || node -e …` would create the marker.
      const hostile = `zz9-missing || node -e "require('fs').writeFileSync('${marker}','x')"`;
      expect(isCommandAvailable(hostile)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("missingCommandMessage", () => {
  it("names what to install for common launchers", () => {
    expect(missingCommandMessage("uvx")).toContain("https://docs.astral.sh/uv/");
    expect(missingCommandMessage("docker")).toContain("https://docs.docker.com/get-docker/");
  });

  it("still says what is missing for launchers it does not know", () => {
    expect(missingCommandMessage("zz9")).toContain('Install "zz9"');
  });
});
