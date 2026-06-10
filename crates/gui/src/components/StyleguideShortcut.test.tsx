import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { StyleguideShortcut } from "./StyleguideShortcut";
import { useStyleguideStore } from "../stores/styleguideStore";

function Harness() {
  return (
    <>
      <StyleguideShortcut />
      <input aria-label="Title" />
    </>
  );
}

function dispatchShortcut() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      metaKey: true,
      altKey: true,
      ctrlKey: true,
      shiftKey: true,
      code: "Digit0",
      bubbles: true,
    })
  );
}

describe("StyleguideShortcut", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStyleguideStore.setState({
      isStyleguideNavVisible: false,
      isLiveChatButtonVisible: false,
    });
  });

  it("reveals the chrome shortcuts with Ctrl+Alt+Cmd+Shift+0", async () => {
    render(<Harness />);

    await act(async () => {
      dispatchShortcut();
    });

    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(true);
  });

  it("hides the chrome shortcuts when toggled while revealed", async () => {
    useStyleguideStore.getState().revealChromeShortcuts();
    render(<Harness />);

    await act(async () => {
      dispatchShortcut();
    });

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
  });

  it("does not conflict with Cmd+Shift+D debug shortcut", () => {
    render(<Harness />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        metaKey: true,
        shiftKey: true,
        code: "KeyD",
        bubbles: true,
      })
    );

    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
  });

  it("does not fire when the full modifier chord is incomplete", async () => {
    render(<Harness />);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "Digit0",
          bubbles: true,
        })
      );
    });

    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
  });

  it("ignores repeated shortcut events while the keys are held", async () => {
    render(<Harness />);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          metaKey: true,
          altKey: true,
          ctrlKey: true,
          shiftKey: true,
          code: "Digit0",
          bubbles: true,
          repeat: true,
        })
      );
    });

    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
  });

  it("does not fire while typing in editable controls", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        metaKey: true,
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        code: "Digit0",
        bubbles: true,
      })
    );

    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
  });
});
