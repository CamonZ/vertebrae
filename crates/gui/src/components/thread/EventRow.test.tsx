import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("keeps local expansion state across parent rerenders", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ToolRow name="Read" status="done" collapsed body="first result" />
    );

    screen.getByRole("button", { name: /Read/ }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("first result")).toBeInTheDocument();

    rerender(
      <ToolRow name="Read" status="done" collapsed body="updated result" />
    );

    expect(screen.getByText("updated result")).toBeInTheDocument();
    expect(screen.queryByText("first result")).not.toBeInTheDocument();
  });

  it("mounts and unmounts a controlled body only after its owner updates", () => {
    const onToggle = vi.fn();
    const onMount = vi.fn();
    const body = <ExpensiveBody onMount={onMount} />;
    const { rerender } = render(
      <ToolRow
        name="Read"
        status="done"
        collapsed
        onToggle={onToggle}
        body={body}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onMount).not.toHaveBeenCalled();

    rerender(
      <ToolRow
        name="Read"
        status="done"
        collapsed={false}
        onToggle={onToggle}
        body={body}
      />
    );
    expect(onMount).toHaveBeenCalledOnce();

    rerender(
      <ToolRow
        name="Read"
        status="done"
        collapsed
        onToggle={onToggle}
        body={body}
      />
    );
    expect(screen.queryByText("expensive body")).not.toBeInTheDocument();
  });

  it("bounds a large expanded tool result and retains access to all output", () => {
    const tail = "+LAST-DIFF-LINE";
    const body = `${" context\n-old\n+new\n".repeat(400)}${tail}`;
    render(<ToolRow name="Read" status="done" body={body} />);

    expect(screen.getByTestId("bounded-content-preview")).toBeInTheDocument();
    expect(screen.queryByText(tail)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show full content/ }));

    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();
  });

  it("pretty-prints a complete large JSON result after expansion", () => {
    const body = JSON.stringify({
      rows: Array.from({ length: 900 }, (_, index) => ({ index })),
      tail: "PRESERVED-JSON-TAIL",
    });
    render(<ToolRow name="Query" status="done" body={body} />);

    expect(screen.queryByText(/PRESERVED-JSON-TAIL/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show full content/ }));

    expect(
      screen.getByText((text) => text.includes('"tail": "PRESERVED-JSON-TAIL"'))
    ).toBeInTheDocument();
  });
});
