import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals after the hover delay and hides on leave", () => {
    render(
      <Tooltip label="more info" delay={400}>
        <button type="button">Trigger</button>
      </Tooltip>
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    const tip = screen.getByRole("tooltip", { hidden: true });

    expect(tip).toHaveAttribute("aria-hidden", "true");
    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(tip).toHaveAttribute("aria-hidden", "false");
    fireEvent.mouseLeave(trigger);
    expect(tip).toHaveAttribute("aria-hidden", "true");
  });

  it("returns the unwrapped child when disabled", () => {
    render(
      <Tooltip label="never" disabled>
        <button type="button">Solo</button>
      </Tooltip>
    );
    expect(
      screen.queryByRole("tooltip", { hidden: true })
    ).not.toBeInTheDocument();
  });
});

it("preserves an explicit child description without duplicating it on focus", () => {
  render(
    <>
      <span id="existing">Existing description</span>
      <Tooltip label="More information">
        <button aria-describedby="existing">Trigger</button>
      </Tooltip>
    </>
  );
  const trigger = screen.getByRole("button", { name: "Trigger" });
  expect(trigger).toHaveAccessibleDescription("Existing description");
  fireEvent.focus(trigger);
  expect(trigger).toHaveAccessibleDescription("Existing description");
  expect(trigger).toHaveAttribute("aria-describedby", "existing");
  expect(screen.getByRole("tooltip")).toHaveTextContent("More information");
  fireEvent.blur(trigger);
  expect(trigger).toHaveAttribute("aria-describedby", "existing");
});
