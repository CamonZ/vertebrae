import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../query";
import { useSacrumConnectionStore } from "../stores/sacrumConnectionStore";

const mockGetSacrumConnectionIdentity = vi.fn();
const mockListDaemonFleet = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getSacrumConnectionIdentity: (...args: unknown[]) =>
      mockGetSacrumConnectionIdentity(...args),
    listDaemonFleet: (...args: unknown[]) => mockListDaemonFleet(...args),
  },
}));

import { useDaemonFleet } from "./useDaemonFleet";
import type { Daemon, DaemonFleetSnapshot } from "../bindings";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const daemon: Daemon = {
  id: "33333333-3333-3333-3333-333333333333",
  status: "pending",
  name: null,
  display_name: "33333333",
  enrolled_at: null,
  removed_at: null,
  created_at: "2026-09-05T10:00:00+00:00",
  updated_at: "2026-09-05T10:00:00+00:00",
};

function snapshot(connectionId: string, daemons: Daemon[]): DaemonFleetSnapshot {
  return { connection_id: connectionId, daemons };
}

describe("useDaemonFleet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    useSacrumConnectionStore.getState().setIdentity(null);
    mockGetSacrumConnectionIdentity.mockResolvedValue({
      status: "ok",
      data: "identity-a",
    });
  });

  it("resolves the connection identity and lists the fleet under it", async () => {
    mockListDaemonFleet.mockResolvedValue({
      status: "ok",
      data: snapshot("identity-a", [daemon]),
    });

    const { result } = renderHook(() => useDaemonFleet(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.daemons).toEqual([daemon]);
    expect(result.current.connectionId).toBe("identity-a");
    expect(result.current.error).toBeNull();
    expect(mockListDaemonFleet).toHaveBeenCalledTimes(1);
  });

  it("rejects a late response from a retired connection instead of caching it", async () => {
    // The request starts under identity-a, but the account switches to
    // identity-b before the response lands.
    mockListDaemonFleet.mockImplementation(async () => {
      useSacrumConnectionStore.getState().setIdentity("identity-b");
      return { status: "ok", data: snapshot("identity-a", [daemon]) };
    });

    const { result } = renderHook(() => useDaemonFleet(), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.daemons).toEqual([]);
    expect(result.current.error).toContain("retired connection");
    // The old account's fleet was never cached under either identity.
    expect(
      queryClient.getQueryData(["sacrum", "identity-a", "daemons", "fleet"])
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(["sacrum", "identity-b", "daemons", "fleet"])
    ).toBeUndefined();
  });

  it("rejects a payload whose connection id differs from the captured scope", async () => {
    mockListDaemonFleet.mockResolvedValue({
      status: "ok",
      data: snapshot("identity-z", [daemon]),
    });

    const { result } = renderHook(() => useDaemonFleet(), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.daemons).toEqual([]);
    expect(result.current.error).toContain("retired connection");
  });

  it("does not fetch while no backend connection is active", async () => {
    mockGetSacrumConnectionIdentity.mockResolvedValue({
      status: "ok",
      data: null,
    });

    const { result } = renderHook(() => useDaemonFleet(), { wrapper });

    await waitFor(() =>
      expect(mockGetSacrumConnectionIdentity).toHaveBeenCalled()
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockListDaemonFleet).not.toHaveBeenCalled();
    expect(result.current.daemons).toEqual([]);
    expect(result.current.error).toContain("No Sacrum backend connection");
  });
});
