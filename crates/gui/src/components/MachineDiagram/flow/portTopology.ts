import type { DiagramTimeline } from "./compile";

export type PortPlanarity = "planar" | "non-planar" | "unknown";

// Reverse incoming ends so parallel rails start nested rather than interleaved.
// Both searches must start from the same rotation to agree within a budget.
const defaultDartRank = (dart: number) => (dart % 2 ? -dart : dart);

class Components {
  readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  root(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  join(a: number, b: number) {
    this.parent[this.root(a)] = this.root(b);
  }
}

/** Fixed ports prescribe a cyclic order; rails sharing one port may permute.
 * A rotation system has a planar embedding exactly when V-E+F=2 in each
 * connected component. Face components are counted with disjoint sets rather
 * than geometric routing. Exhausting the budget means unknown, not non-planar.
 */
function computePortPlanarity(
  diagram: Pick<DiagramTimeline, "parts" | "rails">,
  budget = 200_000
): PortPlanarity {
  // Necessary Euler bounds avoid enumerating rotations of dense graphs
  // (notably K3,3); loops and parallel rails are left to the exact search.
  if (exceedsEulerBound(diagram)) return "non-planar";
  const index = new Map(diagram.parts.map((p, i) => [p.id, i]));
  const connected = new Components(diagram.parts.length);
  for (const r of diagram.rails)
    connected.join(index.get(r.from.part)!, index.get(r.to.part)!);
  let unknown = false;
  for (const component of new Set(
    diagram.parts.map((_, i) => connected.root(i))
  )) {
    const parts = diagram.parts.filter(
      (_, i) => connected.root(i) === component
    );
    const rails = diagram.rails.filter(
      (r) => connected.root(index.get(r.from.part)!) === component
    );
    if (rails.length < parts.length) continue;
    const around = parts.map((p) =>
      Object.entries(p.ports)
        .map(([name, port]) => {
          const angle = { N: 0, E: 1, S: 2, W: 3 }[port.side];
          const position =
            (port.side === "N" || port.side === "S"
              ? port.local[0]
              : port.local[1]) *
            (port.side === "S" || port.side === "W" ? -1 : 1);
          const ends = rails.flatMap((r, i) => [
            ...(r.from.part === p.id && r.from.port === name ? [2 * i] : []),
            ...(r.to.part === p.id && r.to.port === name ? [2 * i + 1] : []),
          ]);
          ends.sort((a, b) => defaultDartRank(a) - defaultDartRank(b));
          return { angle, position, ends };
        })
        .filter((p) => p.ends.length)
        .sort((a, b) => a.angle - b.angle || a.position - b.position)
        .map((p) => p.ends)
    );
    const groups = around.flat();
    const next = new Array<number>(rails.length * 2);
    let trials = 0;
    let found = false;
    const check = () => {
      trials++;
      for (const ports of around) {
        const cycle = ports.flat();
        for (let i = 0; i < cycle.length; i++)
          next[cycle[i]] = cycle[(i + 1) % cycle.length];
      }
      const faces = new Components(next.length);
      for (let dart = 0; dart < next.length; dart++)
        faces.join(dart, next[dart ^ 1]);
      const faceCount = new Set(next.map((_, i) => faces.root(i))).size;
      found = parts.length - rails.length + faceCount === 2;
    };
    const choose = (group: number) => {
      if (found || trials >= budget) return;
      if (group === groups.length) {
        check();
        return;
      }
      const entries = groups[group];
      const arrange = (at: number) => {
        if (found || trials >= budget) return;
        if (at === entries.length) {
          choose(group + 1);
          return;
        }
        for (let j = at; j < entries.length; j++) {
          [entries[at], entries[j]] = [entries[j], entries[at]];
          arrange(at + 1);
          [entries[at], entries[j]] = [entries[j], entries[at]];
        }
      };
      arrange(0);
    };
    choose(0);
    if (!found && trials < budget) return "non-planar";
    if (!found) unknown = true;
  }
  return unknown ? "unknown" : "planar";
}

const topologyCache = new Map<string, PortPlanarity>();

/** Labels, marks and absolute node positions do not change port topology.
 * Keep a bounded value cache for replay and Before/After/metamorphic layouts.
 * Non-default search budgets deliberately bypass it, including budget zero.
 */
export function portPlanarity(
  diagram: Pick<DiagramTimeline, "parts" | "rails">,
  budget = 200_000
): PortPlanarity {
  if (budget !== 200_000) return computePortPlanarity(diagram, budget);
  const parts = new Map(diagram.parts.map((p, i) => [p.id, i]));
  const ports = diagram.parts.map((p) => Object.keys(p.ports));
  const endpoint = (end: DiagramTimeline["rails"][number]["from"]) => {
    const part = parts.get(end.part)!;
    return [part, ports[part].indexOf(end.port)];
  };
  const key = JSON.stringify([
    diagram.parts.map((p) =>
      Object.values(p.ports).map((q) => [q.side, ...q.local])
    ),
    diagram.rails.map((r) => [endpoint(r.from), endpoint(r.to)]),
  ]);
  const cached = topologyCache.get(key);
  if (cached !== undefined) return cached;
  const result = computePortPlanarity(diagram, budget);
  if (topologyCache.size >= 128)
    topologyCache.delete(topologyCache.keys().next().value!);
  topologyCache.set(key, result);
  return result;
}

/** Necessary Euler bounds on the underlying simple graph of each component:
 * true proves the port order non-planar without enumerating rotations. */
function exceedsEulerBound(
  diagram: Pick<DiagramTimeline, "parts" | "rails">
): boolean {
  const index = new Map(diagram.parts.map((p, i) => [p.id, i]));
  const connected = new Components(diagram.parts.length);
  for (const r of diagram.rails)
    connected.join(index.get(r.from.part)!, index.get(r.to.part)!);
  for (const component of new Set(
    diagram.parts.map((_, i) => connected.root(i))
  )) {
    const parts = diagram.parts.filter(
      (_, i) => connected.root(i) === component
    );
    if (parts.length < 3) continue;
    const local = new Map(parts.map((p, i) => [p.id, i]));
    const adjacency = parts.map(() => new Set<number>());
    for (const rail of diagram.rails) {
      const a = local.get(rail.from.part);
      const b = local.get(rail.to.part);
      if (a !== undefined && b !== undefined && a !== b) {
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
    }
    const edges = adjacency.reduce((sum, a) => sum + a.size, 0) / 2;
    if (edges > 3 * parts.length - 6) return true;
    const colour = new Map<number, number>([[0, 0]]);
    const queue = [0];
    let bipartite = true;
    for (const a of queue)
      for (const b of adjacency[a]) {
        if (!colour.has(b)) {
          colour.set(b, 1 - colour.get(a)!);
          queue.push(b);
        } else if (colour.get(a) === colour.get(b)) bipartite = false;
      }
    if (bipartite && edges > 2 * parts.length - 4) return true;
  }
  return false;
}

/** A rail end: `2 * i` leaves rail `i`'s source port, `2 * i + 1` enters its target. */
export type Dart = number;

/** The ports of a part in clockwise order (screen coordinates, y down). */
export function clockwisePorts(
  part: Pick<DiagramTimeline["parts"][number], "ports">
): string[] {
  return Object.entries(part.ports)
    .map(([name, port]) => ({
      name,
      angle: { N: 0, E: 1, S: 2, W: 3 }[port.side],
      position:
        (port.side === "N" || port.side === "S"
          ? port.local[0]
          : port.local[1]) * (port.side === "S" || port.side === "W" ? -1 : 1),
    }))
    .sort((a, b) => a.angle - b.angle || a.position - b.position)
    .map((p) => p.name);
}

/**
 * A planar embedding under fixed port positions: for every used port
 * (`part.port`), the clockwise order of the rail ends sharing it. `fixed`
 * lists ends whose relative order is already drawn and must be kept;
 * `preferred` is tried first, so the result stays close to an existing
 * drawing. Undefined when no embedding exists or the search budget runs out.
 */
export function portEmbedding(
  diagram: Pick<DiagramTimeline, "parts" | "rails">,
  fixed: ReadonlyMap<string, readonly Dart[]> = new Map(),
  preferred: ReadonlyMap<string, readonly Dart[]> = new Map(),
  budget = 200_000
): Map<string, Dart[]> | undefined {
  if (exceedsEulerBound(diagram)) return undefined;
  const index = new Map(diagram.parts.map((p, i) => [p.id, i]));
  const connected = new Components(diagram.parts.length);
  for (const r of diagram.rails)
    connected.join(index.get(r.from.part)!, index.get(r.to.part)!);
  const result = new Map<string, Dart[]>();
  const keyOf = (part: string, port: string) => `${part}.${port}`;
  // Darts at each used port, in preferred order where one is given.
  const dartsAt = new Map<string, Dart[]>();
  diagram.rails.forEach((r, i) => {
    for (const [end, dart] of [
      [r.from, 2 * i],
      [r.to, 2 * i + 1],
    ] as const) {
      const key = keyOf(end.part, end.port);
      dartsAt.set(key, [...(dartsAt.get(key) ?? []), dart]);
    }
  });
  for (const [key, darts] of dartsAt) {
    const order = preferred.get(key) ?? [];
    const rank = (d: Dart) => {
      const at = order.indexOf(d);
      return at < 0 ? order.length : at;
    };
    darts.sort(
      (a, b) => rank(a) - rank(b) || defaultDartRank(a) - defaultDartRank(b)
    );
  }
  // A permutation keeps every fixed end in its drawn relative order.
  const keeps = (key: string, darts: readonly Dart[]) => {
    const want = fixed.get(key);
    if (!want || want.length < 2) return true;
    const seen = darts.filter((d) => want.includes(d));
    return seen.every((d, i) => d === want[i]);
  };
  for (const component of new Set(
    diagram.parts.map((_, i) => connected.root(i))
  )) {
    const parts = diagram.parts.filter(
      (_, i) => connected.root(i) === component
    );
    const railCount = diagram.rails.filter(
      (r) => connected.root(index.get(r.from.part)!) === component
    ).length;
    const ports = parts.map((p) =>
      clockwisePorts(p)
        .map((name) => keyOf(p.id, name))
        .filter((key) => dartsAt.has(key))
    );
    const slots = ports.flat();
    const slotIndex = new Map(slots.map((k, i) => [k, i]));
    const chosenAt = slots.map((k) => [...dartsAt.get(k)!]);
    const aroundSlots = ports.map((around) =>
      around.map((k) => slotIndex.get(k)!)
    );
    // A forest embeds with any rotation: keep the first order that honours `fixed`.
    const forest = railCount < parts.length;
    const next = new Int32Array(diagram.rails.length * 2);
    const seen = new Int32Array(diagram.rails.length * 2);
    const darts = slots.flatMap((k) => dartsAt.get(k)!);
    let stamp = 0;
    let trials = 0;
    let found = false;
    const planar = () => {
      trials++;
      for (const around of aroundSlots) {
        let firstDart = -1;
        let previous = -1;
        for (const slot of around)
          for (const d of chosenAt[slot]) {
            if (previous < 0) firstDart = d;
            else next[previous] = d;
            previous = d;
          }
        if (previous >= 0) next[previous] = firstDart;
      }
      stamp++;
      let faces = 0;
      for (const start of darts)
        if (seen[start] !== stamp) {
          faces++;
          for (let d = start; seen[d] !== stamp; d = next[d ^ 1])
            seen[d] = stamp;
        }
      return parts.length - railCount + faces === 2;
    };
    const choose = (slot: number) => {
      if (found || trials >= budget) return;
      if (slot === slots.length) {
        found = forest || planar();
        if (forest) trials++;
        return;
      }
      const key = slots[slot];
      const darts = [...dartsAt.get(key)!];
      const arrange = (at: number) => {
        if (found || trials >= budget) return;
        if (at === darts.length) {
          if (!keeps(key, darts)) return;
          chosenAt[slot] = [...darts];
          choose(slot + 1);
          return;
        }
        for (let j = at; j < darts.length; j++) {
          [darts[at], darts[j]] = [darts[j], darts[at]];
          arrange(at + 1);
          [darts[at], darts[j]] = [darts[j], darts[at]];
          if (found) return;
        }
      };
      arrange(0);
    };
    choose(0);
    if (!found) return undefined;
    slots.forEach((key, i) => result.set(key, chosenAt[i]));
  }
  return result;
}
