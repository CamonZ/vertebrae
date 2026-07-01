import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionDeleteButton } from "./SessionDeleteButton";

describe("SessionDeleteButton", () => {
  it("renders with the correct aria-label from session label", () => {
    render(<SessionDeleteButton label="My Chat" onClick={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Delete local chat My Chat" })
    ).toBeInTheDocument();
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    render(<SessionDeleteButton label="Test" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled when disabled prop is true", () => {
    render(
      <SessionDeleteButton label="Test" onClick={vi.fn()} disabled />
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is not disabled by default", () => {
    render(<SessionDeleteButton label="Test" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("renders the data-mini-delete attribute when dataMiniDelete is true", () => {
    render(
      <SessionDeleteButton label="Test" onClick={vi.fn()} dataMiniDelete />
    );
    expect(screen.getByRole("button")).toHaveAttribute("data-mini-delete");
  });

  it("does not render data-mini-delete when dataMiniDelete is omitted", () => {
    render(<SessionDeleteButton label="Test" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).not.toHaveAttribute("data-mini-delete");
  });

  it("renders the trash icon SVG", () => {
    const { container } = render(
      <SessionDeleteButton label="Test" onClick={vi.fn()} />
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("sets the correct title from session label", () => {
    render(<SessionDeleteButton label="Project Chat" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "Delete local chat Project Chat"
    );
  });
});
