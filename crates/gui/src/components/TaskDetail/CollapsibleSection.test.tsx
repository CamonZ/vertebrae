import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { CollapsibleSection } from "./CollapsibleSection";

describe("CollapsibleSection", () => {
  describe("rendering", () => {
    it("renders the title", () => {
      render(
        <CollapsibleSection title="Test Section">
          <p>Content</p>
        </CollapsibleSection>
      );

      expect(screen.getByText("Test Section")).toBeInTheDocument();
    });

    it("renders the toggle button with correct aria-label", () => {
      render(
        <CollapsibleSection title="My Section">
          <p>Content</p>
        </CollapsibleSection>
      );

      const button = screen.getByRole("button", {
        name: /toggle my section section/i,
      });
      expect(button).toBeInTheDocument();
    });

    it("renders icon when provided", () => {
      render(
        <CollapsibleSection
          title="Spec"
          icon={<span data-testid="custom-icon">icon</span>}
        >
          <p>Content</p>
        </CollapsibleSection>
      );

      expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
    });

    it("renders badge when provided", () => {
      render(
        <CollapsibleSection
          title="Code"
          badge={<span data-testid="badge">5</span>}
        >
          <p>Content</p>
        </CollapsibleSection>
      );

      expect(screen.getByTestId("badge")).toBeInTheDocument();
    });

    it("applies data-testid when provided", () => {
      render(
        <CollapsibleSection title="Test" testId="my-section">
          <p>Content</p>
        </CollapsibleSection>
      );

      expect(screen.getByTestId("my-section")).toBeInTheDocument();
    });
  });

  describe("collapse behavior", () => {
    it("content is hidden by default when defaultOpen is false", () => {
      render(
        <CollapsibleSection title="Collapsed" defaultOpen={false}>
          <p>Hidden content</p>
        </CollapsibleSection>
      );

      expect(screen.queryByText("Hidden content")).not.toBeInTheDocument();
    });

    it("content is visible when defaultOpen is true", () => {
      render(
        <CollapsibleSection title="Open" defaultOpen={true}>
          <p>Visible content</p>
        </CollapsibleSection>
      );

      expect(screen.getByText("Visible content")).toBeInTheDocument();
    });

    it("clicking toggle reveals hidden content", () => {
      render(
        <CollapsibleSection title="Toggle Me" defaultOpen={false}>
          <p>Revealed content</p>
        </CollapsibleSection>
      );

      expect(screen.queryByText("Revealed content")).not.toBeInTheDocument();

      const button = screen.getByRole("button", {
        name: /toggle toggle me section/i,
      });
      fireEvent.click(button);

      expect(screen.getByText("Revealed content")).toBeInTheDocument();
    });

    it("clicking toggle hides visible content", () => {
      render(
        <CollapsibleSection title="Toggle Me" defaultOpen={true}>
          <p>Content to hide</p>
        </CollapsibleSection>
      );

      expect(screen.getByText("Content to hide")).toBeInTheDocument();

      const button = screen.getByRole("button", {
        name: /toggle toggle me section/i,
      });
      fireEvent.click(button);

      expect(screen.queryByText("Content to hide")).not.toBeInTheDocument();
    });

    it("aria-expanded reflects the open state", () => {
      render(
        <CollapsibleSection title="Aria Test" defaultOpen={false}>
          <p>Content</p>
        </CollapsibleSection>
      );

      const button = screen.getByRole("button", {
        name: /toggle aria test section/i,
      });
      expect(button).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
    });
  });
});
