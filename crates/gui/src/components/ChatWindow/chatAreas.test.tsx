import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { moveChatArea } from "./chatAreas";

function Panes({ changes }: { changes: boolean[] }) {
  return (
    <div className="hc-chat-panes">
      {changes.map((open, index) => (
        <div key={index} data-pane-id={`p${index}`}>
          <textarea
            data-testid="local-chat-composer"
            aria-label={`chat ${index}`}
          />
          {open && (
            <section
              tabIndex={-1}
              aria-label={`changes ${index}`}
              data-chat-area="changes"
            />
          )}
        </div>
      ))}
    </div>
  );
}

describe("moveChatArea", () => {
  afterEach(() => vi.restoreAllMocks());

  it("walks chat 1 · its Changes · chat 2 and wraps", () => {
    const focusPane = vi.fn();
    vi.spyOn(useChatStore, "getState").mockReturnValue({
      ...useChatStore.getState(),
      paneLayout: { panes: [], activePaneId: "p0" },
      focusPane,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    render(<Panes changes={[true, false]} />);
    const chat0 = screen.getByRole("textbox", { name: "chat 0" });
    act(() => chat0.focus());

    act(() => void moveChatArea(document.activeElement, 1));
    expect(screen.getByRole("region", { name: "changes 0" })).toHaveFocus();

    act(() => void moveChatArea(document.activeElement, 1));
    expect(focusPane).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("textbox", { name: "chat 1" })).toHaveFocus();

    act(() => void moveChatArea(document.activeElement, 1));
    expect(chat0).toHaveFocus();

    act(() => void moveChatArea(document.activeElement, -1));
    expect(screen.getByRole("textbox", { name: "chat 1" })).toHaveFocus();
    vi.unstubAllGlobals();
  });

  it("has nowhere to go with a single area", () => {
    render(<Panes changes={[false]} />);
    expect(moveChatArea(screen.getByRole("textbox"), 1)).toBe(false);
  });
});
