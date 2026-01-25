import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useExecutionLogs } from "./useExecutionLogs";
import { commands, SessionLog } from "../bindings";

// Mock the bindings commands
vi.mock("../bindings", () => ({
  commands: {
    getExecutionLogs: vi.fn(),
  },
}));

const mockGetExecutionLogs = vi.mocked(commands.getExecutionLogs);

describe("useExecutionLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with empty state", () => {
    const { result } = renderHook(() => useExecutionLogs());

    expect(result.current.logs).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hasFetched).toBe(false);
  });

  it("fetches logs when fetchLogs is called", async () => {
    const mockLogs: SessionLog[] = [
      {
        id: "log-1",
        step_execution_id: "exec-1",
        content: "Log content 1",
        created_at: "2024-01-01T10:00:00Z",
      },
      {
        id: "log-2",
        step_execution_id: "exec-1",
        content: "Log content 2",
        created_at: "2024-01-01T10:01:00Z",
      },
    ];

    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: mockLogs,
    });

    const { result } = renderHook(() => useExecutionLogs());

    await act(async () => {
      await result.current.fetchLogs("exec-1");
    });

    expect(mockGetExecutionLogs).toHaveBeenCalledWith("exec-1");
    expect(result.current.logs).toHaveLength(2);
    expect(result.current.hasFetched).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sorts logs in descending order (newest first)", async () => {
    const mockLogs: SessionLog[] = [
      {
        id: "log-1",
        step_execution_id: "exec-1",
        content: "Oldest log",
        created_at: "2024-01-01T10:00:00Z",
      },
      {
        id: "log-2",
        step_execution_id: "exec-1",
        content: "Newest log",
        created_at: "2024-01-01T12:00:00Z",
      },
      {
        id: "log-3",
        step_execution_id: "exec-1",
        content: "Middle log",
        created_at: "2024-01-01T11:00:00Z",
      },
    ];

    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: mockLogs,
    });

    const { result } = renderHook(() => useExecutionLogs());

    await act(async () => {
      await result.current.fetchLogs("exec-1");
    });

    expect(result.current.logs[0].content).toBe("Newest log");
    expect(result.current.logs[1].content).toBe("Middle log");
    expect(result.current.logs[2].content).toBe("Oldest log");
  });

  it("sets loading state during fetch", async () => {
    let resolvePromise: ((value: unknown) => void) | undefined;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    mockGetExecutionLogs.mockReturnValue(promise as never);

    const { result } = renderHook(() => useExecutionLogs());

    act(() => {
      result.current.fetchLogs("exec-1");
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    await act(async () => {
      resolvePromise!({ status: "ok", data: [] });
      await promise;
    });

    expect(result.current.isLoading).toBe(false);
  });

  it("handles error responses", async () => {
    mockGetExecutionLogs.mockResolvedValue({
      status: "error",
      error: { message: "Failed to fetch logs" },
    });

    const { result } = renderHook(() => useExecutionLogs());

    await act(async () => {
      await result.current.fetchLogs("exec-1");
    });

    expect(result.current.error).toBe("Failed to fetch logs");
    expect(result.current.logs).toEqual([]);
    expect(result.current.hasFetched).toBe(true);
  });

  it("handles thrown errors", async () => {
    mockGetExecutionLogs.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useExecutionLogs());

    await act(async () => {
      await result.current.fetchLogs("exec-1");
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.logs).toEqual([]);
    expect(result.current.hasFetched).toBe(true);
  });

  it("resets state correctly", async () => {
    const mockLogs: SessionLog[] = [
      {
        id: "log-1",
        step_execution_id: "exec-1",
        content: "Log content",
        created_at: "2024-01-01T10:00:00Z",
      },
    ];

    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: mockLogs,
    });

    const { result } = renderHook(() => useExecutionLogs());

    await act(async () => {
      await result.current.fetchLogs("exec-1");
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.hasFetched).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.logs).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hasFetched).toBe(false);
  });
});
