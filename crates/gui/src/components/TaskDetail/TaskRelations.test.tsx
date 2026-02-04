import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskRelations } from './TaskRelations';
import * as bindingsModule from '../../bindings';
import type { Task } from '../../bindings';

// Helper to create mock Task with all required fields
const createMockTask = (id: string, title: string): Task => ({
  id,
  title,
  description: null,
  level: 'task' as const,
  priority: null,
  tags: [] as string[],
  workflow_id: null,
  current_step_id: null,
  workflow_name: null,
  step_name: null,
  needs_human_review: null,
  review_comment: null,
  revision_feedback: null,
  rejection_reason: null,
  parent_id: null,
  sections: [],
  code_refs: [],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: null,
  started_at: null,
  completed_at: null,
});

const mockTaskList: Task[] = [
  createMockTask('task-1', 'Task One'),
  createMockTask('task-2', 'Task Two'),
  createMockTask('task-3', 'Task Three'),
];

// Mock the bindings module
vi.mock('../../bindings', () => ({
  commands: {
    listTasks: vi.fn(),
    setParent: vi.fn(),
    removeParent: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
  },
}));

describe('TaskRelations', () => {
  const defaultProps = {
    taskId: 'current-task',
    parentId: null,
    childrenIds: [],
    dependsOnIds: [],
    dependentIds: [],
    onTaskSelect: vi.fn(),
    onRelationshipChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default mocks
    vi.mocked(bindingsModule.commands.listTasks).mockResolvedValue({
      status: 'ok',
      data: mockTaskList,
    });
    vi.mocked(bindingsModule.commands.setParent).mockResolvedValue({ status: 'ok', data: null });
    vi.mocked(bindingsModule.commands.removeParent).mockResolvedValue({ status: 'ok', data: null });
    vi.mocked(bindingsModule.commands.addDependency).mockResolvedValue({ status: 'ok', data: null });
    vi.mocked(bindingsModule.commands.removeDependency).mockResolvedValue({ status: 'ok', data: null });
  });

  describe('rendering', () => {
    it('shows "No task selected" when taskId is undefined', () => {
      render(<TaskRelations {...defaultProps} taskId={undefined} />);
      expect(screen.getByText('No task selected')).toBeInTheDocument();
    });

    it('displays parent section', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('Parent')).toBeInTheDocument();
    });

    it('displays children section', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('Children')).toBeInTheDocument();
    });

    it('displays blocked by section', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('Blocked By')).toBeInTheDocument();
    });

    it('displays blocks section', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('Blocks')).toBeInTheDocument();
    });
  });

  describe('parent display', () => {
    it('shows "No parent (root task)" when parentId is null', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('No parent (root task)')).toBeInTheDocument();
    });

    it('shows parent task link when parentId is set', () => {
      render(<TaskRelations {...defaultProps} parentId="parent-123" />);
      expect(screen.getByText('parent')).toBeInTheDocument(); // truncated ID
    });

    it('calls onTaskSelect when parent link is clicked', async () => {
      render(<TaskRelations {...defaultProps} parentId="parent-123" />);
      await userEvent.click(screen.getByText('parent'));
      expect(defaultProps.onTaskSelect).toHaveBeenCalledWith('parent-123');
    });
  });

  describe('children display', () => {
    it('shows "No child tasks" when empty', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('No child tasks')).toBeInTheDocument();
    });

    it('shows child task links', () => {
      render(<TaskRelations {...defaultProps} childrenIds={['child-1', 'child-2']} />);
      const childLinks = screen.getAllByText('child-');
      expect(childLinks).toHaveLength(2);
    });

    it('shows count badge for children', () => {
      render(<TaskRelations {...defaultProps} childrenIds={['child-1', 'child-2']} />);
      // Find the count badge (shows "2")
      const badges = screen.getAllByText('2');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  describe('blockers display', () => {
    it('shows "No blockers" when empty', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('No blockers')).toBeInTheDocument();
    });

    it('shows blocker task links', () => {
      render(<TaskRelations {...defaultProps} dependsOnIds={['blocker-1']} />);
      expect(screen.getByText('blocke')).toBeInTheDocument(); // truncated
    });

    it('shows count badge for blockers', () => {
      render(<TaskRelations {...defaultProps} dependsOnIds={['blocker-1', 'blocker-2']} />);
      const badges = screen.getAllByText('2');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  describe('dependents display', () => {
    it('shows "No dependent tasks" when empty', () => {
      render(<TaskRelations {...defaultProps} />);
      expect(screen.getByText('No dependent tasks')).toBeInTheDocument();
    });

    it('shows dependent task links', () => {
      render(<TaskRelations {...defaultProps} dependentIds={['dependent-1']} />);
      expect(screen.getByText('depend')).toBeInTheDocument(); // truncated
    });
  });

  describe('parent editing', () => {
    it('enters edit mode when parent section is clicked', async () => {
      render(<TaskRelations {...defaultProps} />);

      // Click on the parent display area
      await userEvent.click(screen.getByText('No parent (root task)'));

      // Should show search input
      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
    });

    it('shows warning dot when editing', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      const warningDot = document.querySelector('.bg-warning');
      expect(warningDot).toBeInTheDocument();
    });

    it('fetches and displays available tasks', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(bindingsModule.commands.listTasks).toHaveBeenCalledWith(null);
      });

      // Should show filtered tasks (excluding current task)
      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
        expect(screen.getByText('Task Two')).toBeInTheDocument();
      });
    });

    it('filters tasks based on search query', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search tasks...');
      await userEvent.type(searchInput, 'Two');

      expect(screen.queryByText('Task One')).not.toBeInTheDocument();
      expect(screen.getByText('Task Two')).toBeInTheDocument();
    });

    it('calls setParent when a task is selected', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Task One'));

      await waitFor(() => {
        expect(bindingsModule.commands.setParent).toHaveBeenCalledWith('current-task', 'task-1');
      });
    });

    it('calls onRelationshipChange after successful parent change', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Task One'));

      await waitFor(() => {
        expect(defaultProps.onRelationshipChange).toHaveBeenCalled();
      });
    });

    it('shows remove button when parent exists', async () => {
      render(<TaskRelations {...defaultProps} parentId="existing-parent" />);

      await userEvent.click(screen.getByTitle('View task existing-parent'));

      await waitFor(() => {
        expect(screen.getByTitle('Remove parent')).toBeInTheDocument();
      });
    });

    it('calls removeParent when remove button is clicked', async () => {
      render(<TaskRelations {...defaultProps} parentId="existing-parent" />);

      // Click on the parent display to enter edit mode
      const parentLink = screen.getByTitle('View task existing-parent');
      // We need to click on the container, not the link
      await userEvent.click(parentLink.parentElement!);

      await waitFor(() => {
        expect(screen.getByTitle('Remove parent')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTitle('Remove parent'));

      await waitFor(() => {
        expect(bindingsModule.commands.removeParent).toHaveBeenCalledWith('current-task');
      });
    });

    it('cancels edit mode when cancel button is clicked', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();

      await userEvent.click(screen.getByTitle('Cancel (Esc)'));

      expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
    });

    it('cancels edit mode on Escape key', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
      });
    });
  });

  describe('dependency editing', () => {
    it('enters edit mode when blockers section is clicked', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
    });

    it('shows checkboxes for multi-select', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('pre-selects existing dependencies', async () => {
      render(<TaskRelations {...defaultProps} dependsOnIds={['task-1']} />);

      // Click on the blockers display
      await userEvent.click(screen.getByText('task-1').parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      const task1Checkbox = checkboxes.find((cb) => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Task One');
      });
      expect(task1Checkbox).toBeChecked();
    });

    it('enables save button when changes are made', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      // Save button should be disabled initially (no changes)
      const saveButton = screen.getByTitle('Save changes');
      expect(saveButton).toBeDisabled();

      // Select a task
      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]);

      // Save button should now be enabled
      expect(saveButton).not.toBeDisabled();
    });

    it('calls addDependency for new selections', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      // Select task-1
      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]);

      // Click save
      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(bindingsModule.commands.addDependency).toHaveBeenCalledWith('current-task', 'task-1');
      });
    });

    it('calls removeDependency for deselected items', async () => {
      render(<TaskRelations {...defaultProps} dependsOnIds={['task-1']} />);

      // Click on the blockers display
      await userEvent.click(screen.getByText('task-1').parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      // Deselect task-1
      const checkboxes = screen.getAllByRole('checkbox');
      const task1Checkbox = checkboxes.find((cb) => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Task One');
      });
      await userEvent.click(task1Checkbox!);

      // Click save
      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(bindingsModule.commands.removeDependency).toHaveBeenCalledWith('current-task', 'task-1');
      });
    });

    it('calls onRelationshipChange after successful dependency change', async () => {
      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(defaultProps.onRelationshipChange).toHaveBeenCalled();
      });
    });
  });

  describe('parent editing - additional behaviors', () => {
    it('shows loading state while fetching tasks', async () => {
      // Create a delayed mock
      vi.mocked(bindingsModule.commands.listTasks).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({
          status: 'ok',
          data: [createMockTask('task-1', 'Task One')],
        }), 100))
      );

      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No parent (root task)'));

      expect(screen.getByText('Loading tasks...')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });
    });

    it('excludes current task from available tasks', async () => {
      vi.mocked(bindingsModule.commands.listTasks).mockResolvedValueOnce({
        status: 'ok',
        data: [
          createMockTask('current-task', 'Current Task'),
          createMockTask('task-1', 'Task One'),
        ],
      });

      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      // Current task should not be shown
      expect(screen.queryByText('Current Task')).not.toBeInTheDocument();
    });

    it('filters tasks by task ID', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search tasks...');
      await userEvent.type(searchInput, 'task-2');

      expect(screen.queryByText('Task One')).not.toBeInTheDocument();
      expect(screen.getByText('Task Two')).toBeInTheDocument();
    });

    it('does not show remove button when no parent exists', async () => {
      render(<TaskRelations {...defaultProps} parentId={null} />);
      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      expect(screen.queryByTitle('Remove parent')).not.toBeInTheDocument();
    });

    it('exits edit mode after successful parent selection', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Task One'));

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
      });
    });

    it('calls onRelationshipChange after successful parent removal', async () => {
      render(<TaskRelations {...defaultProps} parentId="existing-parent" />);

      const parentLink = screen.getByTitle('View task existing-parent');
      await userEvent.click(parentLink.parentElement!);

      await waitFor(() => {
        expect(screen.getByTitle('Remove parent')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTitle('Remove parent'));

      await waitFor(() => {
        expect(defaultProps.onRelationshipChange).toHaveBeenCalled();
      });
    });
  });

  describe('dependency editing - additional behaviors', () => {
    it('shows loading state while fetching tasks', async () => {
      vi.mocked(bindingsModule.commands.listTasks).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({
          status: 'ok',
          data: [createMockTask('task-1', 'Task One')],
        }), 100))
      );

      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      expect(screen.getByText('Loading tasks...')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });
    });

    it('excludes current task from available tasks', async () => {
      vi.mocked(bindingsModule.commands.listTasks).mockResolvedValueOnce({
        status: 'ok',
        data: [
          createMockTask('current-task', 'Current Task'),
          createMockTask('task-1', 'Task One'),
        ],
      });

      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      expect(screen.queryByText('Current Task')).not.toBeInTheDocument();
    });

    it('handles adding and removing dependencies in the same save', async () => {
      render(<TaskRelations {...defaultProps} dependsOnIds={['task-1']} />);

      await userEvent.click(screen.getByText('task-1').parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');

      // Find and deselect task-1
      const task1Checkbox = checkboxes.find((cb) => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Task One');
      });
      await userEvent.click(task1Checkbox!);

      // Select task-2
      const task2Checkbox = checkboxes.find((cb) => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Task Two');
      });
      await userEvent.click(task2Checkbox!);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(bindingsModule.commands.removeDependency).toHaveBeenCalledWith('current-task', 'task-1');
        expect(bindingsModule.commands.addDependency).toHaveBeenCalledWith('current-task', 'task-2');
      });
    });

    it('can select multiple dependencies', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');

      // Select first two tasks
      await userEvent.click(checkboxes[0]);
      await userEvent.click(checkboxes[1]);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(bindingsModule.commands.addDependency).toHaveBeenCalledWith('current-task', 'task-1');
        expect(bindingsModule.commands.addDependency).toHaveBeenCalledWith('current-task', 'task-2');
      });
    });

    it('cancels dependency edit mode when cancel button is clicked', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();

      await userEvent.click(screen.getByTitle('Cancel (Esc)'));

      expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
    });

    it('cancels dependency edit mode on Escape key', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
      });
    });

    it('exits edit mode after successful dependency save', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Search tasks...')).not.toBeInTheDocument();
      });
    });

    it('filters tasks by task ID', async () => {
      render(<TaskRelations {...defaultProps} />);
      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search tasks...');
      await userEvent.type(searchInput, 'task-3');

      expect(screen.queryByText('Task One')).not.toBeInTheDocument();
      expect(screen.getByText('Task Three')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('displays error when listTasks fails', async () => {
      vi.mocked(bindingsModule.commands.listTasks).mockResolvedValueOnce({
        status: 'error',
        error: { message: 'Failed to load tasks' },
      });

      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Failed to load tasks')).toBeInTheDocument();
      });
    });

    it('displays error when setParent fails', async () => {
      vi.mocked(bindingsModule.commands.setParent).mockResolvedValueOnce({
        status: 'error',
        error: { message: 'Cannot set parent: would create cycle' },
      });

      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No parent (root task)'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Task One'));

      await waitFor(() => {
        expect(screen.getByText('Cannot set parent: would create cycle')).toBeInTheDocument();
      });
    });

    it('displays error when addDependency fails', async () => {
      vi.mocked(bindingsModule.commands.addDependency).mockResolvedValueOnce({
        status: 'error',
        error: { message: 'Cannot add dependency: would create cycle' },
      });

      render(<TaskRelations {...defaultProps} />);

      await userEvent.click(screen.getByText('No blockers'));

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      await userEvent.click(checkboxes[0]);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(screen.getByText('Cannot add dependency: would create cycle')).toBeInTheDocument();
      });
    });

    it('displays error when removeParent fails', async () => {
      vi.mocked(bindingsModule.commands.removeParent).mockResolvedValueOnce({
        status: 'error',
        error: { message: 'Failed to remove parent' },
      });

      render(<TaskRelations {...defaultProps} parentId="existing-parent" />);

      const parentLink = screen.getByTitle('View task existing-parent');
      await userEvent.click(parentLink.parentElement!);

      await waitFor(() => {
        expect(screen.getByTitle('Remove parent')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTitle('Remove parent'));

      await waitFor(() => {
        expect(screen.getByText('Failed to remove parent')).toBeInTheDocument();
      });
    });

    it('displays error when removeDependency fails', async () => {
      vi.mocked(bindingsModule.commands.removeDependency).mockResolvedValueOnce({
        status: 'error',
        error: { message: 'Failed to remove dependency' },
      });

      render(<TaskRelations {...defaultProps} dependsOnIds={['task-1']} />);

      await userEvent.click(screen.getByText('task-1').parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Task One')).toBeInTheDocument();
      });

      // Deselect task-1
      const checkboxes = screen.getAllByRole('checkbox');
      const task1Checkbox = checkboxes.find((cb) => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Task One');
      });
      await userEvent.click(task1Checkbox!);

      await userEvent.click(screen.getByTitle('Save changes'));

      await waitFor(() => {
        expect(screen.getByText('Failed to remove dependency')).toBeInTheDocument();
      });
    });
  });
});
