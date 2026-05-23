import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

describe("Select", () => {
  it("renders flat options", () => {
    render(
      <Select
        aria-label="role"
        defaultValue="ai"
        options={[
          { value: "ai", label: "AI" },
          { value: "human", label: "Human" },
        ]}
      />,
    );
    expect(screen.getByRole("option", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Human" })).toBeInTheDocument();
  });

  it("renders grouped options", () => {
    render(
      <Select
        aria-label="model"
        defaultValue="haiku"
        options={[
          {
            label: "Anthropic",
            options: [
              { value: "opus", label: "Opus" },
              { value: "haiku", label: "Haiku" },
            ],
          },
        ]}
      />,
    );
    const group = screen.getByRole("group", { name: "Anthropic" });
    expect(group).toBeInTheDocument();
  });

  it("propagates onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        aria-label="x"
        defaultValue="a"
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    await user.selectOptions(screen.getByRole("combobox"), "b");
    expect(onChange).toHaveBeenCalled();
  });
});
