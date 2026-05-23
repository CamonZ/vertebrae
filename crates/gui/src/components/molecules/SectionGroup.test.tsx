import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SectionGroup } from "./SectionGroup";

describe("SectionGroup", () => {
  it("toggles open state on header click", async () => {
    const user = userEvent.setup();
    render(
      <SectionGroup label="Spec" defaultOpen={false}>
        <p>contents</p>
      </SectionGroup>,
    );
    const trigger = screen.getByRole("button", { name: /spec/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("notifies onOpenChange when controlled", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <SectionGroup label="Spec" open={false} onOpenChange={onOpenChange}>
        <p>contents</p>
      </SectionGroup>,
    );
    await user.click(screen.getByRole("button", { name: /spec/i }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("renders count badge when provided", () => {
    render(
      <SectionGroup label="Spec" count={5}>
        <p>x</p>
      </SectionGroup>,
    );
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
