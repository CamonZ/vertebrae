import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";

describe("FilterBar", () => {
  it("renders search and filter slots", () => {
    render(
      <FilterBar
        search={<input aria-label="search" />}
        filters={<button type="button">Level</button>}
      />,
    );
    expect(screen.getByLabelText("search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Level" })).toBeInTheDocument();
  });

  it("renders active filter chips and supports onClearAll", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterBar
        active={[{ id: "lv", label: "Level: Ticket", onClear }]}
        onClearAll={onClearAll}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(onClear).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(onClearAll).toHaveBeenCalled();
  });
});
