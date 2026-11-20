import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Fact } from "../../../bindings";
import { SemanticLabelRow } from "./SemanticLabel";
import type { SemanticLabel } from "./semanticHunks";
import { MAX_FACT_CHIPS, type FactGroup } from "./semanticFacts";

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

const factChips = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-semantic-fact], [data-semantic-fact-count]")].map(
    (chip) => chip.textContent
  );

describe("SemanticLabelRow", () => {
  it("names the first facts, folds the rest into a button that lists them all", () => {
    const facts = Array.from({ length: MAX_FACT_CHIPS + 2 }, (_, i) => call(`step${i}`));
    const { container } = render(
      <SemanticLabelRow label={label([group(facts)])} onJump={vi.fn()} />
    );
    expect(factChips(container)).toEqual(
      facts.slice(0, MAX_FACT_CHIPS).map((_, i) => `+ calls step${i}`)
    );
    const more = screen.getByRole("button", { name: "+2 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    // The facts are not hidden in a hover-only title.
    expect(container.querySelector("[title]")).toBeNull();
    fireEvent.click(more);
    const panel = screen.getByRole("region", { name: "Facts" });
    expect(panel).toHaveFocus();
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      facts.map((_, i) => `+ calls step${i}`)
    );
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Facts" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("names an added declaration's signal and counts the rest", () => {
    const calls = [call("a"), call("b"), call("c")];
    const { container } = render(
      <SemanticLabelRow label={label([group([...calls, lock], true, 1)])} onJump={vi.fn()} />
    );
    expect(factChips(container)).toEqual(["+ lock CACHE.lock", "3 calls"]);
    fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
    const panel = screen.getByRole("region", { name: "Facts" });
    expect(within(panel).getByText("Concurrency")).toBeInTheDocument();
    expect(within(panel).getByText("Calls")).toBeInTheDocument();
    expect(within(panel).getByText("1 more not listed")).toBeInTheDocument();
  });

  it("tags test code on the scope and shows no fact chips without facts", () => {
    const { container } = render(<SemanticLabelRow label={label([], true)} onJump={vi.fn()} />);
    expect(factChips(container)).toEqual([]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".semantic-scope")?.textContent).toBe("fn difftest");
    expect(screen.getByText("changed")).toBeInTheDocument();
  });
});
