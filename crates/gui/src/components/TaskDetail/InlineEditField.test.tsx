import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEditField } from './InlineEditField';

describe('InlineEditField', () => {
  const defaultProps = {
    value: 'Test value',
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('display mode', () => {
    it('renders the current value', () => {
      render(<InlineEditField {...defaultProps} />);
      expect(screen.getByText('Test value')).toBeInTheDocument();
    });

    it('renders placeholder when value is empty', () => {
      render(<InlineEditField {...defaultProps} value="" placeholder="Click to edit" />);
      expect(screen.getByText('Click to edit')).toBeInTheDocument();
    });

    it('uses default placeholder when none provided', () => {
      render(<InlineEditField {...defaultProps} value="" />);
      expect(screen.getByText('Click to edit')).toBeInTheDocument();
    });

    it('enters edit mode on click', async () => {
      render(<InlineEditField {...defaultProps} />);

      const displayElement = screen.getByText('Test value');
      await userEvent.click(displayElement);

      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue('Test value');
    });
  });

  describe('edit mode', () => {
    it('shows input field with current value', async () => {
      render(<InlineEditField {...defaultProps} />);
      await userEvent.click(screen.getByText('Test value'));

      const input = screen.getByRole('textbox');
      expect(input).toHaveValue('Test value');
    });

    it('shows check and cancel buttons', async () => {
      render(<InlineEditField {...defaultProps} />);
      await userEvent.click(screen.getByText('Test value'));

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('shows warning dot indicator when editing', async () => {
      render(<InlineEditField {...defaultProps} />);
      await userEvent.click(screen.getByText('Test value'));

      // The warning dot has a specific class
      const warningDot = document.querySelector('.bg-warning');
      expect(warningDot).toBeInTheDocument();
    });

    it('calls onSave with new value when check button is clicked', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith('New value');
      });
    });

    it('cancels edit when cancel button is clicked', async () => {
      render(<InlineEditField {...defaultProps} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');

      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.getByText('Test value')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('cancels edit on Escape key', async () => {
      render(<InlineEditField {...defaultProps} />);

      await userEvent.click(screen.getByText('Test value'));
      await userEvent.keyboard('{Escape}');

      expect(screen.getByText('Test value')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('saves on Enter key for input', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value{Enter}');

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith('New value');
      });
    });

    it('does not save when value unchanged', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByText('Test value')).toBeInTheDocument();
    });
  });

  describe('multiline mode', () => {
    it('renders textarea when multiline is true', async () => {
      render(<InlineEditField {...defaultProps} multiline rows={4} />);
      await userEvent.click(screen.getByText('Test value'));

      expect(screen.getByRole('textbox')).toHaveAttribute('rows', '4');
    });

    it('requires Ctrl+Enter to save in multiline mode', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} multiline />);

      await userEvent.click(screen.getByText('Test value'));
      const textarea = screen.getByRole('textbox');
      await userEvent.clear(textarea);
      await userEvent.type(textarea, 'New value');

      // Regular Enter should not save
      await userEvent.keyboard('{Enter}');
      expect(onSave).not.toHaveBeenCalled();

      // Ctrl+Enter should save
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

      await waitFor(() => {
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe('validation', () => {
    it('shows error when validation fails', async () => {
      const validate = vi.fn().mockReturnValue('Invalid input');
      render(<InlineEditField {...defaultProps} validate={validate} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'Bad value');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(screen.getByText('Invalid input')).toBeInTheDocument();
    });

    it('shows error when empty value and allowEmpty is false', async () => {
      render(<InlineEditField {...defaultProps} allowEmpty={false} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(screen.getByText('This field cannot be empty')).toBeInTheDocument();
    });

    it('clears error when input changes', async () => {
      render(<InlineEditField {...defaultProps} allowEmpty={false} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(screen.getByText('This field cannot be empty')).toBeInTheDocument();

      await userEvent.type(input, 'New value');
      expect(screen.queryByText('This field cannot be empty')).not.toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows error when onSave throws', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText('Save failed')).toBeInTheDocument();
      });
    });

    it('shows generic error when onSave throws non-Error', async () => {
      const onSave = vi.fn().mockRejectedValue('Unknown error');
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to save')).toBeInTheDocument();
      });
    });
  });

  describe('submitting state', () => {
    it('disables input and buttons while submitting', async () => {
      const onSave = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByRole('textbox')).toBeDisabled();
        expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
      });
    });

    it('shows spinner while submitting', async () => {
      const onSave = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      await userEvent.click(screen.getByText('Test value'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.type(input, 'New value');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).toBeInTheDocument();
      });
    });
  });

  describe('startInEditMode', () => {
    it('starts in edit mode when startInEditMode is true', () => {
      render(<InlineEditField {...defaultProps} value="" startInEditMode />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('does not select text when starting in edit mode (add mode)', () => {
      render(<InlineEditField {...defaultProps} value="existing" startInEditMode />);
      const input = screen.getByRole('textbox');
      // In add mode, text should not be selected
      expect(input).toHaveFocus();
    });
  });

  describe('onCancel callback', () => {
    it('calls onCancel when cancel button is clicked', async () => {
      const onCancel = vi.fn();
      render(<InlineEditField {...defaultProps} startInEditMode onCancel={onCancel} />);

      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancel).toHaveBeenCalled();
    });

    it('calls onCancel when Escape is pressed', async () => {
      const onCancel = vi.fn();
      render(<InlineEditField {...defaultProps} startInEditMode onCancel={onCancel} />);

      await userEvent.keyboard('{Escape}');
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('clearOnSave', () => {
    it('clears input after successful save when clearOnSave is true', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <InlineEditField
          {...defaultProps}
          value=""
          onSave={onSave}
          startInEditMode
          clearOnSave
        />
      );

      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'New value{Enter}');

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith('New value');
        expect(input).toHaveValue('');
      });
    });
  });

  describe('compact mode', () => {
    it('renders with compact styling when compact is true', async () => {
      render(<InlineEditField {...defaultProps} compact />);
      await userEvent.click(screen.getByText('Test value'));

      // The input should have compact padding
      const input = screen.getByRole('textbox');
      expect(input).toHaveClass('px-2', 'py-1');
    });
  });

  describe('prefix', () => {
    it('renders prefix element when provided', async () => {
      const prefix = <span data-testid="custom-prefix">Prefix</span>;
      render(<InlineEditField {...defaultProps} prefix={prefix} />);
      await userEvent.click(screen.getByText('Test value'));

      expect(screen.getByTestId('custom-prefix')).toBeInTheDocument();
    });
  });

  describe('onDelete', () => {
    it('shows delete button when onDelete is provided', async () => {
      const onDelete = vi.fn();
      render(<InlineEditField {...defaultProps} onDelete={onDelete} />);
      await userEvent.click(screen.getByText('Test value'));

      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('does not show delete button when onDelete is not provided', async () => {
      render(<InlineEditField {...defaultProps} />);
      await userEvent.click(screen.getByText('Test value'));

      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('calls onDelete when delete button is clicked', async () => {
      const onDelete = vi.fn();
      render(<InlineEditField {...defaultProps} onDelete={onDelete} />);
      await userEvent.click(screen.getByText('Test value'));

      await userEvent.click(screen.getByRole('button', { name: /delete/i }));
      expect(onDelete).toHaveBeenCalled();
    });

    it('disables all buttons when isDeleting is true', async () => {
      const onDelete = vi.fn();
      render(<InlineEditField {...defaultProps} onDelete={onDelete} isDeleting startInEditMode />);

      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
    });

    it('disables input when isDeleting is true', async () => {
      const onDelete = vi.fn();
      render(<InlineEditField {...defaultProps} onDelete={onDelete} isDeleting startInEditMode />);

      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('shows spinner on delete button when isDeleting is true', async () => {
      const onDelete = vi.fn();
      render(<InlineEditField {...defaultProps} onDelete={onDelete} isDeleting startInEditMode />);

      // The spinner has animate-spin class
      const deleteButton = screen.getByRole('button', { name: /delete/i });
      expect(deleteButton.querySelector('.animate-spin')).toBeInTheDocument();
    });
  });
});
