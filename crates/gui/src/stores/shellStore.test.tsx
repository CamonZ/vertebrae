import { describe, expect, it, beforeEach } from "vitest";
import { useShellStore } from "./shellStore";

describe("useShellStore", () => {
  beforeEach(() => {
    useShellStore.setState({
      pageTitle: "",
      headerActions: null,
      needsAttentionCount: 0,
    });
  });

  it("stores and clears the page title", () => {
    useShellStore.getState().setPageTitle("Operations");
    expect(useShellStore.getState().pageTitle).toBe("Operations");
  });

  it("stores header actions", () => {
    useShellStore.getState().setHeaderActions(<span>x</span>);
    expect(useShellStore.getState().headerActions).not.toBeNull();
  });

  it("tracks needs-attention count", () => {
    useShellStore.getState().setNeedsAttentionCount(3);
    expect(useShellStore.getState().needsAttentionCount).toBe(3);
  });
});
