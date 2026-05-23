import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("applies width/height from numeric props", () => {
    const { container } = render(
      <Skeleton variant="block" width={120} height={40} />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe("120px");
    expect(el.style.height).toBe("40px");
  });

  it("defaults text variant to 100% width", () => {
    const { container } = render(<Skeleton variant="text" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe("100%");
  });
});
