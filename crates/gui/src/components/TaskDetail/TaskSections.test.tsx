import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSections } from "./TaskSections";
import type { Section, SectionType } from "../../bindings";
import * as bindings from "../../bindings";
import * as query from "../../query";

// Mock the bindings commands
vi.mock("../../bindings", async () => {
  const actual = await vi.importActual("../../bindings");
  return {
    ...actual,
    commands: {
      addSection: vi.fn(),
      editSection: vi.fn(),
      removeSection: vi.fn(),
      toggleChecklistItemDone: vi.fn(),
    },
  };
});

vi.mock("../../query", async () => {
  const actual = await vi.importActual("../../query");
  return {
    ...actual,
    updateTaskSectionsInQueryCache: vi.fn(),
  };
});

// Helper to create a section
function createSection(overrides: Partial<Section> & { type: SectionType; content: string }): Section {
  return {
    order: 0,
    done: false,
    done_at: null,
    ...overrides,
  };
}

describe("TaskSections", () => {
  const defaultProps = {
    sections: [] as Section[],
    taskId: "task-123",
    onSectionsChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("shows 'No sections defined' when empty", () => {
      render(<TaskSections {...defaultProps} />);
      expect(screen.getByText("No sections defined")).toBeInTheDocument();
    });

    it("shows Add Section button", () => {
      render(<TaskSections {...defaultProps} />);
      expect(screen.getByText("Add Section")).toBeInTheDocument();
    });

    it("renders section groups for each type with sections", () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
        createSection({ type: "checklist_item", content: "Step 2", order: 1 }),
        createSection({ type: "constraint", content: "Constraint 1", order: 0 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      expect(screen.getByText("Checklist Items")).toBeInTheDocument();
      expect(screen.getByText("Constraints")).toBeInTheDocument();
    });

    it("shows count badge for each section type", () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
        createSection({ type: "checklist_item", content: "Step 2", order: 1 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Should show "2" for steps count in the header badge
      const stepsHeader = screen.getByText("Checklist Items").closest("button");
      expect(stepsHeader).toBeInTheDocument();
      // The count badge is a sibling span (square Badge atom, mono digits).
      expect(stepsHeader?.querySelector(".font-mono")).toHaveTextContent("2");
    });
  });

  describe("section type selector", () => {
    it("shows type selector when Add Section is clicked", async () => {
      render(<TaskSections {...defaultProps} />);

      await userEvent.click(screen.getByText("Add Section"));

      expect(screen.getByText("Select type:")).toBeInTheDocument();
      expect(screen.getByText("Checklist")).toBeInTheDocument();
      expect(screen.getByText("Goal")).toBeInTheDocument();
      expect(screen.getByText("Constraint")).toBeInTheDocument();
    });

    it("hides type selector when X is clicked", async () => {
      render(<TaskSections {...defaultProps} />);

      await userEvent.click(screen.getByText("Add Section"));
      expect(screen.getByText("Select type:")).toBeInTheDocument();

      // Click cancel button
      await userEvent.click(screen.getByTitle("Cancel"));

      expect(screen.queryByText("Select type:")).not.toBeInTheDocument();
    });
  });

  describe("collapsible sections", () => {
    it("expands section when header is clicked", async () => {
      const sections = [
        createSection({ type: "constraint", content: "Constraint 1", order: 0 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Constraints section is collapsed by default
      expect(screen.queryByText("Constraint 1")).not.toBeInTheDocument();

      // Click to expand
      await userEvent.click(screen.getByText("Constraints"));

      expect(screen.getByText("Constraint 1")).toBeInTheDocument();
    });

    it("goal and step sections are open by default", () => {
      const sections = [
        createSection({ type: "goal", content: "The goal", order: 0 }),
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      expect(screen.getByText("The goal")).toBeInTheDocument();
      expect(screen.getByText("Step 1")).toBeInTheDocument();
    });
  });

  describe("step sections", () => {
    it("shows numbered checkboxes for steps", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
        createSection({ type: "checklist_item", content: "Step 2", order: 1 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Steps should show numbers in checkbox buttons (title="Mark as done")
      const checkboxButtons = screen.getAllByTitle("Mark as done");
      expect(checkboxButtons).toHaveLength(2);
      expect(checkboxButtons[0]).toHaveTextContent("1");
      expect(checkboxButtons[1]).toHaveTextContent("2");
    });

    it("shows checkmark for done steps", () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Done step", order: 0, done: true }),
        createSection({ type: "checklist_item", content: "Pending step", order: 1, done: false }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Done step has title "Mark as not done", pending has "Mark as done"
      const doneButton = screen.getByTitle("Mark as not done");
      const pendingButton = screen.getByTitle("Mark as done");
      
      // Done button should contain SVG checkmark
      expect(doneButton.querySelector("svg")).toBeInTheDocument();
      // Pending button should show number
      expect(pendingButton).toHaveTextContent("2");
    });

    it("calls toggleChecklistItemDone when checkbox is clicked", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
      ];

      vi.mocked(bindings.commands.toggleChecklistItemDone).mockResolvedValue({
        status: "ok",
        data: { ...sections[0], done: true },
      });

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Click on the checkbox button
      const checkboxButton = screen.getByTitle("Mark as done");
      await userEvent.click(checkboxButton);

      expect(bindings.commands.toggleChecklistItemDone).toHaveBeenCalledWith("task-123", 0);
    });
  });

  describe("bullet sections", () => {
    it("shows bullet points for non-step sections", async () => {
      const sections = [
        createSection({ type: "constraint", content: "Constraint 1", order: 0 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Expand constraints section
      await userEvent.click(screen.getByText("Constraints"));

      // Should have bullet point (small circle)
      const bullets = document.querySelectorAll(".rounded-full.bg-fg-mute");
      expect(bullets.length).toBe(1);
    });
  });

  describe("editing sections", () => {
    it("enters edit mode when section content is clicked", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Edit me", order: 0 }),
      ];

      render(<TaskSections {...defaultProps} sections={sections} />);

      await userEvent.click(screen.getByText("Edit me"));

      expect(screen.getByRole("textbox")).toHaveValue("Edit me");
    });

    it("calls editSection when edit is saved", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Original", order: 0 }),
      ];

      vi.mocked(bindings.commands.editSection).mockResolvedValue({
        status: "ok",
        data: { ...sections[0], content: "Updated" },
      });

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Click to edit
      await userEvent.click(screen.getByText("Original"));

      // Change value
      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, "Updated");

      // Save
      await userEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(bindings.commands.editSection).toHaveBeenCalledWith(
          "task-123",
          "checklist_item",
          0,
          "Updated"
        );
      });
    });
  });

  describe("deleting sections", () => {
    it("calls removeSection when delete is clicked", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Delete me", order: 0 }),
      ];

      vi.mocked(bindings.commands.removeSection).mockResolvedValue({
        status: "ok",
        data: sections[0],
      });

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Click to edit
      await userEvent.click(screen.getByText("Delete me"));

      // Click delete
      await userEvent.click(screen.getByRole("button", { name: /delete/i }));

      expect(bindings.commands.removeSection).toHaveBeenCalledWith(
        "task-123",
        "checklist_item",
        0
      );
    });
  });

  describe("adding sections", () => {
    it("calls addSection when new section is added", async () => {
      vi.mocked(bindings.commands.addSection).mockResolvedValue({
        status: "ok",
        data: createSection({
          type: "checklist_item",
          content: "New item",
          order: 0,
        }),
      });

      render(<TaskSections {...defaultProps} />);

      // Open type selector
      await userEvent.click(screen.getByText("Add Section"));

      // Select checklist item type
      await userEvent.click(screen.getByText("Checklist"));

      // Find the add input in the expanded section (there will be two inputs now)
      const inputs = screen.getAllByRole("textbox");
      const addInput = inputs.find(input =>
        input.getAttribute("placeholder")?.includes("checklist item")
      );

      if (addInput) {
        await userEvent.type(addInput, "New item");
        await userEvent.click(screen.getByRole("button", { name: /save/i }));

        await waitFor(() => {
          expect(bindings.commands.addSection).toHaveBeenCalledWith(
            "task-123",
            "checklist_item",
            "New item"
          );
        });
      }
    });
  });

  describe("callbacks", () => {
    it("updates the task sections cache after successful operations", async () => {
      const sections = [
        createSection({ type: "checklist_item", content: "Step 1", order: 0 }),
      ];

      const updatedSection = { ...sections[0], done: true };

      vi.mocked(bindings.commands.toggleChecklistItemDone).mockResolvedValue({
        status: "ok",
        data: updatedSection,
      });

      render(<TaskSections {...defaultProps} sections={sections} />);

      // Click on the checkbox button to toggle done
      const checkboxButton = screen.getByTitle("Mark as done");
      await userEvent.click(checkboxButton);

      await waitFor(() => {
        expect(query.updateTaskSectionsInQueryCache).toHaveBeenCalledWith(
          "task-123",
          updatedSection,
          "upsert"
        );
      });
    });
  });
});
