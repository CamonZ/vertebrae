import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { GithubThreadCard } from "./GithubThreadCard";
import { at, reviewThread } from "./fixture";
import { buildReviewModel } from "./model";

it("marks the published lines a local edit changed and names them", () => {
  const published = [540, 541, 542, 543, 544].map((number) => ({
    number,
    text: number === 542 ? "old call();" : `line ${number}`,
    focus: number >= 541 && number <= 543,
  }));
  const model = buildReviewModel(
    7,
    [reviewThread("t1")],
    [
      at("t1", {
        kind: "edited",
        startLine: 541,
        line: 543,
        published,
        editedLines: [542],
        publishedCommit: "1".repeat(40),
      }),
    ],
    false
  );
  render(<GithubThreadCard placed={model.byThread.get("t1")!} />);

  expect(
    screen.getByText(
      "You edited line 542 of the commented lines 541–543 locally; reviewers still see them as published."
    )
  ).toBeInTheDocument();
  const snippet = screen.getByLabelText("Code as published");
  const marked = [...snippet.querySelectorAll("[data-edited]")];
  expect(marked).toHaveLength(1);
  expect(within(marked[0] as HTMLElement).getByText("542")).toBeInTheDocument();
  expect(marked[0]).toHaveTextContent("old call();");
});
