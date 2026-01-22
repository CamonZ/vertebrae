import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { FormModal } from "./FormModal";

describe("FormModal", () => {
  describe("rendering", () => {
    it("renders modal when isOpen is true", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Edit Task"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Modal content</div>
        </FormModal>
      );

      expect(screen.getByText("Edit Task")).toBeInTheDocument();
      expect(screen.getByText("Modal content")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("does not render modal when isOpen is false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={false}
          title="Edit Task"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Modal content</div>
        </FormModal>
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders title text in header", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Task Details"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.getByText("Task Details")).toBeInTheDocument();
    });

    it("renders children content in body", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div data-testid="modal-content">
            <p>This is the form content</p>
          </div>
        </FormModal>
      );

      expect(screen.getByTestId("modal-content")).toBeInTheDocument();
      expect(screen.getByText("This is the form content")).toBeInTheDocument();
    });
  });

  describe("button behavior", () => {
    it("calls onClose when cancel button is clicked", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it("calls onSubmit when submit button is clicked", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const submitButton = screen.getByRole("button", { name: /submit/i });
      fireEvent.click(submitButton);

      expect(handleSubmit).toHaveBeenCalledTimes(1);
    });

    it("disables cancel button during submission", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventCloseDuringSubmit={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      expect(cancelButton).toBeDisabled();
      expect(cancelButton).toHaveClass("opacity-50");
      expect(cancelButton).toHaveClass("cursor-not-allowed");
    });

    it("disables submit button during submission", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const submitButton = screen.getByRole("button", { name: /submit/i });
      expect(submitButton).toBeDisabled();
      expect(submitButton).toHaveClass("bg-primary/80");
      expect(submitButton).toHaveClass("cursor-not-allowed");
    });

    it("shows loading spinner on submit button when isSubmitting=true", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const submitButton = screen.getByRole("button", { name: /submit/i });
      const spinner = submitButton.querySelector("svg.animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    it("does not show loading spinner on submit button when isSubmitting=false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={false}
        >
          <div>Content</div>
        </FormModal>
      );

      const submitButton = screen.getByRole("button", { name: /submit/i });
      const spinner = submitButton.querySelector("svg.animate-spin");
      expect(spinner).not.toBeInTheDocument();
    });
  });

  describe("backdrop click", () => {
    it("calls onClose when backdrop is clicked", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.click(modal);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when backdrop is clicked during submission", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventBackdropClickDuringSubmit={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.click(modal);

      expect(handleClose).not.toHaveBeenCalled();
    });

    it("calls onClose when backdrop is clicked during submission if preventBackdropClickDuringSubmit=false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventBackdropClickDuringSubmit={false}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.click(modal);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("keyboard navigation", () => {
    it("calls onClose when Escape key is pressed", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.keyDown(modal, { key: "Escape" });

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when Escape key is pressed during submission", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventCloseDuringSubmit={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.keyDown(modal, { key: "Escape" });

      expect(handleClose).not.toHaveBeenCalled();
    });

    it("calls onClose when Escape key is pressed during submission if preventCloseDuringSubmit=false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventCloseDuringSubmit={false}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      fireEvent.keyDown(modal, { key: "Escape" });

      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("error banner", () => {
    it("renders error message when error prop is set", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          error="Something went wrong"
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("does not render error banner when error prop is not set", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("renders error banner with correct styling", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          error="Error message"
        >
          <div>Content</div>
        </FormModal>
      );

      const errorBanner = screen.getByRole("alert");
      expect(errorBanner).toHaveClass("bg-error/10");
      expect(errorBanner).toHaveClass("border-error");

      const icon = errorBanner.querySelector("svg");
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveClass("text-error");
    });

    it("shows dismiss button in error banner", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          error="Error message"
        >
          <div>Content</div>
        </FormModal>
      );

      const dismissButton = screen.getByLabelText("Dismiss error");
      expect(dismissButton).toBeInTheDocument();
    });
  });

  describe("close button", () => {
    it("renders close button (X) in header by default", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const closeButton = screen.getByLabelText("Close modal");
      expect(closeButton).toBeInTheDocument();
    });

    it("does not render close button when showCloseButton is false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          showCloseButton={false}
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.queryByLabelText("Close modal")).not.toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const closeButton = screen.getByLabelText("Close modal");
      fireEvent.click(closeButton);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it("disables close button during submission", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          isSubmitting={true}
          preventCloseDuringSubmit={true}
        >
          <div>Content</div>
        </FormModal>
      );

      const closeButton = screen.getByLabelText("Close modal");
      expect(closeButton).toBeDisabled();
      expect(closeButton).toHaveClass("opacity-50");
      expect(closeButton).toHaveClass("cursor-not-allowed");
    });
  });

  describe("button text customization", () => {
    it("renders custom cancel button text", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          cancelButtonText="Close"
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    it("renders custom submit button text", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          submitButtonText="Save"
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });
  });

  describe("button visibility", () => {
    it("does not render cancel button when showCancelButton is false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          showCancelButton={false}
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("does not render submit button when showSubmitButton is false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          showSubmitButton={false}
        >
          <div>Content</div>
        </FormModal>
      );

      expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
    });
  });

  describe("fullscreen mode", () => {
    it("applies fullscreen classes when fullscreen is true", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          fullscreen
        >
          <div>Content</div>
        </FormModal>
      );

      const modalContent = container.querySelector('[role="document"]');
      expect(modalContent).toHaveClass("inset-0");
      expect(modalContent).toHaveClass("m-0");
      expect(modalContent).toHaveClass("rounded-none");
    });

    it("does not apply fullscreen classes when fullscreen is false", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          fullscreen={false}
        >
          <div>Content</div>
        </FormModal>
      );

      const modalContent = container.querySelector('[role="document"]');
      expect(modalContent).not.toHaveClass("inset-0");
      expect(modalContent).not.toHaveClass("m-0");
      expect(modalContent).not.toHaveClass("rounded-none");
    });
  });

  describe("accessibility attributes", () => {
    it("sets proper aria attributes", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Edit Task"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      expect(modal).toHaveAttribute("aria-modal", "true");
      expect(modal).toHaveAttribute("aria-hidden", "false");

      const title = screen.getByText("Edit Task");
      expect(title).toHaveAttribute("id");
    });

    it("sets aria-hidden to false when modal is open", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = screen.getByRole("dialog");
      expect(modal).toHaveAttribute("aria-hidden", "false");
    });

    it("sets aria-hidden to true when modal is closed", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      render(
        <FormModal
          isOpen={false}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
        >
          <div>Content</div>
        </FormModal>
      );

      // Modal is not rendered, so we can't test aria-hidden
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("styling classes", () => {
    it("applies custom className to modal wrapper", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          className="custom-modal-class"
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = container.firstChild;
      expect(modal).toHaveClass("custom-modal-class");
    });

    it("applies custom contentClassName to modal content", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          contentClassName="custom-content-class"
        >
          <div>Content</div>
        </FormModal>
      );

      const modalContent = container.querySelector('[role="document"]');
      expect(modalContent).toHaveClass("custom-content-class");
    });

    it("applies custom headerClassName to header", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          headerClassName="custom-header-class"
        >
          <div>Content</div>
        </FormModal>
      );

      const header = container.querySelector("h2")?.parentElement;
      expect(header).toHaveClass("custom-header-class");
    });

    it("applies custom footerClassName to footer", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          footerClassName="custom-footer-class"
        >
          <div>Content</div>
        </FormModal>
      );

      const footer = container.querySelector("div[class*='custom-footer-class']");
      expect(footer).toBeInTheDocument();
    });
  });

  describe("HTML attributes pass-through", () => {
    it("forwards HTML attributes to modal wrapper", () => {
      const handleClose = vi.fn();
      const handleSubmit = vi.fn();

      const { container } = render(
        <FormModal
          isOpen={true}
          title="Title"
          onClose={handleClose}
          onSubmit={handleSubmit}
          data-testid="modal-wrapper"
          aria-describedby="help"
        >
          <div>Content</div>
        </FormModal>
      );

      const modal = container.firstChild;
      expect(modal).toHaveAttribute("data-testid", "modal-wrapper");
      expect(modal).toHaveAttribute("aria-describedby", "help");
    });
  });

  describe("ref forwarding", () => {
    it("forwards ref to modal wrapper", () => {
      let refElement: HTMLDivElement | null = null;
      const TestComponent = () => {
        const ref = (el: HTMLDivElement | null) => {
          refElement = el;
        };
        return (
          <FormModal
            ref={ref}
            isOpen={true}
            title="Title"
            onClose={vi.fn()}
            onSubmit={vi.fn()}
          >
            <div>Content</div>
          </FormModal>
        );
      };
      render(<TestComponent />);

      expect(refElement).toBeInstanceOf(HTMLDivElement);
      expect(refElement).toHaveClass("z-50");
    });
  });

  describe("displayName", () => {
    it("has displayName set for debugging", () => {
      expect(FormModal.displayName).toBe("FormModal");
    });
  });
});