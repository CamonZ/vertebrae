/**
 * Gallery rails a flow drew that are leads: a part rail running out to the
 * cell's west or east edge (x ≤ 44 or ≥ 596 in part space), where the
 * gallery's neighbours would be. Flows draw their own wires there.
 */
export function drawnLeads(root: ParentNode): string[] {
  return [...root.querySelectorAll(".md-rail path")]
    .map((p) => p.getAttribute("d") ?? "")
    .filter((d) =>
      [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,]/g)].some(([, x]) => {
        const n = Number(x);
        return n <= 44 || n >= 596;
      })
    );
}
