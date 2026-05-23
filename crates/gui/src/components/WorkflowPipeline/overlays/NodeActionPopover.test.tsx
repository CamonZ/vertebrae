import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeActionPopover } from "./NodeActionPopover";

describe("NodeActionPopover", () => {
  it("shows the primary action when not running", async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    render(
      <NodeActionPopover
        isRunning={false}
        onPrimary={onPrimary}
        summary={{ completed: 14, failed: 1, running: 0 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Run next task/ }));
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(screen.getByText(/✓ 14/)).toBeInTheDocument();
    expect(screen.getByText(/✗ 1/)).toBeInTheDocument();
  });

  it("swaps to a stop affordance while running", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <NodeActionPopover isRunning elapsed="0:47" onStop={onStop} />,
    );
    expect(screen.getByText("⟳ running · 0:47")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Stop run/ }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
