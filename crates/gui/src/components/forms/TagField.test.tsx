import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render, userEvent } from "../../test/test-utils";
import { TagField } from "./TagField";

describe("TagField", () => {
  describe("rendering", () => {
    it("renders label text", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} />);
      expect(screen.getByText("Tags")).toBeInTheDocument();
    });

    it("renders empty text when no tags are present", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} emptyText="No tags yet" />);
      expect(screen.getByText("No tags yet")).toBeInTheDocument();
    });

    it("does not render empty text when tags are present", () => {
      render(<TagField label="Tags" value={["tag1"]} onChange={vi.fn()} emptyText="No tags yet" />);
      expect(screen.queryByText("No tags yet")).not.toBeInTheDocument();
    });

    it("renders existing tags as chips with remove buttons", () => {
      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={vi.fn()} />);

      expect(screen.getByText("tag1")).toBeInTheDocument();
      expect(screen.getByText("tag2")).toBeInTheDocument();

      // Check for remove buttons
      const removeButtons = screen.getAllByRole("button", { name: /remove tag/i });
      expect(removeButtons).toHaveLength(2);
    });

    it("shows tag count when showCount is true", () => {
      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={vi.fn()} showCount={true} />);
      expect(screen.getByText("2 tags")).toBeInTheDocument();
    });

    it("does not show tag count when showCount is false", () => {
      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={vi.fn()} showCount={false} />);
      expect(screen.queryByText(/\d+ tags?/i)).not.toBeInTheDocument();
    });

    it("shows max tags in count when maxTags is set", () => {
      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={vi.fn()} maxTags={5} showCount={true} />);
      expect(screen.getByText("2/5 tags")).toBeInTheDocument();
    });

    it("associates label with input via generated id", () => {
      render(<TagField label="Title" value={[]} onChange={vi.fn()} />);
      const label = screen.getByText("Title");
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      expect(label).toHaveAttribute("for");
      expect(input).toHaveAttribute("id");
      expect(label.getAttribute("for")).toBe(input.getAttribute("id"));
    });

    it("associates label with input via custom id", () => {
      render(<TagField label="Title" value={[]} onChange={vi.fn()} id="custom-id" />);
      const label = screen.getByText("Title");
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      expect(label).toHaveAttribute("for", "custom-id");
      expect(input).toHaveAttribute("id", "custom-id");
    });
  });

  describe("tag management", () => {
    it("adds new tag on Enter key press", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "newtag{Enter}");

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(["newtag"]);
    });

    it("calls onRemove when tag remove button clicked", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={handleChange} />);

      // Click remove button for first tag
      const removeButtons = screen.getAllByRole("button", { name: /remove tag/i });
      fireEvent.click(removeButtons[0]);

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(["tag2"]);
    });

    it("removes specific tag when remove button clicked", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={["tag1", "tag2", "tag3"]} onChange={handleChange} />);

      // Click remove button for middle tag
      const removeButtons = screen.getAllByRole("button", { name: /remove tag/i });
      fireEvent.click(removeButtons[1]);

      expect(handleChange).toHaveBeenCalledWith(["tag1", "tag3"]);
    });

    it("trims whitespace from tags before adding", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "  new tag  {Enter}");

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(["new tag"]);
    });
  });

  describe("validation", () => {
    it("prevents duplicate tags from being added", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={["existing"]} onChange={handleChange} allowDuplicates={false} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "existing{Enter}");

      expect(handleChange).not.toHaveBeenCalled();

      // Check for error message
      expect(screen.getByText("Tag already exists")).toBeInTheDocument();
    });

    it("allows duplicate tags when allowDuplicates is true", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={["existing"]} onChange={handleChange} allowDuplicates={true} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "existing{Enter}");

      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(handleChange).toHaveBeenCalledWith(["existing", "existing"]);
    });

    it("prevents adding tags beyond maxTags limit", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={handleChange} maxTags={2} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "tag3{Enter}");

      expect(handleChange).not.toHaveBeenCalled();

      // Check for error message
      expect(screen.getByText("Maximum 2 tags allowed")).toBeInTheDocument();
    });

    it("prevents adding empty tags", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "   {Enter}");

      expect(handleChange).not.toHaveBeenCalled();

      // Check for error message
      expect(screen.getByText("Please enter a tag")).toBeInTheDocument();
    });

    it("prevents adding tags under minTagLength", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} minTagLength={3} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "ab{Enter}");

      expect(handleChange).not.toHaveBeenCalled();

      // Check for error message
      expect(screen.getByText("Tag must be at least 3 characters")).toBeInTheDocument();
    });

    it("prevents adding tags over maxTagLength", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} maxTagLength={5} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "toolong{Enter}");

      expect(handleChange).not.toHaveBeenCalled();

      // Check for error message
      expect(screen.getByText("Tag must be at most 5 characters")).toBeInTheDocument();
    });

    it("shows error message when required field has no tags", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={[]} onChange={handleChange} required allowDuplicates={true} />);

      expect(screen.getByText("At least one tag is required")).toBeInTheDocument();
    });

    it("does not show required error when field has tags", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={["tag1"]} onChange={handleChange} required />);

      expect(screen.queryByText("At least one tag is required")).not.toBeInTheDocument();
    });

    it("shows required error when field has less than minTags", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={[]} onChange={handleChange} minTags={2} required allowDuplicates={true} />);

      expect(screen.getByText("At least one tag is required")).toBeInTheDocument();
    });

    it("does not show required error when field meets minTags", () => {
      const handleChange = vi.fn();

      render(<TagField label="Tags" value={["tag1", "tag2"]} onChange={handleChange} minTags={2} required />);

      expect(screen.queryByText("At least one tag is required")).not.toBeInTheDocument();
    });
  });

  describe("input behavior", () => {
    it("clears input after adding tag", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "test{Enter}");

      expect(input).toHaveValue("");
    });

    it("shows placeholder text when input is empty", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} placeholder="Custom placeholder" />);

      const input = screen.getByPlaceholderText("Custom placeholder");
      expect(input).toBeInTheDocument();
    });

    it("does not add tag on other keys pressed", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      await user.type(input, "test{Space}");

      expect(handleChange).not.toHaveBeenCalled();
    });

    it("clears error when user starts typing", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<TagField label="Tags" value={[]} onChange={handleChange} minTagLength={3} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");

      // First try to add invalid tag
      await user.type(input, "ab{Enter}");
      expect(screen.getByText("Tag must be at least 3 characters")).toBeInTheDocument();

      // Then start typing valid tag
      await user.type(input, "abc");

      expect(screen.queryByText("Tag must be at least 3 characters")).not.toBeInTheDocument();
    });
  });

  describe("help text", () => {
    it("shows default help text when no help text provided", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} allowDuplicates={true} />);
      expect(screen.getByText("Add tags and press Enter")).toBeInTheDocument();
    });

    it("shows custom help text when provided", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} helpText="Enter relevant keywords" />);
      expect(screen.getByText(/Enter relevant keywords/i)).toBeInTheDocument();
      // Check that "Add a tag and press Enter" appears in the placeholder
      expect(screen.getByPlaceholderText(/Add a tag and press Enter/i)).toBeInTheDocument();
    });

    it("shows help text with constraints", () => {
      render(
        <TagField
          label="Tags"
          value={[]}
          onChange={vi.fn()}
          minTagLength={2}
          maxTagLength={10}
          maxTags={5}
          allowDuplicates={false}
          minTags={1}
        />
      );
      const helpText = screen.getByText(/min 2 chars, max 10 chars, max 5 tags, no duplicates, min 1 required/i);
      expect(helpText).toBeInTheDocument();
    });

    it("shows correct help text with minTagLength only", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} minTagLength={3} allowDuplicates={true} />);
      expect(screen.getByText("min 3 chars • Add tags and press Enter")).toBeInTheDocument();
    });
  });

  describe("error states", () => {
    it("displays error message when error prop is set", () => {
      render(
        <TagField
          label="Title"
          value={[]}
          onChange={vi.fn()}
          error="Custom error message"
        />
      );
      expect(screen.getByText("Custom error message")).toBeInTheDocument();
    });

    it("sets aria-invalid when error is present", () => {
      render(
        <TagField
          label="Title"
          value={[]}
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("does not set aria-invalid when no error", () => {
      render(<TagField label="Title" value={[]} onChange={vi.fn()} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).not.toHaveAttribute("aria-invalid");
    });

    it("applies error styling when error prop is set", () => {
      render(
        <TagField
          label="Title"
          value={[]}
          onChange={vi.fn()}
          error="Error message"
        />
      );
      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).toHaveClass("border-err");
    });

    it("highlights duplicate tags in error color", () => {
      const { rerender } = render(<TagField label="Tags" value={[]} onChange={vi.fn()} allowDuplicates={false} />);

      // Add a tag
      rerender(<TagField label="Tags" value={["existing"]} onChange={vi.fn()} allowDuplicates={false} />);

      // Try to add duplicate
      rerender(<TagField label="Tags" value={["existing"]} onChange={vi.fn()} allowDuplicates={false} />);

      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      fireEvent.change(input, { target: { value: "existing" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByText("Tag already exists")).toBeInTheDocument();
    });
  });

  describe("disabled state", () => {
    it("disables input when required field has no tags", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} required />);

      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).toBeDisabled();
    });

    it("does not disable input when required field has tags", () => {
      render(<TagField label="Tags" value={["tag1"]} onChange={vi.fn()} required />);

      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).not.toBeDisabled();
    });

    it("does not disable input when field is not required", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} required={false} />);

      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).not.toBeDisabled();
    });

    it("disables input when minTags not met", () => {
      render(<TagField label="Tags" value={[]} onChange={vi.fn()} minTags={2} required />);

      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).toBeDisabled();
    });
  });

  describe("styling classes", () => {
    it("applies custom className to wrapper", () => {
      const { container } = render(
        <TagField
          label="Tags"
          value={[]}
          onChange={vi.fn()}
          className="custom-class"
        />
      );
      const wrapper = container.firstChild;
      expect(wrapper).toHaveClass("custom-class");
    });

    it("applies custom tagClassName to tags", () => {
      render(
        <TagField
          label="Tags"
          value={["tag1"]}
          onChange={vi.fn()}
          tagClassName="custom-tag-class"
        />
      );

      const tag = screen.getByText("tag1").parentElement;
      expect(tag).toHaveClass("custom-tag-class");
    });

    it("applies base input classes", () => {
      render(<TagField label="Title" value={[]} onChange={vi.fn()} />);
      const input = screen.getByPlaceholderText("Add a tag and press Enter");
      expect(input).toHaveClass("input");
      expect(input).toHaveClass("w-full");
    });
  });

  describe("HTML attributes pass-through", () => {
    it("forwards data attributes", () => {
      render(
        <TagField
          label="Title"
          value={[]}
          onChange={vi.fn()}
          data-testid="tag-field"
        />
      );
      const wrapper = screen.getByTestId("tag-field");
      expect(wrapper).toBeInTheDocument();
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
          <TagField
            ref={ref}
            label="Title"
            value={[]}
            onChange={vi.fn()}
          />
        );
      };
      render(<TestComponent />);

      expect(refElement).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe("displayName", () => {
    it("has displayName set for debugging", () => {
      expect(TagField.displayName).toBe("TagField");
    });
  });
});