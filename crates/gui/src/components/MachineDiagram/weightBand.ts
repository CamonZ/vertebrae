/**
 * Weight band for diagram text at a zoom. Small on-screen text needs a
 * heavier stroke to hold together; as the user zooms in the same glyphs grow
 * and read heavy, so the weight steps down. Bands (rather than a continuous
 * weight) keep zooming from restyling every label on each frame.
 */
export type WeightBand = "far" | "mid" | "near";

export function weightBand(zoom: number): WeightBand {
  if (zoom < 0.5) return "far";
  return zoom < 0.8 ? "mid" : "near";
}
