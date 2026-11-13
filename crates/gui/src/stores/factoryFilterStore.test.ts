import { afterEach, describe, expect, it } from "vitest";
import { NO_FACTORY_SCOPE } from "../utils/workflowFactory";
import { useFactoryFilterStore } from "./factoryFilterStore";

afterEach(() => useFactoryFilterStore.getState().reset());

describe("factoryFilterStore", () => {
  it("remembers the last opened factory after the scope is cleared", () => {
    const store = useFactoryFilterStore.getState();
    store.setFactoryName("Factory A");
    store.setFactoryName(null);
    expect(useFactoryFilterStore.getState()).toMatchObject({
      factoryName: null,
      lastFactoryName: "Factory A",
    });
  });

  it("tracks the synthetic No Factory scope as a last opened factory", () => {
    useFactoryFilterStore.getState().setFactoryName(NO_FACTORY_SCOPE);
    useFactoryFilterStore.getState().setFactoryName(null);
    expect(useFactoryFilterStore.getState().lastFactoryName).toBe(
      NO_FACTORY_SCOPE
    );
  });

  it("forgets the last opened factory on reset", () => {
    useFactoryFilterStore.getState().setFactoryName("Factory A");
    useFactoryFilterStore.getState().reset();
    expect(useFactoryFilterStore.getState().lastFactoryName).toBeNull();
  });
});
