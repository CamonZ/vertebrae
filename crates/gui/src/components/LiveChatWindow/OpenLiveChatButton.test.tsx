import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenLiveChatButton } from "./OpenLiveChatButton";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { useStyleguideStore } from "../../stores/styleguideStore";

describe("OpenLiveChatButton", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStyleguideStore.setState({
      isStyleguideNavVisible: false,
      isLiveChatButtonVisible: false,
    });
    useLiveChatStore.getState().reset();
  });

  it("is hidden until chrome shortcuts are revealed", () => {
    render(<OpenLiveChatButton />);

    expect(
      screen.queryByRole("button", { name: "Open live chat" })
    ).not.toBeInTheDocument();
  });

  it("renders an icon-only button with no visible text label", () => {
    useStyleguideStore.getState().revealChromeShortcuts();

    render(<OpenLiveChatButton />);

    const button = screen.getByRole("button", { name: "Open live chat" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("Live Chat")).not.toBeInTheDocument();
  });

  it("toggles the panel and swaps its accessible name when opened", async () => {
    const user = userEvent.setup();
    useStyleguideStore.getState().revealChromeShortcuts();

    render(<OpenLiveChatButton />);

    await user.click(screen.getByRole("button", { name: "Open live chat" }));

    expect(useLiveChatStore.getState().panelOpen).toBe(true);
    const button = screen.getByRole("button", { name: "Close live chat" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
