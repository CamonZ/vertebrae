import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeChanges } from "./WorktreeChanges";
import { commands, type WorktreeChanges as Changes } from "../../bindings";

vi.mock("../../bindings", () => ({
  commands: { loadWorktreeChanges: vi.fn() },
}));
vi.mock("../thread/toolChange/PatchFiles", () => ({
  default: ({ patch }: { patch: string }) => <pre>{patch}</pre>,
}));
const load = vi.mocked(commands.loadWorktreeChanges);
const empty: Changes = {
  base_branch: "refs/heads/main",
  base_unavailable: null,
  files: [],
};
beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue({ status: "ok", data: empty });
});

describe("WorktreeChanges", () => {
  it("loads on open and refresh and requests the labeled branch baseline", async () => {
    render(<WorktreeChanges worktreePath="/worktree" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading changes");
    expect(screen.queryByText("/worktree")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh changes" })
    ).toBeDisabled();
    await screen.findByText("No changes against this baseline.");
    expect(load).toHaveBeenCalledExactlyOnceWith("/worktree", false);
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByText("No changes against this baseline.");
    fireEvent.change(screen.getByLabelText("Changes baseline"), {
      target: { value: "branch" },
    });
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith("/worktree", true)
    );
  });
  it("renders every file and uses the collapsible sidebar only to jump", async () => {
    load.mockResolvedValue({
      status: "ok",
      data: {
        ...empty,
        files: [
          {
            path: "new",
            old_path: "old",
            status: "renamed",
            marker: null,
            patch:
              "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-before\n+after\n",
          },
          {
            path: "binary",
            old_path: null,
            status: "added",
            marker: "binary",
            patch: "",
          },
        ],
      },
    });
    render(<WorktreeChanges worktreePath="/worktree" />);
    await screen.findByRole("button", { name: "Jump to new" });
    await screen.findByText(/\+after/);
    const first = screen.getByRole("region", { name: "Diff for new" });
    const second = screen.getByRole("region", { name: "Diff for binary" });
    expect(first).toBeVisible();
    expect(second).toBeVisible();
    expect(first.querySelector("h3")).toBeNull();
    expect(first).not.toHaveTextContent("+1 −1");
    expect(
      screen.getByRole("button", { name: "Jump to new" })
    ).toHaveTextContent("+1−1");
    expect(second).toHaveTextContent("Binary file — diff not shown");
    Object.defineProperty(second, "offsetTop", { value: 420 });
    const viewport = screen.getByLabelText("All file diffs");
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    fireEvent.click(screen.getByRole("button", { name: "Jump to binary" }));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 420,
      behavior: "auto",
    });
    expect(first).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
    expect(
      screen.queryByRole("navigation", { name: "Changed files" })
    ).toBeNull();
    expect(first).toBeVisible();
    expect(second).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(
      screen.getByRole("navigation", { name: "Changed files" })
    ).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("keeps failures inline and hides unavailable branch baselines", async () => {
    load.mockResolvedValueOnce({
      status: "error",
      error: { message: "git timed out" },
    });
    render(<WorktreeChanges worktreePath="/missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("git timed out");
    load.mockResolvedValueOnce({
      status: "ok",
      data: { ...empty, base_branch: null, base_unavailable: "No base branch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await screen.findByText("No base branch");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
  it("drops late failures after worktree changes", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof load>>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const view = render(<WorktreeChanges worktreePath="/old" />);
    view.rerender(<WorktreeChanges worktreePath="/new" />);
    await screen.findByText("No changes against this baseline.");
    await act(async () =>
      resolveOld({ status: "error", error: { message: "stale error" } })
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenLastCalledWith("/new", false);
  });
});
