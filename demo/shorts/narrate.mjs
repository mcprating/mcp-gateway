#!/usr/bin/env node
/**
 * Add voiceover (and optionally music) to a rendered Short.
 *
 *   node demo/shorts/narrate.mjs short0-problem
 *   node demo/shorts/narrate.mjs short1-secrets --music bed.mp3
 *   node demo/shorts/narrate.mjs short2-context --voice "Microsoft Hazel Desktop"
 *
 * Speech comes from the Windows synthesiser already on the machine, so there is
 * no account, key or upload involved and the script's own text never leaves the
 * box. It sounds like a machine reading, which for a measurement video is
 * arguably the right register — but swap in a better voice later and only this
 * file changes.
 *
 * Music is yours to supply (Suno, or anything licensed). It is ducked well under
 * the voice and faded at both ends. Nothing is bundled: the repo should not ship
 * audio whose licence it cannot state.
 *
 * Timing lives in narration.json, in seconds against the rendered video, so a
 * line can be aimed at the moment its subject appears on screen.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name) {
  console.error("usage: node demo/shorts/narrate.mjs <short-name> [--music file] [--voice name]");
  process.exit(1);
}
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const VOICE = arg("--voice", "Microsoft Zira Desktop");
const MUSIC = arg("--music", null);
const RATE = Number(arg("--rate", -1)); // SAPI range is -10..10; slightly slow reads clearer
const MUSIC_DB = arg("--music-db", "-22"); // well under the voice

const video = join(__dirname, `${name}.mp4`);
if (!existsSync(video)) {
  console.error(`No ${name}.mp4 — run: node demo/shorts/render-video.mjs ${name}`);
  process.exit(1);
}

const all = JSON.parse(readFileSync(join(__dirname, "narration.json"), "utf8"));
const segments = all[name]?.segments;
if (!segments?.length) {
  console.error(`No narration for "${name}" in narration.json`);
  process.exit(1);
}

const tmp = join(__dirname, ".narrate-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const duration = Number(
  spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", video,
  ]).stdout.toString().trim(),
);

// ── Synthesise each line ─────────────────────────────────────────────────────
console.log(`voice: ${VOICE} · ${segments.length} segments · video ${duration.toFixed(1)}s`);
const wavs = segments.map((seg, i) => {
  const out = join(tmp, `s${i}.wav`);
  // Text goes via a file, not the command line: the lines contain apostrophes
  // and commas that would otherwise need escaping through PowerShell.
  const txt = join(tmp, `s${i}.txt`);
  writeFileSync(txt, seg.text, "utf8");
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice('${VOICE.replace(/'/g, "''")}')
    $s.Rate = ${RATE}
    $s.SetOutputToWaveFile('${out.replace(/'/g, "''")}')
    $s.Speak([IO.File]::ReadAllText('${txt.replace(/'/g, "''")}'))
    $s.Dispose()`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !existsSync(out)) {
    console.error(`TTS failed for segment ${i}: ${r.stderr?.slice(0, 300)}`);
    process.exit(1);
  }
  const len = Number(
    spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", out,
    ]).stdout.toString().trim(),
  );
  return { ...seg, file: out, len };
});

// ── Warn about collisions rather than silently producing mush ────────────────
for (let i = 0; i < wavs.length; i++) {
  const end = wavs[i].at + wavs[i].len;
  const next = wavs[i + 1];
  if (next && end > next.at + 0.05) {
    console.warn(
      `WARNING: segment ${i} runs to ${end.toFixed(1)}s but ${i + 1} starts at ${next.at}s ` +
        `— they will talk over each other. Shorten the text or move the cue.`,
    );
  }
  if (end > duration + 0.5) {
    console.warn(
      `WARNING: segment ${i} ends at ${end.toFixed(1)}s, past the ${duration.toFixed(1)}s video. ` +
        `It will be cut off.`,
    );
  }
}

// ── Mix: each line delayed to its cue, music ducked underneath ───────────────
const inputs = ["-i", video, ...wavs.flatMap((w) => ["-i", w.file])];
if (MUSIC) inputs.push("-i", MUSIC);

const voiceLabels = wavs.map((w, i) => {
  const ms = Math.round(w.at * 1000);
  return `[${i + 1}:a]adelay=${ms}|${ms}[v${i}]`;
});
let graph = voiceLabels.join(";");
graph += `;${wavs.map((_, i) => `[v${i}]`).join("")}amix=inputs=${wavs.length}:normalize=0[voice]`;

if (MUSIC) {
  const mi = wavs.length + 1;
  graph +=
    `;[${mi}:a]volume=${MUSIC_DB}dB,afade=t=in:st=0:d=1.2,` +
    `afade=t=out:st=${Math.max(0, duration - 1.5).toFixed(2)}:d=1.5[bed]` +
    `;[voice][bed]amix=inputs=2:normalize=0:duration=first[mixed]`;
} else {
  graph += `;[voice]anull[mixed]`;
}
// Pad with silence to the full video length BEFORE trimming.
//
// The voice track ends when the last line does, several seconds before the last
// frame. With -shortest that made the audio the shorter stream and ffmpeg cut
// the video to match, eating the tail hold — the closing call-to-action lost
// 2.5s of screen time on every Short. apad extends the silence out to the video,
// so the two streams end together.
graph +=
  `;[mixed]apad,atrim=0:${duration.toFixed(2)},` +
  `alimiter=limit=0.95[out]`; // headroom so the mix cannot clip

const out = join(__dirname, `${name}-narrated.mp4`);
const args = [
  "-y", "-v", "error", ...inputs,
  "-filter_complex", graph,
  "-map", "0:v", "-map", "[out]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
  "-shortest", out,
];

const ff = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((res, rej) => {
  ff.on("error", rej);
  ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\nwrote ${out}`);
if (!MUSIC) console.log("No music bed. Add one with --music <file> (Suno export works).");
