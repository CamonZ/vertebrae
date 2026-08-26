import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../test/test-utils";
import { FactoryFilter } from "./FactoryFilter";
import { factoryNames, filterByFactory } from "../utils/workflowFactory";

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
  });

  it("renders literal factory options and reports the selected value", () => {
    const onChange = vi.fn();
    render(
      <FactoryFilter
        id="factory-filter"
        workflows={[
          { factory_name: "Factory A" },
          { factory_name: "Factory B" },
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

    fireEvent.change(screen.getByLabelText("Filter by factory"), {
      target: { value: "Factory A" },
    });
    expect(onChange).toHaveBeenCalledWith("Factory A");
  });
});
