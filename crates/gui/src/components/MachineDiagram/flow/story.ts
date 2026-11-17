import type { CompiledFlow, DiagramTimeline } from "./compile";
import type { AttachmentSpec } from "./spec";

export interface StoryActor {
  readonly key: string;
  readonly label: string;
  readonly attachments: readonly AttachmentSpec[];
}

/** Caption windows include uncaptioned continuations and exclude absent actors. */
export function storyActors(
  flow: CompiledFlow,
  diagram: DiagramTimeline,
  index: number
): StoryActor[] {
  const beat = diagram.beats[index];
  if (!beat) return [];
  const [start, end] = (beat.id && diagram.beatWindows[beat.id]) || [
    beat.t,
    diagram.beats[index + 1]?.t ?? diagram.period,
  ];
  const overlaps = (t: number, until: number) => t < end && until > start;
  const markers = diagram.markers.filter((m) => m.t >= start && m.t < end);
  const parts = diagram.parts.filter(
    (p) =>
      p.presence !== "absent" &&
      (p.steps.some(
        (s) => (s.t >= start && s.t < end) || overlaps(s.t, s.end)
      ) ||
        markers.some((m) => m.part === p.id))
  );
  const cards = new Set<string>();
  const rails = new Set(markers.flatMap((m) => (m.rail ? [m.rail] : [])));
  for (const p of parts)
    for (const c of p.timeline.cards)
      if (c.id && overlaps(c.born, c.dies)) cards.add(c.id);
  for (const c of diagram.travel.cards) {
    for (const leg of c.legs) {
      if (!overlaps(leg.t, leg.t + leg.d)) continue;
      if (c.id) cards.add(c.id);
      // Arrival markers identify a travelled rail; the leg supplies its
      // start, so a trip crossing a caption boundary belongs to both beats.
      const arrival = diagram.markers.find(
        (m) =>
          m.rail && m.card === c.id && Math.abs(m.t - (leg.t + leg.d)) < 0.00001
      );
      if (arrival?.rail) rails.add(arrival.rail);
    }
  }
  for (const m of markers) if (m.card) cards.add(m.card);
  return [
    ...parts.map((p) => ({
      key: `part:${p.id}`,
      label: p.identity.name,
      attachments: p.attachments,
    })),
    ...diagram.rails
      .filter((r) => r.presence !== "absent" && rails.has(r.id))
      .map((r) => ({
        key: `rail:${r.id}`,
        label: `Rail: ${r.label ?? r.id}`,
        attachments: r.attachments,
      })),
    ...[...cards].map((id) => ({
      key: `card:${id}`,
      label: `Card: ${flow.cards[id]?.label ?? id}`,
      attachments: flow.cards[id]?.attachments ?? [],
    })),
  ];
}
