/**
 * Fragment shaders for the full-width thinking line. Each variant is one
 * WebGL2 fragment program drawn over a full-viewport triangle by the shared
 * renderer (renderer.ts); the variants draw the status phrase itself from a
 * monospace glyph atlas.
 *
 * Coordinate space shared by every variant (set up in the prelude):
 * - `P.x` runs 0..W in line-height units (W = width / height), so features
 *   keep their proportions at any width.
 * - `P.y` runs -0.5..0.5 bottom to top.
 * - `CPX` is one CSS pixel in line units, for crisp 1px cores at any DPR.
 *
 * Uniforms (advanced on the CPU each frame, see renderer.ts):
 * - `u_time`   seconds of animation time (scaled by speed).
 * - `u_k`      0 = thinking, 1 = compacting, eased between the two.
 * - `u_cycle`  seconds since compacting started.
 * - `u_light`  1 on the light theme (see `emit`).
 * - `u_flow`   time integral of (1 - 2k): runs forward while thinking and
 *              backward while compacting, without a jump when the mode flips.
 * - `u_accent` three gradient stops around the user's accent hue.
 * - `u_ink`    the theme's foreground text colour.
 *
 * Shaders return premultiplied RGBA: emitted light goes through `emit`,
 * which tone-maps it and derives alpha, so it glows on any theme
 * background; text and tape are composited as opaque ink with `over`.
 */
import { ASSEMBLER, SHIMMER, UPLINK } from "./glyphLines";

export const THINKING_LINE_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PRELUDE = `#version 300 es
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_k;
uniform float u_cycle;
uniform float u_flow;
uniform float u_dpr;
uniform float u_light;
/** Gradient stops derived from the user's accent (renderer.ts). */
uniform vec3 u_accent[3];
/** Foreground text colour (--color-fg). */
uniform vec3 u_ink;

out vec4 fragColor;

#define PI 3.14159265
#define TAU 6.28318531

vec2 P;
float W;
float CPX;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/**
 * Tone-map emitted light into premultiplied RGBA. Light glows on the dark
 * theme; on the cream light theme additive light washes out, so the same
 * emission is printed as deepened ink instead.
 */
vec4 emit(vec3 c) {
  c = 1.0 - exp(-max(c, 0.0));
  float a = max(c.r, max(c.g, c.b));
  if (u_light > 0.5) {
    vec3 hue = c / max(a, 1e-4);
    a = min(1.0, a * 1.25);
    return vec4(hue * hue * 0.62 * a, a);
  }
  return vec4(c, a);
}

/** 1/r glow around a distance, with a core of \`w\` line units. */
float glow(float d, float w) {
  return w / (d + w);
}

vec4 shade();

void main() {
  W = u_res.x / u_res.y;
  P = vec2(gl_FragCoord.x / u_res.y, gl_FragCoord.y / u_res.y - 0.5);
  CPX = u_dpr / u_res.y;
  fragColor = shade();
}
`;

export const THINKING_LINE_VARIANTS = [
  {
    id: "shimmer",
    name: "Shimmer",
    blurb:
      "The calm default: a soft band of accent light sweeps across the muted label and runs on down a trailing hairline. Compacting: the band runs inward.",
    phrase: "Thinking…",
    compactingPhrase: "Compacting conversation…",
    body: SHIMMER,
  },
  {
    id: "uplink",
    name: "Uplink",
    blurb:
      "The phrase fades in, scrambles into machine script, transmits it as a morse-spaced ciphertext stream, then vanishes. Compacting is the downlink: the stream flows in and stops, the script materialises, is compacted against the wall, springs back and decodes.",
    phrase: "Beaming a whisper up to the deep net…",
    compactingPhrase: "Pulling old transmissions down from orbit…",
    body: UPLINK,
  },
  {
    id: "assembler",
    name: "Assembler",
    blurb:
      "Strips of nanobots fly in, snap into register and settle into the letters, then dissolve and fly off; stray bots ride with them. Compacting: the swarm is crushed into a glowing brick against the left wall, held, then springs back.",
    phrase: "Nanobots assembling the next thought…",
    compactingPhrase: "Crushing the conversation into a dense brick…",
    body: ASSEMBLER,
  },
] as const;

export type ThinkingLineVariant = (typeof THINKING_LINE_VARIANTS)[number]["id"];

export function thinkingLineFragmentSource(
  variant: ThinkingLineVariant
): string {
  const def = THINKING_LINE_VARIANTS.find((v) => v.id === variant);
  if (!def) throw new Error(`Unknown thinking line variant: ${variant}`);
  return PRELUDE + def.body;
}
