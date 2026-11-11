import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { ThreadFindContext } from "../thread/find";
import { usePaneFind } from "./usePaneFind";

const rows = ["alpha needle", "beta", "gamma needle", "needle delta"];

function Pane({ onReady }: { onReady: (open: () => boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const find = usePaneFind(ref);
  onReady(find.openFind);
  return (
    <div>
      {find.bar}
      <ThreadFindContext.Provider value={find.findQuery}>
        <div ref={ref} data-testid="transcript">
          <ThreadFindContext.Consumer>
            {(query) =>
              rows.map((text) => (
                <p
                  key={text}
                  data-find-match={
                    query && text.includes(query) ? "" : undefined
                  }
                >
                  {text}
                </p>
              ))
            }
          </ThreadFindContext.Consumer>
        </div>
      </ThreadFindContext.Provider>
    </div>
  );
}

function renderPane() {
  let open: () => boolean = () => false;
  render(<Pane onReady={(fn) => (open = fn)} />);
  act(() => {
    open();
  });
  return screen.getByTestId("pane-find-input");
}

describe("PaneFindBar", () => {
  it("counts model-marked rows and cycles the current match", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const input = renderPane();

    fireEvent.change(input, { target: { value: " NEEDLE " } });
    expect(screen.getByTestId("pane-find-count")).toHaveTextContent("1/3");
    const current = () =>
      screen.getByTestId("transcript").querySelector("[data-find-current]");
    expect(current()).toHaveTextContent("alpha needle");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("pane-find-count")).toHaveTextContent("2/3");
    expect(current()).toHaveTextContent("gamma needle");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("pane-find-count")).toHaveTextContent("3/3");
    expect(current()).toHaveTextContent("needle delta");
  });

  it("reports no matches and closes on Escape", () => {
    const input = renderPane();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByTestId("pane-find-count")).toHaveTextContent("0/0");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("pane-find-input")).toBeNull();
    expect(
      screen.getByTestId("transcript").querySelector("[data-find-match]")
    ).toBeNull();
  });
});
