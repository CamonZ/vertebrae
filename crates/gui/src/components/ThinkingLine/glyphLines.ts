/**
 * Thinking-line bodies that draw the status phrase from the monospace glyph
 * atlas (renderer.ts). Each body is appended to PRELUDE (shaders.ts) and
 * starts with the TEXT snippet below.
 */

/*
 * Text sampling. `u_text` holds atlas slots (char − 32, "…" = 95) for the
 * first `u_textLen` characters of the phrase. `textureLod` with an explicit
 * level: implicit derivatives are undefined after the early returns shaders
 * use, and the atlas cell is far larger than the on-screen glyph.
 */
const TEXT = `
uniform sampler2D u_glyphs;
uniform float u_glyphAspect;
uniform float u_atlasCellH;
uniform float u_text[96];
uniform float u_textLen;

/** Gradient around the user's accent: g = 0..1 across u_accent's stops. */
vec3 accentRamp(float g) {
  return g < 0.5 ? mix(u_accent[0], u_accent[1], g * 2.0) : mix(u_accent[1], u_accent[2], g * 2.0 - 1.0);
}

float textCode(float i) { return u_text[int(clamp(i, 0.0, 95.0))]; }
/** A machine-script glyph slot (machineGlyphs.ts: slots 96–127). */
float machineCode(float seed) { return 96.0 + floor(hash11(seed) * 31.99); }

float glyphLod(float gh) { return max(log2(u_atlasCellH / (gh * u_res.y)), 0.0); }

/** Coverage of glyph code at cell-local q (0..1, y up). */
float glyphTex(vec2 q, float code, float lod) {
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  vec2 cell = vec2(mod(code, 16.0), floor(code / 16.0));
  // keep the filter footprint inside the cell so neighbours don't bleed in
  vec2 cellPx = vec2(u_atlasCellH * u_glyphAspect, u_atlasCellH);
  vec2 e = 0.5 * exp2(lod) / cellPx;
  q = clamp(q, e, 1.0 - e);
  vec2 uv = (cell + vec2(q.x, 1.0 - q.y)) / vec2(16.0, 8.0);
  return textureLod(u_glyphs, uv, lod).a;
}

/** Opaque ink over emitted light; both premultiplied. */
vec4 over(vec3 ink, float a, vec4 light) {
  return vec4(ink * a, a) + light * (1.0 - a);
}

float rightFade(float x) { return smoothstep(W, W - 1.5, x); }
`;

/*
 * Uplink ─ the phrase fades in, holds, then scrambles left-to-right
 * into machine script (every glyph re-rolls each frame in a gradient around
 * the accent). It stays scrambled for a while, then the glyphs flare and
 * vanish left-to-right, leaving the line empty until the next fade-in. Beyond
 * the phrase a fast stream of ciphertext blocks flows out, their lengths and
 * spacing keying MORSE_MESSAGE in morse; it only transmits while the phrase
 * is scrambled. Compacting is the downlink: the stream flows in and stops,
 * the machine script materialises right-to-left, is compacted against the
 * left wall behind a glowing plate, springs back, decodes right-to-left into
 * the phrase and fades out.
 */
/** The message Uplink's ciphertext stream keys out in morse. */
const MORSE_MESSAGE = "THE DEEP NET IS LISTENING";
const MORSE: Record<string, string> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
};

/**
 * Lays the message out as a tape of glyph cells with morse timing: dot 1,
 * dash 3, element gap 1, letter gap 3, word gap 7 (also closing the loop).
 * Each cell holds 0 for silence, else `elementWidth * 4 + offsetInElement + 1`.
 */
function morseTape(message: string): number[] {
  const cells: number[] = [];
  const gap = (n: number) => cells.push(...Array<number>(n).fill(0));
  message.split(" ").forEach((word, w) => {
    if (w > 0) gap(7);
    [...word].forEach((ch, l) => {
      if (l > 0) gap(3);
      [...MORSE[ch]].forEach((el, e) => {
        if (e > 0) gap(1);
        const width = el === "-" ? 3 : 1;
        for (let i = 0; i < width; i++) cells.push(width * 4 + i + 1);
      });
    });
  });
  gap(7);
  return cells;
}

const TAPE = morseTape(MORSE_MESSAGE);

