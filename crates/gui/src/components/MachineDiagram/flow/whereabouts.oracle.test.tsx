/**
 * Oracle tests for the player's narration: what `cardWhereabouts` and
 * `partStatusAt` say must agree with what FlowDiagram actually draws. The
 * rendered SVG is the oracle; Hegel picks the arrangement, the card and the
 * instant.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "./__fixtures__/mechanisms.flow.yaml?raw";
import { noteIndex } from "../timeline";
import { FlowDiagram } from "./FlowDiagram";
import {
  cardTrack,
  cardWhereabouts,
  compileFlowOrThrow,
  parseFlowSpec,
  partStatusAt,
  type DiagramTimeline,
} from "./index";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function arrangements(source: string): DiagramTimeline[] {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return [...compileFlowOrThrow(parsed.value).arrangements];
}

const DIAGRAMS = [
  ...arrangements(inlineDiscussions),
  ...arrangements(mechanisms),
  ...arrangements(burstOptions),
];

/** Cards with ids that this arrangement actually draws. */
function cardIds(d: DiagramTimeline): string[] {
  const ids = new Set<string>();
  for (const c of d.travel.cards) if (c.id) ids.add(c.id);
  for (const p of d.parts)
    for (const c of p.timeline.cards) if (c.id) ids.add(c.id);
  return [...ids].sort();
}

/** Layer → opacity of card `id` as drawn: "rail" or the enclosing part id. */
function drawn(container: HTMLElement, id: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of container.querySelectorAll(`[data-card-id='${id}']`)) {
    const part = el.closest("[data-part-id]")?.getAttribute("data-part-id");
    const layer = part ?? (el.closest(".md-rail-cards") ? "rail" : "?");
    const alpha = Number(
      el.querySelector(":scope > g[opacity]")?.getAttribute("opacity") ?? 0
    );
    out.set(layer, Math.max(out.get(layer) ?? 0, alpha));
  }
  return out;
}

const layerOf = (w: ReturnType<typeof cardWhereabouts>) =>
  w.kind === "rail" ? "rail" : w.kind === "part" ? w.part : null;

afterEach(cleanup);

test("a card is drawn where the narration says it is", () =>
  hegel.test(
    (tc) => {
      const d = tc.draw(gs.sampledFrom(DIAGRAMS));
      const ids = cardIds(d);
      tc.assume(ids.length > 0);
      const id = tc.draw(gs.sampledFrom(ids));
      const t = tc.draw(
        gs.floats({ minValue: 0, maxValue: d.period, excludeMax: true })
      );
      const { container } = render(
        <FlowDiagram diagram={d} t={t} reducedMotion={false} />
      );
      const where = cardWhereabouts(d, id, t);
      const seen = drawn(container, id);
      const clearly = [...seen].filter(([, a]) => a >= 0.5).map(([l]) => l);
      const layer = layerOf(where);

      if (where.kind === "pending")
        check(
          seen.size === 0,
          `${id} at ${t}: pending but drawn in ${[...seen.keys()]}`
        );
      if (where.kind === "rail") {
        check(where.rail !== "", `${id} at ${t}: rail without an id`);
        check(
          d.rails.some((r) => r.id === where.rail && r.to.part === where.to),
          `${id} at ${t}: rail ${where.rail} does not lead to ${where.to}`
        );
      }
      // Wherever the narration puts the card, it is drawn there (fading in
      // counts) unless the whole loop is fading out.
      if (layer !== null && t < d.period - 0.6)
        check(
          seen.has(layer),
          `${id} at ${t}: narrated in ${layer}, drawn in ${[...seen.keys()]}`
        );
      // A card drawn clearly in one place only is narrated there.
      if (layer !== null && clearly.length === 1 && seen.size === 1)
        check(
          layer === clearly[0],
          `${id} at ${t}: drawn in ${clearly[0]}, narrated in ${layer}`
        );
      // Not narrated anywhere: at most the 0.12 s fade-out of an appearance
      // that has just ended is still drawn.
      if (layer === null) {
        const ended = cardTrack(d, id).filter((s) => s.dies < t);
        const lastDeath = Math.max(-Infinity, ...ended.map((s) => s.dies));
        check(
          clearly.length === 0 || t - lastDeath < 0.12,
          `${id} at ${t}: ${where.kind} but drawn in ${clearly}`
        );
      }
      if (where.kind === "gap")
        check(
          cardTrack(d, id).some((s) => s.born >= t),
          `${id} at ${t}: in a gap with no later appearance`
        );
      cleanup();
    },
    { testCases: 150 }
  ));

test("the inspected state of a part is the status line it draws", () =>
  hegel.test(
    (tc) => {
      const d = tc.draw(gs.sampledFrom(DIAGRAMS));
      const parts = d.parts.filter((p) => p.presence !== "absent");
      const part = tc.draw(gs.sampledFrom(parts));
      const t = tc.draw(
        gs.floats({ minValue: 0, maxValue: d.period, excludeMax: true })
      );
      const reduced = tc.draw(gs.booleans());
      const { container } = render(
        <FlowDiagram
          diagram={d}
          t={t}
          reducedMotion={reduced}
          interaction={{ onActivatePart: () => {} }}
        />
      );
      const g = container.querySelector(`[data-part-id='${part.id}']`)!;
      const status = partStatusAt(part, t, reduced).text;
      // Screen readers hear the same state as the inspector shows.
      check(
        g.getAttribute("aria-label")?.endsWith(` Now: ${status}.`) === true,
        `${part.id} at ${t}: inspector says "${status}", aria-label ${g.getAttribute("aria-label")}`
      );
      // Parts drawn at full scale show it as their status line (smaller
      // parts hide text). A swap draws the outgoing line too, and for its
      // first 0.08 s only the outgoing one (the new line is still at 0 alpha).
      if (part.scale >= 1) {
        const texts = [...g.querySelectorAll(".md-status text")]
          .filter((e) => e.closest("[data-part-id]") === g)
          .map((e) => e.textContent ?? "");
        const notes = part.timeline.notes;
        const i = noteIndex(notes, t);
        const swapping =
          !reduced && i > 0 && t - notes[i][0] < 0.08 && texts.length === 1;
        check(
          texts.includes(status) || (swapping && texts[0] === notes[i - 1][1]),
          `${part.id} at ${t}: inspector says "${status}", drawn: ${JSON.stringify(texts)}`
        );
      }
      cleanup();
    },
    { testCases: 120 }
  ));
