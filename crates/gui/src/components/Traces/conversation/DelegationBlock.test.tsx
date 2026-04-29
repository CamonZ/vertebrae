import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DelegationBlock } from "./DelegationBlock";

describe("DelegationBlock", () => {
  it("renders children and exposes parent/child task IDs as data attrs", () => {
    render(
      <DelegationBlock parentTaskId="parent" childTaskId="child">
        <div data-testid="inner">hi</div>
      </DelegationBlock>
    );
    const block = screen.getByTestId("unified-chat-delegation");
    expect(block.getAttribute("data-parent-task-id")).toBe("parent");
    expect(block.getAttribute("data-child-task-id")).toBe("child");
    expect(screen.getByTestId("inner")).toBeInTheDocument();
  });

  it("shows the child task title when provided", () => {
    render(
      <DelegationBlock parentTaskId="p" childTaskId="c" childTaskTitle="Subtask A">
        <span>x</span>
      </DelegationBlock>
    );
    expect(screen.getByText(/delegated → Subtask A/)).toBeInTheDocument();
  });

  it("omits the title row when no childTaskTitle is given", () => {
    render(
      <DelegationBlock parentTaskId="p" childTaskId="c">
        <span>x</span>
      </DelegationBlock>
    );
    expect(screen.queryByText(/delegated →/)).toBeNull();
  });

  it("indents based on depth (default depth=1 → 0px)", () => {
    const { rerender } = render(
      <DelegationBlock parentTaskId="p" childTaskId="c">
        <span>x</span>
      </DelegationBlock>
    );
    expect(screen.getByTestId("unified-chat-delegation").style.marginLeft).toBe(
      "0px"
    );
    rerender(
      <DelegationBlock parentTaskId="p" childTaskId="c" depth={3}>
        <span>x</span>
      </DelegationBlock>
    );
    expect(screen.getByTestId("unified-chat-delegation").style.marginLeft).toBe(
      "32px"
    );
  });
});
