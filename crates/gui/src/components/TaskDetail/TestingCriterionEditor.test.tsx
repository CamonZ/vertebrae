import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TestingCriterionEditor } from './TestingCriterionEditor';
import * as bindings from '../../bindings';

// Mock the bindings
vi.mock('../../bindings', () => ({
  commands: {
    addSection: vi.fn(),
    editSection: vi.fn(),
    addCriterionRef: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCommands = bindings.commands as Record<string, any>;

describe('TestingCriterionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create new testing criterion', () => {
    it('renders create form for new criterion', () => {
      render(
        <TestingCriterionEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('New Testing Criterion')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Describe the testing criterion/i)).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        <TestingCriterionEditor
          taskId="task1"
          isOpen={false}
          onClose={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('submits new criterion with content', async () => {
      mockCommands.addSection.mockResolvedValue({ status: 'ok', data: { id: 'crit1' } });

      const onSave = vi.fn();
      render(
        <TestingCriterionEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByPlaceholderText(/Describe the testing criterion/i);
      fireEvent.change(textarea, { target: { value: 'Should display error message' } });

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.addSection).toHaveBeenCalledWith(
          'task1',
          'testing_criterion',
          'Should display error message'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('validates empty criterion content', async () => {
      render(
        <TestingCriterionEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const submitButton = screen.getByRole('button', { name: /Create/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        const errors = screen.getAllByText(/Testing criterion cannot be empty/i);
        expect(errors.length).toBeGreaterThan(0);
      });

      expect(mockCommands.addSection).not.toHaveBeenCalled();
    });
  });

  describe('edit existing criterion', () => {
    it('renders edit form with pre-filled content', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Verify feature works',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Edit Testing Criterion')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Verify feature works')).toBeInTheDocument();
    });

    it('shows code references section in edit mode', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText('Code References')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/e.g., src\/main.rs/i)).toBeInTheDocument();
    });

    it('shows message for new unsaved criterion', () => {
      render(
        <TestingCriterionEditor
          taskId="task1"
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByText(/Save the criterion first to add code references/i)).toBeInTheDocument();
    });

    it('submits edited criterion', async () => {
      mockCommands.editSection.mockResolvedValue({ status: 'ok' });

      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Old criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const textarea = screen.getByDisplayValue('Old criterion');
      fireEvent.change(textarea, { target: { value: 'Updated criterion' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCommands.editSection).toHaveBeenCalledWith(
          'task1',
          'testing_criterion',
          0,
          'Updated criterion'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe('code reference management', () => {
    it('disables add reference button when file path is empty', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const lineNumberInput = screen.getByPlaceholderText(/e.g., 42/i);
      fireEvent.change(lineNumberInput, { target: { value: '42' } });

      const addButton = screen.getByRole('button', { name: /Add Reference/i });
      expect(addButton).toBeDisabled();
    });

    it('disables add reference button when line number is empty', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const filePathInput = screen.getByPlaceholderText(/e.g., src\/main.rs/i);
      fireEvent.change(filePathInput, { target: { value: 'src/main.rs' } });

      const addButton = screen.getByRole('button', { name: /Add Reference/i });
      expect(addButton).toBeDisabled();
    });

    it('rejects invalid line numbers', async () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const filePathInput = screen.getByPlaceholderText(/e.g., src\/main.rs/i);
      const lineNumberInput = screen.getByPlaceholderText(/e.g., 42/i);

      fireEvent.change(filePathInput, { target: { value: 'src/main.rs' } });
      fireEvent.change(lineNumberInput, { target: { value: '-5' } });

      const addButton = screen.getByRole('button', { name: /Add Reference/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/Line number must be a positive integer/i)).toBeInTheDocument();
      });

      expect(mockCommands.addCriterionRef).not.toHaveBeenCalled();
    });

    it('adds code reference with all fields', async () => {
      mockCommands.addCriterionRef.mockResolvedValue({ status: 'ok' });

      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 1,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const filePathInput = screen.getByPlaceholderText(/e.g., src\/main.rs/i);
      const lineNumberInput = screen.getByPlaceholderText(/e.g., 42/i);
      const nameInput = screen.getByPlaceholderText(/e.g., main function/i);

      fireEvent.change(filePathInput, { target: { value: 'src/lib.rs' } });
      fireEvent.change(lineNumberInput, { target: { value: '150' } });
      fireEvent.change(nameInput, { target: { value: 'init function' } });

      const addButton = screen.getByRole('button', { name: /Add Reference/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(mockCommands.addCriterionRef).toHaveBeenCalledWith(
          'task1',
          1,
          'src/lib.rs',
          150,
          'init function'
        );
        expect(onSave).toHaveBeenCalled();
      });
    });

    it('enables add button when all required fields are filled', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const filePathInput = screen.getByPlaceholderText(/e.g., src\/main.rs/i) as HTMLInputElement;
      const lineNumberInput = screen.getByPlaceholderText(/e.g., 42/i) as HTMLInputElement;
      const nameInput = screen.getByPlaceholderText(/e.g., main function/i) as HTMLInputElement;

      // Initially disabled
      let addButton = screen.getByRole('button', { name: /Add Reference/i });
      expect(addButton).toBeDisabled();

      // Fill in path and line number
      fireEvent.change(filePathInput, { target: { value: 'src/main.rs' } });
      fireEvent.change(lineNumberInput, { target: { value: '100' } });

      // Should now be enabled
      addButton = screen.getByRole('button', { name: /Add Reference/i });
      expect(addButton).not.toBeDisabled();

      // Name is optional so button stays enabled
      fireEvent.change(nameInput, { target: { value: 'init function' } });
      addButton = screen.getByRole('button', { name: /Add Reference/i });
      expect(addButton).not.toBeDisabled();
    });

    it('renders code reference input fields', () => {
      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByPlaceholderText(/e.g., src\/main.rs/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/e.g., 42/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/e.g., main function/i)).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('displays API errors for criterion edit', async () => {
      mockCommands.editSection.mockResolvedValue({
        status: 'error',
        error: { message: 'Server error' },
      });

      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 0,
        done: false,
        order: 1,
        code_refs: [],
      };

      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
        />
      );

      const textarea = screen.getByDisplayValue('Test criterion');
      fireEvent.change(textarea, { target: { value: 'Updated' } });

      const submitButton = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Server error/i)).toBeInTheDocument();
      });
    });

    it('calls addCriterionRef when adding code reference', async () => {
      mockCommands.addCriterionRef.mockResolvedValue({ status: 'ok' });

      const criterion = {
        type: 'testing_criterion' as const,
        content: 'Test criterion',
        ordinal: 2,
        done: false,
        order: 1,
        code_refs: [],
      };

      const onSave = vi.fn();
      render(
        <TestingCriterionEditor
          taskId="task1"
          criterion={criterion}
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      const filePathInputs = screen.getAllByPlaceholderText(/e.g., src\/main.rs/i);
      const lineNumberInputs = screen.getAllByPlaceholderText(/e.g., 42/i);

      fireEvent.change(filePathInputs[0], { target: { value: 'src/lib.rs' } });
      fireEvent.change(lineNumberInputs[0], { target: { value: '100' } });

      const addButton = screen.getByRole('button', { name: /Add Reference/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(mockCommands.addCriterionRef).toHaveBeenCalledWith(
          'task1',
          2,
          'src/lib.rs',
          100,
          undefined
        );
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe('close behavior', () => {
    it('calls onClose when cancel button is clicked', () => {
      const onClose = vi.fn();
      render(
        <TestingCriterionEditor
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