export const UPLINK =
  TEXT +
  `
const float FADE_IN = 0.08;
const float ENC_START = 0.3;
const float VANISH_START = 0.7;
const float RX_START = 0.2;
const float RX_END = 0.42;
const float RX_SPEED = 110.0;

const int TAPE_LEN = ${TAPE.length};
const float TAPE[${TAPE.length}] = float[](${TAPE.map((v) => v.toFixed(1)).join(",")});

vec4 shade() {
  float t = u_time;
  float gh = min(16.0 * CPX, 0.95);
  float cw = gh * u_glyphAspect;
  float x0 = 0.15;
  if (P.x < x0) return vec4(0.0);
  float lod = glyphLod(gh);
  float qy = P.y / gh + 0.5;
  float frame = floor(t * 30.0);
  float period = 6.0;
  float epoch = floor(t / period);
  float ph = t - epoch * period;
  float len = u_textLen;
  float fade = rightFade(P.x);

  float n = ph / period;

  // ── downlink (compacting) ──
  // Receive: the stream flows in and is swallowed between RX_START and
  // RX_END, then stops.
  // The machine script materialises right-to-left, is compacted against the
  // left wall behind a glowing plate, held, springs back, decodes
  // right-to-left into the phrase, holds and fades out.
  if (u_k > 0.5) {
    float sq = 1.0;
    if (n > 0.64) {
      float e = (n - 0.64) * period;
      sq = 1.0 - 0.7 * exp(-e * 7.0) * cos(e * 14.0);
    } else if (n > 0.56) {
      sq = 0.3;
    } else if (n > 0.45) {
      float v = (n - 0.45) / 0.11;
      sq = mix(1.0, 0.3, v * v * v);
    }
    float crush = clamp((1.0 - sq) / 0.7, 0.0, 1.0);
    float edge = x0 + len * cw * sq;
    float hold = smoothstep(0.52, 0.56, n) * (1.0 - smoothstep(0.64, 0.68, n));
    float plate = glow(abs(P.x - edge), CPX * 1.2) * step(abs(qy - 0.5), 0.6) * hold;
    vec3 plateLight = u_accent[1] * plate * 1.6;

    float du = (P.x - x0) / (cw * sq);
    float dc = floor(du);
    vec2 dq = vec2(du - dc, qy);
    if (dc < len) {
      float back = 1.0 - dc / max(len, 1.0);
      float appearT = 0.33 + 0.1 * back;
      float decodeT = 0.72 + 0.1 * back + 0.015 * hash21(vec2(dc, epoch));
      float sc = machineCode(dc * 17.0 + frame * 3.1 + epoch * 7.0);
      float g = fract(dc * 0.045 - t * 0.7);
      vec3 grad = accentRamp(abs(g * 2.0 - 1.0));
      if (n < appearT) {
        float e = (appearT - n) * period;
        return emit((grad * glyphTex(dq, sc, lod) * 2.2 * exp(-e * 12.0) + plateLight) * fade);
      }
      if (n < decodeT) {
        float a = glyphTex(dq, sc, lod);
        float flash = exp(-(n - appearT) * period * 10.0);
        return emit((grad * a * (1.35 + 1.2 * flash) * (1.0 + 1.5 * crush) + plateLight) * fade);
      }
      float a = glyphTex(dq, textCode(dc), lod);
      float flash = exp(-(n - decodeT) * period * 9.0);
      float gone = 1.0 - smoothstep(0.94, 1.0, n);
      vec3 ink = mix(u_ink, u_light > 0.5 ? u_accent[1] * 0.55 : vec3(1.0), flash);
      return over(ink, a * gone * fade, emit((grad * a * flash * 1.6 * gone + plateLight) * fade));
    }
    if (P.x < x0 + (len + 2.0) * cw) return emit(plateLight * fade);
  }

  float u = (P.x - x0) / cw;
  float c = floor(u);
  vec2 q = vec2(u - c, qy);

  // ── phrase ──
  // Cycle, as fractions of the period: fade in clear, hold, scramble
  // left-to-right into machine script, stay scrambled (transmitting), vanish
  // left-to-right with a last flare, then stay empty until the next fade-in.
  if (c < len) {
    float sweep = c / max(len, 1.0);
    float encT = ENC_START + 0.12 * sweep + 0.015 * hash21(vec2(c, epoch));
    float vanT = VANISH_START + 0.12 * sweep;
    float sc = machineCode(c * 17.0 + frame * 3.1 + epoch * 7.0);
    float g = fract(c * 0.045 - t * 0.7);
    vec3 grad = accentRamp(abs(g * 2.0 - 1.0));
    if (n >= vanT) {
      float e = (n - vanT) * period;
      return emit(grad * glyphTex(q, sc, lod) * 2.2 * exp(-e * 12.0) * fade);
    }
    if (n >= encT) {
      float a = glyphTex(q, sc, lod);
      float flash = exp(-(n - encT) * period * 10.0);
      return emit(grad * a * (1.35 + 1.2 * flash) * fade);
    }
    float glitch = step(0.994, hash21(vec2(c, floor(t * 14.0))));
    float a = glyphTex(q, glitch > 0.5 ? sc : textCode(c), lod);
    if (glitch > 0.5) return emit(grad * a * 1.35 * fade);
    float fadeIn = smoothstep(0.0, FADE_IN, n);
    vec3 ink = mix(u_light > 0.5 ? u_accent[1] * 0.55 : u_accent[1], u_ink, fadeIn);
    return over(ink, a * fadeIn * fade, vec4(0.0));
  }

  // ── ciphertext stream, keyed as morse ──
  // Blocks of re-rolling machine glyphs whose lengths and spacing follow
  // morse timing in glyph cells: dot 1, dash 3, element gap 1, letter gap 3,
  // word gap 7. The tape spells MORSE_MESSAGE, reading left to right.
  float s0 = x0 + (len + 2.0) * cw;
  if (P.x < s0) return vec4(0.0);
  // downlink pulls the stream in fast, so it crosses the line in about a
  // second and only shows while the line is empty
  bool rx = u_k > 0.5;
  float su = (P.x - s0) / cw + (rx ? t * RX_SPEED : -u_flow * 38.0);
  float sc = floor(su);
  float lc = mod(sc, float(TAPE_LEN));
  float cell = TAPE[int(lc)];
  if (cell < 0.5) return vec4(0.0);
  // A cell left the phrase at te (compacting: is swallowed at te). Uplink
  // only transmits while the phrase is scrambled; downlink only receives
  // before RX_END, so the stream has stopped before the compaction.
  float te = rx ? sc / RX_SPEED : t - (sc + u_flow * 38.0) / 38.0;
  float nE = mod(te, period) / period;
  if (rx ? nE < RX_START || nE > RX_END : nE < ENC_START || nE > VANISH_START + 0.12) return vec4(0.0);
  float elW = floor((cell - 1.0) / 4.0);
  float pf = cell - 1.0 - elW * 4.0;

  vec2 sq = vec2(su - sc, qy);
  // leading edge in the direction of travel is brightest
  float lead = u_k > 0.5 ? 1.0 - pf / elW : (pf + 1.0) / elW;
  float a = glyphTex(sq, machineCode(sc * 5.3 + frame), lod);
  float g = fract(sc * 0.03 + t * 0.5);
  vec3 grad = accentRamp(abs(g * 2.0 - 1.0));
  float across = (P.x - s0) / max(W - s0, 1.0);
  float lit = (0.25 + 1.1 * lead * lead) * mix(1.0, 0.45, across);
  lit *= smoothstep(0.0, 2.0 * cw, P.x - s0);
  return emit(grad * a * lit * fade);
}
`;

