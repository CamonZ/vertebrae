import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComparisonSelect } from "./ComparisonSelect";

const options = [
  { value: "main", label: "main" },
  { value: "disabled", label: "archived", disabled: true },
  { value: "feature", label: "feature/changes" },
];

describe("ComparisonSelect", () => {
  it("supports keyboard selection, skips disabled refs and keeps focus on its trigger", () => {
    const change = vi.fn();

    render(
      <ComparisonSelect
        label="Base"
        value="main"
        options={options}
        onChange={change}
      />
    );

    const trigger = screen.getByRole("combobox", { name: "Base" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(
      screen.getByRole("option", { name: "feature/changes" })
    ).toHaveAttribute("id", trigger.getAttribute("aria-activedescendant"));
    expect(change).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(change).toHaveBeenCalledExactlyOnceWith("feature");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports type-ahead and cancels with Escape or an outside click", () => {
    const change = vi.fn();

    render(
      <ComparisonSelect
        label="Compare"
        value="main"
        options={options}
        onChange={change}
      />
    );

    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "f" });

    expect(
      screen.getByRole("option", { name: "feature/changes" })
    ).toHaveAttribute("id", trigger.getAttribute("aria-activedescendant"));
    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
  });

  it("themes a portaled menu and closes it after pointer selection or unmount", () => {
    const change = vi.fn();

    const { unmount } = render(
      <ComparisonSelect
        label="Compare"
        value="main"
        options={options}
        onChange={change}
      />
    );

    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getByRole("listbox")).toHaveClass("comparison-options");
    expect(screen.getByRole("option", { name: "main" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.click(screen.getByRole("option", { name: "feature/changes" }));

    expect(change).toHaveBeenCalledWith("feature");

    fireEvent.click(screen.getByRole("combobox"));
    unmount();

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
