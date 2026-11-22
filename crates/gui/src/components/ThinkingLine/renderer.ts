/**
 * One WebGL2 context renders every mounted thinking line. Browsers cap live
 * WebGL contexts (~16) and evict the oldest past that, so per-canvas contexts
 * would break as soon as several chats think at once. Instead each instance
 * owns a cheap 2D canvas; per frame the shared GL canvas draws the instance's
 * shader into its bottom-left corner and the result is blitted across with
 * `drawImage`, which stays on the GPU in WebKit and Chromium.
 *
 * One requestAnimationFrame loop drives all instances. It only runs while an
 * animated instance is on screen (IntersectionObserver in ThinkingLine.tsx);
 * paused or reduced-motion instances get a single still frame.
 */
import {
  THINKING_LINE_VERTEX_SHADER,
  thinkingLineFragmentSource,
  type ThinkingLineVariant,
} from "./shaders";
import { drawMachineGlyph, MACHINE_GLYPH_COUNT } from "./machineGlyphs";

export type ThinkingLineMode = "thinking" | "compacting";

/** Animation time a still (paused / reduced-motion) frame is rendered at. */
const STILL_FRAME_TIME = 2.2;
/** Rate constant for easing u_k between thinking and compacting. */
const MODE_EASE_RATE = 5;
const MAX_DPR = 2;
/** Glyph slots in `u_text`; must match TEXT_CAPACITY in the TEXT snippet. */
const TEXT_CAPACITY = 96;
/** Atlas cell height in px; mipmaps cover the smaller on-screen sizes. */
const ATLAS_CELL_H = 64;
const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;
/** Atlas slot of "…" (slots 0–94 are ASCII 32–126). */
const ELLIPSIS_CODE = 95;
/** First atlas slot of the machine glyphs (machineGlyphs.ts). */
const MACHINE_GLYPH_BASE = 96;
const UNKNOWN_CODE = "?".charCodeAt(0) - 32;

interface ProgramEntry {
  program: WebGLProgram;
  res: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  k: WebGLUniformLocation | null;
  cycle: WebGLUniformLocation | null;
  flow: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  ink: WebGLUniformLocation | null;
  // Text uniforms: null unless the shader includes the TEXT snippet.
  glyphs: WebGLUniformLocation | null;
  glyphAspect: WebGLUniformLocation | null;
  atlasCellH: WebGLUniformLocation | null;
  text: WebGLUniformLocation | null;
  textLen: WebGLUniformLocation | null;
}

interface Instance {
  target: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  variant: ThinkingLineVariant;
  mode: ThinkingLineMode;
  speed: number;
  animate: boolean;
  visible: boolean;
  dirty: boolean;
  width: number;
  height: number;
  dpr: number;
  time: number;
  k: number;
  cycle: number;
  flow: number;
  textCodes: Float32Array;
  textLen: number;
}

export interface ThinkingLineOptions {
  variant: ThinkingLineVariant;
  mode: ThinkingLineMode;
  speed: number;
  animate: boolean;
  /** Status phrase drawn in the line. */
  text?: string;
}

