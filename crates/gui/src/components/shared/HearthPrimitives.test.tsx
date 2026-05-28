import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CompactRunCard,
  DetailHeader,
  Glyph,
  HeroStatus,
  IdChip,
  KindChip,
  Pipeline,
  RunChip,
  StepDot,
} from "./HearthPrimitives";

const FULL_ID = "a1a7ac1f-e4ad-403d-9ea3-60d8203b54c0";

function installClipboardMock() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("Hearth primitives", () => {
  it("keeps IdChip copy behavior on the existing IdentityBadge copy control", async () => {
    const writeText = installClipboardMock();
    render(<IdChip id={FULL_ID} kind="task" />);

    expect(screen.getByText("a1a7ac1f")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy full task ID" })
      );
    });

    expect(writeText).toHaveBeenCalledWith(FULL_ID);
  });

  it("hides terminal run statuses unless forced", () => {
    const { container, rerender } = render(<RunChip status="completed" />);
    expect(container.firstChild).toBeNull();

    rerender(<RunChip status="completed" force />);

    expect(screen.getByLabelText("Run status: Completed")).toHaveClass(
      "c-run-chip",
      "completed"
    );
  });

  it("maps production run status and step kind to stable Hearth classes", () => {
    render(
      <div>
        <RunChip status="executing" />
        <KindChip stepType="evaluate" />
        <Pipeline
          segments={[
            { stepType: "execute", state: "completed" },
            { stepType: "human_input", state: "running" },
          ]}
        />
        <StepDot variant="waiting" />
      </div>
    );

    expect(screen.getByLabelText("Run status: Running")).toHaveClass(
      "c-run-chip",
      "running"
    );
    expect(screen.getByLabelText("Step kind: Evaluate")).toHaveClass(
      "c-kind-chip",
      "kind-eval"
    );
    expect(
      screen.getByLabelText("2 step pipeline").querySelectorAll(".seg")
    ).toHaveLength(2);
    expect(screen.getByLabelText("Step waiting")).toHaveClass(
      "c-dot",
      "waiting"
    );
  });

  it("honors custom run labels on active chips", () => {
    render(<RunChip status="executing" label="Deploying" />);

    expect(screen.getByLabelText("Run status: Deploying")).toHaveTextContent(
      "Deploying"
    );
  });

  it("derives labels when KindChip receives only a Hearth kind", () => {
    render(<KindChip kind="eval" />);

    expect(screen.getByLabelText("Step kind: Evaluate")).toHaveClass(
      "kind-eval"
    );
  });

  it("renders clickable detail crumbs as keyboard-accessible buttons", () => {
    const onClick = vi.fn();
    render(
      <DetailHeader
        title="Ticket"
        crumbs={[{ text: "Parent", onClick, em: true }]}
      />
    );

    const crumb = screen.getByRole("button", { name: "Parent" });
    fireEvent.click(crumb);

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("uses the shared level mark for glyphs", () => {
    render(<Glyph level="epic" />);

    expect(screen.getByLabelText("Level: Epic")).toHaveAttribute(
      "data-level",
      "epic"
    );
  });

  it("provides accessible labels for hero and compact run surfaces", () => {
    render(
      <div>
        <HeroStatus status="waiting" step={{ n: 2, kind: "route" }} />
        <CompactRunCard
          status="failed"
          id={FULL_ID}
          when="now"
          reason="workflow rejected"
        />
      </div>
    );

    expect(screen.getByLabelText("Hero status: Waiting")).toBeInTheDocument();
    expect(screen.getByLabelText("Run status: Failed")).toHaveClass("failed");
    expect(
      screen.getByRole("button", { name: "Copy full task run ID" })
    ).toBeInTheDocument();
  });
});
