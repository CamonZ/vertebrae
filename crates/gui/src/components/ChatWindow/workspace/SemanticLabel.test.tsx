import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Fact } from "../../../bindings";
import { SemanticLabelRow } from "./SemanticLabel";
import type { SemanticLabel } from "./semanticHunks";
import { type FactGroup } from "./semanticFacts";

const call = (subject: string): Fact => ({
  kind: { type: "call" },
  change: { kind: "added", subject },
});

const lock: Fact = {
  kind: { type: "lock" },
  change: { kind: "added", subject: "CACHE.lock" },
};

const label = (facts: FactGroup[], test = false): SemanticLabel => ({
  side: "additions",
  lineNumber: 3,
  scope: [{ kind: "function", keyword: "fn", name: "diff", old_line: 1, new_line: 1 }],
  chips: [{ kind: "changed" }],
  facts,
  test,
});

const group = (facts: Fact[], whole = false, omitted = 0): FactGroup => ({
  owner: { keyword: "fn", name: "diff" },
  whole,
  facts,
  omitted,
});

describe("SemanticLabelRow", () => {
  it("keeps a multi-line label clear of source expressions", () => {
    const branch: Fact = {
      kind: { type: "branch" },
      change: { kind: "added", subject: "language != Language::Rust" },
    };
    const { container } = render(
      <SemanticLabelRow label={label([group([branch])])} onJump={vi.fn()} />
    );
    expect(container).not.toHaveTextContent("language != Language::Rust");
    expect(container).not.toHaveTextContent("changed");
    const more = screen.getByRole("button", { name: "Facts" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    // The facts are not hidden in a hover-only title.
    expect(container.querySelector("[title]")).toBeNull();
    fireEvent.click(more);
    const panel = screen.getByRole("region", { name: "Facts" });
    expect(panel).toHaveFocus();
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      ["+ if language != Language::Rust"]
    );
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Facts" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("groups an added declaration's facts in the disclosure", () => {
    const calls = [call("a"), call("b"), call("c")];
    render(
      <SemanticLabelRow label={label([group([...calls, lock], true, 1)])} onJump={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Facts" }));
    const panel = screen.getByRole("region", { name: "Facts" });
    expect(within(panel).getByText("Concurrency")).toBeInTheDocument();
    expect(within(panel).getByText("Calls")).toBeInTheDocument();
    expect(within(panel).getByText("1 more not listed")).toBeInTheDocument();
  });

  it("tags test code on the scope and shows no fact chips without facts", () => {
    const { container } = render(<SemanticLabelRow label={label([], true)} onJump={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".semantic-scope")?.textContent).toBe("fn difftest");
    expect(screen.queryByText("changed")).toBeNull();
  });
});

it("keeps a single-line edit quiet while exposing facts and related hunks", () => {
  const jump = vi.fn();
  const location = { path: "other.rs", line: 2, side: "new" as const };
  const { container } = render(
    <SemanticLabelRow
      label={{ ...label([group([call("retry"), lock])]), singleLine: true }}
      onJump={vi.fn()}
      related={[{ text: "Calls retry (added)", location }]}
      onRelatedJump={jump}
    />
  );
  expect(screen.queryByText("changed")).toBeNull();
  expect(container).not.toHaveTextContent("CACHE.lock");
  fireEvent.click(screen.getByRole("button", { name: "Calls retry (added) ↗" }));
  expect(jump).toHaveBeenCalledWith(location);
  fireEvent.click(screen.getByRole("button", { name: "Facts" }));
  const panel = screen.getByRole("region", { name: "Facts" });
  expect(within(panel).getByText("+ calls retry")).toBeVisible();
  expect(within(panel).getByText("+ lock CACHE.lock")).toBeVisible();
});

it("omits an empty row for a self-explanatory single-line addition", () => {
  const { container } = render(
    <SemanticLabelRow
      label={{
        ...label([]),
        singleLine: true,
        scope: [],
        chips: [{ kind: "added", declaration: { keyword: "const", name: "LIMIT" } }],
      }}
      onJump={vi.fn()}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
