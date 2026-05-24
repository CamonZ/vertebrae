import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useShellStore } from "../stores/shellStore";
import { useShellHeader } from "./useShellHeader";

describe("useShellHeader", () => {
  it("sets and clears the header state", () => {
    const { unmount } = renderHook(() =>
      useShellHeader("Operations", <span>live count</span>),
    );
    expect(useShellStore.getState().pageTitle).toBe("Operations");
    expect(useShellStore.getState().headerActions).not.toBeNull();
    unmount();
    expect(useShellStore.getState().pageTitle).toBe("");
    expect(useShellStore.getState().headerActions).toBeNull();
  });
});
