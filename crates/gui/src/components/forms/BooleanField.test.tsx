import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render, userEvent } from "../../test/test-utils";
import { BooleanField } from "./BooleanField";

describe("BooleanField", () => {
  describe("rendering - switch variant", () => {
    it("renders toggle switch with value from prop", () => {
      render(
        <BooleanField
          label="Enable notifications"
          value={true}
          onChange={vi.fn()}
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    it("renders label text", () => {
      render(
        <BooleanField
          label="Enable notifications"
          value={false}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText("Enable notifications")).toBeInTheDocument();
    });

    it("shows on/off text correctly", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
          onText="Enabled"
          offText="Disabled"
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveTextContent("Enabled");
    });

    it("shows default on/off text", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveTextContent("Off");
    });

    it("renders required indicator when required is true", () => {
      render(
        <BooleanField
          label="Required"
          value={false}
          onChange={vi.fn()}
          required
        />
      );
      const requiredIndicator = screen.getByLabelText("required");
      expect(requiredIndicator).toBeInTheDocument();
      expect(requiredIndicator).toHaveTextContent("*");
    });

    it("renders help text when provided", () => {
      render(
        <BooleanField
          label="Notifications"
          value={false}
          onChange={vi.fn()}
          helpText="Receive email notifications"
        />
      );
      expect(screen.getByText("Receive email notifications")).toBeInTheDocument();
    });

    it("renders disabled state with proper styling", () => {
      render(
        <BooleanField
          label="Disabled"
          value={true}
          onChange={vi.fn()}
          disabled
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveClass("opacity-50");
    });
  });

  describe("functionality - switch variant", () => {
    it("toggles value when clicked", async () => {
      const handleChange = vi.fn();
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={handleChange}
        />
      );

      const toggle = screen.getByRole("switch");
      await userEvent.click(toggle);

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(true);
    });

    it("does not toggle when disabled", async () => {
      const handleChange = vi.fn();
      render(
        <BooleanField
          label="Disabled"
          value={true}
          onChange={handleChange}
          disabled
        />
      );

      const toggle = screen.getByRole("switch");
      await userEvent.click(toggle);

      expect(handleChange).not.toHaveBeenCalled();
    });

    it("shows error state when error prop set", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
          error="This setting is required"
        />
      );

      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveAttribute("aria-invalid", "true");
    });

    it("focuses on toggle when label is clicked", async () => {
      const handleChange = vi.fn();
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={handleChange}
        />
      );

      const label = screen.getByText("Feature");
      await userEvent.click(label);

      expect(handleChange).toHaveBeenCalledWith(true);
    });
  });

  describe("size variants - switch", () => {
    it("renders small toggle", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
          size="sm"
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveClass("h-6 w-11");
    });

    it("renders medium toggle", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
          size="md"
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveClass("h-8 w-14");
    });

    it("renders large toggle", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
          size="lg"
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveClass("h-10 w-20");
    });
  });

  describe("checkbox variant", () => {
    it("renders checkbox with value from prop", () => {
      render(
        <BooleanField
          label="Enable notifications"
          value={true}
          onChange={vi.fn()}
          variant="checkbox"
        />
      );
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    });

    it("shows checkmark when checked", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
          variant="checkbox"
        />
      );
      const checkbox = screen.getByRole("checkbox");
      const checkmark = checkbox.querySelector("svg");
      expect(checkmark).toBeInTheDocument();
    });

    it("shows on/off text in checkbox", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
          variant="checkbox"
          onText="Yes"
          offText="No"
        />
      );
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveTextContent("No");
    });

    it("toggles value when checkbox is clicked", async () => {
      const handleChange = vi.fn();
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={handleChange}
          variant="checkbox"
        />
      );

      const checkbox = screen.getByRole("checkbox");
      await userEvent.click(checkbox);

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(true);
    });

    it("shows disabled state for checkbox", () => {
      render(
        <BooleanField
          label="Disabled"
          value={true}
          onChange={vi.fn()}
          variant="checkbox"
          disabled
        />
      );
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toBeDisabled();
    });

    it("shows error state for checkbox", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
          variant="checkbox"
          error="This setting is required"
        />
      );

      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveAttribute("aria-invalid", "true");
    });
  });

  describe("accessibility", () => {
    it("has proper ARIA attributes for toggle", () => {
      render(
        <BooleanField
          label="Feature"
          value={true}
          onChange={vi.fn()}
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(toggle).toHaveAttribute("id");
    });

    it("has proper ARIA attributes for checkbox", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
          variant="checkbox"
        />
      );
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveAttribute("aria-checked", "false");
      expect(checkbox).toHaveAttribute("id");
    });

    it("respects id prop", () => {
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={vi.fn()}
          id="custom-id"
        />
      );
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveAttribute("id", "custom-id");
    });

    it("supports keyboard navigation", async () => {
      const handleChange = vi.fn();
      render(
        <BooleanField
          label="Feature"
          value={false}
          onChange={handleChange}
        />
      );

      const toggle = screen.getByRole("switch");
      await userEvent.click(toggle);
      await userEvent.keyboard("{Space}");

      expect(handleChange).toHaveBeenCalledWith(true);
    });
  });
});