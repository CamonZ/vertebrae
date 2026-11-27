import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { anchored, at, reviewThread } from "./fixture";
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
