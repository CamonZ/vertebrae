import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../test/test-utils";
import { FactoryFilter } from "./FactoryFilter";
import {
  factoryNames,
  filterByFactory,
  NO_FACTORY_SCOPE,
} from "../utils/workflowFactory";

describe("FactoryFilter", () => {
  it("returns unique non-empty factory names in stable order", () => {
    expect(
      factoryNames([
        { factory_name: "Zeta" },
        { factory_name: null },
        { factory_name: "Alpha" },
        { factory_name: "Zeta" },
        { factory_name: "" },
      ])
    ).toEqual(["Alpha", "Zeta"]);
  });

  it("uses an exact, case-sensitive match", () => {
    const workflows = [
      { id: "wf-1", factory_name: "Factory A" },
      { id: "wf-2", factory_name: "factory a" },
      { id: "wf-3", factory_name: "Factory B" },
    ];

    expect(filterByFactory(workflows, "Factory A").map((w) => w.id)).toEqual([
      "wf-1",
    ]);
    expect(
      filterByFactory(
        [...workflows, { id: "wf-none", factory_name: null }],
        NO_FACTORY_SCOPE
      ).map((w) => w.id)
    ).toEqual(["wf-none"]);
  });

  it("renders literal factory options and reports the selected value", () => {
    const onChange = vi.fn();
    render(
      <FactoryFilter
        id="factory-filter"
        workflows={[
          { factory_name: "Factory A" },
          { factory_name: "Factory B" },
          { factory_name: null },
        ]}
        value={null}
        onChange={onChange}
      />
    );

    expect(
      screen.getByRole("option", { name: "All factories" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Factory A" })
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Filter by factory").closest(".scope-level")
    ).toBeInTheDocument();
    const noFactoryOption = screen.getByRole("option", {
      name: "No Factory",
    });
    expect(noFactoryOption).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by factory"), {
      target: { value: "Factory A" },
    });
    expect(onChange).toHaveBeenCalledWith("Factory A");

    fireEvent.change(screen.getByLabelText("Filter by factory"), {
      target: { value: noFactoryOption.getAttribute("value") },
    });
    expect(onChange).toHaveBeenLastCalledWith(NO_FACTORY_SCOPE);
  });
});
