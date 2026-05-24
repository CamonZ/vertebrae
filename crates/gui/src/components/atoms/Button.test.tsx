import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children and fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks clicks while loading", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("requires a confirm click for danger variant with confirm prop", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="danger" confirm onClick={onClick}>
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button");
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Sure?");
    await user.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("fires immediately for danger without confirm prop", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="danger" onClick={onClick}>
        Delete
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
