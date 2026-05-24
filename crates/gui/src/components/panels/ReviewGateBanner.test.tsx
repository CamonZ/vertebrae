import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewGateBanner } from "./ReviewGateBanner";

describe("ReviewGateBanner", () => {
  it("fires onAccept on accept click", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    render(<ReviewGateBanner onAccept={onAccept} />);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("requires a second reject click after revealing feedback", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<ReviewGateBanner onReject={onReject} />);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/feedback/i)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/feedback/i), "needs work");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledExactlyOnceWith("needs work");
  });

  it("disables actions when busy", () => {
    render(<ReviewGateBanner busy />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});
