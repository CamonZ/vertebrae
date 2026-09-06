import { describe, it, expect, beforeEach } from "vitest";
import {
  getSacrumConnectionIdentity,
  isCurrentSacrumConnectionIdentity,
  useSacrumConnectionStore,
} from "./sacrumConnectionStore";
import { resetProjectScopedStores } from "./projectScopedStores";

describe("sacrumConnectionStore", () => {
  beforeEach(() => {
    useSacrumConnectionStore.getState().setIdentity(null);
  });

  it("tracks the last observed identity", () => {
    expect(getSacrumConnectionIdentity()).toBeNull();

    useSacrumConnectionStore.getState().setIdentity("abc123");
    expect(getSacrumConnectionIdentity()).toBe("abc123");
    expect(isCurrentSacrumConnectionIdentity("abc123")).toBe(true);
    expect(isCurrentSacrumConnectionIdentity("other")).toBe(false);
  });

  it("never treats an unknown identity as current", () => {
    useSacrumConnectionStore.getState().setIdentity("abc123");
    expect(isCurrentSacrumConnectionIdentity(null)).toBe(false);
    expect(isCurrentSacrumConnectionIdentity(undefined)).toBe(false);
    expect(isCurrentSacrumConnectionIdentity("")).toBe(false);
  });

  it("resets the identity together with the project scope", () => {
    useSacrumConnectionStore.getState().setIdentity("abc123");
    resetProjectScopedStores();
    expect(getSacrumConnectionIdentity()).toBeNull();
    expect(isCurrentSacrumConnectionIdentity("abc123")).toBe(false);
  });
});
