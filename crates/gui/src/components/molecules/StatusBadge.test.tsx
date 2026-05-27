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

  it("renders workflow and step as two segments of one breadcrumb", () => {
    render(
      <StatusBadge state={{ kind: "workflow", workflow: "Implementation", step: "in_progress" }} />,
    );
    expect(screen.getByText("Implementation")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("omits the step segment when the step is empty", () => {
    render(
      <StatusBadge state={{ kind: "workflow", workflow: "Implementation", step: "" }} />,
    );
    expect(screen.getByText("Implementation")).toBeInTheDocument();
  });

  it("becomes interactive when onClick is provided", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<StatusBadge state="failed" onClick={onClick} />);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
