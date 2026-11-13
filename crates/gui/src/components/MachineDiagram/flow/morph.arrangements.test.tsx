/**
 * The morph between any two named arrangements, not just Before → After:
 * halfway through, a part that reads the same in both is drawn once,
 * unblended, where it was; a part that reads differently blends (a layer
 * between transparent and opaque); the morph settles on the arriving
 * arrangement. Every ordered pair of the three-option reference spec is
 * checked, and Hegel checks random pairs of generated arrangements.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, it, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import { world } from "./arrangementWorlds";
import { FlowPlayer } from "./FlowPlayer";
import {
  arrangement,
  compileFlowOrThrow,
  parseFlowSpec,
  type CompiledFlow,
} from "./index";
import { MORPH_SECONDS, partDiffers } from "./morph";

const player = () => screen.getByTestId("flow-player");
const radios = () =>
  within(screen.getByRole("radiogroup", { name: "Arrangement" })).getAllByRole(
    "radio"
  );
const frame = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** Each drawn copy of a part: where it is and whether it is a morph layer. */
function drawnParts() {
  const out = new Map<
    string,
    { transform: string | null; blended: boolean }[]
  >();
  for (const g of player().querySelectorAll<SVGGElement>("[data-part-id]")) {
    const id = g.dataset.partId!;
    out.set(id, [
      ...(out.get(id) ?? []),
      {
        transform: g.getAttribute("transform"),
        blended: g.closest("[data-morph-to],[data-morph-from]") !== null,
      },
    ]);
  }
  return out;
}

const layerOpacities = () =>
  [
    ...player().querySelectorAll<SVGGElement>(
      "[data-morph-to],[data-morph-from]"
    ),
  ].map((g) => Number(g.getAttribute("opacity")));

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Morph `flow` from arrangement `x` to `y` and check it halfway and settled. */
function morphs(flow: CompiledFlow, x: number, y: number): void {
  const names = flow.arrangements.map((d) => d.arrangement);
  const [from, to] = [
    arrangement(flow, names[x])!,
    arrangement(flow, names[y])!,
  ];
  fireEvent.click(radios()[x]);
  frame(MORPH_SECONDS * 1000 + 50);
  check(player().dataset.arrangement === names[x], `not on ${names[x]}`);
  const settled = drawnParts();
  fireEvent.click(radios()[y]);
  check(
    player().dataset.morph === `${names[x]}→${names[y]}`,
    `morph is ${player().dataset.morph}, not ${names[x]}→${names[y]}`
  );
  frame(MORPH_SECONDS * 500);
  const mid = drawnParts();
  const live = (x: { presence: string }) => x.presence !== "absent";
  let differing = 0;
  let leavingParts = 0;
  for (const p of to.parts) {
    const q = from.parts.find((o) => o.id === p.id)!;
    if (!live(p) && !live(q)) continue;
    const copies = mid.get(p.id) ?? [];
    if (partDiffers(p, q)) {
      differing++;
      if (live(q)) leavingParts++;
      // Arriving where it was absent: it fades in (a leaving copy has no id).
      if (live(p) && !live(q))
        check(
          copies.length === 1 && copies[0].blended,
          `${p.id} arrives in ${names[y]} but does not fade in`
        );
      if (!live(p))
        check(
          copies.length === 0,
          `${p.id} is absent in ${names[y]} but drawn live`
        );
    } else {
      check(
        copies.length === 1 && !copies[0].blended,
        `${p.id} reads the same but is drawn ${copies.length}× (blended: ${copies.map((c) => c.blended)})`
      );
      check(
        copies[0].transform === settled.get(p.id)?.[0]?.transform,
        `${p.id} moved: ${settled.get(p.id)?.[0]?.transform} → ${copies[0].transform}`
      );
    }
  }
  // One leaving copy per part that reads differently and was drawn before.
  const leaving = [...player().querySelectorAll("[data-morph-from]")].filter(
    (g) => g.querySelector(".md-part")
  );
  check(
    leaving.length === leavingParts,
    `${leaving.length} leaving part copies, expected ${leavingParts}`
  );
  if (differing > 0)
    check(
      layerOpacities().some((o) => o > 0 && o < 1),
      `halfway, no layer is between transparent and opaque: ${layerOpacities()}`
    );
  frame(MORPH_SECONDS * 1000);
  check(player().dataset.morph === undefined, "the morph did not settle");
  check(
    player().dataset.arrangement === names[y],
    `settled on ${player().dataset.arrangement}`
  );
  check(
    player().querySelectorAll("[data-morph-to],[data-morph-from]").length === 0,
    "morph layers left after settling"
  );
}

function renderMoving(flow: CompiledFlow) {
  render(<FlowPlayer flow={flow} reducedMotion={false} />);
  act(() => player().focus());
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("morphing between named arrangements", () => {
  const p = parseFlowSpec(burstOptions);
  if (!p.ok) throw new Error("fixture does not parse");
  const flow = compileFlowOrThrow(p.value);
  const n = flow.arrangements.length;
  const pairs = Array.from({ length: n }, (_, x) =>
    Array.from({ length: n }, (_, y) => [x, y] as const)
  )
    .flat()
    .filter(([x, y]) => x !== y);

  it.each(pairs)("the three-option spec morphs from %i to %i", (x, y) => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderMoving(flow);
    morphs(flow, x, y);
  });
});

test(
  "any two generated arrangements morph one into the other",
  () =>
    hegel.test(
      (tc) => {
        const w = tc.draw(world);
        tc.assume(w.names.length > 1);
        const flow = compileFlowOrThrow(w.spec);
        const x = tc.draw(
          gs.integers({ minValue: 0, maxValue: w.names.length - 1 })
        );
        const y = tc.draw(
          gs.integers({ minValue: 0, maxValue: w.names.length - 1 })
        );
        tc.assume(x !== y);
        cleanup();
        vi.useRealTimers();
        vi.useFakeTimers({
          toFake: [
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "performance",
          ],
        });
        renderMoving(flow);
        morphs(flow, x, y);
      },
      { testCases: 60 }
    ),
  60_000
);
