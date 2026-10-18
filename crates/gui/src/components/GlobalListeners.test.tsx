import { describe, it, expect, vi } from "vitest";
import { render } from "../test/test-utils";

const mockUseTaskChangeListener = vi.fn();
const mockUseArtifactChangeListener = vi.fn();
const mockUseDaemonChangeListener = vi.fn();
const mockUseTaskRunChangeListener = vi.fn();
const mockUseWorkflowChangeListener = vi.fn();
const mockUseStepChangeListener = vi.fn();
const mockUseStepExecutionChangeListener = vi.fn();
const mockUseSectionChangeListener = vi.fn();
const mockUseNotificationChangeListener = vi.fn();
const mockUseSessionLogChangeListener = vi.fn();
const mockUseStepTransitionChangeListener = vi.fn();
const mockUseWorkflowTransitionChangeListener = vi.fn();
const mockUseLocalChatEventRouter = vi.fn();
const mockUseGateChatSync = vi.fn();

vi.mock("../hooks", () => ({
  useArtifactChangeListener: (...args: unknown[]) =>
    mockUseArtifactChangeListener(...args),
  useDaemonChangeListener: (...args: unknown[]) =>
    mockUseDaemonChangeListener(...args),
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
  useNotificationChangeListener: (...args: unknown[]) =>
    mockUseNotificationChangeListener(...args),
  useSessionLogChangeListener: (...args: unknown[]) =>
    mockUseSessionLogChangeListener(...args),
  useStepTransitionChangeListener: (...args: unknown[]) =>
    mockUseStepTransitionChangeListener(...args),
  useWorkflowTransitionChangeListener: (...args: unknown[]) =>
    mockUseWorkflowTransitionChangeListener(...args),
}));

vi.mock("../hooks/useLocalChatEventRouter", () => ({
  useLocalChatEventRouter: (...args: unknown[]) =>
    mockUseLocalChatEventRouter(...args),
}));

vi.mock("../hooks/useGateChatSync", () => ({
  useGateChatSync: (...args: unknown[]) => mockUseGateChatSync(...args),
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
    expect(mockUseArtifactChangeListener).toHaveBeenCalled();
    expect(mockUseDaemonChangeListener).toHaveBeenCalled();
    expect(mockUseTaskRunChangeListener).toHaveBeenCalled();
    expect(mockUseWorkflowChangeListener).toHaveBeenCalled();
    expect(mockUseStepChangeListener).toHaveBeenCalled();
    expect(mockUseStepExecutionChangeListener).toHaveBeenCalled();
    expect(mockUseSectionChangeListener).toHaveBeenCalled();
    expect(mockUseNotificationChangeListener).toHaveBeenCalled();
    expect(mockUseSessionLogChangeListener).toHaveBeenCalled();
    expect(mockUseStepTransitionChangeListener).toHaveBeenCalled();
    expect(mockUseWorkflowTransitionChangeListener).toHaveBeenCalled();
    expect(mockUseLocalChatEventRouter).toHaveBeenCalled();
    expect(mockUseGateChatSync).toHaveBeenCalled();
  });

  it("calls each listener hook with no arguments (base store-level subscription)", () => {
    render(<GlobalListeners />);

    expect(mockUseTaskChangeListener).toHaveBeenCalledWith();
    expect(mockUseArtifactChangeListener).toHaveBeenCalledWith();
    expect(mockUseDaemonChangeListener).toHaveBeenCalledWith();
    expect(mockUseTaskRunChangeListener).toHaveBeenCalledWith();
    expect(mockUseWorkflowChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepExecutionChangeListener).toHaveBeenCalledWith();
    expect(mockUseSectionChangeListener).toHaveBeenCalledWith();
    expect(mockUseNotificationChangeListener).toHaveBeenCalledWith();
    expect(mockUseSessionLogChangeListener).toHaveBeenCalledWith();
    expect(mockUseStepTransitionChangeListener).toHaveBeenCalledWith();
    expect(mockUseWorkflowTransitionChangeListener).toHaveBeenCalledWith();
    expect(mockUseLocalChatEventRouter).toHaveBeenCalledWith();
  });
});
