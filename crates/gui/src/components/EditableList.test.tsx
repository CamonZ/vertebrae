import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableList } from "./EditableList";

describe("EditableList", () => {
  const defaultProps = {
    items: ["Item 1", "Item 2", "Item 3"],
    emptyText: "No items",
    placeholder: "Add item...",
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders all items", () => {
      render(<EditableList {...defaultProps} />);

      expect(screen.getByText("Item 1")).toBeInTheDocument();
      expect(screen.getByText("Item 2")).toBeInTheDocument();
      expect(screen.getByText("Item 3")).toBeInTheDocument();
    });

    it("renders empty text when no items", () => {
      render(<EditableList {...defaultProps} items={[]} />);

      expect(screen.getByText("No items")).toBeInTheDocument();
    });

    it("renders bullet points by default", () => {
      render(<EditableList {...defaultProps} />);

      // Bullet points are small circles
      const bullets = document.querySelectorAll(".rounded-full.bg-fg-mute");
      expect(bullets.length).toBe(3);
    });

    it("renders add input field", () => {
      render(<EditableList {...defaultProps} />);

      // The add field shows placeholder text in display mode (click to edit)
      expect(screen.getByText("Add item...")).toBeInTheDocument();
    });
  });

  describe("bullet variant", () => {
    it("shows bullet points for each item", () => {
      render(<EditableList {...defaultProps} variant="bullet" />);

      const bullets = document.querySelectorAll(".rounded-full.bg-fg-mute");
      expect(bullets.length).toBe(3);
    });
  });

  describe("step variant", () => {
    it("shows numbered checkboxes instead of bullets", () => {
      render(<EditableList {...defaultProps} variant="step" />);

      // Should show numbers 1, 2, 3
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("shows checkmark when item is done", () => {
      render(
        <EditableList
          {...defaultProps}
          variant="step"
          itemStates={[{ done: true }, { done: false }, { done: false }]}
        />
      );

      // First item should have checkmark (svg), others should have numbers
      const checkmarks = document.querySelectorAll("svg.h-3.w-3");
      expect(checkmarks.length).toBe(1);
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("applies done styling to completed items", () => {
      render(
        <EditableList
          {...defaultProps}
          variant="step"
          itemStates={[{ done: true }, { done: false }, { done: false }]}
        />
      );

      const item1 = screen.getByText("Item 1");
      expect(item1.className).toContain("line-through");
      expect(item1.className).toContain("opacity-60");
    });

    it("calls onToggleDone when checkbox is clicked", async () => {
      const onToggleDone = vi.fn();
      render(
        <EditableList
          {...defaultProps}
          variant="step"
          onToggleDone={onToggleDone}
        />
      );

      // Click on the first checkbox (shows "1")
      await userEvent.click(screen.getByText("1"));

      expect(onToggleDone).toHaveBeenCalledTimes(1);
      expect(onToggleDone).toHaveBeenCalledWith(0);
    });
  });

  describe("monospace prop", () => {
    it("applies monospace font when monospace is true", () => {
      render(<EditableList {...defaultProps} monospace />);

      const item1 = screen.getByText("Item 1");
      expect(item1.className).toContain("font-mono");
    });

    it("does not apply monospace font by default", () => {
      render(<EditableList {...defaultProps} />);

      const item1 = screen.getByText("Item 1");
      expect(item1.className).not.toContain("font-mono");
    });
  });

  describe("editing", () => {
    it("enters edit mode when item is clicked", async () => {
      render(<EditableList {...defaultProps} />);

      await userEvent.click(screen.getByText("Item 1"));

      // Should show input with current value
      expect(screen.getByRole("textbox")).toHaveValue("Item 1");
    });

    it("calls onEdit when edit is saved", async () => {
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(<EditableList {...defaultProps} onEdit={onEdit} />);

      // Click to edit first item
      await userEvent.click(screen.getByText("Item 1"));

      // Clear and type new value
      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, "Updated Item");

      // Save
      await userEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(onEdit).toHaveBeenCalledTimes(1);
        expect(onEdit).toHaveBeenCalledWith(0, "Updated Item");
      });
    });

    it("exits edit mode when cancel is clicked", async () => {
      render(<EditableList {...defaultProps} />);

      await userEvent.click(screen.getByText("Item 1"));
      expect(screen.getByRole("textbox")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      // Should be back to display mode
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByText("Item 1")).toBeInTheDocument();
    });
  });

  describe("deleting", () => {
    it("calls onDelete when delete button is clicked in edit mode", async () => {
      const onDelete = vi.fn();
      render(<EditableList {...defaultProps} onDelete={onDelete} />);

      // Click to edit first item
      await userEvent.click(screen.getByText("Item 1"));

      // Click delete button
      await userEvent.click(screen.getByRole("button", { name: /delete/i }));

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(0);
    });
  });

  describe("adding", () => {
    it("calls onAdd when new item is added via input", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(<EditableList {...defaultProps} onAdd={onAdd} />);

      // Click on add field to enter edit mode (shows placeholder as text initially)
      await userEvent.click(screen.getByText("Add item..."));

      // Now the input should be visible
      const input = screen.getByRole("textbox");
      await userEvent.type(input, "New Item");

      // Click save
      await userEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(onAdd).toHaveBeenCalledTimes(1);
        expect(onAdd).toHaveBeenCalledWith("New Item");
      });
    });

    it("does not call onAdd for empty input", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(<EditableList {...defaultProps} onAdd={onAdd} />);

      // Click on add field to enter edit mode
      await userEvent.click(screen.getByText("Add item..."));

      // Try to save empty (input is empty by default)
      await userEvent.click(screen.getByRole("button", { name: /save/i }));

      expect(onAdd).not.toHaveBeenCalled();
    });

    it("trims whitespace from added items", async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      render(<EditableList {...defaultProps} onAdd={onAdd} />);

      // Click on add field to enter edit mode
      await userEvent.click(screen.getByText("Add item..."));

      const input = screen.getByRole("textbox");
      await userEvent.type(input, "  Trimmed Item  ");

      await userEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(onAdd).toHaveBeenCalledWith("Trimmed Item");
      });
    });
  });
});
