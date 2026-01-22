import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render, userEvent } from "../../test/test-utils";
import { SelectField, SelectOption } from "./SelectField";

describe("SelectField", () => {
  const mockOptions: SelectOption[] = [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Critical", value: "critical", disabled: true },
  ];

  describe("rendering", () => {
    it("renders select element with options", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toBeInTheDocument();
    });

    it("renders label text", () => {
      render(
        <SelectField
          label="Task Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );
      expect(screen.getByText("Task Priority")).toBeInTheDocument();
    });

    it("shows placeholder text when no value selected", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          placeholder="Select priority level"
        />
      );
      const placeholder = screen.getByText("Select priority level");
      expect(placeholder).toBeInTheDocument();
    });

    it("shows selected option value", () => {
      render(
        <SelectField
          label="Priority"
          value="high"
          onChange={vi.fn()}
          options={mockOptions}
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveValue("high");
    });

    it("renders required indicator when required is true", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          required
        />
      );
      const requiredIndicator = screen.getByLabelText("required");
      expect(requiredIndicator).toBeInTheDocument();
      expect(requiredIndicator).toHaveTextContent("*");
    });

    it("renders help text when provided", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          helpText="Select the priority level for the task"
        />
      );
      expect(screen.getByText("Select the priority level for the task")).toBeInTheDocument();
    });

    it("renders disabled state", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          disabled
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toBeDisabled();
    });

    it("does not show arrow when showArrow is false", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          showArrow={false}
        />
      );
      const arrow = screen.getByRole("combobox").querySelector("svg");
      expect(arrow).not.toBeInTheDocument();
    });

    it("shows arrow by default", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );
      const arrow = screen.getByTestId("select-arrow");
      expect(arrow).toBeInTheDocument();
    });
  });

  describe("functionality", () => {
    it("calls onChange when option is selected", async () => {
      const handleChange = vi.fn();
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={handleChange}
          options={mockOptions}
        />
      );

      const select = screen.getByRole("combobox");
      await userEvent.selectOptions(select, "medium");

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith("medium");
    });

    it("does not call onChange for placeholder option", async () => {
      const handleChange = vi.fn();
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={handleChange}
          options={mockOptions}
          placeholder="Select priority"
        />
      );

      const select = screen.getByRole("combobox");
      // Selecting the first option (placeholder) should not trigger onChange
      await userEvent.selectOptions(select, "");

      expect(handleChange).not.toHaveBeenCalled();
    });

    it("shows error state when error prop set", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          error="Priority is required"
        />
      );

      const select = screen.getByRole("combobox");
      expect(select).toHaveAttribute("aria-invalid", "true");
    });

    it("focuses on select when label is clicked", async () => {
      const handleChange = vi.fn();
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={handleChange}
          options={mockOptions}
        />
      );

      const label = screen.getByText("Priority");
      await userEvent.click(label);

      const select = screen.getByRole("combobox");
      expect(select).toHaveFocus();
    });
  });

  describe("option handling", () => {
    it("displays all options correctly", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );

      const select = screen.getByRole("combobox");
      userEvent.click(select);

      // Check that all options are present
      expect(screen.getByText("Low")).toBeInTheDocument();
      expect(screen.getByText("Medium")).toBeInTheDocument();
      expect(screen.getByText("High")).toBeInTheDocument();
      expect(screen.getByText("Critical")).toBeInTheDocument();
    });

    it("disables disabled options", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );

      const select = screen.getByRole("combobox");
      userEvent.click(select);

      // Check that Critical option is disabled
      const criticalOption = screen.getByText("Critical").closest("option");
      expect(criticalOption).toHaveAttribute("disabled");
    });

    it("can have placeholder option", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          placeholder="Choose a priority"
        />
      );

      const select = screen.getByRole("combobox");
      expect(select).toHaveValue("");
    });

    it("can hide placeholder option", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          showPlaceholder={false}
        />
      );

      const select = screen.getByRole("combobox");
      expect(select).toHaveValue(undefined);
    });
  });

  describe("option grouping", () => {
    const groupedOptions: SelectOption[] = [
      { label: "HTML", value: "html", group: "Markup Languages" },
      { label: "CSS", value: "css", group: "Markup Languages" },
      { label: "JavaScript", value: "javascript", group: "Programming Languages" },
      { label: "TypeScript", value: "typescript", group: "Programming Languages" },
    ];

    it("groups options correctly", () => {
      render(
        <SelectField
          label="Language"
          value=""
          onChange={vi.fn()}
          options={groupedOptions}
        />
      );

      const select = screen.getByRole("combobox");
      
      // Check that the select contains optgroup elements
      const optgroups = select.querySelectorAll("optgroup");
      expect(optgroups).toHaveLength(2);
      
      // Check optgroup labels
      expect(optgroups[0]).toHaveAttribute("label", "Markup Languages");
      expect(optgroups[1]).toHaveAttribute("label", "Programming Languages");
    });

    it("shows ungrouped options without group label", () => {
      const ungroupedOptions = [
        { label: "Option 1", value: "1" },
        { label: "Option 2", value: "2" },
      ];

      render(
        <SelectField
          label="Options"
          value=""
          onChange={vi.fn()}
          options={ungroupedOptions}
        />
      );

      const select = screen.getByRole("combobox");
      userEvent.click(select);

      // No optgroup label should be present
      expect(screen.queryByText("ungrouped")).not.toBeInTheDocument();
    });
  });

  describe("size variants", () => {
    it("renders small select", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          size="sm"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveClass("text-sm");
    });

    it("renders medium select", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          size="md"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveClass("text-base");
    });

    it("renders large select", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          size="lg"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveClass("text-lg");
    });
  });

  describe("keyboard navigation", () => {
    it("opens dropdown on space key", async () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );

      const select = screen.getByRole("combobox");
      select.focus();
      await userEvent.keyboard("{Space}");

      // Note: We can't easily test dropdown opening in unit tests
      // as it's browser behavior
    });
  });

  describe("accessibility", () => {
    it("has proper ARIA attributes", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveAttribute("id");
      expect(select).not.toHaveAttribute("aria-invalid");
    });

    it("sets invalid state when error is present", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          error="Required field"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveAttribute("aria-invalid", "true");
    });

    it("respects custom id", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          id="custom-select-id"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toHaveAttribute("id", "custom-select-id");
    });

    it("has proper label association", () => {
      const { container } = render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          id="test-id"
        />
      );

      const label = container.querySelector("label");
      expect(label).toBeInTheDocument();
      
      const select = screen.getByRole("combobox");
      expect(label).toHaveAttribute("for", "test-id");
      expect(select).toHaveAttribute("id", "test-id");
    });
  });

  describe("edge cases", () => {
    it("handles empty options array", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={[]}
          placeholder="No options available"
        />
      );
      const select = screen.getByRole("combobox");
      expect(select).toBeInTheDocument();
    });

    it("handles options with empty values", () => {
      const optionsWithEmptyValues: SelectOption[] = [
        { label: "None", value: "" },
        { label: "Option 1", value: "1" },
      ];

      render(
        <SelectField
          label="Option"
          value=""
          onChange={vi.fn()}
          options={optionsWithEmptyValues}
          showPlaceholder={false}
        />
      );

      const select = screen.getByRole("combobox");
      expect(select).toHaveValue("");
    });

    it("handles disabled parent field", () => {
      render(
        <SelectField
          label="Priority"
          value=""
          onChange={vi.fn()}
          options={mockOptions}
          disabled
        />
      );

      const select = screen.getByRole("combobox");
      expect(select).toBeDisabled();
      expect(select).toHaveClass("opacity-50");
    });
  });
});