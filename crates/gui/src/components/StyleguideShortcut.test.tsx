import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { StyleguideShortcut } from "./StyleguideShortcut";
import { useStyleguideStore } from "../stores/styleguideStore";

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function Harness() {
  return (
    <MemoryRouter initialEntries={["/operations"]}>
      <StyleguideShortcut />
      <input aria-label="Title" />
      <Routes>
        <Route path="*" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>
  );
}

function HarnessOnStyleguide() {
  return (
    <MemoryRouter initialEntries={["/styleguide"]}>
      <StyleguideShortcut />
      <Routes>
        <Route path="*" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>
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

  it("reveals the chrome shortcuts and navigates with Ctrl+Alt+Cmd+Shift+0", async () => {
    render(<Harness />);

    await act(async () => {
      dispatchShortcut();
    });

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(true);
    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(true);
    expect(screen.getByTestId("location")).toHaveTextContent("/styleguide");
  });

  it("hides the chrome shortcuts and leaves the current page when toggled from /styleguide", async () => {
    useStyleguideStore.getState().revealChromeShortcuts();
    render(<HarnessOnStyleguide />);

    await act(async () => {
      dispatchShortcut();
    });

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
  });

  it("hides the chrome shortcuts without navigating when toggled from another page", async () => {
    useStyleguideStore.getState().revealChromeShortcuts();
    render(<Harness />);

    await act(async () => {
      dispatchShortcut();
    });

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
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

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
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

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(useStyleguideStore.getState().isLiveChatButtonVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
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

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
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

    expect(useStyleguideStore.getState().isStyleguideNavVisible).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/operations");
  });
});
