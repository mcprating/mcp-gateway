/**
 * Shared framing for the YouTube Shorts recordings.
 *
 * A Short is 1080x1920 — vertical. The existing demo/run-demo.mjs is written for
 * a landscape GIF and uses 64-column rules, which at a font size legible on a
 * phone would run off both sides of the frame. Everything here is capped at
 * WIDTH columns so a take can be recorded at ~30px and still be readable held
 * at arm's length, which is the only viewing condition that matters.
 *
 * Pacing is deliberate and on by default here (unlike run-demo.mjs, where the
 * fast path is what CI and humans want). A recording that emits 20 lines in
 * 600ms is unusable: the viewer cannot read the before/after that is the entire
 * argument. Override with DEMO_PACE_MS to re-time without editing scripts.
 */

export const WIDTH = 44;

const PACE_MS = Number(process.env.DEMO_PACE_MS || 1400);

/** Hold the frame so a viewer can actually read it. */
export const beat = (factor = 1) =>
  PACE_MS > 0
    ? new Promise((r) => setTimeout(r, PACE_MS * factor))
    : Promise.resolve();

export const rule = (ch = "─") => ch.repeat(WIDTH);

/** A section heading that survives being cropped into a vertical frame. */
export function heading(text) {
  console.log(`\n${rule()}`);
  console.log(`  ${text}`);
  console.log(rule());
}

/**
 * Wrap to WIDTH at word boundaries with a hanging indent.
 *
 * Tool descriptions from the registry are written for a model, not a terminal,
 * and run to several hundred characters. Left unwrapped they either soft-wrap at
 * the emulator's width (breaking the vertical framing) or get truncated to
 * something that misrepresents what the server actually said.
 */
export function wrap(text, indent = "  ") {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = indent;
  for (const w of words) {
    if (line.length + w.length + 1 > WIDTH && line.trim()) {
      lines.push(line);
      line = indent + w;
    } else {
      line += (line.trim() ? " " : "") + w;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

/** Right-align a number against a label, ledger style. */
export function ledger(label, value, indent = "  ") {
  const v = String(value);
  const pad = Math.max(1, WIDTH - indent.length - label.length - v.length);
  return `${indent}${label}${" ".repeat(pad)}${v}`;
}

export const fmt = (n) => n.toLocaleString("en-US");
