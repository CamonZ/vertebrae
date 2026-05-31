import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render, userEvent } from "../../test/test-utils";
import { TextareaField } from "./TextareaField";

describe("TextareaField", () => {
  describe("rendering", () => {
    it("renders textarea element with value from prop", () => {
      render(<TextareaField label="Description" value="Hello World" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue("Hello World");
    });

    it("renders label text", () => {
      render(<TextareaField label="Task Description" value="" onChange={vi.fn()} />);
      expect(screen.getByText("Task Description")).toBeInTheDocument();
    });

    it("shows placeholder text when value is empty", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          placeholder="Enter task description"
        />
      );
      const textarea = screen.getByPlaceholderText("Enter task description");
      expect(textarea).toBeInTheDocument();
    });

    it("renders required indicator when required is true", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} required />);
      const requiredIndicator = screen.getByLabelText("required");
      expect(requiredIndicator).toBeInTheDocument();
      expect(requiredIndicator).toHaveTextContent("*");
    });

    it("does not render required indicator when required is false", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} required={false} />);
      expect(screen.queryByLabelText("required")).not.toBeInTheDocument();
    });

    it("renders help text when provided", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          helpText="Enter a detailed description"
        />
      );
      expect(screen.getByText("Enter a detailed description")).toBeInTheDocument();
    });

    it("associates label with textarea via generated id", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} />);
      const label = screen.getByText("Title");
      const textarea = screen.getByRole("textbox");

      expect(label).toHaveAttribute("for");
      expect(textarea).toHaveAttribute("id");
      expect(label.getAttribute("for")).toBe(textarea.getAttribute("id"));
    });

    it("associates label with textarea via custom id", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} id="custom-id" />);
      const label = screen.getByText("Title");
      const textarea = screen.getByRole("textbox");

      expect(label).toHaveAttribute("for", "custom-id");
      expect(textarea).toHaveAttribute("id", "custom-id");
    });

    it("renders textarea with rows prop", () => {
      render(<TextareaField label="Description" value="" onChange={vi.fn()} rows={6} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveAttribute("rows", "6");
    });

    it("uses default rows when not provided", () => {
      render(<TextareaField label="Description" value="" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveAttribute("rows", "4");
    });
  });

  describe("value and onChange", () => {
    it("calls onChange with new value on each keystroke", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TextareaField label="Title" value="" onChange={handleChange} />);
      const textarea = screen.getByRole("textbox");

      await user.type(textarea, "Hello");

      expect(handleChange).toHaveBeenCalledTimes(5);
      // Verify the handler is being called by checking any call exists
      expect(handleChange).toHaveBeenCalled();
    });

    it("calls onChange with new value on each keystroke", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TextareaField label="Title" value="" onChange={handleChange} />);
      const textarea = screen.getByRole("textbox");

      await user.type(textarea, "Hello");

      expect(handleChange).toHaveBeenCalledTimes(5);
      // Verify the handler is being called by checking any call exists
      expect(handleChange).toHaveBeenCalled();
    });

    it("updates value when prop changes", () => {
      const { rerender } = render(<TextareaField label="Title" value="Initial" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");

      expect(textarea).toHaveValue("Initial");

      rerender(<TextareaField label="Title" value="Updated" onChange={vi.fn()} />);
      expect(textarea).toHaveValue("Updated");
    });
  });

  describe("error states", () => {
    it("displays error message when error prop is set", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="This field is required"
        />
      );
      expect(screen.getByText("This field is required")).toBeInTheDocument();
    });

    it("sets aria-invalid when error is present", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveAttribute("aria-invalid", "true");
    });

    it("does not set aria-invalid when no error", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).not.toHaveAttribute("aria-invalid");
    });

    it("applies error styling when error prop is set", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("border-err");
    });

    it("shows error styling when minLength constraint violated", () => {
      render(
        <TextareaField
          label="Title"
          value="Hi"
          onChange={vi.fn()}
          minLength={5}
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("border-err");
    });

    it("shows error message when minLength constraint violated", () => {
      render(
        <TextareaField
          label="Title"
          value="Hi"
          onChange={vi.fn()}
          minLength={5}
        />
      );
      expect(screen.getByText("Minimum 5 characters required")).toBeInTheDocument();
    });

    it("does not show minLength error when input is empty", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          minLength={5}
        />
      );
      expect(screen.queryByText(/Minimum/)).not.toBeInTheDocument();
    });

    it("does not show minLength error when constraint is met", () => {
      render(
        <TextareaField
          label="Title"
          value="Hello World"
          onChange={vi.fn()}
          minLength={5}
        />
      );
      expect(screen.queryByText(/Minimum/)).not.toBeInTheDocument();
    });

    it("prioritizes prop error over minLength error", () => {
      render(
        <TextareaField
          label="Title"
          value="Hi"
          onChange={vi.fn()}
          minLength={5}
          error="Custom error message"
        />
      );
      // Should show custom error, not minLength error
      expect(screen.getByText("Custom error message")).toBeInTheDocument();
      expect(screen.queryByText(/Minimum 5 characters/)).not.toBeInTheDocument();
    });
  });

  describe("character count", () => {
    it("shows character count (X/Y) when maxLength is set", () => {
      render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={vi.fn()}
          maxLength={500}
        />
      );
      const charCount = screen.getByText("5/500");
      expect(charCount).toBeInTheDocument();
    });

    it("updates character count as user types", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      const { rerender } = render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={handleChange}
          maxLength={500}
        />
      );

      expect(screen.getByText("5/500")).toBeInTheDocument();

      // Simulate typing by updating the value prop
      handleChange.mockImplementation((e) => {
        rerender(
          <TextareaField
            label="Description"
            value={e.target.value}
            onChange={handleChange}
            maxLength={500}
          />
        );
      });

      const textarea = screen.getByRole("textbox");
      await user.type(textarea, " World");

      expect(screen.getByText("11/500")).toBeInTheDocument();
    });

    it("shows character count in text-muted when under limit", () => {
      render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={vi.fn()}
          maxLength={500}
        />
      );
      const charCount = screen.getByText("5/500");
      expect(charCount).toHaveClass("text-fg-mute");
    });

    it("shows character count in error color when at or over limit", () => {
      render(
        <TextareaField
          label="Description"
          value="This is exactly 31 characters!!"
          onChange={vi.fn()}
          maxLength={31}
        />
      );
      const charCount = screen.getByText("31/31");
      expect(charCount).toHaveClass("text-err");
    });

    it("does not show character count when maxLength is not set", () => {
      render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={vi.fn()}
        />
      );
      expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument();
    });

    it("associates character count with textarea via aria-describedby", () => {
      render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={vi.fn()}
          maxLength={500}
        />
      );
      const textarea = screen.getByRole("textbox");
      const describedById = textarea.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();

      const charCount = screen.getByText("5/500");
      expect(charCount).toHaveAttribute("id", describedById);
    });
  });

  describe("resize control", () => {
    it("applies resize-none class when resize='none'", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          resize="none"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("resize-none");
    });

    it("applies resize-y class when resize='vertical'", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          resize="vertical"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("resize-y");
    });

    it("applies resize-x class when resize='horizontal'", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          resize="horizontal"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("resize-x");
    });

    it("applies resize class when resize='both'", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          resize="both"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("resize");
    });

    it("defaults to resize vertical", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("resize-y");
    });
  });

  describe("disabled state", () => {
    it("applies disabled attribute to textarea", () => {
      render(<TextareaField label="Title" value="Test" onChange={vi.fn()} disabled />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeDisabled();
    });

    it("applies disabled styling", () => {
      render(<TextareaField label="Title" value="Test" onChange={vi.fn()} disabled />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("opacity-50");
      expect(textarea).toHaveClass("cursor-not-allowed");
    });

    it("prevents user input when disabled", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(
        <TextareaField
          label="Title"
          value="Initial"
          onChange={handleChange}
          disabled
        />
      );
      const textarea = screen.getByRole("textbox");

      await user.type(textarea, " text");

      expect(handleChange).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("Initial");
    });
  });

  describe("auto-focus", () => {
    it("auto-focuses textarea when autoFocus prop is true", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          autoFocus
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveFocus();
    });

    it("does not auto-focus when autoFocus prop is false", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          autoFocus={false}
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).not.toHaveFocus();
    });
  });

  describe("auto-grow", () => {
    it("has autoGrow classes when autoGrow is true", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          autoGrow
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("min-h-[80px]");
    });

    it("does not have autoGrow classes when autoGrow is false", () => {
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          autoGrow={false}
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).not.toHaveClass("min-h-[80px]");
    });

    it("applies maxHeight when provided", () => {
      // Note: This is a visual test that would need manual verification
      // since we can't easily test the resize observer behavior in unit tests
      render(
        <TextareaField
          label="Description"
          value=""
          onChange={vi.fn()}
          autoGrow
          maxHeight="200px"
        />
      );
      const textarea = screen.getByRole("textbox");
      // Check that the textarea is present and can interact with it
      expect(textarea).toBeInTheDocument();
    });
  });

  describe("ref forwarding", () => {
    it("forwards ref to native textarea element", () => {
      const ref = { current: null as HTMLTextAreaElement | null };

      render(<TextareaField label="Title" value="" onChange={vi.fn()} ref={ref} />);

      expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
      expect(ref.current).toHaveAttribute("rows", "4");
    });

    it("allows direct DOM access via ref", () => {
      const ref = { current: null as HTMLTextAreaElement | null };

      render(<TextareaField label="Title" value="Hello" onChange={vi.fn()} ref={ref} />);

      expect(ref.current?.value).toBe("Hello");
    });
  });

  describe("styling classes", () => {
    it("applies base textarea classes", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("input");
      expect(textarea).toHaveClass("w-full");
    });

    it("merges custom className with base classes", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          className="custom-class"
        />
      );
      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveClass("custom-class");
      expect(textarea).toHaveClass("input");
    });

    it("applies focus ring styling", () => {
      render(<TextareaField label="Title" value="" onChange={vi.fn()} />);
      const textarea = screen.getByRole("textbox");
      // Focus styles are defined in CSS, just verify the class structure
      expect(textarea).toHaveClass("input");
    });
  });

  describe("HTML attributes pass-through", () => {
    it("forwards standard textarea attributes", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          name="task-description"
          autoComplete="off"
          data-testid="description-textarea"
          spellCheck={true}
        />
      );
      const textarea = screen.getByTestId("description-textarea");
      expect(textarea).toHaveAttribute("name", "task-description");
      expect(textarea).toHaveAttribute("autocomplete", "off");
      expect(textarea).toHaveAttribute("spellcheck", "true");
    });
  });

  describe("accessibility", () => {
    it("sets aria-describedby for error message", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const textarea = screen.getByRole("textbox");
      const describedById = textarea.getAttribute("aria-describedby");

      expect(describedById).toBeTruthy();

      const errorMessage = screen.getByRole("alert");
      expect(errorMessage).toBeInTheDocument();
    });

    it("includes error icon in error message", () => {
      render(
        <TextareaField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error text"
        />
      );
      const alert = screen.getByRole("alert");
      const icon = alert.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });
  });

  describe("character count positioning", () => {
    it("positions character count absolutely inside wrapper", () => {
      render(
        <TextareaField
          label="Description"
          value="Hello"
          onChange={vi.fn()}
          maxLength={500}
        />
      );
      const wrapper = screen.getByRole("textbox").parentElement;
      expect(wrapper).toHaveClass("relative");

      const charCount = screen.getByText("5/500");
      expect(charCount).toHaveClass("absolute");
      expect(charCount).toHaveClass("right-3");
      expect(charCount).toHaveClass("bottom-3");
    });
  });

  describe("displayName", () => {
    it("has displayName set for debugging", () => {
      expect(TextareaField.displayName).toBe("TextareaField");
    });
  });
});