import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { moveChatArea } from "./chatAreas";

function Panes({
  side,
  sideLabel = "Discussions",
}: {
  side: boolean[];
  sideLabel?: string;
}) {
  return (
    <div className="hc-chat-panes">
      {side.map((open, index) => (
        <div key={index} data-pane-id={`p${index}`}>
          <div
            data-transcript-viewport
            tabIndex={0}
            aria-label={`transcript ${index}`}
          />
          <textarea
            data-testid="local-chat-composer"
            aria-label={`chat ${index}`}
          />
          {open && (
            <section
              tabIndex={-1}
              aria-label={`${sideLabel} ${index}`}
              data-chat-area="discussions"
            />
          )}
        </div>
      ))}
    </div>
  );
}

describe("moveChatArea", () => {
  it("walks the composer and its side column, wrapping, never leaving the chat", () => {
    render(<Panes side={[true, true]} />);
    const chat0 = screen.getByRole("textbox", { name: "chat 0" });
    const side0 = screen.getByRole("region", { name: "Discussions 0" });
    act(() => chat0.focus());

    act(() => void moveChatArea(document.activeElement, 1));
    expect(side0).toHaveFocus();
    act(() => void moveChatArea(document.activeElement, 1));
    expect(chat0).toHaveFocus();
    act(() => void moveChatArea(document.activeElement, -1));
    expect(side0).toHaveFocus();
    act(() => void moveChatArea(document.activeElement, -1));
    expect(chat0).toHaveFocus();
  });

  it("treats the transcript as the chat's area", () => {
    render(<Panes side={[true]} />);
    const transcript = screen.getByLabelText("transcript 0");
    act(() => transcript.focus());
    act(() => void moveChatArea(document.activeElement, 1));
    expect(screen.getByRole("region", { name: "Discussions 0" })).toHaveFocus();
  });

  it("has nowhere to go while the side column is closed", () => {
    render(<Panes side={[false, true]} />);
    expect(
      moveChatArea(screen.getByRole("textbox", { name: "chat 0" }), 1)
    ).toBe(false);
    expect(screen.getByRole("textbox", { name: "chat 0" })).not.toHaveFocus();
  });
});
