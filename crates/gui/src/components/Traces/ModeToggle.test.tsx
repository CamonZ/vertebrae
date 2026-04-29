import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { render } from "../../test/test-utils";
import { ModeToggle, ModePlaceholder, type TraceMode } from "./ModeToggle";

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
  it("renders all three modes with thread active by default", () => {
    render(<Harness />);
    const thread = screen.getByTestId("trace-mode-option-thread");
    const corridor = screen.getByTestId("trace-mode-option-corridor");
    const strip = screen.getByTestId("trace-mode-option-strip");
    expect(thread).toHaveAttribute("data-active", "true");
    expect(corridor).toHaveAttribute("data-active", "false");
    expect(strip).toHaveAttribute("data-active", "false");
  });

  it("switches active mode when a different option is clicked", () => {
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

    fireEvent.click(screen.getByTestId("trace-mode-option-strip"));
    expect(screen.getByTestId("active-mode").textContent).toBe("strip");
  });

  it("invokes onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(<ModeToggle mode="thread" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("trace-mode-option-strip"));
    expect(onChange).toHaveBeenCalledWith("strip");
  });
});

describe("ModePlaceholder", () => {
  it("renders the active mode label and a coming-soon stub", () => {
    render(<ModePlaceholder mode="corridor" />);
    const placeholder = screen.getByTestId("trace-mode-placeholder");
    expect(placeholder).toHaveAttribute("data-mode", "corridor");
    expect(placeholder.textContent).toMatch(/Corridor/);
    expect(placeholder.textContent).toMatch(/Coming soon/);
  });
});