/*
 * Assembler ─ the phrase arrives as a nanobot swarm. It is cut into
 * horizontal strips that stream in from the right as clouds of accent-lit
 * bots, each strip at its own pace; they snap into register and the bots
 * settle into the letters, cooling into text from a bright assembly front.
 * Before the next cycle the text dissolves back into bots and the strips
 * stream out. Stray bots drift along the lanes toward the phrase.
 * Compacting is a trash compactor: the text dissolves, the swarm is crushed
 * into a hot brick against the left wall behind a glowing plate, held, then
 * springs back into text, while the strays are sucked in as streaks.
 */
export const ASSEMBLER =
  TEXT +
  `
#define STRIPS 7.0

/** 1 where column c of the phrase holds a visible (non-space) glyph. */
float solidAt(float c) {
  return step(0.0, c) * step(c, u_textLen - 1.0) * step(0.5, textCode(c));
}

/**
 * Nanobot in the micro-lattice cell around p: a jittering, flickering speck.
 * Returns its intensity; id gets a per-bot hash for colour variation.
 */
float bot(vec2 p, float seed, float agitation, out float id) {
  float m = 2.2 * CPX;
  vec2 g = floor(p / m);
  vec2 h = hash22(g + seed);
  id = h.x;
  float ph = u_time * (3.0 + 6.0 * h.x) + h.y * TAU;
  vec2 c = (g + 0.5 + (0.18 + 0.12 * agitation) * vec2(sin(ph), cos(ph * 1.3))) * m;
  float r = 0.36 * m;
  float d = length(p - c);
  float speck = smoothstep(r + 0.6 * CPX, r - 0.2 * CPX, d);
  float flicker = 0.5 + 0.5 * step(0.35, fract(h.y * 5.0 + u_time * (1.5 + h.x * 5.0)));
  return speck * flicker;
}

vec4 shade() {
  float t = u_time;
  float gh = min(16.0 * CPX, 0.95);
  float cw = gh * u_glyphAspect;
  float x0 = 0.15;
  if (P.x < x0) return vec4(0.0);
  float lod = glyphLod(gh);
  float qy = P.y / gh + 0.5;
  float fade = rightFade(P.x);
  float inBox = step(0.0, qy) * step(qy, 1.0);
  float s = floor(clamp(qy, 0.0, 0.999) * STRIPS);
  float inStrip = fract(qy * STRIPS);
  float textEnd = x0 + u_textLen * cw;
  bool compacting = u_k > 0.5;

  float xc;
  float swarmAmt;
  float grainH;
  float seed;
  float moving = 0.0;
  float trailDir = 1.0;
  float crush = 0.0;
  float plate = 0.0;
  float strayX;
  float epoch;

  if (!compacting) {
    // ── thinking: strips stream in from the right, settle, stream out ──
    float period = 6.0;
    epoch = floor(t / period);
    float ph = t - epoch * period;
    vec2 h = hash22(vec2(s, epoch));
    float land = 0.5 + 0.8 * h.x;
    float leave = period - 1.3 + 0.4 * h.y;
    float span = max(W - x0, 1.0);
    float dist = (1.0 + 0.3 * hash11(s * 7.1 + epoch * 3.3)) * span;
    float dx = 0.0;
    if (ph < land) {
      float u = 1.0 - ph / land;
      dx = dist * u * u * u;
      moving = u;
    } else if (ph > leave) {
      float u = (ph - leave) / 0.8;
      dx = span * u * u * 1.3;
      moving = min(u * 2.0, 1.0);
      trailDir = -1.0;
    } else {
      float e = ph - land;
      dx = -0.3 * cw * exp(-e * 16.0) * sin(e * 42.0);
    }
    xc = P.x - dx;
    float settle = clamp((ph - land) / 0.5, 0.0, 1.0);
    float scatter = clamp((ph - leave + 0.4) / 0.4, 0.0, 1.0);
    swarmAmt = max(1.0 - settle, scatter);
    // grain in content space, so it travels with the strip
    grainH = hash21(floor(vec2(xc, P.y) / (1.5 * CPX)) + epoch * 1.7);
    seed = epoch;
    strayX = xc;
  } else {
    // ── compacting: dissolve, crush into a brick against the left wall,
    //    hold, spring back out and settle into text ──
    float period = 6.0;
    epoch = floor(t / period);
    float p = t - epoch * period - 0.15 * hash11(s * 5.3 + epoch);
    float sq;
    if (p < 0.8) {
      sq = 1.0;
    } else if (p < 2.0) {
      float u = (p - 0.8) / 1.2;
      sq = mix(1.0, 0.1, u * u * u);
    } else if (p < 3.6) {
      sq = 0.1;
    } else {
      float e = p - 3.6;
      sq = 1.0 - 0.9 * exp(-e * 5.0) * cos(e * 10.0);
    }
    crush = 1.0 - sq;
    xc = x0 + (P.x - x0) / sq;
    float dissolve = clamp(p / 0.8, 0.0, 1.0);
    float settle = clamp((p - 4.4) / 0.8, 0.0, 1.0);
    swarmAmt = dissolve * (1.0 - settle);
    grainH = hash21(floor(P.xy / (1.5 * CPX)) + epoch * 1.7);
    seed = epoch + 0.5;
    float hold = smoothstep(1.6, 2.0, p) * (1.0 - smoothstep(3.6, 3.9, p));
    float edge = x0 + (textEnd - x0) * sq;
    plate = glow(abs(P.x - edge), CPX * 1.2) * step(abs(qy - 0.5), 0.6) * hold;
    // strays are squeezed too, less hard so their bots stay visible
    strayX = x0 + (P.x - x0) / mix(1.0, sq, 0.6);
  }

  // ── the phrase, as text or as bots ──
  float u = (xc - x0) / cw;
  float c = floor(u);
  float solid = solidAt(c) * inBox;
  float glyph = glyphTex(vec2(u - c, qy), textCode(c), lod) * inBox;
  float isBot = step(grainH, swarmAmt);
  float front = step(grainH, swarmAmt + 0.3) * (1.0 - isBot) * step(0.001, swarmAmt);
  float cut = moving > 0.05 ? step(0.16, inStrip) : 1.0;
  float a = glyph * (1.0 - isBot);

  // bots fill the cell, denser and brighter on the letterforms; a crushed
  // swarm is drawn in screen space so the brick packs solid and runs hot
  float id;
  vec2 bp = compacting ? P : vec2(xc, P.y);
  float b = bot(bp, seed, max(moving, crush), id);
  float onForm = smoothstep(0.15, 0.6, glyph);
  float swarm = b * solid * isBot * cut * step(abs(qy - 0.5), 0.46)
    * mix(0.5 * step(0.3, id), 1.4, max(onForm, crush)) * (1.0 + 1.5 * crush);

  // faint wake behind a moving strip, broken into bot-sized dashes
  float trail = 0.0;
  if (moving > 0.05) {
    float stepX = cw * (0.5 + 1.5 * moving);
    for (int k = 1; k <= 4; k++) {
      float xt = xc + trailDir * float(k) * stepX;
      trail += solidAt(floor((xt - x0) / cw)) * (1.0 - float(k) * 0.22);
    }
    trail *= moving * inBox * cut * step(abs(qy - 0.5), 0.42)
      * step(0.55, hash21(vec2(floor(xc / (2.2 * CPX)), s)));
  }

  // ── stray bots in the lanes, in the effect's own space: they arrive and
  //    leave with their strip while thinking, and are crushed toward the
  //    wall and sprung back out while compacting ──
  float stray = 0.0;
  float strayId = 0.0;
  if (strayX > textEnd + cw) {
    vec2 pd = vec2(strayX, P.y);
    float sb = bot(pd, 3.1 + epoch, 1.0, strayId);
    float present = step(0.982, hash21(floor(pd / (2.2 * CPX)) + vec2(7.7, epoch * 3.1)));
    float ramp = smoothstep(textEnd + cw, textEnd + 5.0 * cw, strayX);
    stray = sb * present * inBox * ramp * (1.4 + 0.8 * crush);
  }

  vec3 botColor = id < 0.5
    ? mix(u_accent[0], u_accent[1], id * 2.0)
    : mix(u_accent[1], u_accent[2], id * 2.0 - 1.0);
  vec3 strayColor = mix(u_accent[1], u_accent[2], strayId);
  float flash = solid * front * 1.8 * onForm;
  vec3 light = u_accent[1] * (flash + trail * 0.35 + plate * 1.6)
    + botColor * swarm * 3.2 + strayColor * stray;
  return over(u_ink, a * fade, emit(light * fade));
}
`;

