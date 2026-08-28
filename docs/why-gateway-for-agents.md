# Why an AI agent benefits from the MCP Gateway

Written for someone deciding whether to point their agent at the Gateway instead of
wiring MCP servers directly. Claims here map to behaviour verified in this repo; the
limitations section is deliberately explicit.

---

## The problem, stated precisely

Wiring MCP servers directly into an agent means the **human decides everything up front**:
which servers exist, which are trustworthy, which are installed, and what they're allowed
to touch. That config is static, so the agent can only ever use tools someone predicted it
would need — and every one of them is loaded, trusted and running whether used or not.

Four concrete costs:

1. **A fixed toolset.** Hit a task outside the configured servers and the agent is stuck,
   even though a suitable server exists in the ecosystem.
2. **Every tool is always loaded.** Each server's full tool schema sits in the context
   window on every turn. Ten servers × a dozen tools is a large, permanent tax.
3. **Trust is all-or-nothing.** A server in the config is fully trusted, with whatever
   environment it inherits. Given ~52k indexed servers of wildly varying quality and a
   2026 discourse full of MCP CVEs, "I read the README once" is thin diligence.
4. **No usable record.** When an agent calls twenty tools across five servers, there's no
   single place showing what ran, with what arguments, and what it touched.

---

## What the Gateway changes

### 1. The agent can find tools it wasn't given

`mcp_discover` puts a **52,801-entry indexed registry** inside the agent's own toolset.
The agent searches at runtime, in its own reasoning loop:

```
mcp_discover({query: "read documentation from a github repo"})
→ 3 candidates, each with a quality score, trust tier, how to run it, and whether it
  needs API keys
```

This converts "the tools my developer configured" into "the tools that exist" — the
difference between a fixed integration list and an agent that can go get what it needs.

### 2. Judgement before execution, not after

Every discovery result carries a **quality score (0–100)**, a **trust tier**
(`Verified → Trusted → Community → Unverified`), a **safety score** from a
supply-chain screen, and **whether credentials are required**.

The agent can apply a policy — *"only connect to Community or better"* — instead of
running whatever it found. For a system deciding autonomously which third-party code to
execute, that's the difference between selection and gambling.

Connecting to something untrusted **stops and asks first**: the Gateway returns a warning
and requires `confirmed: true` on the retry. Missing required env vars are reported *before*
the process is spawned rather than surfacing as an opaque crash.

### 3. Containment is the default

A connected server runs inside a sandbox and the agent is told so:

```
🛡️ Sandbox (l1-process)
- No environment variables (secrets) exposed
- No network access (declared)
```

- **L1** — process-level env scoping: the child inherits none of your environment, so an
  `AWS_SECRET_ACCESS_KEY` in the parent shell isn't readable by a server you just found.
- **L2** — container isolation with an **egress allowlist**, so a server can only reach
  hosts it declared.
- **Audit trail** — `mcp_audit` records connections and tool calls.

This is what makes runtime discovery *safe enough to be a good idea*. Discovery without
containment would be an agent downloading and running arbitrary code — strictly worse than
a static config. The two features only make sense together.

### 4. Load tools on demand, not up front

The agent sees **13 meta-tools**, not the union of every downstream server's tools.
Downstream tools appear only after `mcp_connect`, namespaced `slug__tool`, and disappear
on `mcp_disconnect`. Ten servers behind one gateway is still 13 tools in context until
something is actually needed.

*(Read the honest limits of this in "What this does not solve" below.)*

### 5. One integration point

The client config names **one** server. Adding capability is a runtime action, not a
config edit plus restart. This matters most for:

- **Hosted / remote agents** that cannot edit a local config file.
- **Mobile and browser clients**, which cannot spawn local processes at all — the HTTP
  daemon lets them reach the whole MCP ecosystem over an authenticated endpoint
  (verified: token required, `401` without it).
- **Multi-tenant deployments**, where each tenant gets its own token and connection set.

---

## A concrete flow

> **Agent task:** "Summarise the architecture of the modelcontextprotocol/servers repo."

1. `mcp_discover({query: "github repo documentation"})` — finds candidates with scores
2. Picks a `[Community]`-tier hosted server over an `[Unverified]` one
3. `mcp_connect({url: "https://mcp.deepwiki.com/mcp"})` — 3 tools, transport auto-detected
4. `mcp_call_tool({name: "mcp-deepwiki-com__read_wiki_structure", ...})` — real content
5. `mcp_disconnect(...)` — tools removed, process/session closed

Nobody configured a DeepWiki integration. The agent found it, judged it, used it, and put
it away. *(Every step in this flow was executed end-to-end — see
[`cursor-walkthrough.md`](./cursor-walkthrough.md) for captured output.)*

---

## What this does **not** solve

Stated plainly, because overclaiming here invites fair criticism:

- **It does not eliminate token cost for data-heavy work.** The Gateway removes the
  *tool-manifest* tax (13 schemas instead of hundreds), but intermediate results still
  pass through the context window. For genuinely large data, **code execution that
  processes in a sandbox and returns only the answer beats a proxy** — that's a real
  advantage of the code-execution pattern, not something a gateway wins.
- **Safety scoring is a metadata screen, not code analysis.** It reads maintenance,
  license, provenance and install shape. No flags means "no obvious red flags", not
  "audited safe".
- **A quality score is not a correctness guarantee.** It's a ranking signal built from
  popularity, freshness, completeness, MCP compliance and community activity.
- **Discovery breadth is not curation.** ~52.8k indexed entries is far more than the
  ~10k curated ecosystem; the long tail includes experimental and abandoned work. That's
  why score and trust tier are shown on every result rather than a bare list.
- **It adds a hop.** One more process between agent and server — worth it for discovery,
  containment and audit; not worth it if you have three known servers and no trust concern.

---

## When to use which

| Situation | Use |
|---|---|
| Agent needs capabilities you can't enumerate in advance | **Gateway** |
| Running third-party servers you haven't audited | **Gateway** (containment + audit) |
| Mobile / browser / hosted agent that can't spawn processes | **Gateway HTTP daemon** |
| Many servers, but only a few used per session | **Gateway** (on-demand loading) |
| Three trusted servers, fixed workflow | **Direct config** — the hop isn't earning anything |
| Bulk data transformation across tools | **Code execution**, ideally sandboxed by the Gateway |
