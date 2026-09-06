import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, queryKeys } from "../query";

const mockGetSacrumConnectionIdentity = vi.fn();
const mockGetDaemon = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getSacrumConnectionIdentity: (...args: unknown[]) =>
      mockGetSacrumConnectionIdentity(...args),
    getDaemon: (...args: unknown[]) => mockGetDaemon(...args),
  },
}));

import { useDaemonDetail } from "./useDaemonDetail";
import type { Daemon, DaemonDetailSnapshot } from "../bindings";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const daemon: Daemon = {
  id: "33333333-3333-3333-3333-333333333333",
  status: "active",
  name: "Farm bot",
  display_name: "Farm bot",
  enrolled_at: "2026-09-05T11:00:00+00:00",
  removed_at: null,
  created_at: "2026-09-05T10:00:00+00:00",
  updated_at: "2026-09-05T10:00:00+00:00",
};

function detailSnapshot(
  connectionId: string,
  daemon: Daemon | null
): DaemonDetailSnapshot {
  return { connection_id: connectionId, daemon };
}

describe("useDaemonDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mockGetSacrumConnectionIdentity.mockResolvedValue({
      status: "ok",
      data: "identity-a",
    });
    mockGetDaemon.mockResolvedValue({
      status: "ok",
      data: detailSnapshot("identity-a", daemon),
    });
  });

  it("fetches the daemon detail under the resolved connection", async () => {
    const { result } = renderHook(() => useDaemonDetail(daemon.id), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual(daemon));
    expect(mockGetDaemon).toHaveBeenCalledWith(daemon.id);
    expect(mockGetDaemon).toHaveBeenCalledTimes(1);
    expect(result.current.connectionId).toBe("identity-a");
    expect(result.current.error).toBeNull();
  });

  it("returns null when the backend reports the daemon is gone", async () => {
    mockGetDaemon.mockResolvedValue({
      status: "ok",
      data: detailSnapshot("identity-a", null),
    });

    const { result } = renderHook(() => useDaemonDetail(daemon.id), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("fetches even when a fleet cache entry already holds the daemon", async () => {
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), [daemon]);

    const { result } = renderHook(() => useDaemonDetail(daemon.id), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual(daemon));
    expect(mockGetDaemon).toHaveBeenCalledTimes(1);
  });
});
