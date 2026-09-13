#!/usr/bin/env node
/**
 * Render a Shorts script straight to a 1080x1920 video. No screen recorder.
 *
 *   node demo/shorts/render-video.mjs short1-secrets
 *   node demo/shorts/render-video.mjs short2-context --out my.mp4
 *
 * Why not just record the terminal: a capture has to be framed, cropped to 9:16
 * and have its font size guessed, and every one of those is re-done by hand each
 * time a number changes. These scripts emit deterministic text, so the video can
 * be generated from it — exact framing, guaranteed-legible type, and a re-render
 * whenever the measurements move.
 *
 * Timing comes from the scripts themselves. They are run at their authored pace
 * and each line is stamped as it arrives, so the beat() calls already written
 * into them become the video's rhythm. Nothing is re-timed in an editor.
 *
 * Output has no audio: add voiceover and captions in CapCut. The wording is in
 * this directory's README, timed to what appears on screen.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = process.argv[2];
if (!script) {
  console.error("usage: node demo/shorts/render-video.mjs <short1-secrets|short2-context|short3-discover>");
  process.exit(1);
}
const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1] : join(__dirname, `${script}.mp4`);

const W = 1080;
const H = 1920;
const BG = "0x0d1117";
const FG = "0xe6edf3";
const MARGIN = 44;
const TAIL_HOLD = 2.5; // let the last frame sit before it cuts
// 44 columns is what _frame.mjs wraps to. Sizing the glyph to fill the width
// between margins is what makes this legible on a phone; Cascadia's advance
// width is ~0.6em, so this lands a little under the full 44 to leave slack.
const FONT_SIZE = Math.floor(((W - MARGIN * 2) / 44 / 0.6) * 0.92);
const LINE_H = Math.round(FONT_SIZE * 1.48);

// ffmpeg wants a drive-letter colon escaped inside a filter graph.
const FONT = "C\\:/Windows/Fonts/CascadiaMono.ttf";

const frames = join(__dirname, ".render-tmp");
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

/**
 * Emoji are dropped, not rendered.
 *
 * Cascadia Mono has no colour emoji, so 💀 and 🛡️ come out as tofu boxes — worse
 * than absent. Their job on screen is done better by the words next to them, and
 * adding a second font layer just for two glyphs is not worth the filter graph.
 */
const strip = (s) =>
  s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+$/, "");

/**
 * Slower than the terminal default, because narration sets the pace.
 *
 * _frame.mjs holds each beat 1400ms, which is right for watching output scroll
 * past. It is wrong for video: the synthesised voice reads about 2.2 words a
 * second, so an 11s render left every narration segment talking over the next
 * one. ~4200ms lands each Short near 30s, which is both the format's sweet spot
 * and roughly the 45-50 words of voiceover it can carry.
 */
let PACE = process.env.DEMO_PACE_MS;
if (!PACE) {
  try {
    const n = JSON.parse(readFileSync(join(__dirname, "narration.json"), "utf8"));
    PACE = String(n[script]?.pace ?? 4200);
  } catch {
    PACE = "4200";
  }
}

console.log(`running ${script} at ${PACE}ms/beat to capture timings…`);
const child = spawn(process.execPath, [join(__dirname, `${script}.mjs`)], {
  cwd: join(__dirname, "..", ".."),
  env: { ...process.env, DEMO_PACE_MS: PACE },
});

const lines = [];
const t0 = Date.now();
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    lines.push({ text: strip(raw), at: (Date.now() - t0) / 1000 });
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

await new Promise((res, rej) => {
  child.on("error", rej);
  child.on("close", (code) => (code === 0 ? res() : rej(new Error(`${script} exited ${code}`))));
});

const duration = (lines.at(-1)?.at ?? 0) + TAIL_HOLD;

// Lay out vertically, giving a blank line roughly half a row.
//
// A blank line is breathing room, not content, and at full height six of them
// pushed short1's closing CTA off the bottom of the frame — the one line the
// whole video exists to show. Half-height keeps the rhythm and buys back the
// space.
let y = MARGIN;
for (const l of lines) {
  l.y = y;
  y += l.text.trim() ? LINE_H : Math.round(LINE_H * 0.45);
}
const contentHeight = y - MARGIN;
if (contentHeight > H - MARGIN * 2) {
  console.warn(
    `WARNING: content is ${contentHeight}px but the frame allows ${H - MARGIN * 2}px. ` +
      `The tail will render off-frame — shorten the script rather than shrinking the type.`,
  );
}

// One drawtext per line, revealed at the moment the script printed it. textfile=
// rather than text= on purpose: it sidesteps escaping ':' '%' '\' and quotes,
// which is where hand-built filter graphs usually break.
const filters = lines.map((l, i) => {
  if (!l.text.trim()) return null;
  const f = join(frames, `l${i}.txt`);
  writeFileSync(f, l.text, "utf8");
  const path = f.replace(/\\/g, "/").replace(/^([A-Za-z])\:/, "$1\\:");
  return (
    // expansion=none is load-bearing. drawtext expands %{...} sequences by
    // default, and a bare '%' in the text makes the whole line render as
    // nothing — no error, no warning, just a gap. Short 2's "68% of the whole
    // window" vanished this way and was only caught by looking at a frame.
    `drawtext=fontfile='${FONT}':textfile='${path}':expansion=none:` +
    `fontcolor=${FG}:fontsize=${FONT_SIZE}:x=${MARGIN}:y=${l.y}:` +
    `enable='gte(t,${l.at.toFixed(2)})'`
  );
}).filter(Boolean);

console.log(`${lines.length} lines · ${FONT_SIZE}px · ${duration.toFixed(1)}s · ${W}x${H}`);

const args = [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", `color=c=${BG}:s=${W}x${H}:d=${duration.toFixed(2)}`,
  "-vf", filters.join(","),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  OUT,
];
const ff = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((res, rej) => {
  ff.on("error", rej);
  ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});

rmSync(frames, { recursive: true, force: true });
console.log(`\nwrote ${OUT}`);
console.log(`Next: drop it in CapCut, add the voiceover from demo/shorts/README.md.`);
