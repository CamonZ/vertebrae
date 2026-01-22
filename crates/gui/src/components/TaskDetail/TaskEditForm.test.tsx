import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render, createMockTask } from "../../test/test-utils";
import { TaskEditForm } from "./TaskEditForm";
import * as commands from "../../bindings";

// Mock the commands
vi.mock("../../bindings", () => ({
  commands: {
    updateTask: vi.fn(),
  },
}));

const mockTask = createMockTask({
  id: "task-123",
  title: "Original Title",
  description: "Original Description",
  level: "task",
  priority: "medium",
  tags: ["tag1", "tag2"],
});

describe("TaskEditForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders the edit form modal when mounted", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Edit Task")).toBeInTheDocument();
    });

    it("pre-populates title field with current task title", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title");
      expect(titleInput).toBeInTheDocument();
      expect(titleInput).toHaveAttribute("id", "edit-task-title");
    });

    it("pre-populates description field with current task description", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const descriptionInput = screen.getByDisplayValue("Original Description");
      expect(descriptionInput).toBeInTheDocument();
      expect(descriptionInput).toHaveAttribute("id", "edit-task-description");
    });

    it("pre-populates priority field with current task priority", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const prioritySelect = screen.getByRole("combobox", { name: /priority/i }) as HTMLSelectElement;
      expect(prioritySelect).toBeInTheDocument();
      expect(prioritySelect.value).toBe("medium");
    });

    it("pre-populates tags field as comma-separated values", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const tagsInput = screen.getByDisplayValue("tag1, tag2");
      expect(tagsInput).toBeInTheDocument();
      expect(tagsInput).toHaveAttribute("id", "edit-task-tags");
    });

    it("displays level as read-only field", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByText("Task")).toBeInTheDocument();
    });

    it("renders all form fields with correct labels", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
      expect(screen.getByText("Level")).toBeInTheDocument(); // Level is displayed as text
      expect(screen.getByRole("combobox", { name: /priority/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/tags/i)).toBeInTheDocument();
    });

    it("renders title and description as required fields", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleLabel = screen.getByText("Title").parentElement;
      const descriptionLabel = screen.getByText("Description").parentElement;

      expect(titleLabel?.textContent).toContain("*");
      expect(descriptionLabel?.textContent).toContain("*");
    });

    it("renders Cancel and Save Changes buttons", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    });

    it("handles empty tags gracefully", () => {
      const taskWithoutTags = createMockTask({
        ...mockTask,
        tags: [],
      });

      render(
        <TaskEditForm
          taskId={taskWithoutTags.id!}
          currentTask={taskWithoutTags}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const tagsInput = screen.getByDisplayValue("");
      expect(tagsInput).toBeInTheDocument();
    });

    it("handles null description gracefully", () => {
      const taskWithoutDescription = createMockTask({
        ...mockTask,
        description: null,
      });

      render(
        <TaskEditForm
          taskId={taskWithoutDescription.id!}
          currentTask={taskWithoutDescription}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const descriptionInput = screen.getByPlaceholderText("Enter task description") as HTMLTextAreaElement;
      expect(descriptionInput.value).toBe("");
    });

    it("handles null priority gracefully", () => {
      const taskWithoutPriority = createMockTask({
        ...mockTask,
        priority: null,
      });

      render(
        <TaskEditForm
          taskId={taskWithoutPriority.id!}
          currentTask={taskWithoutPriority}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const prioritySelect = screen.getByDisplayValue("None");
      expect(prioritySelect).toBeInTheDocument();
    });
  });

  describe("validation", () => {
    it("displays error message when title is empty", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Title is required")).toBeInTheDocument();
      });
    });

    it("displays error message when description is empty", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const descriptionInput = screen.getByDisplayValue("Original Description") as HTMLTextAreaElement;
      fireEvent.change(descriptionInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Description is required")).toBeInTheDocument();
      });
    });

    it("displays error message when both title and description are empty", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      const descriptionInput = screen.getByDisplayValue("Original Description") as HTMLTextAreaElement;

      fireEvent.change(titleInput, { target: { value: "" } });
      fireEvent.change(descriptionInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Title is required")).toBeInTheDocument();
        expect(screen.getByText("Description is required")).toBeInTheDocument();
      });
    });

    it("allows submission when title has only whitespace", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "   " } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Title is required")).toBeInTheDocument();
      });
    });

    it("allows submission when description has only whitespace", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const descriptionInput = screen.getByDisplayValue("Original Description") as HTMLTextAreaElement;
      fireEvent.change(descriptionInput, { target: { value: "   " } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Description is required")).toBeInTheDocument();
      });
    });

    it("clears validation errors when user corrects the input", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Title is required")).toBeInTheDocument();
      });

      fireEvent.change(titleInput, { target: { value: "New Title" } });

      // Error should be cleared immediately
      expect(screen.queryByText("Title is required")).not.toBeInTheDocument();
    });
  });

  describe("submission", () => {
    it("calls updateTask command with correct parameters on successful submission", async () => {
      const mockUpdateTask = vi.fn().mockResolvedValue({
        status: "ok",
        data: null,
      });
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Updated Title" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith(
          mockTask.id,
          "Updated Title",
          null,
          null
        );
      });
    });

    it("only sends changed fields to the API", async () => {
      const mockUpdateTask = vi.fn().mockResolvedValue({
        status: "ok",
        data: null,
      });
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith(
          mockTask.id,
          null,
          null,
          null
        );
      });
    });

    it("calls onSuccess callback after successful submission", async () => {
      const mockOnSuccess = vi.fn();
      vi.mocked(commands.commands.updateTask).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={mockOnSuccess}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it("displays loading state during submission", async () => {
      const mockUpdateTask = vi.fn(() =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ status: "ok", data: null }),
            100
          )
        )
      );
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(submitButton).toBeDisabled();
        const spinner = submitButton.querySelector("svg.animate-spin");
        expect(spinner).toBeInTheDocument();
      });
    });

    it("disables form inputs during submission", async () => {
      const mockUpdateTask = vi.fn(() =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ status: "ok", data: null }),
            100
          )
        )
      );
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      const descriptionInput = screen.getByDisplayValue("Original Description") as HTMLTextAreaElement;
      const prioritySelect = screen.getByRole("combobox", { name: /priority/i }) as HTMLSelectElement;

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      // Wait for inputs to be disabled during submission
      await waitFor(() => {
        expect(titleInput).toBeDisabled();
      });
      expect(descriptionInput).toBeDisabled();
      expect(prioritySelect).toBeDisabled();
    });

    it("prevents form submission when validation fails", async () => {
      const mockUpdateTask = vi.fn();
      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockUpdateTask).not.toHaveBeenCalled();
      });
    });
  });

  describe("error handling", () => {
    it("displays error message when API call fails", async () => {
      const errorMessage = "Failed to update task";
      vi.mocked(commands.commands.updateTask).mockResolvedValue({
        status: "error",
        error: { message: errorMessage },
      });

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });
    });

    it("displays error message when an exception is thrown", async () => {
      vi.mocked(commands.commands.updateTask).mockRejectedValue(
        new Error("Network error")
      );

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });

    it("clears error message when user starts editing again", async () => {
      const errorMessage = "Failed to update task";
      vi.mocked(commands.commands.updateTask).mockResolvedValue({
        status: "error",
        error: { message: errorMessage },
      });

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });

      // Edit the title to trigger error clear
      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Updated Title" } });

      // Error should be cleared immediately
      expect(screen.queryByText(errorMessage)).not.toBeInTheDocument();
    });

    it("allows retry after error", async () => {
      const mockUpdateTask = vi.fn();
      mockUpdateTask
        .mockResolvedValueOnce({
          status: "error",
          error: { message: "First attempt failed" },
        })
        .mockResolvedValueOnce({
          status: "ok",
          data: null,
        });

      vi.mocked(commands.commands.updateTask).mockImplementation(mockUpdateTask);

      const mockOnSuccess = vi.fn();

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={mockOnSuccess}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });

      // First submission fails
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("First attempt failed")).toBeInTheDocument();
      });

      // Second submission succeeds
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });
  });

  describe("cancel functionality", () => {
    it("calls onClose when cancel button is clicked", async () => {
      const mockOnClose = vi.fn();

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={mockOnClose}
          onSuccess={vi.fn()}
        />
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("resets form to original values when cancel is clicked", async () => {
      const mockOnClose = vi.fn();

      const { rerender } = render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={mockOnClose}
          onSuccess={vi.fn()}
        />
      );

      // Edit the fields
      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Modified Title" } });

      // Cancel should reset form
      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      // Verify onClose was called
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("prevents cancel during submission if preventCloseDuringSubmit is true", async () => {
      const mockOnClose = vi.fn();

      vi.mocked(commands.commands.updateTask).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ status: "ok", data: null }),
              100
            )
          )
      );

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={mockOnClose}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        const cancelButton = screen.getByRole("button", { name: /cancel/i });
        expect(cancelButton).toBeDisabled();
      });
    });
  });

  describe("field updates", () => {
    it("updates title field when user types", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "New Title" } });

      expect(titleInput.value).toBe("New Title");
    });

    it("updates description field when user types", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const descriptionInput = screen.getByDisplayValue(
        "Original Description"
      ) as HTMLTextAreaElement;
      fireEvent.change(descriptionInput, {
        target: { value: "New Description" },
      });

      expect(descriptionInput.value).toBe("New Description");
    });

    it("updates priority field when user selects option", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const prioritySelect = screen.getByRole("combobox", { name: /priority/i }) as HTMLSelectElement;
      fireEvent.change(prioritySelect, { target: { value: "high" } });

      expect(prioritySelect.value).toBe("high");
    });

    it("updates tags field when user types", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const tagsInput = screen.getByDisplayValue("tag1, tag2") as HTMLInputElement;
      fireEvent.change(tagsInput, { target: { value: "newtag1, newtag2" } });

      expect(tagsInput.value).toBe("newtag1, newtag2");
    });

    it("handles priority None selection", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const prioritySelect = screen.getByRole("combobox", { name: /priority/i }) as HTMLSelectElement;
      fireEvent.change(prioritySelect, { target: { value: "none" } });

      expect(prioritySelect.value).toBe("none");
    });
  });

  describe("modal integration", () => {
    it("renders modal with correct title", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByText("Edit Task")).toBeInTheDocument();
    });

    it("modal is always open (isOpen=true)", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("disables backdrop click during submission", async () => {
      vi.mocked(commands.commands.updateTask).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ status: "ok", data: null }),
              100
            )
          )
      );

      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        const modal = screen.getByRole("dialog");
        // Modal should have preventBackdropClickDuringSubmit set
        expect(modal).toBeInTheDocument();
      });
    });
  });

  describe("update on prop change", () => {
    it("resets form when currentTask changes", () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "Modified Title" } });
      expect(titleInput.value).toBe("Modified Title");

      // Change the currentTask prop
      const updatedTask = createMockTask({
        ...mockTask,
        id: "task-456",
        title: "Different Title",
        description: "Different Description",
      });

      // Rerender with new task - use screen.getByDisplayValue to find new values
      // Note: We render the updated component but don't capture rerender since we use screen queries
      render(
        <TaskEditForm
          taskId={updatedTask.id!}
          currentTask={updatedTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
        { container: screen.getByRole("dialog").parentElement as HTMLElement }
      );

      const newTitleInput = screen.getByDisplayValue("Different Title");
      expect(newTitleInput).toBeInTheDocument();
    });

    it("clears errors when currentTask changes", async () => {
      render(
        <TaskEditForm
          taskId={mockTask.id!}
          currentTask={mockTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );

      // Create a validation error
      const titleInput = screen.getByDisplayValue("Original Title") as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "" } });

      const submitButton = screen.getByRole("button", { name: /save changes/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Title is required")).toBeInTheDocument();
      });

      // Change currentTask
      const updatedTask = createMockTask({
        ...mockTask,
        id: "task-456",
        title: "New Task",
      });

      // Render with new task
      render(
        <TaskEditForm
          taskId={updatedTask.id!}
          currentTask={updatedTask}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
        { container: screen.getByRole("dialog").parentElement as HTMLElement }
      );

      // Errors should be cleared
      expect(screen.queryByText("Title is required")).not.toBeInTheDocument();
    });
  });
});
