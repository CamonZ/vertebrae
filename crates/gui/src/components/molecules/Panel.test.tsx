import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("renders nothing when closed", () => {
    render(<Panel open={false} onClose={() => {}} title="Detail" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("calls onClose on close button click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Panel open onClose={onClose} title="Detail" />);
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<Panel open onClose={onClose} title="Detail" />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the detach button when onDetach provided", () => {
    render(<Panel open onClose={() => {}} title="X" onDetach={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Detach to window" }),
    ).toBeInTheDocument();
  });
});
