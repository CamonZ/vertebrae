import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { anchored, at, outdated, reviewThread } from "./fixture";
import { buildReviewModel, markerKey } from "./model";
import { useReviewController } from "./useReviewController";

const model = buildReviewModel(
  7,
  [reviewThread("t1")],
  [at("t1", anchored(13))],
  false
);
const placed = model.byThread.get("t1")!;

function controller(railCovers: boolean) {
  const pane = { current: document.createElement("div") };
  return renderHook(() =>
    useReviewController(
      model,
      pane,
      () => true,
      () => railCovers
    )
  );
}

describe("choosing a rail entry shown in the diff", () => {
  it("returns focus to the rail entry when the rail stays beside the diff", () => {
    const { result } = controller(false);
    act(() => result.current.rail.select(placed));
    expect(result.current.diff!.openThreads.has("t1")).toBe(true);
    act(() => result.current.diff!.closeThread("t1"));
    expect(result.current.diff!.focusMarker).toBeNull();
  });

  it("returns focus to the thread's marker when the rail covered the diff", () => {
    // The covering rail closed when it showed the thread.
    const { result } = controller(true);
    act(() => result.current.rail.select(placed));
    act(() => result.current.diff!.closeThread("t1"));
    expect(result.current.diff!.focusMarker).toBe(
      markerKey("src/lib.rs", "additions", 13)
    );
  });
});

describe("revealing a thread for its private discussion", () => {
  /*
   * Model (3e4d738d, criterion 3): a reveal shows the thread wherever it
   * can be read, the diff when Changes can show it there, else expanded in
   * the Review rail, and keeps it shown however often it is revealed (a
   * rail entry's select toggles; a reveal never hides).
   */
  it("shows the thread in the diff or the rail, and never hides it", () =>
    hegel.test(
      (tc) => {
        const placement = tc.draw(
          gs.sampledFrom([anchored(13), outdated(9), outdated(null)])
        );
        const threads = [reviewThread("t1"), reviewThread("t2")];
        const shownModel = buildReviewModel(
          7,
          threads,
          [at("t1", placement), at("t2", placement)],
          false
        );
        const target = shownModel.byThread.get("t1")!;
        const inDiff = tc.draw(
          gs.arrays(gs.booleans(), { minSize: 1, maxSize: 4 })
        );
        let call = 0;
        const pane = { current: document.createElement("div") };
        const { result, unmount } = renderHook(() =>
          useReviewController(shownModel, pane, () => inDiff[call] ?? false)
        );
        const shown = { diff: false, rail: false };
        for (call = 0; call < inDiff.length; call++) {
          let where: "diff" | "rail" = "rail";
          act(() => {
            where = result.current.reveal(target);
          });
          expect(where).toBe(inDiff[call] ? "diff" : "rail");
          shown[where] = true;
        }
        const { diff, rail } = result.current;
        expect(diff!.openThreads.has("t1")).toBe(shown.diff);
        expect(rail.inline.has("t1")).toBe(shown.rail);
        // An outdated thread opens with its file's other outdated threads.
        expect(diff!.openThreads.has("t2")).toBe(
          shown.diff && target.kind === "outdated"
        );
        if (shown.diff) expect(diff!.focusThreadId).toBe("t1");
        unmount();
      },
      { testCases: 100 }
    ));
});
