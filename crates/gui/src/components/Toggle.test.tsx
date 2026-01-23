import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  const defaultProps = {
    checked: false,
    onChange: vi.fn(),
    label: "Test toggle",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders as a switch button", () => {
      render(<Toggle {...defaultProps} />);
      const toggle = screen.getByRole("switch");
      expect(toggle).toBeInTheDocument();
    });

    it("has correct aria-label", () => {
      render(<Toggle {...defaultProps} label="Enable feature" />);
      expect(screen.getByLabelText("Enable feature")).toBeInTheDocument();
    });

    it("shows unchecked state when checked is false", () => {
      render(<Toggle {...defaultProps} checked={false} />);
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("shows checked state when checked is true", () => {
      render(<Toggle {...defaultProps} checked={true} />);
      const toggle = screen.getByRole("switch");
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("colors", () => {
    it("uses primary color by default when checked", () => {
      render(<Toggle {...defaultProps} checked={true} />);
      const toggle = screen.getByRole("switch");
      expect(toggle.className).toContain("bg-primary");
    });

    it("uses warning color when activeColor is warning", () => {
      render(<Toggle {...defaultProps} checked={true} activeColor="warning" />);
      const toggle = screen.getByRole("switch");
      expect(toggle.className).toContain("bg-warning");
    });

    it("uses success color when activeColor is success", () => {
      render(<Toggle {...defaultProps} checked={true} activeColor="success" />);
      const toggle = screen.getByRole("switch");
      expect(toggle.className).toContain("bg-success");
    });

    it("uses error color when activeColor is error", () => {
      render(<Toggle {...defaultProps} checked={true} activeColor="error" />);
      const toggle = screen.getByRole("switch");
      expect(toggle.className).toContain("bg-error");
    });

    it("uses tertiary background when unchecked", () => {
      render(<Toggle {...defaultProps} checked={false} />);
      const toggle = screen.getByRole("switch");
      expect(toggle.className).toContain("bg-bg-tertiary");
    });
  });

  describe("interaction", () => {
    it("calls onChange with true when clicked while unchecked", async () => {
      const onChange = vi.fn();
      render(<Toggle {...defaultProps} checked={false} onChange={onChange} />);

      await userEvent.click(screen.getByRole("switch"));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("calls onChange with false when clicked while checked", async () => {
      const onChange = vi.fn();
      render(<Toggle {...defaultProps} checked={true} onChange={onChange} />);

      await userEvent.click(screen.getByRole("switch"));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it("does not call onChange when disabled", async () => {
      const onChange = vi.fn();
      render(<Toggle {...defaultProps} onChange={onChange} disabled />);

      await userEvent.click(screen.getByRole("switch"));

      expect(onChange).not.toHaveBeenCalled();
    });

    it("shows disabled styling when disabled", () => {
      render(<Toggle {...defaultProps} disabled />);
      const toggle = screen.getByRole("switch");
      expect(toggle).toBeDisabled();
    });
  });
});
