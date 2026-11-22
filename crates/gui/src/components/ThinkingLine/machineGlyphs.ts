/**
 * Invented "machine script" glyphs for scrambled text. Each glyph is built
 * deterministically from a seed on a 3×5 node grid inside the font's cap-height
 * box: a stem, rungs and hooks off it, plus one accent mark (ring, notch, dot
 * or slash). Stroke weight matches the mono font so the script sits naturally
 * next to real text in the atlas.
 */

/** Number of machine glyphs drawn into the atlas after the ASCII slots. */
export const MACHINE_GLYPH_COUNT = 32;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws machine glyph `index` centred in the cell at (x, y). `top` and
 * `baseline` are the cap-height box's y offsets within the cell.
 */
export function drawMachineGlyph(
  ctx: CanvasRenderingContext2D,
  index: number,
  x: number,
  y: number,
  cellW: number,
  top: number,
  baseline: number,
  stroke: number
) {
  const r = rng(index * 7919 + 17);
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(r() * items.length)];
  const left = x + cellW * 0.2;
  const right = x + cellW * 0.8;
  const nx = (c: number) => left + ((right - left) * c) / 2;
  const ny = (row: number) => y + top + ((baseline - top) * row) / 4;

  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = stroke;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  const line = (c0: number, r0: number, c1: number, r1: number) => {
    ctx.beginPath();
    ctx.moveTo(nx(c0), ny(r0));
    ctx.lineTo(nx(c1), ny(r1));
    ctx.stroke();
  };

  // Stem: full height, or a split stem with a gap.
  const stemCol = pick([0, 1, 1, 2]);
  if (r() < 0.75) line(stemCol, 0, stemCol, 4);
  else {
    const gap = 1 + Math.floor(r() * 3);
    line(stemCol, 0, stemCol, gap - 0.6);
    line(stemCol, gap + 0.6, stemCol, 4);
  }

  // Rungs: 1–3 horizontal strokes leaving the stem.
  const rungs = 1 + Math.floor(r() * 3);
  const usedRows = new Set<number>();
  for (let i = 0; i < rungs; i++) {
    const row = pick([0, 1, 2, 3, 4]);
    if (usedRows.has(row)) continue;
    usedRows.add(row);
    const to = stemCol === 1 ? pick([0, 2]) : 2 - stemCol;
    line(stemCol, row, to, row);
    // Some rungs end in a hook.
    if (r() < 0.4) line(to, row, to, row + (row < 2 ? 1 : -1));
  }

  // One accent mark.
  const mark = r();
  const mc = pick([0, 1, 2]);
  const mr = pick([1, 2, 3]);
  if (mark < 0.3) {
    ctx.beginPath();
    ctx.arc(nx(mc), ny(mr), (right - left) * 0.2, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mark < 0.55) {
    const d = stroke * 1.2;
    ctx.fillRect(nx(mc) - d / 2, ny(mr) - d / 2, d, d);
  } else if (mark < 0.8) {
    line(mc === 1 ? 0 : mc, mr - 1, mc === 1 ? 2 : 2 - mc, mr + 1);
  } else {
    // Notch: a short open bracket.
    const s = mc < 1 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(nx(mc) + s * stroke * 2, ny(mr - 0.6));
    ctx.lineTo(nx(mc), ny(mr - 0.6));
    ctx.lineTo(nx(mc), ny(mr + 0.6));
    ctx.lineTo(nx(mc) + s * stroke * 2, ny(mr + 0.6));
    ctx.stroke();
  }
  ctx.restore();
}
