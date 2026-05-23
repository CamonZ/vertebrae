import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders header, body, and footer slots", () => {
    render(
      <Card header="Title" footer="Footer">
        body
      </Card>,
    );
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("interactive variant fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Card variant="interactive" onClick={onClick}>
        click
      </Card>,
    );
    await user.click(screen.getByText("click"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
