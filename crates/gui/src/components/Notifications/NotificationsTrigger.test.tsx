import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, userEvent } from "../../test/test-utils";
import { useNotificationStore } from "../../stores";
import { NotificationsTrigger } from "./NotificationsTrigger";

describe("NotificationsTrigger", () => {
  beforeEach(() => {
    act(() => {
      useNotificationStore.setState({
        notifications: [],
        isPanelOpen: false,
      });
    });
  });

  afterEach(() => {
    act(() => {
      useNotificationStore.setState({
        notifications: [],
        isPanelOpen: false,
      });
    });
  });

  it("shows the unread count and toggles the activity panel", async () => {
    act(() => {
      useNotificationStore.getState().addNotification({
        message: "Task abc123 updated",
        type: "info",
        entity: "task",
        entityId: "task-abc123",
      });
    });
    render(<NotificationsTrigger />);

    const trigger = screen.getByTestId("notifications-trigger");
    expect(screen.getByTestId("notifications-trigger-count")).toHaveTextContent(
      "1 new"
    );
    expect(trigger).toHaveAttribute("aria-label", "Open notifications, 1 unread");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);

    expect(useNotificationStore.getState().isPanelOpen).toBe(true);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("does not add a command-key hint to the trigger", () => {
    render(<NotificationsTrigger />);

    expect(screen.queryByText("⌘")).not.toBeInTheDocument();
    expect(screen.queryByText("K")).not.toBeInTheDocument();
  });
});