export interface ThinkingLineHandle {
  update(options: Partial<ThinkingLineOptions>): void;
  /** CSS-pixel size of the target canvas. */
  resize(cssWidth: number, cssHeight: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface ThinkingLineStats {
  fps: number;
  /** CPU time spent issuing draws + blits per frame (GPU work is async). */
  frameMs: number;
  drawn: number;
  instances: number;
}

class ThinkingLineRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private atlas: WebGLTexture | null = null;
  private atlasAspect = 0.6;
  private atlasFontsHooked = false;
  private lost = false;
  private light = false;
  private themeKey = "";
  /** Three RGB gradient stops around the accent hue (u_accent). */
  private accentStops = new Float32Array(9);
  /** Foreground text colour (u_ink). */
  private ink = new Float32Array(3);
  private themeObserver: MutationObserver | null = null;
  private unsupported = false;
  private programs = new Map<ThinkingLineVariant, ProgramEntry | null>();
  private errors = new Map<ThinkingLineVariant, string>();
  private instances = new Set<Instance>();
  /** Notified when availability changes (context lost / restored). */
  private listeners = new Set<() => void>();
  private canvas2d: boolean | null = null;
  private raf = 0;
  private last = 0;
  private stats: ThinkingLineStats = {
    fps: 0,
    frameMs: 0,
    drawn: 0,
    instances: 0,
  };

  attach(
    target: HTMLCanvasElement,
    options: ThinkingLineOptions
  ): ThinkingLineHandle {
    const { text, ...rest } = options;
    const textCodes = new Float32Array(TEXT_CAPACITY);
    const inst: Instance = {
      target,
      ctx: target.getContext("2d"),
      ...rest,
      textCodes,
      textLen: encodeText(text, textCodes),
      visible: true,
      dirty: true,
      width: 0,
      height: 0,
      dpr: 1,
      time: options.animate ? Math.random() * 10 : STILL_FRAME_TIME,
      k: options.mode === "compacting" ? 1 : 0,
      cycle: 0,
      flow: 0,
    };
    inst.flow = inst.time;
    this.instances.add(inst);
    this.observeTheme();
    this.schedule();

    return {
      update: ({ text, ...next }) => {
        if (text !== undefined) inst.textLen = encodeText(text, inst.textCodes);
        if (next.mode && next.mode !== inst.mode) {
          if (next.mode === "compacting") inst.cycle = 0;
          if (!inst.animate) inst.k = next.mode === "compacting" ? 1 : 0;
        }
        if (next.animate === false && inst.animate) {
          inst.time = STILL_FRAME_TIME;
          inst.flow = STILL_FRAME_TIME;
        }
        Object.assign(inst, next);
        if (!inst.animate) inst.k = inst.mode === "compacting" ? 1 : 0;
        inst.dirty = true;
        this.schedule();
      },
      resize: (cssWidth, cssHeight) => {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const w = Math.max(0, Math.round(cssWidth * dpr));
        const h = Math.max(0, Math.round(cssHeight * dpr));
        if (w === inst.width && h === inst.height && dpr === inst.dpr) return;
        inst.width = w;
        inst.height = h;
        inst.dpr = dpr;
        target.width = w;
        target.height = h;
        inst.dirty = true;
        this.schedule();
      },
      setVisible: (visible) => {
        inst.visible = visible;
        if (visible) inst.dirty = true;
        this.schedule();
      },
      dispose: () => {
        this.instances.delete(inst);
      },
    };
  }

  getStats(): ThinkingLineStats {
    return { ...this.stats, instances: this.instances.size };
  }

  /**
   * Whether `variant` can be drawn right now: needs 2D canvases for the
   * per-instance blit, a live WebGL2 context and a compiled program. Probes
   * eagerly (creating the context and compiling the program on first call)
   * so callers can show their fallback before the first frame.
   */
  isAvailable(variant: ThinkingLineVariant): boolean {
    this.canvas2d ??=
      document.createElement("canvas").getContext("2d") !== null;
    if (!this.canvas2d || !this.ensureGl()) return false;
    return this.program(variant) !== null;
  }

  /** Subscribe to availability changes; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getError(variant: ThinkingLineVariant): string | undefined {
    if (this.unsupported) return "WebGL2 is unavailable";
    return this.errors.get(variant);
  }

  /**
   * Theme and accent live on <html> (`.light`, `data-accent`; see
   * hooks/useTheme.ts). The per-frame check is a string compare; colours are
   * re-resolved from the CSS tokens only when either changes, and still
   * frames are redrawn.
   */
  private syncTheme(): boolean {
    const root = document.documentElement;
    const key = `${root.className}|${root.dataset.accent ?? ""}`;
    if (key !== this.themeKey) {
      this.themeKey = key;
      this.light = root.classList.contains("light");
      const style = getComputedStyle(root);
      const accent = resolveCssColor(style.getPropertyValue("--color-accent"));
      const fg = resolveCssColor(style.getPropertyValue("--color-fg"));
      if (accent) writeAccentStops(accent, this.accentStops);
      if (fg) this.ink.set(fg);
      for (const inst of this.instances) inst.dirty = true;
    }
    return this.light;
  }

  private observeTheme() {
    if (this.themeObserver || typeof MutationObserver === "undefined") return;
    this.themeObserver = new MutationObserver(() => {
      this.syncTheme();
      this.schedule();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-accent"],
    });
  }

  private needsFrame(): boolean {
    for (const inst of this.instances) {
      if (!inst.visible || inst.width === 0 || inst.height === 0) continue;
      if (inst.animate || inst.dirty) return true;
    }
    return false;
  }

  private schedule() {
    if (this.raf || this.unsupported || !this.needsFrame()) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    const start = performance.now();
    let drawn = 0;

    const live = [...this.instances].filter(
      (i) => i.visible && i.width > 0 && i.height > 0 && (i.animate || i.dirty)
    );
    for (const inst of live) if (inst.animate) advance(inst, dt);
    const light = this.syncTheme();

    if (live.length > 0 && this.ensureGl()) {
      const gl = this.gl!;
      const canvas = this.canvas!;
      const maxW = Math.max(...live.map((i) => i.width));
      const maxH = Math.max(...live.map((i) => i.height));
      // Grow-only: resizing the drawing buffer reallocates it.
      if (canvas.width < maxW || canvas.height < maxH) {
        canvas.width = Math.max(canvas.width, maxW);
        canvas.height = Math.max(canvas.height, maxH);
      }
      gl.bindVertexArray(this.vao);
      gl.clearColor(0, 0, 0, 0);
      for (const inst of live) {
        const entry = this.program(inst.variant);
        if (!entry || !inst.ctx) continue;
        gl.viewport(0, 0, inst.width, inst.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(entry.program);
        gl.uniform2f(entry.res, inst.width, inst.height);
        gl.uniform1f(entry.time, inst.time);
        gl.uniform1f(entry.k, inst.k);
        gl.uniform1f(entry.cycle, inst.cycle);
        gl.uniform1f(entry.flow, inst.flow);
        gl.uniform1f(entry.dpr, inst.dpr);
        gl.uniform1f(entry.light, light ? 1 : 0);
        gl.uniform3fv(entry.accent, this.accentStops);
        gl.uniform3fv(entry.ink, this.ink);
        if (entry.glyphs) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.ensureAtlas(gl));
          gl.uniform1i(entry.glyphs, 0);
          gl.uniform1f(entry.glyphAspect, this.atlasAspect);
          gl.uniform1f(entry.atlasCellH, ATLAS_CELL_H);
          gl.uniform1fv(entry.text, inst.textCodes);
          gl.uniform1f(entry.textLen, inst.textLen);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        inst.ctx.clearRect(0, 0, inst.width, inst.height);
        // GL's origin is bottom-left: the viewport sits at the bottom of the
        // shared canvas.
        inst.ctx.drawImage(
          canvas,
          0,
          canvas.height - inst.height,
          inst.width,
          inst.height,
          0,
          0,
          inst.width,
          inst.height
        );
        inst.dirty = false;
        drawn += 1;
      }
    }

    const cost = performance.now() - start;
    const fps = dt > 0 ? 1 / dt : this.stats.fps;
    this.stats.fps = this.stats.fps ? this.stats.fps * 0.9 + fps * 0.1 : fps;
    this.stats.frameMs = this.stats.frameMs * 0.9 + cost * 0.1;
    this.stats.drawn = drawn;

    if (this.needsFrame()) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  private ensureGl(): boolean {
    if (this.lost || this.unsupported) return false;
    if (this.gl && this.vao) return true;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.lost = true;
        this.notify();
      });
      this.canvas.addEventListener("webglcontextrestored", () => {
        this.lost = false;
        this.vao = null;
        this.atlas = null;
        this.programs.clear();
        for (const inst of this.instances) inst.dirty = true;
        this.notify();
        this.schedule();
      });
    }
    this.gl ??= this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!this.gl) {
      this.unsupported = true;
      return false;
    }
    this.vao = this.gl.createVertexArray();
    return true;
  }

  /**
   * Monospace glyph atlas (ASCII 32–126 plus "…") in the app's mono font,
   * white on transparent; shaders sample its alpha. Rebuilt once the web
   * font has loaded, since the first build may fall back to a system face.
   */
  private ensureAtlas(gl: WebGL2RenderingContext): WebGLTexture | null {
    if (this.atlas) return this.atlas;
    const family =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";
    const font = `400 ${Math.round(ATLAS_CELL_H * 0.68)}px ${family}`;
    const atlasCanvas = document.createElement("canvas");
    const ctx = atlasCanvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = font;
    const cellW = Math.ceil(ctx.measureText("M").width);
    atlasCanvas.width = cellW * ATLAS_COLS;
    atlasCanvas.height = ATLAS_CELL_H * ATLAS_ROWS;
    ctx.font = font;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i <= ELLIPSIS_CODE; i++) {
      const ch = i === ELLIPSIS_CODE ? "\u2026" : String.fromCharCode(32 + i);
      const x = (i % ATLAS_COLS) * cellW + cellW / 2;
      const y = Math.floor(i / ATLAS_COLS) * ATLAS_CELL_H + ATLAS_CELL_H * 0.74;
      ctx.fillText(ch, x, y);
    }
    // Cap-height box of the font, which the machine glyphs share.
    const metrics = ctx.measureText("H");
    const baseline = ATLAS_CELL_H * 0.74;
    const top = baseline - metrics.actualBoundingBoxAscent;
    const stroke = Math.max(2, ATLAS_CELL_H * 0.068);
    for (let i = 0; i < MACHINE_GLYPH_COUNT; i++) {
      const slot = MACHINE_GLYPH_BASE + i;
      const x = (slot % ATLAS_COLS) * cellW;
      const y = Math.floor(slot / ATLAS_COLS) * ATLAS_CELL_H;
      drawMachineGlyph(ctx, i, x, y, cellW, top, baseline, stroke);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      atlasCanvas
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlas = tex;
    this.atlasAspect = cellW / ATLAS_CELL_H;

    if (!this.atlasFontsHooked && document.fonts) {
      this.atlasFontsHooked = true;
      void document.fonts
        .load(font)
        .then(() => document.fonts.ready)
        .then(() => {
          if (this.gl !== gl || this.atlas !== tex) return;
          gl.deleteTexture(tex);
          this.atlas = null;
          for (const inst of this.instances) inst.dirty = true;
          this.schedule();
        });
    }
    return tex;
  }

  private program(variant: ThinkingLineVariant): ProgramEntry | null {
    const cached = this.programs.get(variant);
    if (cached !== undefined) return cached;
    const gl = this.gl!;
    const entry = compileProgram(gl, variant, (message) => {
      this.errors.set(variant, message);
      console.error(`[thinking-line] ${variant}: ${message}`);
    });
    this.programs.set(variant, entry);
    return entry;
  }
}

