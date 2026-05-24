import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Chip } from "./Chip";

describe("Chip", () => {
  it("toggles aria-pressed for filter variant", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Chip variant="filter" active onClick={onClick}>
        Ticket
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "Ticket" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("invokes onDismiss on input variant", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Chip variant="input" onDismiss={onDismiss}>
        tag
      </Chip>,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("is non-interactive in static variant", () => {
    render(<Chip>static</Chip>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
