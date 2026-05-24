import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TreeNode } from "./TreeNode";

describe("TreeNode", () => {
  it("selects on row click without toggling", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <TreeNode hasChildren onSelect={onSelect} onToggle={onToggle}>
        Task
      </TreeNode>,
    );
    await user.click(screen.getByText("Task"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("toggles on chevron click without selecting", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <TreeNode hasChildren onSelect={onSelect} onToggle={onToggle}>
        Task
      </TreeNode>,
    );
    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("exposes aria-level for depth", () => {
    render(<TreeNode depth={2}>Leaf</TreeNode>);
    expect(screen.getByRole("treeitem")).toHaveAttribute("aria-level", "3");
  });
});
