/** Test oracle: enumerate rotation systems compatible with fixed port order.
 * Euler's formula on the dart permutation certifies a planar embedding.
 * A bounded search reports unknown, never a false non-planarity claim.
 */
import type { DiagramTimeline } from "./compile";
export type Planarity = "planar" | "non-planar" | "unknown";

export function fixedPortPlanarity(
  d: Pick<DiagramTimeline, "parts" | "rails">,
  limit = 200_000
): Planarity {
  const parent = new Map(d.parts.map((p) => [p.id, p.id]));
  const root = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const r of d.rails) parent.set(root(r.from.part), root(r.to.part));
  let unknown = false;
  for (const component of new Set(d.parts.map((p) => root(p.id)))) {
    const parts = d.parts.filter((p) => root(p.id) === component);
    const rails = d.rails.filter((r) => root(r.from.part) === component);
    if (rails.length < parts.length) continue; // Every tree permits every rotation.
    const rotation = new Array<number>(rails.length * 2);
    const groups = parts.map((p) => {
      const ports = Object.entries(p.ports).sort(([, a], [, b]) => {
        const sides = { N: 0, E: 1, S: 2, W: 3 };
        if (a.side !== b.side) return sides[a.side] - sides[b.side];
        const coordinate = a.side === "N" || a.side === "S" ? 0 : 1;
        return (
          (a.local[coordinate] - b.local[coordinate]) *
          (a.side === "S" || a.side === "W" ? -1 : 1)
        );
      });
      return ports
        .map(([name]) =>
          rails.flatMap((r, i) => [
            ...(r.from.part === p.id && r.from.port === name ? [2 * i] : []),
            ...(r.to.part === p.id && r.to.port === name ? [2 * i + 1] : []),
          ])
        )
        .filter((g) => g.length > 0);
    });
    let visited = 0;
    let planar = false;
    const selected: number[][][] = groups.map((g) =>
      g.map((darts) =>
        [...darts].sort((a, b) => (a % 2 ? -a : a) - (b % 2 ? -b : b))
      )
    );
    const choices = selected.flatMap((ports, v) =>
      ports.map((darts, p) => ({ darts, v, p }))
    );
    const evaluate = () => {
      visited++;
      for (const ports of selected) {
        const around = ports.flat();
        for (let i = 0; i < around.length; i++)
          rotation[around[i]] = around[(i + 1) % around.length];
      }
      const seen = new Set<number>();
      let faces = 0;
      for (let i = 0; i < rotation.length; i++)
        if (!seen.has(i)) {
          faces++;
          let dart = i;
          while (!seen.has(dart)) {
            seen.add(dart);
            dart = rotation[dart ^ 1];
          }
        }
      planar = parts.length - rails.length + faces === 2;
    };
    const search = (at: number) => {
      if (planar || visited >= limit) return;
      if (at === choices.length) {
        evaluate();
        return;
      }
      const { darts, v, p } = choices[at];
      const permute = (k: number) => {
        if (planar || visited >= limit) return;
        if (k === darts.length) {
          selected[v][p] = [...darts];
          search(at + 1);
          return;
        }
        for (let i = k; i < darts.length; i++) {
          [darts[k], darts[i]] = [darts[i], darts[k]];
          permute(k + 1);
          [darts[k], darts[i]] = [darts[i], darts[k]];
        }
      };
      permute(0);
    };
    search(0);
    if (!planar && visited < limit) return "non-planar";
    if (!planar) unknown = true;
  }
  return unknown ? "unknown" : "planar";
}
