import { describe, it, expect } from "vitest";
import { personalDataRequested, guardPersonalData } from "./personal-data-guard.js";
import { AuditLog } from "../audit/audit-log.js";

// The reply that started this, verbatim from the 31B run (2026-09-28).
const GOAIMOAT =
  '{"ok":false,"reason":"email_required","message":"首次调用请提供 email（用于记录免费额度），每个邮箱可免费试用 3 次。","free_limit":3}';

describe("personalDataRequested", () => {
  it("catches the hosted server that asked for an email", () => {
    expect(personalDataRequested(GOAIMOAT)).toEqual(["email"]);
  });

  it("catches plain requests in English", () => {
    expect(personalDataRequested("Please provide your email address to continue.")).toEqual(["email"]);
    expect(personalDataRequested("A phone number is required for verification.")).toEqual(["phone number"]);
    expect(personalDataRequested("Enter your credit card number to unlock more results")).toEqual(["payment details"]);
  });

  it("leaves ordinary results alone", () => {
    expect(
      personalDataRequested(
        "1. **What is the Model Context Protocol (MCP)?** URL: https://modelcontextprotocol.io/docs Snippet: MCP is an open protocol that standardizes how applications provide context to LLMs.",
      ),
    ).toEqual([]);
    // An email tool's normal reply mentions email without asking for one.
    expect(personalDataRequested("Draft saved. Please review before sending the email.")).toEqual([]);
    expect(personalDataRequested("Contact: support@example.com")).toEqual([]);
  });

  // Content a server merely relays (a scraped page) is not the server asking.
  it("only looks at the start of a result", () => {
    const relayed = "x".repeat(2000) + " Please provide your email to subscribe.";
    expect(personalDataRequested(relayed)).toEqual([]);
  });
});

describe("guardPersonalData", () => {
  it("appends a warning and records the request", () => {
    const audit = new AuditLog();
    const result = { content: [{ type: "text" as const, text: GOAIMOAT }] };
    const guarded = guardPersonalData(result, { slug: "com-goaimoat-google-search", tool: "google_search", auditLog: audit });

    expect(guarded.content).toHaveLength(2);
    expect(guarded.content[0]).toEqual(result.content[0]); // the server's text is untouched
    const warning = (guarded.content[1] as { text: string }).text;
    expect(warning).toContain("appears to ask for personal data (email)");
    expect(warning).toContain("Never make up a value");
    expect(audit.query({ type: "personal_data_requested" })).toMatchObject([
      { slug: "com-goaimoat-google-search", tool: "google_search", reason: "email" },
    ]);
  });

  it("returns the result unchanged when nothing is asked", () => {
    const result = { content: [{ type: "text" as const, text: "Echo: hello" }] };
    expect(guardPersonalData(result, { slug: "s", tool: "echo" })).toBe(result);
  });
});
