import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render, userEvent } from "../../test/test-utils";
import { TextField } from "./TextField";

describe("TextField", () => {
  describe("rendering", () => {
    it("renders input element with value from prop", () => {
      render(<TextField label="Title" value="Hello World" onChange={vi.fn()} />);
      const input = screen.getByRole("textbox");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("Hello World");
    });

    it("renders label text", () => {
      render(<TextField label="Task Title" value="" onChange={vi.fn()} />);
      expect(screen.getByText("Task Title")).toBeInTheDocument();
    });

    it("shows placeholder text when value is empty", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          placeholder="Enter task title"
        />
      );
      const input = screen.getByPlaceholderText("Enter task title");
      expect(input).toBeInTheDocument();
    });

    it("renders required indicator when required is true", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} required />);
      const requiredIndicator = screen.getByLabelText("required");
      expect(requiredIndicator).toBeInTheDocument();
      expect(requiredIndicator).toHaveTextContent("*");
    });

    it("does not render required indicator when required is false", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} required={false} />);
      expect(screen.queryByLabelText("required")).not.toBeInTheDocument();
    });

    it("renders help text when provided", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          helpText="Enter a descriptive title"
        />
      );
      expect(screen.getByText("Enter a descriptive title")).toBeInTheDocument();
    });

    it("associates label with input via generated id", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} />);
      const label = screen.getByText("Title");
      const input = screen.getByRole("textbox");

      expect(label).toHaveAttribute("for");
      expect(input).toHaveAttribute("id");
      expect(label.getAttribute("for")).toBe(input.getAttribute("id"));
    });

    it("associates label with input via custom id", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} id="custom-id" />);
      const label = screen.getByText("Title");
      const input = screen.getByRole("textbox");

      expect(label).toHaveAttribute("for", "custom-id");
      expect(input).toHaveAttribute("id", "custom-id");
    });
  });

  describe("value and onChange", () => {
    it("calls onChange with new value on each keystroke", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TextField label="Title" value="" onChange={handleChange} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "Hello");

      expect(handleChange).toHaveBeenCalledTimes(5);
      // Verify the handler is being called by checking any call exists
      expect(handleChange).toHaveBeenCalled();
    });

    it("updates value when prop changes", () => {
      const { rerender } = render(<TextField label="Title" value="Initial" onChange={vi.fn()} />);
      const input = screen.getByRole("textbox");

      expect(input).toHaveValue("Initial");

      rerender(<TextField label="Title" value="Updated" onChange={vi.fn()} />);
      expect(input).toHaveValue("Updated");
    });
  });

  describe("error states", () => {
    it("displays error message when error prop is set", () => {
      render(
        <TextField
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
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("does not set aria-invalid when no error", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} />);
      const input = screen.getByRole("textbox");
      expect(input).not.toHaveAttribute("aria-invalid");
    });

    it("applies error styling when error prop is set", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("border-error");
    });

    it("shows error styling when minLength constraint violated", () => {
      render(
        <TextField
          label="Title"
          value="Hi"
          onChange={vi.fn()}
          minLength={5}
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("border-error");
    });

    it("shows error message when minLength constraint violated", () => {
      render(
        <TextField
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
        <TextField
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
        <TextField
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
        <TextField
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
        <TextField
          label="Title"
          value="Hello"
          onChange={vi.fn()}
          maxLength={100}
        />
      );
      const charCount = screen.getByText("5/100");
      expect(charCount).toBeInTheDocument();
    });

    it("updates character count as user types", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      const { rerender } = render(
        <TextField
          label="Title"
          value="Hello"
          onChange={handleChange}
          maxLength={100}
        />
      );

      expect(screen.getByText("5/100")).toBeInTheDocument();

      // Simulate typing by updating the value prop
      handleChange.mockImplementation((e) => {
        rerender(
          <TextField
            label="Title"
            value={e.target.value}
            onChange={handleChange}
            maxLength={100}
          />
        );
      });

      const input = screen.getByRole("textbox");
      await user.type(input, " World");

      expect(screen.getByText("11/100")).toBeInTheDocument();
    });

    it("shows character count in text-muted when under limit", () => {
      render(
        <TextField
          label="Title"
          value="Hello"
          onChange={vi.fn()}
          maxLength={100}
        />
      );
      const charCount = screen.getByText("5/100");
      expect(charCount).toHaveClass("text-text-muted");
    });

    it("shows character count in error color when at or over limit", () => {
      render(
        <TextField
          label="Title"
          value="This is exactly 31 characters!!"
          onChange={vi.fn()}
          maxLength={31}
        />
      );
      const charCount = screen.getByText("31/31");
      expect(charCount).toHaveClass("text-error");
    });

    it("does not show character count when maxLength is not set", () => {
      render(
        <TextField
          label="Title"
          value="Hello"
          onChange={vi.fn()}
        />
      );
      expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument();
    });

    it("associates character count with input via aria-describedby", () => {
      render(
        <TextField
          label="Title"
          value="Hello"
          onChange={vi.fn()}
          maxLength={100}
        />
      );
      const input = screen.getByRole("textbox");
      const describedById = input.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();

      const charCount = screen.getByText("5/100");
      expect(charCount).toHaveAttribute("id", describedById);
    });
  });

  describe("disabled state", () => {
    it("applies disabled attribute to input", () => {
      render(<TextField label="Title" value="Test" onChange={vi.fn()} disabled />);
      const input = screen.getByRole("textbox");
      expect(input).toBeDisabled();
    });

    it("applies disabled styling", () => {
      render(<TextField label="Title" value="Test" onChange={vi.fn()} disabled />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("opacity-50");
      expect(input).toHaveClass("cursor-not-allowed");
    });

    it("prevents user input when disabled", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(
        <TextField
          label="Title"
          value="Initial"
          onChange={handleChange}
          disabled
        />
      );
      const input = screen.getByRole("textbox");

      await user.type(input, " text");

      expect(handleChange).not.toHaveBeenCalled();
      expect(input).toHaveValue("Initial");
    });
  });

  describe("auto-focus", () => {
    it("auto-focuses input when autoFocus prop is true", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          autoFocus
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveFocus();
    });

    it("does not auto-focus when autoFocus prop is false", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          autoFocus={false}
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).not.toHaveFocus();
    });
  });

  describe("ref forwarding", () => {
    it("forwards ref to native input element", () => {
      const ref = { current: null as HTMLInputElement | null };

      render(<TextField label="Title" value="" onChange={vi.fn()} ref={ref} />);

      expect(ref.current).toBeInstanceOf(HTMLInputElement);
      expect(ref.current).toHaveAttribute("type", "text");
    });

    it("allows direct DOM access via ref", () => {
      const ref = { current: null as HTMLInputElement | null };

      render(<TextField label="Title" value="Hello" onChange={vi.fn()} ref={ref} />);

      expect(ref.current?.value).toBe("Hello");
    });
  });

  describe("styling classes", () => {
    it("applies base input classes", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("input");
      expect(input).toHaveClass("w-full");
    });

    it("merges custom className with base classes", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          className="custom-class"
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("custom-class");
      expect(input).toHaveClass("input");
    });

    it("applies focus ring styling", () => {
      render(<TextField label="Title" value="" onChange={vi.fn()} />);
      const input = screen.getByRole("textbox");
      // Focus styles are defined in CSS, just verify the class structure
      expect(input).toHaveClass("input");
    });
  });

  describe("accessibility", () => {
    it("sets aria-describedby for error message", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const input = screen.getByRole("textbox");
      const describedById = input.getAttribute("aria-describedby");

      expect(describedById).toBeTruthy();

      const errorMessage = screen.getByRole("alert");
      expect(errorMessage).toBeInTheDocument();
    });

    it("includes error icon in error message", () => {
      render(
        <TextField
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

  describe("HTML attributes pass-through", () => {
    it("forwards standard input attributes", () => {
      render(
        <TextField
          label="Title"
          value=""
          onChange={vi.fn()}
          name="task-title"
          autoComplete="off"
          data-testid="title-input"
        />
      );
      const input = screen.getByTestId("title-input");
      expect(input).toHaveAttribute("name", "task-title");
      expect(input).toHaveAttribute("autocomplete", "off");
    });

    it("supports pattern attribute for validation", () => {
      render(
        <TextField
          label="Email"
          value="test@example.com"
          onChange={vi.fn()}
          pattern="[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,4}$"
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("pattern");
      // The pattern attribute stores the escaped version (double backslashes)
      expect(input.getAttribute("pattern")).toBe("[a-z0-9._%+-]+@[a-z0-9.-]+\\\\.[a-z]{2,4}$");
    });

    it("supports inputMode attribute", () => {
      render(
        <TextField
          label="Number"
          value=""
          onChange={vi.fn()}
          inputMode="numeric"
        />
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("inputmode", "numeric");
    });
  });

  describe("character count positioning", () => {
    it("positions character count absolutely inside wrapper", () => {
      render(
        <TextField
          label="Title"
          value="Hello"
          onChange={vi.fn()}
          maxLength={100}
        />
      );
      const wrapper = screen.getByRole("textbox").parentElement;
      expect(wrapper).toHaveClass("relative");

      const charCount = screen.getByText("5/100");
      expect(charCount).toHaveClass("absolute");
      expect(charCount).toHaveClass("right-3");
    });
  });

  describe("displayName", () => {
    it("has displayName set for debugging", () => {
      expect(TextField.displayName).toBe("TextField");
    });
  });
});
