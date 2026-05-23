import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["queued", "Queued"],
    ["executing", "Running"],
    ["waiting", "Waiting"],
    ["completed", "Done"],
    ["failed", "Failed"],
    ["pending_review", "Needs Review"],
  ] as const)("labels %s state as %s", (state, label) => {
    render(<StatusBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("composes a workflow:step label", () => {
    render(
      <StatusBadge state={{ kind: "workflow", workflow: "Implementation", step: "In Progress" }} />,
    );
    expect(screen.getByText("Implementation / In Progress")).toBeInTheDocument();
  });

  it("becomes interactive when onClick is provided", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<StatusBadge state="failed" onClick={onClick} />);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
