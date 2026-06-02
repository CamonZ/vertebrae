import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { FormField } from "./FormField";

describe("FormField", () => {
  describe("rendering", () => {
    it("renders label text", () => {
      render(
        <FormField label="Task Title">
          <input type="text" />
        </FormField>
      );
      expect(screen.getByText("Task Title")).toBeInTheDocument();
    });

    it("renders children input component", () => {
      render(
        <FormField label="Title">
          <input data-testid="test-input" type="text" />
        </FormField>
      );
      expect(screen.getByTestId("test-input")).toBeInTheDocument();
    });

    it("renders required indicator when required is true", () => {
      render(
        <FormField label="Title" required>
          <input type="text" />
        </FormField>
      );
      const requiredIndicator = screen.getByLabelText("required");
      expect(requiredIndicator).toBeInTheDocument();
      expect(requiredIndicator).toHaveTextContent("*");
    });

    it("does not render required indicator when required is false", () => {
      render(
        <FormField label="Title" required={false}>
          <input type="text" />
        </FormField>
      );
      expect(screen.queryByLabelText("required")).not.toBeInTheDocument();
    });

    it("renders help text when provided", () => {
      render(
        <FormField label="Title" helpText="Enter a descriptive title">
          <input type="text" />
        </FormField>
      );
      expect(screen.getByText("Enter a descriptive title")).toBeInTheDocument();
    });

    it("does not render help text when not provided", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      // Label should exist but help text should not
      expect(screen.getByText("Title")).toBeInTheDocument();
      // Check that no small elements exist beyond possible label context
      const smallElements = screen.queryAllByRole("note"); // small has implicit role="note"
      expect(smallElements).toHaveLength(0);
    });

    it("renders error message when provided", () => {
      render(
        <FormField label="Title" error="This field is required">
          <input type="text" />
        </FormField>
      );
      expect(screen.getByText("This field is required")).toBeInTheDocument();
    });

    it("does not render error message when not provided", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("label association", () => {
    it("associates label with input via htmlFor when inputId is provided", () => {
      render(
        <FormField label="Title" inputId="title-input">
          <input id="title-input" type="text" />
        </FormField>
      );
      const label = screen.getByText("Title");
      const input = screen.getByRole("textbox");

      expect(label).toHaveAttribute("for", "title-input");
      expect(input).toHaveAttribute("id", "title-input");
    });

    it("does not set htmlFor on label when inputId is not provided", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const label = screen.getByText("Title");
      expect(label).not.toHaveAttribute("for");
    });
  });

  describe("accessibility", () => {
    it("sets role='alert' on error message for screen readers", () => {
      render(
        <FormField label="Title" error="Invalid input">
          <input type="text" />
        </FormField>
      );
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent("Invalid input");
    });

    it("includes error icon in error message", () => {
      render(
        <FormField label="Title" error="Error text">
          <input type="text" />
        </FormField>
      );
      const alert = screen.getByRole("alert");
      const icon = alert.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    it("marks error icon as aria-hidden", () => {
      render(
        <FormField label="Title" error="Error text">
          <input type="text" />
        </FormField>
      );
      const icon = screen.getByRole("alert").querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  });

  describe("styling classes", () => {
    it("applies custom className to wrapper div", () => {
      const { container } = render(
        <FormField label="Title" className="custom-class">
          <input type="text" />
        </FormField>
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass("custom-class");
    });

    it("includes default gap class for spacing", () => {
      const { container } = render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass("gap-1.5");
    });

    it("includes flex and flex-col classes for layout", () => {
      const { container } = render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass("flex");
      expect(wrapper).toHaveClass("flex-col");
    });
  });

  describe("label styling", () => {
    it("applies text-fg-soft color to label", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const label = screen.getByText("Title");
      expect(label).toHaveClass("text-fg-soft");
    });

    it("applies font-medium to label", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const label = screen.getByText("Title");
      expect(label).toHaveClass("font-medium");
    });

    it("applies text-xs size to label", () => {
      render(
        <FormField label="Title">
          <input type="text" />
        </FormField>
      );
      const label = screen.getByText("Title");
      expect(label).toHaveClass("text-xs");
    });

    it("applies text-err color to required asterisk", () => {
      render(
        <FormField label="Title" required>
          <input type="text" />
        </FormField>
      );
      const asterisk = screen.getByLabelText("required");
      expect(asterisk).toHaveClass("text-err");
    });
  });

  describe("help text styling", () => {
    it("applies text-fg-mute color to help text", () => {
      render(
        <FormField label="Title" helpText="Help text">
          <input type="text" />
        </FormField>
      );
      const helpText = screen.getByText("Help text");
      expect(helpText).toHaveClass("text-fg-mute");
    });

    it("renders help text as small muted serif italic (field-hint role)", () => {
      render(
        <FormField label="Title" helpText="Help text">
          <input type="text" />
        </FormField>
      );
      const helpText = screen.getByText("Help text");
      expect(helpText).toHaveClass("font-serif", "italic", "text-[13px]");
    });
  });

  describe("error styling", () => {
    it("applies text-err color to error message", () => {
      render(
        <FormField label="Title" error="Error message">
          <input type="text" />
        </FormField>
      );
      const errorContainer = screen.getByRole("alert");
      expect(errorContainer).toHaveClass("text-err");
    });

    it("applies the 2xs token size to error message", () => {
      render(
        <FormField label="Title" error="Error message">
          <input type="text" />
        </FormField>
      );
      const errorContainer = screen.getByRole("alert");
      expect(errorContainer).toHaveClass("text-2xs");
    });

    it("applies flex and items-center to error container", () => {
      render(
        <FormField label="Title" error="Error message">
          <input type="text" />
        </FormField>
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("flex");
      expect(alert).toHaveClass("items-center");
    });
  });

  describe("props forwarding", () => {
    it("forwards HTML attributes to wrapper div", () => {
      const { container } = render(
        <FormField label="Title" data-testid="form-field" aria-describedby="help">
          <input type="text" />
        </FormField>
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveAttribute("data-testid", "form-field");
      expect(wrapper).toHaveAttribute("aria-describedby", "help");
    });
  });

  describe("complex children", () => {
    it("renders select element as child", () => {
      render(
        <FormField label="Status" inputId="status">
          <select id="status">
            <option value="todo">Todo</option>
            <option value="done">Done</option>
          </select>
        </FormField>
      );
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("renders textarea element as child", () => {
      render(
        <FormField label="Description" inputId="description">
          <textarea id="description" />
        </FormField>
      );
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("renders custom component as child", () => {
      const CustomInput = () => (
        <div data-testid="custom-input">Custom Input</div>
      );
      render(
        <FormField label="Custom">
          <CustomInput />
        </FormField>
      );
      expect(screen.getByTestId("custom-input")).toBeInTheDocument();
    });

    it("renders multiple children", () => {
      render(
        <FormField label="Tags">
          <input type="text" data-testid="input" />
          <button type="button" data-testid="button">
            Add
          </button>
        </FormField>
      );
      expect(screen.getByTestId("input")).toBeInTheDocument();
      expect(screen.getByTestId("button")).toBeInTheDocument();
    });
  });

  describe("ref forwarding", () => {
    it("forwards ref to wrapper div", () => {
      let refElement: HTMLDivElement | null = null;
      const TestComponent = () => {
        const ref = (el: HTMLDivElement | null) => {
          refElement = el;
        };
        return (
          <FormField label="Title" ref={ref}>
            <input type="text" />
          </FormField>
        );
      };
      render(<TestComponent />);
      expect(refElement).toBeInstanceOf(HTMLDivElement);
    });
  });
});
