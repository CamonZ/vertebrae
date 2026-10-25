import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatAssociation } from "./ChatAssociation";

const record = {
  ticketId: "97a3edab-5e4a-40a8-b580-19708657a222",
  ticketTitle: "Implement associations",
  worktreePath: "/project/tree-97a3edab",
  branch: "feature",
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
};

describe("ChatAssociation", () => {
  it("opens a popover with full details and Escape restores focus", async () => {
    const u = userEvent.setup();
    render(
      <ChatAssociation
        record={record}
        diagnostic="Model offline"
        onCorrect={vi.fn()}
      />
    );
    const trigger = screen.getByLabelText("Conversation context: 97a3edab");
    await u.click(trigger);
    expect(screen.getByText("/project/tree-97a3edab (feature)")).toBeVisible();
    expect(
      screen.getByText(/Implement associations · 97a3edab-5e4a/)
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Model offline");
    await u.type(screen.getByLabelText("Ticket ID"), "{Escape}");
    expect(trigger.closest("details")).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
  });

  it("passes the correction through and shows rejection", async () => {
    const u = userEvent.setup();
    const onCorrect = vi.fn(() => {
      throw new Error("Unknown ticket");
    });
    render(
      <ChatAssociation
        record={record}
        diagnostic={null}
        onCorrect={onCorrect}
      />
    );
    await u.click(screen.getByLabelText("Conversation context: 97a3edab"));
    await u.type(screen.getByLabelText("Ticket ID"), "deadbeef");
    await u.click(screen.getByRole("button", { name: "Set ticket" }));
    expect(onCorrect).toHaveBeenCalledWith("deadbeef");
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown ticket");
  });
});
