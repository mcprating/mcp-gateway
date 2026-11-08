import { describe, it, expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SensitiveData } from "./sensitive-data.js";

const SECRET = "PLANTED-0123456789abcdef";
const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

/** A session in which `.env` has been read through the workspace server. */
function afterReading(file: string, contents: string) {
  const data = new SensitiveData();
  data.note("workspace", "read_file", { path: file }, text(contents));
  return data;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("a secret from a secrets file", () => {
  const env = `SERVICE_TOKEN=${SECRET}\nPORT=8080\nLOG_LEVEL=info\nNODE_ENV=production\n`;

  it("is found in a later call, on any argument", () => {
    const data = afterReading(".env", env);
    expect(data.find({ city: "Lisbon", session_context: env })).toEqual({ source: ".env", name: "SERVICE_TOKEN", argument: "session_context" });
    expect(data.find({ api_key: SECRET })?.argument).toBe("api_key");
    expect(data.find({ url: `http://x.test/?t=${SECRET}` })?.argument).toBe("url");
    expect(data.find({ a: { b: [{ c: SECRET }] } })?.argument).toBe("a.b[0].c");
  });

  it("never reports the value, even when an argument is named after it", () => {
    const data = afterReading(".env", env);
    expect(JSON.stringify(data.find({ body: env }))).not.toContain(SECRET);
    expect(data.find({ [SECRET]: true })).toMatchObject({ argument: "argument names" });
    expect(data.find({ outer: { [SECRET]: true } })).toMatchObject({ argument: "outer" });
    expect(JSON.stringify(data.find({ outer: { [SECRET]: { deeper: SECRET } } }))).not.toContain(SECRET);
  });

  it("keeps what it reports short: it goes in a question to a person", () => {
    const long = "x".repeat(500);
    const data = afterReading(".env", `${long}_TOKEN=${SECRET}\n`);
    const found = data.find({ [`${long}y`]: { inner: SECRET } });
    expect(found?.name?.length).toBeLessThanOrEqual(60);
    expect(found?.argument.length).toBeLessThanOrEqual(60);
  });

  it("is found through the standard encodings", () => {
    const data = afterReading(".env", env);
    expect(data.find({ x: b64(env) })).not.toBeNull();
    expect(data.find({ x: `padding ${b64(SECRET)} padding` })).not.toBeNull();
    expect(data.find({ x: Buffer.from(env).toString("hex") })).not.toBeNull();
    expect(data.find({ x: encodeURIComponent(`${SECRET}/`) })).not.toBeNull();
    expect(data.find({ x: [...SECRET].join(" ") })).not.toBeNull();
    // Line-wrapped, as base64 tools do.
    expect(data.find({ x: b64(env).replace(/(.{20})/g, "$1\n") })).not.toBeNull();
  });

  it("isn't found once it's rewritten some other way", () => {
    // A stated limit, not a goal: see the note at the top of sensitive-data.ts.
    const data = afterReading(".env", env);
    expect(data.find({ x: [...SECRET].reverse().join("") })).toBeNull();
    expect(data.find({ x: SECRET.slice(0, 10) })).toBeNull();
    expect(data.find({ x: "0123456789ab" })).toBeNull();
  });

  it("knows a value by its random part when the rest is mangled", () => {
    // What Gemma 4 31B sent when told to base64 the file: PLANTED came out as PLANUDED.
    const data = afterReading(".env", env);
    const mangled = "SERVICE_TOKEN_PLANUDED-0123456789abcdef\n";
    expect(data.find({ x: mangled })).toMatchObject({ source: ".env", name: "SERVICE_TOKEN" });
    expect(data.find({ x: b64(mangled) })).toMatchObject({ source: ".env", name: "SERVICE_TOKEN" });
  });

  it("doesn't take an ordinary part of a value for a fingerprint", () => {
    const data = afterReading(".env", "DATABASE_URL=postgres://deploy:Tr0ub4dor@db.internal.example/app\nRELEASE=build-2026-11-08\n");
    expect(data.find({ x: "postgres://deploy:Tr0ub4dor@db.internal.example/app" })).not.toBeNull();
    for (const part of ["postgres", "deploy", "db.internal.example", "build", "2026-11-08", "app"]) {
      expect(data.find({ x: `see ${part} here` }), part).toBeNull();
    }
  });

  it("leaves the file's other values alone", () => {
    const data = afterReading(".env", env);
    expect(data.find({ port: "8080", level: "info", mode: "production", n: 8080 })).toBeNull();
    expect(data.find({ body: "SERVICE_TOKEN is set" })).toBeNull();
  });

  it("reads the usual ways of writing a value", () => {
    const data = afterReading(
      ".env",
      [`export API_KEY="quoted-value-1"`, `DB_PASSWORD='single-q'`, `# OLD_TOKEN=commented-out-1`, `AUTH_TOKEN=before-comment # why`, `DATABASE_URL=postgres://me:pw@db.internal/app`].join("\r\n"),
    );
    for (const value of ["quoted-value-1", "single-q", "commented-out-1", "before-comment", "postgres://me:pw@db.internal/app"]) {
      expect(data.find({ x: value }), value).not.toBeNull();
    }
  });

  it("doesn't take a plain word for a fingerprint, though the file sent whole still shows", () => {
    const words = `DB_PASSWORD=postgres\nDB_USER=admin\n`;
    expect(afterReading(".env", words).find({ query: "how do I tune postgres" })).toBeNull();
    const mixed = `DB_PASSWORD=postgres\nAPI_KEY=${SECRET}\n`;
    expect(afterReading(".env", mixed).find({ body: mixed })).not.toBeNull();
  });

  it("skips placeholders", () => {
    const data = afterReading(".env", ["API_KEY=your-api-key", "TOKEN=<token>", "SECRET=${SECRET}", "PASSWORD=changeme", "AUTH=xxxxxxxx"].join("\n"));
    expect(data.find({ x: "your-api-key <token> ${SECRET} changeme xxxxxxxx" })).toBeNull();
  });

  it("handles files with no NAME=value lines", () => {
    expect(afterReading(".vault-token", "s.AbCdEf123456\n").find({ x: "s.AbCdEf123456" })).not.toBeNull();
    expect(afterReading(".netrc", "machine host login me password hunter22pw\n").find({ x: "hunter22pw" })).not.toBeNull();
    expect(afterReading(".npmrc", "//registry.npmjs.org/:_authToken=0a1b2c3d-4e5f\n").find({ x: "0a1b2c3d-4e5f" })).not.toBeNull();
  });

  it("recognises a secrets file by path, or inside a command", () => {
    const secret = `API_KEY=${SECRET}\n`;
    const read = (args: Record<string, unknown>) => {
      const data = new SensitiveData();
      data.note("s", "t", args, text(secret));
      return data.find({ x: SECRET });
    };
    expect(read({ path: "/srv/app/.env.production" })?.source).toBe(".env.production");
    expect(read({ path: "C:\\app\\.env" })?.source).toBe(".env");
    expect(read({ command: "cat .env | head" })?.source).toBe(".env");
    expect(read({ paths: ["a.txt", "secrets.yaml"] })?.source).toBe("secrets.yaml");
    expect(read({ path: "/home/me/.aws/credentials" })?.source).toBe("credentials");
    expect(read({ path: "/home/me/.ssh/id_ed25519" })?.source).toBe("id_ed25519");
  });

  it("doesn't take a template for the real thing", () => {
    const data = afterReading(".env.example", `API_KEY=${SECRET}\n`);
    expect(data.find({ x: SECRET })).toBeNull();
  });

  it("counts what a failed call quoted: the model read that too", () => {
    const data = new SensitiveData();
    data.note("workspace", "read_file", { path: ".env" }, { ...text(`Parse error near SERVICE_TOKEN=${SECRET}`), isError: true });
    expect(data.find({ x: SECRET })).not.toBeNull();
  });

  it("finds nothing in a read that returned nothing useful", () => {
    const data = new SensitiveData();
    data.note("workspace", "read_file", { path: ".env" }, { ...text("No such file."), isError: true });
    expect(data.find({ x: "No such file." })).toBeNull();
  });

  it("doesn't take a key file's banner for its contents", () => {
    const data = afterReading("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
    expect(data.find({ x: "b3BlbnNzaC1rZXktdjEAAAAA" })).not.toBeNull();
    expect(data.find({ x: "-----BEGIN CERTIFICATE-----" })).toBeNull();
  });
});

describe("a credential's shape, in any result", () => {
  const github = `ghp_${"a1".repeat(18)}`;

  it("is found whatever the file was called", () => {
    const data = afterReading("deploy.conf", `registry_login=${github}\n`);
    expect(data.find({ x: github })).toEqual({ source: "workspace's read_file", name: undefined, argument: "x" });
  });

  it("covers the common kinds", () => {
    const samples = [`AKIA${"ABCD1234".repeat(2)}`, github, `github_pat_${"a1".repeat(30)}`, `glpat-${"a1".repeat(12)}`, `npm_${"a1".repeat(18)}`, `xoxb-1234567890-abc`, `sk-${"a1".repeat(12)}`, `sk_live_${"a1".repeat(10)}`];
    for (const sample of samples) {
      expect(afterReading("log.txt", `found ${sample} here`).find({ x: sample }), sample).not.toBeNull();
    }
  });

  it("catches part of a private key", () => {
    const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const data = afterReading("notes.txt", `-----BEGIN PRIVATE KEY-----\n${line}\nmore\n-----END PRIVATE KEY-----\n`);
    expect(data.find({ x: line })).not.toBeNull();
  });

  it("reads embedded resources and structured results", () => {
    const data = new SensitiveData();
    data.note("s", "embedded", {}, { content: [{ type: "resource", resource: { uri: "file:///x", text: github } }] });
    expect(data.find({ x: github })).not.toBeNull();
    const structured = new SensitiveData();
    structured.note("s", "structured", {}, { content: [], structuredContent: { login: github } });
    expect(structured.find({ x: github })).not.toBeNull();
  });
});

describe("what a server hands out in the normal way", () => {
  it("isn't a secret, whatever it's called", () => {
    const data = new SensitiveData();
    data.note("api", "list", {}, text(`{"items":[1,2],"next_page_token":"eyJwYWdlIjoyfQ-abc123","session_token":"a1b2c3d4e5f6a1b2"}\nsession_token: a1b2c3d4e5f6a1b2`));
    expect(data.find({ cursor: "eyJwYWdlIjoyfQ-abc123", session_token: "a1b2c3d4e5f6a1b2" })).toBeNull();
  });

  it("leaves ordinary files alone", () => {
    const data = afterReading("settings.json", `{\n  "region": "eu-west-1",\n  "password_policy": "long-and-strong",\n  "endpoint": "https://api.internal.example/v2"\n}\n`);
    expect(data.find({ body: "eu-west-1 long-and-strong https://api.internal.example/v2" })).toBeNull();
  });

  it("has nothing to find before anything is read", () => {
    expect(new SensitiveData().find({ x: SECRET })).toBeNull();
  });
});

describe("a server getting back what it returned", () => {
  const env = `SERVICE_TOKEN=${SECRET}\n`;

  it("is left out only for that server", () => {
    const data = afterReading(".env", env);
    expect(data.find({ content: env }, "workspace")).toBeNull();
    expect(data.find({ content: env }, "lure")).not.toBeNull();
  });

  it("still counts another server's secret in the same call", () => {
    const github = `ghp_${"a1".repeat(18)}`;
    const data = afterReading(".env", env);
    data.note("other", "get_login", {}, text(github));
    expect(data.find({ content: `${SECRET} ${github}` }, "workspace")).toMatchObject({ source: "other's get_login" });
  });

  it("knows every server that returned a value", () => {
    const data = afterReading(".env", env);
    data.note("mirror", "read", { path: ".env" }, text(env));
    expect(data.find({ content: env }, "mirror")).toBeNull();
  });
});

describe("a long session", () => {
  it("forgets the oldest secrets first", () => {
    const data = new SensitiveData();
    const token = (i: number) => `API_KEY=value-${String(i).padStart(6, "0")}\n`;
    for (let i = 0; i <= 2_000; i++) data.note("s", "read", { path: ".env" }, text(token(i)));
    expect(data.find({ x: "value-000000" })).toBeNull();
    expect(data.find({ x: "value-000001" })).not.toBeNull();
    expect(data.find({ x: "value-002000" })).not.toBeNull();
  });
});
