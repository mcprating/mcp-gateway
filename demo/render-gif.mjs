#!/usr/bin/env node
/**
 * Render demo/sandbox-demo.gif from run-demo.mjs's output. No screen recorder.
 *
 *   npm run build && node demo/render-gif.mjs
 *
 * The previous GIF was screen-recorded (vhs hangs on Windows, see demo.tape),
 * and it filmed the recorder's shell prompt, including the local username.
 * Same approach as demo/shorts/render-video.mjs: run the script at its authored
 * pace, stamp each line as it arrives, and draw the lines with ffmpeg. The
 * framing is exact, and a wording change is a re-render, not a retake.
 *
 * The demo reads the environment of whoever runs it, and although values are
 * redacted, the NAMES of real variables are printed. So it runs here with a
 * clean, synthetic environment: what Windows needs to start node, plus fake
 * DEMO_* credentials. The output is the same on any machine and publishes
 * nothing about one.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "sandbox-demo.gif");

const W = 1080;
const H = 720;
const BG = "0x0d1117";
const FG = "0xe6edf3";
const MARGIN = 28;
const FONT_SIZE = 18;
const LINE_H = 24;
const TAIL_HOLD = 4; // hold the takeaway before the GIF loops
const FPS = 10;
const FONT = "C\\:/Windows/Fonts/CascadiaMono.ttf";

// Just enough to start node on Windows and elsewhere, plus the fakes.
const KEEP = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "PROGRAMFILES",
  "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS", "PATHEXT"];
const env = Object.fromEntries(KEEP.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
Object.assign(env, {
  USERNAME: "demo",
  LANG: "en_US.UTF-8",
  EDITOR: "code",
  // Planted fakes, printed in full by the demo so there's something to see.
  DEMO_GITHUB_TOKEN: "ghp_FAKE0000000000000000000000000000demo",
  DEMO_DATABASE_URL: "postgres://demo:FAKE-password@db.example.invalid/app",
  DEMO_PACE_MS: "2200",
});

// Emoji have no glyph in Cascadia Mono and render as boxes; the words carry them.
const strip = (s) =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, "").replace(/\s+$/, "");

const lines = [];
const t0 = Date.now();
const child = spawn(process.execPath, [join(__dirname, "run-demo.mjs"), "--pace"], {
  cwd: join(__dirname, ".."),
  env,
});
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    lines.push({ text: strip(buf.slice(0, i)), at: (Date.now() - t0) / 1000 });
    buf = buf.slice(i + 1);
  }
});
child.stderr.on("data", () => {}); // gateway logs go to stderr; not part of the demo
await new Promise((res, rej) => {
  child.on("error", rej);
  child.on("close", (c) => (c === 0 ? res() : rej(new Error(`run-demo exited ${c}`))));
});

// Refuse to publish anything that looks like it came from a real machine.
const leaky = lines.find((l) => /redacted|opetr|CLAUDE|ANTHROPIC/i.test(l.text));
if (leaky) throw new Error(`refusing to render, output mentions a real variable: ${leaky.text}`);

// Blank lines are breathing room: half a row.
let y = MARGIN;
for (const l of lines) {
  l.y = y;
  y += l.text.trim() ? LINE_H : Math.round(LINE_H * 0.45);
}
if (y > H - MARGIN) throw new Error(`content is ${y}px tall; the frame is ${H}px. Shorten the output.`);

const tmp = join(__dirname, ".render-gif-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const filters = lines
  .map((l, i) => {
    if (!l.text.trim()) return null;
    const f = join(tmp, `l${i}.txt`);
    writeFileSync(f, l.text, "utf8");
    const path = f.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");
    // expansion=none: a bare '%' otherwise blanks the whole line.
    return `drawtext=fontfile='${FONT}':textfile='${path}':expansion=none:fontcolor=${FG}:fontsize=${FONT_SIZE}:x=${MARGIN}:y=${l.y}:enable='gte(t,${l.at.toFixed(2)})'`;
  })
  .filter(Boolean);

const duration = (lines.at(-1)?.at ?? 0) + TAIL_HOLD;
const graph = `${filters.join(",")},fps=${FPS},split[a][b];[a]palettegen=max_colors=16[p];[b][p]paletteuse=dither=none`;
const ff = spawn("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", `color=c=${BG}:s=${W}x${H}:d=${duration.toFixed(2)}`,
  "-filter_complex", graph,
  "-loop", "0",
  OUT,
], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((res, rej) => {
  ff.on("error", rej);
  ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});
rmSync(tmp, { recursive: true, force: true });
console.log(`${lines.length} lines · ${duration.toFixed(1)}s · ${W}x${H} → ${OUT}`);
