import { describe, expect, it, beforeEach } from "vitest";
import { useShellStore } from "./shellStore";

describe("useShellStore", () => {
  beforeEach(() => {
    useShellStore.setState({
      pageTitle: "",
      headerActions: null,
    });
  });

  it("stores and clears the page title", () => {
    useShellStore.getState().setPageTitle("Tasks");
    expect(useShellStore.getState().pageTitle).toBe("Tasks");
  });

  it("stores header actions", () => {
    useShellStore.getState().setHeaderActions(<span>x</span>);
    expect(useShellStore.getState().headerActions).not.toBeNull();
  });
});
