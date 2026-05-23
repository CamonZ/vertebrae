import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("is aria-hidden by default", () => {
    const { container } = render(
      <Icon>
        <circle cx="12" cy="12" r="10" />
      </Icon>,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("becomes a labelled image when label is provided", () => {
    render(
      <Icon label="warning">
        <path d="M0 0" />
      </Icon>,
    );
    expect(screen.getByRole("img", { name: "warning" })).toBeInTheDocument();
  });

  it("applies the requested size in px", () => {
    const { container } = render(
      <Icon size="lg">
        <circle cx="12" cy="12" r="10" />
      </Icon>,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
  });
});
