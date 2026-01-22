import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog';

describe('DeleteConfirmationDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    isDeleting: false,
    cascade: false,
    onCascadeChange: vi.fn(),
    taskTitle: 'Test Task',
    childCount: 0,
  };

  it('should render when isOpen is true', () => {
    render(<DeleteConfirmationDialog {...defaultProps} />);
    expect(screen.getByText('Delete Task')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <DeleteConfirmationDialog {...defaultProps} isOpen={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('should display the task title in confirmation message', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        taskTitle="Important Task"
      />
    );
    expect(screen.getByText(/Important Task/)).toBeInTheDocument();
  });

  it('should call onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should call onConfirm when Delete button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('should show child task info when childCount > 0', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={3}
      />
    );
    expect(screen.getByText(/This task has 3 child tasks/)).toBeInTheDocument();
    expect(screen.getByText(/Delete all child tasks/)).toBeInTheDocument();
    expect(screen.getByText(/Keep child tasks without parent/)).toBeInTheDocument();
  });

  it('should show singular when childCount is 1', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={1}
      />
    );
    expect(screen.getByText(/This task has 1 child task/)).toBeInTheDocument();
  });

  it('should not show child options when childCount is 0', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={0}
      />
    );
    expect(screen.queryByText(/Delete all child tasks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Keep child tasks without parent/)).not.toBeInTheDocument();
    expect(screen.getByText(/no child tasks/)).toBeInTheDocument();
  });

  it('should call onCascadeChange when cascade toggle changes', () => {
    const onCascadeChange = vi.fn();
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={2}
        cascade={false}
        onCascadeChange={onCascadeChange}
      />
    );

    const cascadeCheckbox = screen.getByRole('checkbox', {
      name: /Cascade delete child tasks/i,
    });
    fireEvent.click(cascadeCheckbox);
    expect(onCascadeChange).toHaveBeenCalledWith(true);
  });

  it('should show error message when error prop is set', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        error="Failed to delete task"
      />
    );
    expect(screen.getByText('Failed to delete task')).toBeInTheDocument();
  });

  it('should disable buttons when isDeleting is true', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        isDeleting={true}
      />
    );
    const deleteButton = screen.getByRole('button', { name: /Deleting/i });
    expect(deleteButton).toBeDisabled();
  });

  it('should show loading text in Delete button when isDeleting is true', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        isDeleting={true}
      />
    );
    expect(screen.getByText('Deleting...')).toBeInTheDocument();
  });

  it('should call onCascadeChange when orphan checkbox changes', () => {
    const onCascadeChange = vi.fn();
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={2}
        cascade={false}
        onCascadeChange={onCascadeChange}
      />
    );

    const orphanCheckbox = screen.getByRole('checkbox', {
      name: /Keep child tasks without parent/i,
    });
    fireEvent.click(orphanCheckbox);
    expect(onCascadeChange).toHaveBeenCalledWith(true);
  });

  it('should check cascade option when cascade is true', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={2}
        cascade={true}
      />
    );

    const cascadeCheckbox = screen.getByRole('checkbox', {
      name: /Cascade delete child tasks/i,
    });
    expect(cascadeCheckbox).toBeChecked();
  });

  it('should disable checkboxes when isDeleting is true', () => {
    render(
      <DeleteConfirmationDialog
        {...defaultProps}
        childCount={2}
        isDeleting={true}
      />
    );

    const cascadeCheckbox = screen.getByRole('checkbox', {
      name: /Cascade delete child tasks/i,
    });
    expect(cascadeCheckbox).toBeDisabled();
  });
});
