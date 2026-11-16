import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";
import { chooseDropdownValue, dropdownOptions } from "../../test/dropdown";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Select", () => {
  it("renders the app dropdown with the selected label", () => {
    render(<Select aria-label="Pick" value="b" options={OPTIONS} />);
    const trigger = screen.getByRole("button", { name: "Pick" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveTextContent("Beta");
    expect(trigger).toHaveAttribute("data-value", "b");
  });

  it("flattens option groups", () => {
    render(
      <Select
        aria-label="Grouped"
        value="a"
        options={[{ label: "Group", options: OPTIONS }]}
      />
    );
    expect(
      dropdownOptions(screen.getByRole("button", { name: "Grouped" })).map(
        (option) => option.label
      )
    ).toEqual(["Alpha", "Beta"]);
  });

  it("calls onChange with an event whose target.value is the choice", () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Pick" value="a" onChange={onChange} options={OPTIONS} />
    );
    chooseDropdownValue(screen.getByRole("button", { name: "Pick" }), "b");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe("b");
  });

  it("shows the placeholder until a value is chosen", () => {
    render(
      <Select aria-label="Pick" placeholder="Choose…" value="" options={OPTIONS} />
    );
    expect(screen.getByRole("button", { name: "Pick" })).toHaveTextContent(
      "Choose…"
    );
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<Select aria-label="Pick" value="a" options={OPTIONS} />);
    const trigger = screen.getByRole("button", { name: "Pick" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
