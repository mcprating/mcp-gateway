import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Notices a secret the model has read turning up in a later tool call.
 *
 * A poisoned description needs no code of its own: it asks for a file's text as
 * an argument to its tool, or tells the model to post it with a tool on a server
 * the person trusts. Nothing the sandbox watches is involved, and the request can
 * be in any language or worded as a policy, so the wording is no test. The data
 * is: the gateway saw what came back from reading .env, and it sees what an
 * argument holds. On Gemma 4 31B the argument form got through the gateway 5
 * times out of 5 (demo/poison, parameter-capture).
 *
 * What counts as a secret is kept narrow, because a check that questions ordinary
 * work gets turned off:
 *   - values in a file whose name says it holds secrets, like .env or id_rsa
 *   - strings shaped like a credential, wherever they appear
 * Anything else a server returns is left alone. Servers hand out session tokens
 * and page cursors and expect them back, so a name like "token" proves nothing
 * outside such a file.
 *
 * It compares text. Standard encodings are undone, and a value's random part
 * counts on its own: Gemma 4 31B, told to base64 a .env, kept the 16 random
 * characters of a token and mangled the constant prefix in front of them. But a
 * secret the model has rewritten some other way, or one in a file nothing marks
 * out, goes by unseen.
 * It only knows what came through the gateway, too: a client's own file tools
 * don't. Secrets are held in memory for the session and never logged or shown:
 * the person is told where one came from, not what it is.
 */

/** A secret found in a tool call's arguments. Says where it came from, never what it is. */
export interface SecretFound {
  /** The file it was read from, or the server and tool that returned it. */
  source: string;
  /** The name it had in the file, when it had one. */
  name?: string;
  /** Which argument holds it. */
  argument: string;
}

interface KnownSecret {
  source: string;
  name?: string;
  /** The servers that returned it, which so already have it. */
  servers: Set<string>;
}

/** Past this the oldest go first, so a long session doesn't grow without limit. */
const MAX_SECRETS = 2_000;
/** How much of one result is looked through. */
const MAX_RESULT_CHARS = 1_000_000;
/** How much of one argument is looked through for a file name. */
const MAX_PATH_CHARS = 2_000;
/** Names here come from the model or a file, and go in a question to the person. */
const MAX_LABEL = 60;

const SECRET_FILE =
  /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.vault-token|credentials\.json|secrets?\.(?:json|ya?ml|toml)|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx))$/i;
const SECRET_DIRECTORY = /(?:^|[\\/])\.(?:aws|ssh|gnupg|kube|docker)[\\/]/i;
/** `.env.example` and the like are written to be shared. */
const TEMPLATE_FILE = /\.(?:example|sample|template|dist)$/i;

const CREDENTIAL_SHAPES = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI, Anthropic and others
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g, // Stripe
];
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/g;

/** `NAME=value`, `export NAME=value`, `name: value` or `"name": "value",`, commented out or not. */
const ASSIGNMENT = /^[ \t#]*(?:export[ \t]+)?["']?([^\s"'=]+?)["']?[ \t]*(?:=|:[ \t])[ \t]*(.*)$/gm;
const SECRET_NAME = /key|token|secret|passw|pwd|credential|auth|dsn/i;
const PLACEHOLDER = /^(?:<.*>|\$\{?\w+\}?|\{\{.*\}\}|\*{3,}|your[-_ ].*|change[-_]me|example.*)$/i;
const PLAIN_WORD = /^[a-z]+$/i;
const PLAIN_NUMBER = /^[\d.]+$/;

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){8,}/g;
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;

/** The text of a result, as the model got it. */
function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource" && "text" in block.resource) return block.resource.text;
    return "";
  });
  const text = parts.filter(Boolean).join("\n") || (result.structuredContent ? JSON.stringify(result.structuredContent) : "");
  return text.slice(0, MAX_RESULT_CHARS).replace(/\r\n?/g, "\n");
}

/**
 * Every string in a tool call's arguments, with where it sits. Keys too: an
 * argument's name is sent as well. One is reported as its parent, not by name,
 * since the name may be the secret.
 */
function* strings(value: unknown, path = ""): Generator<[argument: string, text: string]> {
  if (typeof value === "string") yield [path, value];
  else if (typeof value === "number") yield [path, String(value)];
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* strings(item, `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield [path || "argument names", key];
      yield* strings(item, path ? `${path}.${key}` : key);
    }
  }
}

/** The name of a secrets file these arguments mention, as a path or inside a command. */
function secretFileIn(args: Record<string, unknown>): string | null {
  for (const [, text] of strings(args)) {
    for (const word of text.slice(0, MAX_PATH_CHARS).split(/[\s"'`;|&<>(),=]+/)) {
      const name = word.split(/[\\/]/).pop() ?? "";
      if (TEMPLATE_FILE.test(name)) continue;
      if (SECRET_FILE.test(name) || SECRET_DIRECTORY.test(word)) return name.slice(0, 80);
    }
  }
  return null;
}

