import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticId,
  IdentityBadge,
  NavigableReference,
  ScanIdentifier,
  formatEntityId,
} from "./EntityId";

const FULL_ID = "860cde1b-9093-42ff-a19d-7453f3b7891b";

function installClipboardMock() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("EntityId primitives", () => {
  it("formats IDs with eight-character short IDs by default and full IDs on request", () => {
    expect(formatEntityId(FULL_ID)).toBe("860cde1b");
    expect(formatEntityId(FULL_ID, { full: true })).toBe(FULL_ID);
    expect(formatEntityId(null)).toBe("-");
  });

  it("renders scan identifiers as short IDs with full-ID metadata and copy control", async () => {
    const writeText = installClipboardMock();
    render(<ScanIdentifier id={FULL_ID} kind="task" />);

    expect(screen.getByText("860cde1b")).toBeInTheDocument();
    expect(screen.getByTitle(`Task ID: ${FULL_ID}`)).toHaveAttribute(
      "data-full-id",
      FULL_ID
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy full task ID" }));
    });
    expect(writeText).toHaveBeenCalledWith(FULL_ID);
  });

  it("can render an ID without the copy control", () => {
    render(<ScanIdentifier id={FULL_ID} kind="workflow" copyable={false} />);

    expect(screen.getByText("860cde1b")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy full workflow ID" })
    ).not.toBeInTheDocument();
  });

  it("renders focused, navigable, and diagnostic contexts with the expected display modes", () => {
    render(
      <div>
        <IdentityBadge id={FULL_ID} kind="task" testId="identity" />
        <NavigableReference id={FULL_ID} kind="workflow" testId="reference" />
        <DiagnosticId id={FULL_ID} kind="task run" testId="diagnostic" />
      </div>
    );

    expect(screen.getByTestId("identity")).toHaveAttribute(
      "data-id-display",
      "short"
    );
    expect(
      screen.getByRole("button", { name: "Copy full workflow ID" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("diagnostic")).toHaveTextContent(FULL_ID);
    expect(screen.getByTestId("diagnostic")).toHaveAttribute(
      "data-id-display",
      "full"
    );
  });
});
