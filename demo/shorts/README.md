# YouTube Shorts — recording kit

Three runnable scripts, each producing the on-screen content for one Short, plus
the voiceover written to match what the script actually prints.

Everything here is real: the security demo really reads the environment, the
token numbers come from public tool schemas, and the connect really spawns a
server. Nothing is staged, which is the only reason any of it is worth posting.

---

## Before the first take

```bash
npm run build                                    # scripts import dist/
node demo/shorts/short2-context.mjs --refresh    # ~4 min, only when stale
npx -y @oevortex/ddg_search --help               # warm the npx cache
```

That last line matters. A cold `npx` adds ten seconds of dead air to Short 3's
connect. Warming it is not cheating — the package genuinely stays cached after
first install — but the video should not imply first-run is instant, and the
script prints the real elapsed time either way.

## You do not need a screen recorder

```bash
node demo/shorts/render-video.mjs short1-secrets
```

That writes `short1-secrets.mp4` at exactly 1080×1920, ready for CapCut. It runs
the script at its authored pace, stamps each line as it is printed, and renders
the whole thing with ffmpeg — so the `beat()` calls already written into the
scripts become the video's timing, and nothing needs re-timing in an editor.

Doing it this way rather than capturing a window means the framing is exact, the
type is legible by construction rather than by luck, and when a measurement
changes you re-run one command instead of re-recording and re-cropping a take.
It also warns instead of silently clipping if the content grows past the frame —
which it did, and which cost `short3` its closing call-to-action until the layout
was fixed.

Current output:

| script | duration |
|---|--:|
| `short1-secrets` | 13.5s |
| `short2-context` | 20.3s |
| `short3-discover` | 15.7s |

All three leave room for narration inside a 30–40s Short.

**Emoji are dropped in the render.** Cascadia Mono has no colour emoji, so 💀 and
🛡️ would come out as empty boxes. The words next to them carry the meaning; if
you want the emoji, add them as text layers in CapCut where they will render
properly.

**If you would rather record the terminal anyway:** 44 columns, dark background,
a font with real box-drawing glyphs. Windows Game Bar (Win+G) captures a window
without installing anything. Crop to 9:16 afterwards — and never record a
maximised terminal and shrink it, which is the single most common way a dev-tool
Short ends up unreadable.

**Pacing:** the scripts hold each beat by default (`DEMO_PACE_MS`, default
1400ms). `DEMO_PACE_MS=0` runs instantly for checking output; leave it unset for
a render or a take.

---

## Short 1 — "it can read your API keys"

```bash
node demo/shorts/short1-secrets.mjs
```

Runtime ~20s. **Read the numbers off your own run** — the variable count and
credential count depend on your shell, so the script below marks them `[N]`.

> **[0:00]** If you use MCP servers in Claude Desktop or Cursor, every one of
> them can read your entire shell. Including your API keys.
>
> **[0:06]** This is a deliberately malicious MCP server. I'm running it exactly
> the way every MCP client runs them today. It asked for nothing — and it
> received all **[N]** variables in my environment. It took **[N]** credentials.
> Two of those are fakes I planted. The rest are real, and no, I'm not showing
> you those.
>
> **[0:20]** Same server, through the gateway. It gets a constructed
> environment: **[N]** variables, none of them sensitive. It took nothing,
> because there was nothing there to take.
>
> **[0:30]** Free, MIT licensed, on GitHub. Link's in the pinned comment — a
> star genuinely helps.

**Do not** say "it read my AWS key and my OpenAI key." The demo redacts every
real value by design and shows only the two planted fakes. Claiming otherwise
would be describing something the viewer can see is not on screen.

---

## Short 2 — "where did your context window go?"

```bash
node demo/shorts/short2-context.mjs
```

Runtime ~25s. The strongest of the three: it is an original measurement, and
nobody else publishes it.

> **[0:00]** Why does your context window disappear before you've typed
> anything?
>
> **[0:04]** Every MCP server you configure injects its entire tool schema into
> every single turn — whether you use it or not. So I measured it. Ninety-one
> real servers, from their published schemas. The median one costs about two
> and a half thousand tokens. Configure ten, and that's twenty-six thousand
> tokens gone before your first word.
>
> **[0:18]** The gateway is one server. Flat, two thousand six hundred tokens,
> and it loads a server's tools only when you actually connect to it. About ten
> times less, every turn.
>
> **[0:26]** The heaviest server I found exposes six hundred and eight tools.
> That one is sixty-eight percent of your whole context window. One server.

Numbers update themselves from `context-cost.json`, and the measurement date is
on screen. If you re-record after a `--refresh`, re-read the figures — the
heaviest server in particular changes between refreshes.

---

## Short 3 — "one config entry instead of fifty"

```bash
node demo/shorts/short3-discover.mjs
```

Runtime ~25s. Live against the registry.

> **[0:00]** Stop pasting fifty lines of JSON into your MCP config every time
> you want a new tool.
>
> **[0:05]** This replaces all of it. One entry.
>
> **[0:10]** Then just ask for what you need. There are a hundred and
> ninety-six Postgres servers in the registry — here are the three best by
> quality score. Connect one, and its tools are live.
>
> **[0:22]** You pay that wait once, when you ask for a server. Not for every
> server you configured, at every single launch.

**Do not** say "installs in 10 seconds" or quote a total server count.
Our own blog post measures a **13.2s median** to a usable tool list, so the
first claim is contradicted by our own data. And [post
1](https://mcprating.io/blog/how-many-mcp-servers) argues that headline ecosystem
counts are unreliable — quoting one in an ad for the project that made that
argument is the sort of thing people screenshot.

---

## What changed from the first draft, and why

The original scripts were sound in structure; these are the same three hooks
with the factual problems fixed.

| Draft claim | Problem | Now |
|---|---|---|
| "read my AWS key and OpenAI key" | Demo redacts real values — it is not on screen | Counts, plus the two planted fakes |
| "10 servers = 15,000 tokens" | Understated ~1.7×; came from a 6-server sample | 25,870, from 91 servers |
| "Flat 2,800 tokens" | Close, slightly overstated | 2,644, measured live each run |
| "It indexes 57,000+ servers" | Wrong (63,168), and contradicts post 1 | Count dropped entirely |
| "Install in 10 seconds via npx" | Our own post measures 13.2s median | Real elapsed time, shown |

Two mistakes worth keeping in mind while recording: the registry API **silently
ignores unknown query parameters**, so `sort=downloads` and `?q=` returned
unfiltered results with no error and quietly produced wrong numbers twice during
this work. And the corpus is drawn from servers we have verified, which is a
biased sample of the whole index — the videos say "measured from 91 servers",
never "the average MCP server".
