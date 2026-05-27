import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";

const options = [
  { value: "delete", label: "Delete all" },
  { value: "keep", label: "Keep them" },
] as const;

describe("SegmentedControl", () => {
  it("renders each option as a radio in a radiogroup", () => {
    render(
      <SegmentedControl
        ariaLabel="Cascade choice"
        options={options}
        value="keep"
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("radiogroup", { name: "Cascade choice" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("marks the selected option with aria-checked", () => {
    render(
      <SegmentedControl options={options} value="keep" onChange={vi.fn()} />
    );

    expect(screen.getByRole("radio", { name: "Keep them" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Delete all" })).not.toBeChecked();
  });

  it("calls onChange with the clicked option's value", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl options={options} value="keep" onChange={onChange} />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Delete all" }));
    expect(onChange).toHaveBeenCalledWith("delete");
  });

  it("moves selection with arrow keys (roving tabindex)", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl options={options} value="keep" onChange={onChange} />
    );

    const selected = screen.getByRole("radio", { name: "Keep them" });
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Delete all" })).toHaveAttribute(
      "tabindex",
      "-1"
    );

    fireEvent.keyDown(selected, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("delete");
  });

  it("does not fire onChange when disabled", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={options}
        value="keep"
        onChange={onChange}
        disabled
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Delete all" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
