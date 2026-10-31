import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationAssociations } from "./ConversationAssociations";
import { useChatStore } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

const association = {
  ticketId: "4694275d-ab38-423a-9e3e-17d8316cd070",
  ticketTitle: "Declutter headers",
  worktreePath: "/project/a-very-long-worktree-path",
  branch: "feature",
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
};
const session = {
  id: "row",
  association,
} as unknown as LocalChatSessionSummary;
afterEach(() => useChatStore.setState({ localSessionSummaries: {} }));

describe("conversation association row", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "shows only established icons: ticket %s, worktree %s",
    (ticket, worktree) => {
      render(
        <ConversationAssociations
          session={{
            ...session,
            association: {
              ...association,
              ticketId: ticket ? association.ticketId : null,
              worktreePath: worktree ? association.worktreePath : null,
            },
          }}
        />
      );
      expect(screen.queryByRole("img", { name: /^Ticket:/ }) !== null).toBe(
        ticket
      );
      expect(screen.queryByRole("img", { name: /^Worktree:/ }) !== null).toBe(
        worktree
      );
    }
  );

  it("reveals full details on focus outside the scroll container and dismisses with Escape", () => {
    const { container } = render(
      <ConversationAssociations session={session} />
    );
    const icon = screen.getByRole("img", { name: /^Worktree:/ });
    fireEvent.focus(icon);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent(`${association.worktreePath} (feature)`);
    expect(container).not.toContainElement(tooltip);
    expect(tooltip).toHaveClass("z-[100]");
    expect(icon).toHaveAttribute("aria-describedby", tooltip.id);
    fireEvent.keyDown(icon, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses live corrections and clears rather than stale history, and switches rows", () => {
    useChatStore.setState({
      localSessionSummaries: { row: { ...session, association: null } },
    });
    const { rerender } = render(<ConversationAssociations session={session} />);
    expect(
      screen.queryByRole("img", { name: /^Ticket:/ })
    ).not.toBeInTheDocument();
    useChatStore.setState({
      localSessionSummaries: {
        row: {
          ...session,
          association: {
            ...association,
            ticketTitle: "Corrected ticket",
          },
        },
      },
    });
    rerender(<ConversationAssociations session={session} />);
    expect(screen.getByRole("img", { name: /^Ticket:/ })).toHaveAccessibleName(
      /Corrected ticket/
    );
    rerender(
      <ConversationAssociations
        session={{ ...session, id: "other", association: null }}
      />
    );
    expect(
      screen.queryByRole("img", { name: /^Ticket:/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
