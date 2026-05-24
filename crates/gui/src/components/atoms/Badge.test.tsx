import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders label by default", () => {
    render(<Badge intent="success">Done</Badge>);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders count variant as a numeric pill", () => {
    render(<Badge count={3} intent="accent" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides label when dot is 'only'", () => {
    render(<Badge dot="only">hidden</Badge>);
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });
});