type Candidate = { value: string; name?: string };

function credentialsIn(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const shape of CREDENTIAL_SHAPES) {
    for (const [value] of text.matchAll(shape)) found.push({ value });
  }
  // By line, so that part of a key is still recognised.
  for (const [, body] of text.matchAll(PRIVATE_KEY)) {
    for (const line of body.split("\n")) {
      if (line.trim().length >= 16) found.push({ value: line.trim() });
    }
  }
  return found;
}

function isSecretValue(name: string, value: string): boolean {
  // A word can turn up anywhere: with DB_PASSWORD=postgres, so would every mention
  // of postgres. The rest of the file still gives a file sent whole away.
  if (PLAIN_WORD.test(value) || PLACEHOLDER.test(value)) return false;
  if (SECRET_NAME.test(name)) return value.length >= 6;
  // In a secrets file, but not named as one: PORT=8080 isn't.
  return value.length >= 12 && !PLAIN_NUMBER.test(value);
}

function unquote(raw: string): string {
  return raw
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/,$/, "")
    .replace(/^(["'])(.*)\1$/, "$2");
}

function secretsInFile(text: string): Candidate[] {
  const found = credentialsIn(text);
  const assignments = [...text.matchAll(ASSIGNMENT)];
  for (const [, name, raw] of assignments) {
    const value = unquote(raw);
    if (isSecretValue(name, value)) found.push({ value, name });
  }
  // A bare token, or a format of its own like .netrc: there are no names to go on.
  if (assignments.length === 0) {
    for (const word of text.split(/\s+/)) {
      // What follows an = if there is one, which an error quoting a line can have.
      const value = word.replace(/^[^=]*=(?=[^=])/, "");
      if (value.length >= 8 && !PLAIN_WORD.test(value) && !value.startsWith("-----")) found.push({ value });
    }
  }
  return found;
}

/** An argument as it stands, and with the standard encodings taken off. */
function views(text: string): string[] {
  const squeezed = text.replace(/\s+/g, "");
  const found = [text, squeezed];
  found.push(
    text.replace(PERCENT_RUN, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    }),
  );
  // Both: squeezing rejoins a line-wrapped run, but it also glues a run in a
  // sentence to the words around it, which throws its decoding out.
  for (const form of [text, squeezed]) {
    for (const run of form.match(BASE64_RUN) ?? []) found.push(Buffer.from(run, "base64").toString("utf8"));
    for (const run of form.match(HEX_RUN) ?? []) found.push(Buffer.from(run, "hex").toString("utf8"));
  }
  return found;
}

/**
 * A run of letters and digits, long enough that it doesn't turn up by chance.
 * Both must be in it: a word or a number is no fingerprint.
 */
const RANDOM_PART = /[A-Za-z0-9]{12,}/g;

/** A value, and its random parts as fingerprints of their own. */
function fingerprints(value: string): string[] {
  const parts = (value.match(RANDOM_PART) ?? []).filter((part) => part !== value && /[A-Za-z]/.test(part) && /\d/.test(part));
  return [value, ...new Set(parts)];
}

export class SensitiveData {
  private readonly secrets = new Map<string, KnownSecret>();

  /** Remember the secrets in a tool's result. Takes the result as the server sent it. */
  note(slug: string, toolName: string, args: Record<string, unknown>, result: CallToolResult): void {
    // A failed call counts too: an error can quote what it failed on, and the model reads it.
    const text = resultText(result);
    if (!text) return;
    const file = secretFileIn(args);
    const source = file ?? `${slug}'s ${toolName}`;
    for (const { value, name } of file ? secretsInFile(text) : credentialsIn(text)) {
      for (const fingerprint of fingerprints(value)) {
        const known = this.secrets.get(fingerprint);
        if (known) {
          known.servers.add(slug);
          continue;
        }
        this.secrets.set(fingerprint, { source, name: name?.slice(0, MAX_LABEL), servers: new Set([slug]) });
        if (this.secrets.size > MAX_SECRETS) this.secrets.delete(this.secrets.keys().next().value as string);
      }
    }
  }

  /**
   * The first secret in these arguments, if there is one.
   *
   * `alreadyHas` leaves out what that server returned itself. It gains nothing by
   * getting back what it sent, so the only risk is it passing the value on. The
   * caller decides when that can't happen. It covers nothing from any other
   * server, so a server can't use this to collect what it never had.
   */
  find(args: Record<string, unknown>, alreadyHas?: string): SecretFound | null {
    if (this.secrets.size === 0) return null;
    for (const [argument, text] of strings(args)) {
      for (const view of views(text)) {
        for (const [value, secret] of this.secrets) {
          if (alreadyHas && secret.servers.has(alreadyHas)) continue;
          if (view.includes(value)) return { source: secret.source, name: secret.name, argument: argument.slice(0, MAX_LABEL) };
        }
      }
    }
    return null;
  }
}
