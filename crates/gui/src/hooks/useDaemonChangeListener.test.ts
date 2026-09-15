import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, queryKeys } from "../query";

const mockGetSacrumConnectionIdentity = vi.fn();
const mockListen = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getSacrumConnectionIdentity: (...args: unknown[]) =>
      mockGetSacrumConnectionIdentity(...args),
  },
  events: {
    daemonChangedEvent: {
      listen: (...args: unknown[]) => mockListen(...args),
    },
  },
}));

import { useDaemonChangeListener } from "./useDaemonChangeListener";
import type { Daemon } from "../bindings";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const daemon: Daemon = {
  id: "daemon-1",
  status: "pending",
  name: null,
  display_name: "daemon-1",
  max_concurrency: null,
  enrolled_at: null,
  removed_at: null,
  inserted_at: "2026-09-14T10:00:00Z",
  updated_at: "2026-09-14T10:00:00Z",
};

describe("useDaemonChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mockGetSacrumConnectionIdentity.mockResolvedValue({
      status: "ok",
      data: "identity-a",
    });
    mockListen.mockResolvedValue(vi.fn());
  });

  it("applies matching account CDC events without refetching", async () => {
    const rendered = renderHook(() => useDaemonChangeListener(), { wrapper });

    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.sacrumConnection())).toBe(
        "identity-a"
      )
    );
    const handleChanged = mockListen.mock.calls[
      mockListen.mock.calls.length - 1
    ][0] as (event: {
      payload: {
        connection_id: string;
        daemon_id: string;
        change_type: "Created" | "Updated" | "Deleted";
        daemon: Daemon | null;
      };
    }) => void;

    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), []);
    handleChanged({
      payload: {
        connection_id: "identity-a",
        daemon_id: daemon.id,
        change_type: "Created",
        daemon,
      },
    });

    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toEqual([daemon]);
    rendered.unmount();
  });

  it("ignores events from a retired connection", async () => {
    renderHook(() => useDaemonChangeListener(), { wrapper });
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    const handleChanged = mockListen.mock.calls[0][0] as (event: {
      payload: {
        connection_id: string;
        daemon_id: string;
        change_type: "Created" | "Updated" | "Deleted";
        daemon: Daemon | null;
      };
    }) => void;
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), []);
    handleChanged({
      payload: {
        connection_id: "identity-old",
        daemon_id: daemon.id,
        change_type: "Created",
        daemon,
      },
    });

    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toEqual([]);
  });
});
