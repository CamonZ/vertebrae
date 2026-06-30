import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DetachedPlaceholder } from "./DetachedPlaceholder";

describe("DetachedPlaceholder", () => {
  it("renders the session label in the message", () => {
    render(<DetachedPlaceholder label="Project Chat" onReattach={vi.fn()} />);
    expect(screen.getByText("Project Chat")).toBeInTheDocument();
  });

  it("renders the 'open in a pop-out window' message", () => {
    render(<DetachedPlaceholder label="Test" onReattach={vi.fn()} />);
    expect(
      screen.getByText(/open in a pop-out window/)
    ).toBeInTheDocument();
  });

  it("renders with role=status and aria-label", () => {
    render(<DetachedPlaceholder label="Test" onReattach={vi.fn()} />);
    expect(
      screen.getByRole("status", { name: "Session detached" })
    ).toBeInTheDocument();
  });

  it("fires onReattach when the reattach button is clicked", () => {
    const onReattach = vi.fn();
    render(<DetachedPlaceholder label="Test" onReattach={onReattach} />);
    fireEvent.click(screen.getByRole("button", { name: "Reattach to panel" }));
    expect(onReattach).toHaveBeenCalledTimes(1);
  });

  it("renders the reattach button with the correct label", () => {
    render(<DetachedPlaceholder label="Test" onReattach={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Reattach to panel" })
    ).toBeInTheDocument();
  });
});
