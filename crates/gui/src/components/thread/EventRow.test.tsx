import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ToolRow } from "./EventRow";

function ExpensiveBody({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <span>expensive body</span>;
}

describe("ToolRow", () => {
  it("does not mount a collapsed body until the row is expanded", () => {
    const onMount = vi.fn();
    const { container } = render(
      <ToolRow
        name="Read"
        status="done"
        collapsed
        body={<ExpensiveBody onMount={onMount} />}
      />
    );

    const header = screen.getByRole("button", { name: /Read/ });
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByText("expensive body")).not.toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(header);

    expect(onMount).toHaveBeenCalledOnce();
    expect(screen.getByText("expensive body")).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".evtool-bd")).toHaveAttribute(
      "id",
      header.getAttribute("aria-controls")
    );
  });

  it("keeps local expansion state across parent rerenders", () => {
    const { rerender } = render(
      <ToolRow name="Read" status="done" collapsed body="first result" />
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /Read/ }), {
      key: "Enter",
    });
    expect(screen.getByText("first result")).toBeInTheDocument();

    rerender(
      <ToolRow name="Read" status="done" collapsed body="updated result" />
    );

    expect(screen.getByText("updated result")).toBeInTheDocument();
    expect(screen.queryByText("first result")).not.toBeInTheDocument();
  });

  it("bounds a large expanded tool result and retains access to all output", () => {
    const tail = "LAST-RESULT-LINE";
    const body = `${"result line\n".repeat(1_100)}${tail}`;
    render(<ToolRow name="Read" status="done" body={body} />);

    expect(screen.getByTestId("bounded-content-preview")).toBeInTheDocument();
    expect(screen.queryByText(tail)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show full content/ }));

    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();
  });
});
