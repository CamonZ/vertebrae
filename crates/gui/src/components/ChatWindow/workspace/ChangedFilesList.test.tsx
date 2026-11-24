import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorktreeChange } from "../../../bindings";
import { ChangedFilesList } from "./ChangedFilesList";

const change = (path: string, old_path: string | null): WorktreeChange =>
  ({
    path,
    old_path,
    status: old_path ? "renamed" : "modified",
    marker: null,
    totals: { additions: 1, deletions: 0, binary_files: 0 },
    patch: "",
  }) as WorktreeChange;

function renderRows(files: WorktreeChange[]) {
  render(
    <ChangedFilesList
      listRef={null}
      files={files}
      selectedPath={null}
      activePath={null}
      onJump={() => {}}
    />
  );
}

describe("ChangedFilesList rows", () => {
  it("leads a rename within its directory with the short source", () => {
    renderRows([change("docs/guide.md", "docs/notes.md")]);
    const row = screen.getByRole("button", { name: "Jump to docs/guide.md" });
    expect(row).toHaveTextContent("guide.mdfrom notes.md · docs");
    expect(row).toHaveAttribute("title", "docs/notes.md → docs/guide.md");
  });

  it("keeps a move's full source path on the muted line", () => {
    renderRows([change("src/lib/guide.md", "docs/notes.md")]);
    const row = screen.getByRole("button", {
      name: "Jump to src/lib/guide.md",
    });
    expect(row).toHaveTextContent("guide.mdfrom docs/notes.md · src/lib");
  });

  it("shows a top-level rename's source without a directory", () => {
    renderRows([change("new.ts", "old.ts")]);
    expect(
      screen.getByRole("button", { name: "Jump to new.ts" })
    ).toHaveTextContent(/^Rnew\.tsfrom old\.ts\+1−0$/);
  });
});
