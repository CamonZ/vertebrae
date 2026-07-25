import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepStrip } from "./StepStrip";
import type { Kind } from "./layout/types";

const SHAPE: Kind[] = ["execute", "execute", "eval", "route", "wait", "human", "finish"];

describe("StepStrip", () => {
  it("renders the ribbon with one segment per step", () => {
    const { getByTestId, container } = render(<StepStrip shape={SHAPE} />);
    expect(getByTestId("step-strip-ribbon")).toBeInTheDocument();
    expect(container.querySelectorAll(".al-ribbon .seg")).toHaveLength(
      SHAPE.length,
    );
  });

  it("carries the k-<kind> token class for colour", () => {
    const { container } = render(<StepStrip shape={SHAPE} />);
    expect(container.querySelector(".seg.k-execute")).toBeInTheDocument();
    expect(container.querySelector(".seg.k-route")).toBeInTheDocument();
  });

  it("renders an empty ribbon for an empty shape", () => {
    const { getByTestId, container } = render(<StepStrip shape={[]} />);
    expect(getByTestId("step-strip-ribbon")).toBeInTheDocument();
    expect(container.querySelectorAll(".al-ribbon .seg")).toHaveLength(0);
  });
});
