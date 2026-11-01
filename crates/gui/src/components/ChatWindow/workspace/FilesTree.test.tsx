import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../../bindings";
import { FilesTree } from "./FilesTree";

vi.mock("../../../bindings", () => ({
  commands: { listWorktreeDirectory: vi.fn() },
}));
const list = vi.mocked(commands.listWorktreeDirectory);
type ListResult = Awaited<ReturnType<typeof list>>;

const listing = (
  path: string,
  names: string[],
  truncated = false
): ListResult => ({
  status: "ok",
  data: {
    path,
    truncated,
    entries: names.map((name) => ({
      name,
      path: path ? `${path}/${name}` : name,
      kind: name.endsWith("dir") ? "directory" : "file",
      symlink: name.startsWith("link"),
    })),
  },
});

beforeEach(() => list.mockReset());

describe("FilesTree", () => {
  it("expands symlinked folders like folders and labels the link", async () => {
    list
      .mockResolvedValueOnce(listing("", ["linkdir"]))
      .mockResolvedValueOnce(listing("linkdir", ["inner.ts"]));
    render(
      <FilesTree
        worktreePath="/w"
        statuses={new Map()}
        activePath={null}
        refreshToken={0}
        onOpen={vi.fn()}
      />
    );
    const link = await screen.findByRole("button", {
      name: /linkdir/,
    });
    expect(link).toHaveAccessibleName(/^linkdir ?\(symlink\)$/);
    expect(link).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(link);
    expect(
      await screen.findByRole("button", { name: "inner.ts" })
    ).toBeVisible();
    expect(list).toHaveBeenLastCalledWith("/w", "linkdir");
  });

  it("reports truncated folders", async () => {
    list.mockResolvedValueOnce(listing("", ["a", "b"], true));
    render(
      <FilesTree
        worktreePath="/w"
        statuses={new Map()}
        activePath={null}
        refreshToken={0}
        onOpen={vi.fn()}
      />
    );
    expect(
      await screen.findByText("Only the first 2 entries are shown.")
    ).toBeVisible();
  });

  it("refreshes loaded folders in place and drops stale responses", async () => {
    let resolveStale!: (value: ListResult) => void;
    list
      .mockResolvedValueOnce(listing("", ["dir"]))
      .mockResolvedValueOnce({ status: "error", error: { message: "denied" } });
    const onOpen = vi.fn();
    const tree = (refreshToken: number) => (
      <FilesTree
        worktreePath="/w"
        statuses={new Map()}
        activePath={null}
        refreshToken={refreshToken}
        onOpen={onOpen}
      />
    );
    const view = render(tree(0));
    fireEvent.click(await screen.findByRole("button", { name: "dir" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("denied");
    // The first root refresh is overtaken by a second one.
    list
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve;
        })
      )
      .mockResolvedValueOnce(listing("dir", ["fresh.txt"]))
      .mockResolvedValueOnce(listing("", ["dir"]))
      .mockResolvedValueOnce(listing("dir", ["fresh.txt"]));
    view.rerender(tree(1));
    view.rerender(tree(2));
    fireEvent.click(await screen.findByRole("button", { name: "fresh.txt" }));
    expect(onOpen).toHaveBeenCalledWith("dir/fresh.txt");
    expect(screen.getByRole("button", { name: "dir" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await act(async () => resolveStale(listing("", ["stale"])));
    expect(screen.queryByRole("button", { name: "stale" })).toBeNull();
    expect(list).toHaveBeenCalledTimes(6);
  });
});
