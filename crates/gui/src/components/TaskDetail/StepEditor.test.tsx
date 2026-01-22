import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StepEditor } from './StepEditor';
import * as bindings from '../../bindings';

// Mock the bindings
vi.mock('../../bindings', () => ({
  commands: {
    addSection: vi.fn(),
    editSection: vi.fn(),
    markSectionDone: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCommands = bindings.commands as Record<string, any>;

describe('StepEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create new step', () => {
    it('renders create form for new step', () => {
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('New Step')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Describe the step/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Mark this step as done/i)).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        <StepEditor
          taskId="task1"
          isOpen={false}
          onClose={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('submits new step with content', async () => {
      mockCommands.addSection.mockResolvedValue({ status: 'ok', data: { id: 'step1' } });

      const onSave = vi.fn();
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByPlaceholderText(/Describe the step/i);
      fireEvent.change(textarea, { target: { value: 'Implement feature X' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.addSection).toHaveBeenCalledWith(
          'task1',
          'step',
          'Implement feature X'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('validates empty step content', async () => {
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        const errors = screen.getAllByText(/Step content cannot be empty/i);
        expect(errors.length).toBeGreaterThan(0);
      });

      expect(mockCommands.addSection).not.toHaveBeenCalled();
    });
  });

  describe('edit existing step', () => {
    it('renders edit form with pre-filled content', () => {
      const step = {
        type: 'step' as const,
        content: 'Deploy to production',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Edit Step')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Deploy to production')).toBeInTheDocument();
    });

    it('shows done toggle in edit mode', () => {
      const step = {
        type: 'step' as const,
        content: 'Test step',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const checkbox = screen.getByRole('checkbox', { name: /Mark this step as done/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('displays done status when step is marked done', () => {
      const step = {
        type: 'step' as const,
        content: 'Completed step',
        ordinal: 0,
        done: true,
        order: 1,
        code_refs: [],
      };

      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const checkbox = screen.getByRole('checkbox', { name: /Mark this step as done/i }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      expect(screen.getByText('Complete')).toBeInTheDocument();
    });

    it('submits edited step with new content', async () => {
      mockCommands.editSection.mockResolvedValue({ status: 'ok' });

      const step = {
        type: 'step' as const,
        content: 'Old step',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByDisplayValue('Old step');
      fireEvent.change(textarea, { target: { value: 'Updated step' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.editSection).toHaveBeenCalledWith(
          'task1',
          'step',
          0,
          'Updated step'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('toggles done status on checkbox change', async () => {
      mockCommands.editSection.mockResolvedValue({ status: 'ok' });
      mockCommands.markSectionDone.mockResolvedValue({ status: 'ok' });

      const step = {
        type: 'step' as const,
        content: 'Test step',
        ordinal: 1,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const checkbox = screen.getByRole('checkbox', { name: /Mark this step as done/i });
      fireEvent.click(checkbox);

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.editSection).toHaveBeenCalled();
        expect(mockCommands.markSectionDone).toHaveBeenCalledWith('task1', 1);
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('does not call markSectionDone if done status does not change', async () => {
      mockCommands.editSection.mockResolvedValue({ status: 'ok' });

      const step = {
        type: 'step' as const,
        content: 'Already done step',
        ordinal: 0,
        done: true,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByDisplayValue('Already done step');
      fireEvent.change(textarea, { target: { value: 'Updated text' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.editSection).toHaveBeenCalled();
        expect(mockCommands.markSectionDone).not.toHaveBeenCalled();
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe('done toggle UI', () => {
    it('shows prominent done toggle', () => {
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const toggleBox = screen.getByText(/Mark this step as done/i).closest('div');
      expect(toggleBox).toHaveClass('rounded-lg', 'border', 'bg-background-tertiary', 'p-4');
    });

    it('checkbox updates done state UI', () => {
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const checkbox = screen.getByRole('checkbox', { name: /Mark this step as done/i });
      expect(screen.queryByText('Complete')).not.toBeInTheDocument();

      fireEvent.click(checkbox);
      expect(screen.getByText('Complete')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('displays API errors', async () => {
      mockCommands.editSection.mockResolvedValue({
        status: 'error',
        error: { message: 'Failed to update step' },
      });

      const step = {
        type: 'step' as const,
        content: 'Test step',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <StepEditor
          taskId="task1"
          step={step}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByDisplayValue('Test step');
      fireEvent.change(textarea, { target: { value: 'Updated' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Failed to update step/i)).toBeInTheDocument();
      });
    });
  });

  describe('close behavior', () => {
    it('calls onClose when cancel button is clicked', () => {
      const onClose = vi.fn();
      render(
        <StepEditor
          taskId="task1"
          isOpen={true}
          onClose={onClose}
        />
      );

      const cancelButton = screen.getByRole('button', { name: /Cancel/i });
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalled();
    });
  });
});
