import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LiveExecutionBanner } from "./LiveExecutionBanner";

describe("LiveExecutionBanner", () => {
  it("renders running count and per-step chips", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    render(
      <LiveExecutionBanner
        totalRunning={3}
        steps={[
          { id: "ip", name: "In Progress", count: 2 },
          { id: "rg", name: "Review Gate", count: 1 },
        ]}
        onStepClick={onStepClick}
      />,
    );
    expect(screen.getByText("3 running")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /In Progress \(2\)/ }),
    );
    expect(onStepClick).toHaveBeenCalledExactlyOnceWith("ip");
  });

  it("renders nothing when no runs are active", () => {
    const { container } = render(
      <LiveExecutionBanner totalRunning={0} steps={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