function advance(inst: Instance, dt: number) {
  const step = dt * inst.speed;
  const target = inst.mode === "compacting" ? 1 : 0;
  inst.k += (target - inst.k) * (1 - Math.exp(-step * MODE_EASE_RATE));
  if (Math.abs(target - inst.k) < 1e-3) inst.k = target;
  inst.time += step;
  inst.flow += step * (1 - 2 * inst.k);
  if (inst.mode === "compacting") inst.cycle += step;
}

function compileProgram(
  gl: WebGL2RenderingContext,
  variant: ThinkingLineVariant,
  onError: (message: string) => void
): ProgramEntry | null {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      onError(gl.getShaderInfoLog(s) ?? "shader compile failed");
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, THINKING_LINE_VERTEX_SHADER);
  const fs = shader(gl.FRAGMENT_SHADER, thinkingLineFragmentSource(variant));
  if (!vs || !fs) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    onError(gl.getProgramInfoLog(program) ?? "program link failed");
    gl.deleteProgram(program);
    return null;
  }
  const u = (name: string) => gl.getUniformLocation(program, name);
  return {
    program,
    res: u("u_res"),
    time: u("u_time"),
    k: u("u_k"),
    cycle: u("u_cycle"),
    flow: u("u_flow"),
    dpr: u("u_dpr"),
    light: u("u_light"),
    accent: u("u_accent"),
    ink: u("u_ink"),
    glyphs: u("u_glyphs"),
    glyphAspect: u("u_glyphAspect"),
    atlasCellH: u("u_atlasCellH"),
    text: u("u_text"),
    textLen: u("u_textLen"),
  };
}

