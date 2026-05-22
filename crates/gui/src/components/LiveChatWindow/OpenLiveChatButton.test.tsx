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
      screen.queryByRole("button", { name: "Live Chat" })
    ).not.toBeInTheDocument();
  });

  it("renders and toggles the live chat panel when chrome shortcuts are visible", async () => {
    const user = userEvent.setup();
    useStyleguideStore.getState().revealChromeShortcuts();

    render(<OpenLiveChatButton />);

    await user.click(screen.getByRole("button", { name: "Live Chat" }));

    expect(useLiveChatStore.getState().panelOpen).toBe(true);
  });
});
