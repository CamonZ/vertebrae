import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/test-utils";
import { GateChatStatusBar } from "./GateChatStatusBar";

describe("GateChatStatusBar", () => {
  it.each([
    ["drafting", 1, "Drafting", "waiting"],
    ["rejected", 3, "Rejected · attempt 3", "failed"],
    ["under_review", 1, "Under review", "running"],
    ["accepted", 2, "Accepted", "completed"],
    ["closed", 1, "Gate closed", "stopped"],
  ] as const)(
    "shows the %s phase as a %s chip",
    (phase, attempt, label, chipState) => {
      render(
        <GateChatStatusBar
          stepName="approve"
          status={{ phase, attempt, waitingExecutionId: null }}
        />
      );

      const bar = screen.getByTestId("gate-chat-status");
      expect(bar).toHaveAttribute("data-phase", phase);
      expect(bar).toHaveTextContent("approve");
      const chip = screen.getByText(label).closest(".c-run-chip");
      expect(chip).toHaveAttribute("data-state", chipState);
    }
  );
});
