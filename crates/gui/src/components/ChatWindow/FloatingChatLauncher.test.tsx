import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingChatLauncher } from "./FloatingChatLauncher";
import { useChatStore } from "../../stores/chatStore";

describe("FloatingChatLauncher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.getState().reset();
  });

  it("renders the launcher pill with an Alt-Alt keyboard hint (no text label)", () => {
    render(<FloatingChatLauncher />);

    const button = screen.getByRole("button", { name: "Open project chat" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("hc-launch");
    expect(button).not.toHaveTextContent("Ask sacrum");
    // Two ⌥ chips hint the double-tap shortcut.
    const keys = button.querySelectorAll("kbd.key");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toHaveTextContent("⌥");
  });

  it("opens the project-scoped claude chat when clicked", async () => {
    const user = userEvent.setup();
    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    const session = Object.values(useChatStore.getState().sessions).find(
      (s) => s.scope === "project"
    );
    expect(session).toBeDefined();
    expect(session?.label).toBe("Project Chat");
  });

  it("hides itself once the panel is open (panel owns the anchor)", () => {
    useChatStore.setState({ panelOpen: true });
    render(<FloatingChatLauncher />);

    expect(
      screen.queryByRole("button", { name: "Open project chat" })
    ).not.toBeInTheDocument();
  });

  it("double-tapping Alt opens the project chat", async () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt" });

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(
      Object.values(useChatStore.getState().sessions).some(
        (s) => s.scope === "project"
      )
    ).toBe(true);
  });

  it("a single Alt press does not open the chat", () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("ignores auto-repeat: a held Alt key does not count as two taps", () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt", repeat: true });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("double-tapping Alt while the panel is open closes it (listener stays armed)", () => {
    useChatStore.setState({ panelOpen: true });
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt" });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });
});
