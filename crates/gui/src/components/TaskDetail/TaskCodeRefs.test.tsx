import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCodeRefs } from './TaskCodeRefs';
import * as bindingsModule from '../../bindings';

// Mock the bindings module
vi.mock('../../bindings', () => ({
  commands: {
    addCodeRef: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    editCodeRef: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    removeCodeRef: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

describe('TaskCodeRefs', () => {
  const defaultProps = {
    codeRefs: [],
    taskId: 'task-123',
    onCodeRefsChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('empty state', () => {
    it('shows empty message when no code refs', () => {
      render(<TaskCodeRefs {...defaultProps} />);
      expect(screen.getByText('No code references')).toBeInTheDocument();
    });

    it('shows add button', () => {
      render(<TaskCodeRefs {...defaultProps} />);
      expect(screen.getByRole('button', { name: /add code reference/i })).toBeInTheDocument();
    });
  });

  describe('displaying code refs', () => {
    const codeRefs = [
      { path: 'src/main.rs', line_start: 42, line_end: null, name: 'main function', description: 'Entry point' },
      { path: 'src/lib.rs', line_start: 10, line_end: 20, name: null, description: null },
      { path: 'README.md', line_start: null, line_end: null, name: null, description: null },
    ];

    it('displays all code refs', () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      expect(screen.getByText('src/main.rs')).toBeInTheDocument();
      expect(screen.getByText('src/lib.rs')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    it('displays name when present', () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);
      expect(screen.getByText('main function')).toBeInTheDocument();
    });

    it('displays description when present', () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);
      expect(screen.getByText('Entry point')).toBeInTheDocument();
    });

    it('displays line range correctly for single line', () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);
      expect(screen.getByText('L42')).toBeInTheDocument();
    });

    it('displays line range correctly for range', () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);
      expect(screen.getByText('L10-20')).toBeInTheDocument();
    });
  });

  describe('adding code refs', () => {
    it('shows form when add button is clicked', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      expect(screen.getByPlaceholderText(/file path/i)).toBeInTheDocument();
    });

    it('shows warning dot in add form', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const warningDot = document.querySelector('.bg-warning');
      expect(warningDot).toBeInTheDocument();
    });

    it('calls addCodeRef command on save', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/new-file.rs');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(bindingsModule.commands.addCodeRef).toHaveBeenCalledWith(
          'task-123',
          'src/new-file.rs',
          null,
          null,
          null,
          null
        );
      });
    });

    it('parses path with line number', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/file.rs:L42');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(bindingsModule.commands.addCodeRef).toHaveBeenCalledWith(
          'task-123',
          'src/file.rs',
          42,
          null,
          null,
          null
        );
      });
    });

    it('parses path with line range', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/file.rs:L10-20');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(bindingsModule.commands.addCodeRef).toHaveBeenCalledWith(
          'task-123',
          'src/file.rs',
          10,
          20,
          null,
          null
        );
      });
    });

    it('calls onCodeRefsChanged after successful add', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/file.rs');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(defaultProps.onCodeRefsChanged).toHaveBeenCalled();
      });
    });

    it('shows error when path is empty', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(screen.getByText('Path is required')).toBeInTheDocument();
    });

    it('cancels add form on escape', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));
      expect(screen.getByPlaceholderText(/file path/i)).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByPlaceholderText(/file path/i)).not.toBeInTheDocument();
    });

    it('cancels add form on cancel button click', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByPlaceholderText(/file path/i)).not.toBeInTheDocument();
    });
  });

  describe('editing code refs', () => {
    const codeRefs = [
      { path: 'src/main.rs', line_start: 42, line_end: null, name: 'main', description: 'Entry point' },
    ];

    it('enters edit mode on click', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));

      expect(screen.getByDisplayValue('src/main.rs')).toBeInTheDocument();
    });

    it('populates form with existing values', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));

      expect(screen.getByDisplayValue('src/main.rs')).toBeInTheDocument();
      expect(screen.getByDisplayValue('42')).toBeInTheDocument();
      expect(screen.getByDisplayValue('main')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Entry point')).toBeInTheDocument();
    });

    it('calls editCodeRef command on save', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));

      const pathInput = screen.getByDisplayValue('src/main.rs');
      await userEvent.clear(pathInput);
      await userEvent.type(pathInput, 'src/updated.rs');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(bindingsModule.commands.editCodeRef).toHaveBeenCalledWith(
          'task-123',
          0,
          'src/updated.rs',
          42,
          null,
          'main',
          'Entry point'
        );
      });
    });

    it('shows delete button in edit mode', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));

      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('cancels edit on escape', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));
      expect(screen.getByDisplayValue('src/main.rs')).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByDisplayValue('src/main.rs')).not.toBeInTheDocument();
      expect(screen.getByText('src/main.rs')).toBeInTheDocument();
    });
  });

  describe('deleting code refs', () => {
    const codeRefs = [
      { path: 'src/main.rs', line_start: 42, line_end: null, name: 'main', description: null },
    ];

    it('calls removeCodeRef command when delete is clicked', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      // Enter edit mode
      await userEvent.click(screen.getByText('src/main.rs'));

      // Click delete
      await userEvent.click(screen.getByRole('button', { name: /delete/i }));

      await waitFor(() => {
        expect(bindingsModule.commands.removeCodeRef).toHaveBeenCalledWith('task-123', 0);
      });
    });

    it('calls onCodeRefsChanged after successful delete', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      await userEvent.click(screen.getByText('src/main.rs'));
      await userEvent.click(screen.getByRole('button', { name: /delete/i }));

      await waitFor(() => {
        expect(defaultProps.onCodeRefsChanged).toHaveBeenCalled();
      });
    });
  });

  describe('copy functionality', () => {
    const codeRefs = [
      { path: 'src/main.rs', line_start: 42, line_end: null, name: null, description: null },
    ];

    it('shows copy button on hover', async () => {
      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      const copyButton = screen.getByRole('button', { name: /copy path/i });
      expect(copyButton).toBeInTheDocument();
    });

    it('copies path to clipboard', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });

      render(<TaskCodeRefs {...defaultProps} codeRefs={codeRefs} />);

      const copyButton = screen.getByRole('button', { name: /copy path/i });
      await userEvent.click(copyButton);

      expect(mockWriteText).toHaveBeenCalledWith('src/main.rs:L42');
    });
  });

  describe('keyboard shortcuts', () => {
    it('saves on Ctrl+Enter in add form', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/file.rs');

      fireEvent.keyDown(pathInput, { key: 'Enter', ctrlKey: true });

      await waitFor(() => {
        expect(bindingsModule.commands.addCodeRef).toHaveBeenCalled();
      });
    });

    it('saves on Cmd+Enter in add form (Mac)', async () => {
      render(<TaskCodeRefs {...defaultProps} />);

      await userEvent.click(screen.getByRole('button', { name: /add code reference/i }));

      const pathInput = screen.getByPlaceholderText(/file path/i);
      await userEvent.type(pathInput, 'src/file.rs');

      fireEvent.keyDown(pathInput, { key: 'Enter', metaKey: true });

      await waitFor(() => {
        expect(bindingsModule.commands.addCodeRef).toHaveBeenCalled();
      });
    });
  });
});
