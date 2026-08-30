import { describe, it, expect } from "vitest";
import { buildScopedEnvironment, withheldEnvNames } from "./env-scoper.js";
import { matchesAllowlist, lintAllowlist } from "./egress-proxy.js";

/**
 * These two functions are the sandbox. Everything else in the gateway is
 * plumbing around them: if buildScopedEnvironment leaks one variable, an
 * untrusted package gets a live credential; if matchesAllowlist says yes when
 * it should say no, the egress allowlist is decoration.
 *
 * Both are pure and total, which makes them exactly the wrong thing to leave
 * covered only by an end-to-end script that has to spawn a real process to
 * exercise one branch.
 */

const SOURCE_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  AWS_SECRET_ACCESS_KEY: "AKIAsecret",
  OPENAI_API_KEY: "sk-live-do-not-leak",
  GITHUB_TOKEN: "ghp_realtoken",
  DATABASE_URL: "postgres://u:p@h/db",
  BASH_FUNC_x: "() { echo pwned; }",
} as NodeJS.ProcessEnv;

describe("buildScopedEnvironment", () => {
  it("withholds every unlisted variable, including the ones that matter", () => {
    const env = buildScopedEnvironment({ allow: [], inheritDefaults: false }, undefined, SOURCE_ENV);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-live-do-not-leak");
  });

  it("passes only the names the manifest allowlisted", () => {
    const env = buildScopedEnvironment(
      { allow: ["GITHUB_TOKEN"], inheritDefaults: false },
      undefined,
      SOURCE_ENV,
    );
    expect(env.GITHUB_TOKEN).toBe("ghp_realtoken");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("does not invent values for allowlisted names that are absent upstream", () => {
    const env = buildScopedEnvironment(
      { allow: ["NOT_SET_ANYWHERE"], inheritDefaults: false },
      undefined,
      SOURCE_ENV,
    );
    expect("NOT_SET_ANYWHERE" in env).toBe(false);
  });

  it("refuses exported shell functions, which are a shellshock-shaped foothold", () => {
    const env = buildScopedEnvironment(
      { allow: ["BASH_FUNC_x"], inheritDefaults: false },
      undefined,
      SOURCE_ENV,
    );
    expect(env.BASH_FUNC_x).toBeUndefined();
  });

  it("honours user-supplied env, since that is explicit intent for this connection", () => {
    const env = buildScopedEnvironment(
      { allow: [], inheritDefaults: false },
      { MY_TOKEN: "provided-by-user" },
      SOURCE_ENV,
    );
    expect(env.MY_TOKEN).toBe("provided-by-user");
  });

  it("lets user-supplied values override an allowlisted inherited one", () => {
    const env = buildScopedEnvironment(
      { allow: ["GITHUB_TOKEN"], inheritDefaults: false },
      { GITHUB_TOKEN: "user-override" },
      SOURCE_ENV,
    );
    expect(env.GITHUB_TOKEN).toBe("user-override");
  });

  it("reports withheld names without ever exposing their values", () => {
    const env = buildScopedEnvironment({ allow: [], inheritDefaults: false }, undefined, SOURCE_ENV);
    const withheld = withheldEnvNames(env, SOURCE_ENV);
    expect(withheld).toContain("AWS_SECRET_ACCESS_KEY");
    expect(withheld.join(",")).not.toContain("AKIAsecret");
  });
});

describe("matchesAllowlist", () => {
  it("matches an exact host on any port when the pattern omits one", () => {
    expect(matchesAllowlist("api.github.com", 443, ["api.github.com"])).toBe(true);
    expect(matchesAllowlist("api.github.com", 8080, ["api.github.com"])).toBe(true);
  });

  it("honours a port when the pattern specifies one", () => {
    expect(matchesAllowlist("api.github.com", 443, ["api.github.com:443"])).toBe(true);
    expect(matchesAllowlist("api.github.com", 80, ["api.github.com:443"])).toBe(false);
  });

  it("matches subdomains and the apex under a leading wildcard", () => {
    expect(matchesAllowlist("raw.githubusercontent.com", 443, ["*.githubusercontent.com"])).toBe(true);
    expect(matchesAllowlist("githubusercontent.com", 443, ["*.githubusercontent.com"])).toBe(true);
  });

  it("does not fall for a suffix-confusion hostname", () => {
    // The attack this guards: registering evil-example.com to ride a
    // "*.example.com" allowlist. Anchoring on the dot is what prevents it.
    expect(matchesAllowlist("evil-example.com", 443, ["*.example.com"])).toBe(false);
    expect(matchesAllowlist("notexample.com", 443, ["*.example.com"])).toBe(false);
  });

  it("denies anything not listed, and denies on an empty allowlist", () => {
    expect(matchesAllowlist("evil.test", 443, ["api.github.com"])).toBe(false);
    expect(matchesAllowlist("api.github.com", 443, [])).toBe(false);
  });

  it("fails CLOSED on a malformed pattern rather than opening up", () => {
    // A missing dot is a typo, not a wildcard. It must match nothing — the
    // dangerous reading would be treating it as "*".
    expect(matchesAllowlist("example.com", 443, ["*example.com"])).toBe(false);
    expect(matchesAllowlist("anything.test", 443, ["*example.com"])).toBe(false);
    expect(matchesAllowlist("anything.test", 443, ["*"])).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchesAllowlist("API.GitHub.COM", 443, ["api.github.com"])).toBe(true);
    expect(matchesAllowlist("api.github.com", 443, ["API.GITHUB.COM"])).toBe(true);
  });
});

describe("lintAllowlist", () => {
  it("says nothing about well-formed patterns", () => {
    expect(lintAllowlist(["api.github.com", "*.example.com:443", "localhost:3000"])).toEqual([]);
  });

  it("flags a wildcard missing its dot, which silently matches nothing", () => {
    const [problem] = lintAllowlist(["*example.com"]);
    expect(problem).toMatch(/matches nothing/);
  });

  it("flags a wildcard over a public suffix, which grants most of the web", () => {
    expect(lintAllowlist(["*.com"])[0]).toMatch(/most of the web/);
  });

  it("flags a non-numeric port and an IPv6 literal", () => {
    expect(lintAllowlist(["api.github.com:https"])[0]).toMatch(/not a number/);
    expect(lintAllowlist(["::1:443"])[0]).toMatch(/IPv6/);
  });
});
