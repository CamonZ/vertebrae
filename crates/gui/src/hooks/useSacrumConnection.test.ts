import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, queryKeys } from "../query";

const mockGetSacrumConnectionIdentity = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getSacrumConnectionIdentity: (...args: unknown[]) =>
      mockGetSacrumConnectionIdentity(...args),
  },
}));

import { useSacrumConnection } from "./useSacrumConnection";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useSacrumConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it("exposes the identity once the connection query resolves", async () => {
    mockGetSacrumConnectionIdentity.mockResolvedValue({
      status: "ok",
      data: "identity-a",
    });

    const { result } = renderHook(() => useSacrumConnection(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.identity).toBe("identity-a"));
    expect(result.current.isLoading).toBe(false);
  });

  it("evicts the retired identity's daemon subtree on identity change", async () => {
    mockGetSacrumConnectionIdentity
      .mockResolvedValueOnce({ status: "ok", data: "identity-a" })
      .mockResolvedValue({ status: "ok", data: "identity-b" });

    const { result } = renderHook(() => useSacrumConnection(), { wrapper });
    await waitFor(() => expect(result.current.identity).toBe("identity-a"));

    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), []);
    queryClient.setQueryData(
      queryKeys.daemons.detail("identity-a", "daemon-1"),
      null
    );
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-b"), []);

    await queryClient.invalidateQueries({
      queryKey: queryKeys.sacrumConnection(),
    });
    await waitFor(() => expect(result.current.identity).toBe("identity-b"));

    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(
        queryKeys.daemons.detail("identity-a", "daemon-1")
      )
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-b"))
    ).toBeDefined();
  });
});
