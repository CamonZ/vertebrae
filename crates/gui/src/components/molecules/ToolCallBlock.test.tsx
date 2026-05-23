import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolCallBlock } from "./ToolCallBlock";

describe("ToolCallBlock", () => {
  it("starts collapsed and expands on header click", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallBlock toolName="Read" summary="src/main.rs" result="ok" />,
    );
    expect(screen.queryByText("ok")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("respects defaultOpen", () => {
    render(
      <ToolCallBlock toolName="Bash" result="output" defaultOpen />,
    );
    expect(screen.getByText("output")).toBeInTheDocument();
  });
});
