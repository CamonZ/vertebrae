import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { render } from "../../test/test-utils";
import { ModeToggle, type TraceMode } from "./ModeToggle";

function Harness({ initial = "thread" as TraceMode }: { initial?: TraceMode }) {
  const [m, setM] = useState<TraceMode>(initial);
  return (
    <div>
      <ModeToggle mode={m} onChange={setM} />
      <span data-testid="active-mode">{m}</span>
    </div>
  );
}

describe("ModeToggle", () => {
  it("renders only THREAD and CORRIDOR with thread active by default", () => {
    render(<Harness />);
    const buttons = screen.getAllByRole("tab");
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "trace-mode-option-thread",
      "trace-mode-option-corridor",
    ]);
    expect(screen.getByTestId("trace-mode-option-thread")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(screen.getByTestId("trace-mode-option-corridor")).toHaveAttribute(
      "data-active",
      "false"
    );
  });

  it("switches active mode when CORRIDOR is clicked", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    expect(screen.getByTestId("active-mode").textContent).toBe("corridor");
    expect(screen.getByTestId("trace-mode-option-corridor")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(screen.getByTestId("trace-mode-option-thread")).toHaveAttribute(
      "data-active",
      "false"
    );
  });

  it("invokes onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(<ModeToggle mode="thread" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    expect(onChange).toHaveBeenCalledWith("corridor");
  });
});