/** Writes atlas slots for `text` into `out`; returns the glyph count. */
function encodeText(text: string | undefined, out: Float32Array): number {
  out.fill(0);
  if (!text) return 0;
  let n = 0;
  for (const ch of text) {
    if (n >= out.length) break;
    out[n++] = glyphCode(ch);
  }
  return n;
}

function glyphCode(ch: string): number {
  if (ch === "\u2026") return ELLIPSIS_CODE;
  if (ch === "\u2018" || ch === "\u2019") return "'".charCodeAt(0) - 32;
  const c = ch.codePointAt(0) ?? 0;
  return c >= 32 && c <= 126 ? c - 32 : UNKNOWN_CODE;
}

let shared: ThinkingLineRenderer | null = null;

export function getThinkingLineRenderer(): ThinkingLineRenderer {
  shared ??= new ThinkingLineRenderer();
  return shared;
}

/** Resolves any CSS colour (oklch tokens included) to sRGB 0..1. */
function resolveCssColor(value: string): [number, number, number] | null {
  const v = value.trim();
  if (!v) return null;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/** Accent hue rotated by this many degrees for the outer gradient stops. */
const ACCENT_SPREAD_DEG = 32;

/**
 * Writes three emissive stops (hue − spread, accent, hue + spread) into
 * `out`. Each is normalised to a peak channel of 1 so the shaders' light
 * stays equally bright whichever accent the user picked.
 */
function writeAccentStops(rgb: [number, number, number], out: Float32Array) {
  const [h, s, l] = rgbToHsl(rgb);
  const sat = Math.max(s, 0.55);
  [-ACCENT_SPREAD_DEG, 0, ACCENT_SPREAD_DEG].forEach((deg, i) => {
    const c = i === 1 ? rgb : hslToRgb([(h + deg / 360 + 1) % 1, sat, l]);
    const peak = Math.max(c[0], c[1], c[2], 1e-3);
    out.set(
      c.map((v) => v / peak),
      i * 3
    );
  });
}

function rgbToHsl([r, g, b]: [number, number, number]): [
  number,
  number,
  number,
] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [
  number,
  number,
  number,
] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
