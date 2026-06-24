import { describe, it, expect, vi } from "vitest";
import { render } from "../test/test-utils";

const mockUseTaskChangeListener = vi.fn();
const mockUseTaskRunChangeListener = vi.fn();
const mockUseWorkflowChangeListener = vi.fn();
const mockUseStepChangeListener = vi.fn();
const mockUseStepExecutionChangeListener = vi.fn();
const mockUseSectionChangeListener = vi.fn();
const mockUseSessionLogChangeListener = vi.fn();
const mockUseStepTransitionChangeListener = vi.fn();

vi.mock("../hooks", () => ({
  useTaskChangeListener: (...args: unknown[]) =>
    mockUseTaskChangeListener(...args),
  useTaskRunChangeListener: (...args: unknown[]) =>
    mockUseTaskRunChangeListener(...args),
  useWorkflowChangeListener: (...args: unknown[]) =>
    mockUseWorkflowChangeListener(...args),
  useStepChangeListener: (...args: unknown[]) =>
    mockUseStepChangeListener(...args),
  useStepExecutionChangeListener: (...args: unknown[]) =>
    mockUseStepExecutionChangeListener(...args),
  useSectionChangeListener: (...args: unknown[]) =>
    mockUseSectionChangeListener(...args),
  useSessionLogChangeListener: (...args: unknown[]) =>
    mockUseSessionLogChangeListener(...args),
  useStepTransitionChangeListener: (...args: unknown[]) =>
    mockUseStepTransitionChangeListener(...args),
}));

import { GlobalListeners } from "./GlobalListeners";

describe("GlobalListeners", () => {
  it("renders nothing visible", () => {
    const { container } = render(<GlobalListeners />);
    expect(container.innerHTML).toBe("");
  });

  it("activates all listener hooks", () => {
    render(<GlobalListeners />);

    expect(mockUseTaskChangeListener).toHaveBeenCalled();
    expect(mockUseTaskRunChangeListener).toHaveBeenCalled();
    expect(mockUseWorkflowChangeListener).toHaveBeenCalled();
    expect(mockUseStepChangeListener).toHaveBeenCalled();
    expect(mockUseStepExecutionChangeListener).toHaveBeenCalled();
    expect(mockUseSectionChangeListener).toHaveBeenCalled();
    expect(mockUseSessionLogChangeListener).toHaveBeenCalled();
    expect(mockUseStepTransitionChangeListener).toHaveBeenCalled();
  });

  it("calls each listener hook with no arguments (base store-level subscription)", () => {
    render(<GlobalListeners />);

    expect(mockUseTaskChangeListener).toHaveBeenCalledWith();
    expect(mockUseTaskRunChangeListener).toHaveBeenCalledWith();
    expect(mockUseWorkflowChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepExecutionChangeListener).toHaveBeenCalledWith();
    expect(mockUseSectionChangeListener).toHaveBeenCalledWith();
    expect(mockUseSessionLogChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepTransitionChangeListener).toHaveBeenCalledWith();
  });
});
