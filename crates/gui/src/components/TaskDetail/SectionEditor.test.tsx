import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SectionEditor } from './SectionEditor';
import * as bindings from '../../bindings';

// Mock the bindings
vi.mock('../../bindings', () => ({
  commands: {
    addSection: vi.fn(),
    editSection: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCommands = bindings.commands as Record<string, any>;

describe('SectionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create new section', () => {
    it('renders create form when isOpen is true', () => {
      render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('New Goal')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Enter goal/i)).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={false}
          onClose={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('submits new section with validated content', async () => {
      mockCommands.addSection.mockResolvedValue({ status: 'ok', data: { id: 'sec1' } });

      const onSave = vi.fn();
      render(
        <SectionEditor
          taskId="task1"
          sectionType="context"
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter context/i);
      fireEvent.change(textarea, { target: { value: 'Test context' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.addSection).toHaveBeenCalledWith(
          'task1',
          'context',
          'Test context'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('validates empty content', async () => {
      const onClose = vi.fn();
      render(
        <SectionEditor
          taskId="task1"
          sectionType="constraint"
          isOpen={true}
          onClose={onClose}
        />
      );

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        const errors = screen.getAllByText(/Content cannot be empty/i);
        expect(errors.length).toBeGreaterThan(0);
      });

      expect(mockCommands.addSection).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      mockCommands.addSection.mockResolvedValue({
        status: 'error',
        error: { message: 'Server error' },
      });

      render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter goal/i);
      fireEvent.change(textarea, { target: { value: 'Test goal' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Server error/i)).toBeInTheDocument();
      });
    });
  });

  describe('edit existing section', () => {
    it('renders edit form with pre-filled content', () => {
      const section = {
        type: 'goal' as const,
        content: 'Existing goal',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <SectionEditor
          taskId="task1"
          section={section}
          sectionType="goal"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Edit Goal')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Existing goal')).toBeInTheDocument();
    });

    it('submits edited section', async () => {
      mockCommands.editSection.mockResolvedValue({ status: 'ok' });

      const section = {
        type: 'context' as const,
        content: 'Old context',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <SectionEditor
          taskId="task1"
          section={section}
          sectionType="context"
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByDisplayValue('Old context');
      fireEvent.change(textarea, { target: { value: 'Updated context' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.editSection).toHaveBeenCalledWith(
          'task1',
          'context',
          0,
          'Updated context'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('shows submit button text as Save for existing section', () => {
      const section = {
        type: 'constraint' as const,
        content: 'Test constraint',
        ordinal: 1,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <SectionEditor
          taskId="task1"
          section={section}
          sectionType="constraint"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
    });
  });

  describe('close behavior', () => {
    it('calls onClose when cancel button is clicked', () => {
      const onClose = vi.fn();
      render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={onClose}
        />
      );

      const cancelButton = screen.getByRole('button', { name: /Cancel/i });
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalled();
    });

    it('resets form when closing', async () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={onClose}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter goal/i);
      fireEvent.change(textarea, { target: { value: 'Some text' } });

      const cancelButton = screen.getByRole('button', { name: /Cancel/i });
      fireEvent.click(cancelButton);

      // Reopen the modal
      rerender(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={onClose}
        />
      );

      // Form should be empty after close
      const newTextarea = screen.getByPlaceholderText(/Enter goal/i) as HTMLTextAreaElement;
      expect(newTextarea.value).toBe('');
    });
  });

  describe('loading state', () => {
    it('disables textarea during submission', async () => {
      mockCommands.addSection.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter goal/i) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Test' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(textarea).toBeDisabled();
      });
    });

    it('shows loading state on submit button', async () => {
      mockCommands.addSection.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(
        <SectionEditor
          taskId="task1"
          sectionType="goal"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Enter goal/i);
      fireEvent.change(textarea, { target: { value: 'Test' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(submitButton).toBeDisabled();
      });
    });
  });

  describe('section type formatting', () => {
    it.each([
      ['goal', 'Goal'],
      ['context', 'Context'],
      ['constraint', 'Constraint'],
      ['testing_criterion', 'Testing Criterion'],
    ])('formats section type %s as %s', (sectionType: string, displayName: string) => {
      render(
        <SectionEditor
          taskId="task1"
          sectionType={sectionType as typeof sectionType}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText(`New ${displayName}`)).toBeInTheDocument();
    });
  });
});
