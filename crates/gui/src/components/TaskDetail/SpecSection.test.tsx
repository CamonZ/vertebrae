import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { SpecSection } from "./SpecSection";
import type { Section } from "../../bindings";

function createSection(
  overrides: Partial<Section> & { type: Section["type"]; content: string }
): Section {
  return {
    order: 0,
    done: null,
    done_at: null,
    ...overrides,
  };
}

describe("SpecSection", () => {
  describe("empty state", () => {
    it("shows description placeholder when no content", () => {
      render(<SpecSection description={null} sections={[]} />);

      expect(screen.getByText("No description")).toBeInTheDocument();
    });
  });

  describe("goal display", () => {
    it("shows goal section content", () => {
      const sections = [
        createSection({ type: "goal", content: "Build the feature" }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Goal")).toBeInTheDocument();
      expect(screen.getByText("Build the feature")).toBeInTheDocument();
    });

    it("shows multiple goals", () => {
      const sections = [
        createSection({ type: "goal", content: "First goal", order: 0 }),
        createSection({ type: "goal", content: "Second goal", order: 1 }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("First goal")).toBeInTheDocument();
      expect(screen.getByText("Second goal")).toBeInTheDocument();
    });
  });

  describe("description display", () => {
    it("shows description when present", () => {
      render(
        <SpecSection description="A detailed description" sections={[]} />
      );

      expect(screen.getByText("A detailed description")).toBeInTheDocument();
    });

    it("shows description alongside goals", () => {
      const sections = [createSection({ type: "goal", content: "The goal" })];

      render(
        <SpecSection description="Supporting details" sections={sections} />
      );

      expect(screen.getByText("The goal")).toBeInTheDocument();
      expect(screen.getByText("Supporting details")).toBeInTheDocument();
    });
  });

  describe("constraints display", () => {
    it("shows constraint items with bullet points", () => {
      const sections = [
        createSection({
          type: "constraint",
          content: "Must be fast",
          order: 0,
        }),
        createSection({
          type: "constraint",
          content: "Must be reliable",
          order: 1,
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Constraints")).toBeInTheDocument();
      expect(screen.getByText("Must be fast")).toBeInTheDocument();
      expect(screen.getByText("Must be reliable")).toBeInTheDocument();
    });
  });

  describe("filters out non-spec sections", () => {
    it("does not show testing_criterion sections", () => {
      const sections = [
        createSection({ type: "goal", content: "The goal" }),
        createSection({
          type: "testing_criterion",
          content: "Should not appear in spec",
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("The goal")).toBeInTheDocument();
      expect(
        screen.queryByText("Should not appear in spec")
      ).not.toBeInTheDocument();
    });
  });

  describe("checklist and negative-space sections", () => {
    it("shows checklist items with completion state", () => {
      const sections = [
        createSection({
          type: "checklist_item",
          content: "Complete the first step",
          order: 0,
          done: true,
        }),
        createSection({
          type: "checklist_item",
          content: "Complete the second step",
          order: 1,
          done: false,
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Checklist Items")).toBeInTheDocument();
      expect(screen.getByText("Complete the first step")).toHaveClass(
        "line-through"
      );
      expect(screen.getByText("Complete the second step")).toBeInTheDocument();
      expect(screen.getByText("Complete the second step")).not.toHaveClass(
        "line-through"
      );
    });

    it("shows anti patterns and negative tests", () => {
      const sections = [
        createSection({
          type: "anti_pattern",
          content: "Do not bypass the service layer",
        }),
        createSection({
          type: "failure_test",
          content: "Reject malformed task payloads",
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Anti Patterns")).toBeInTheDocument();
      expect(
        screen.getByText("Do not bypass the service layer")
      ).toBeInTheDocument();
      expect(screen.getByText("Negative Tests")).toBeInTheDocument();
      expect(
        screen.getByText("Reject malformed task payloads")
      ).toBeInTheDocument();
    });
  });

  describe("context and behavior sections", () => {
    it("shows context sections", () => {
      const sections = [
        createSection({
          type: "context",
          content: "Historical context",
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Context")).toBeInTheDocument();
      expect(screen.getByText("Historical context")).toBeInTheDocument();
    });

    it("shows current behavior sections", () => {
      const sections = [
        createSection({
          type: "current_behavior",
          content: "Currently broken",
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Current Behavior")).toBeInTheDocument();
      expect(screen.getByText("Currently broken")).toBeInTheDocument();
    });

    it("shows desired behavior sections", () => {
      const sections = [
        createSection({
          type: "desired_behavior",
          content: "Should work correctly",
        }),
      ];

      render(<SpecSection description={null} sections={sections} />);

      expect(screen.getByText("Desired Behavior")).toBeInTheDocument();
      expect(screen.getByText("Should work correctly")).toBeInTheDocument();
    });
  });
});