/*
 * Shimmer ─ the calm default. The status label sits in muted ink; a soft band
 * of accent light sweeps across it and runs on down a hairline that trails
 * off to the right, then rests. Compacting sends the band the other way:
 * in along the hairline and back across the label.
 */
export const SHIMMER =
  TEXT +
  `
vec4 shade() {
  float gh = min(16.0 * CPX, 0.95);
  float cw = gh * u_glyphAspect;
  float x0 = 0.15;
  if (P.x < x0) return vec4(0.0);
  float lod = glyphLod(gh);
  float qy = P.y / gh + 0.5;
  float fade = rightFade(P.x);
  float textEnd = x0 + u_textLen * cw;

  // band: crosses the whole line in 1.8 s, then rests until the next sweep
  float period = 2.6;
  float ph = mod(u_time, period);
  float span = max(W - x0, 1.0);
  float v = (span + 6.0 * cw) / 1.8;
  float bx = u_k > 0.5 ? W + 3.0 * cw - v * ph : x0 - 3.0 * cw + v * ph;
  float d = (P.x - bx) / (2.6 * cw);
  float band = exp(-d * d);

  // label
  if (P.x < textEnd) {
    float u = (P.x - x0) / cw;
    float c = floor(u);
    float a = glyphTex(vec2(u - c, qy), textCode(c), lod);
    vec3 lit = u_light > 0.5 ? u_accent[1] * 0.55 : u_accent[1];
    vec3 ink = mix(u_ink, lit, band * 0.85);
    return over(ink, a * (0.62 + 0.38 * band) * fade, emit(u_accent[1] * a * band * 0.5 * fade));
  }

  // hairline trailing off to the right
  float start = textEnd + (u_textLen > 0.0 ? 0.6 * cw : 0.0);
  if (P.x < start) return vec4(0.0);
  float along = (P.x - start) / max(W - start, 1.0);
  float line = 1.0 - smoothstep(0.5 * CPX, 1.1 * CPX, abs(P.y));
  float base = 0.16 * (1.0 - smoothstep(0.0, 0.85, along));
  float light = line * band * 1.3 * (1.0 - 0.6 * along);
  float halo = glow(abs(P.y), 1.6 * CPX) * band * 0.25 * (1.0 - along);
  return over(u_ink, line * base * fade, emit(u_accent[1] * (light + halo) * fade));
}
`;
