import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { queryClient, queryKeys } from "../query";

const mockListProjectArtifacts = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listProjectArtifacts: (...args: unknown[]) => mockListProjectArtifacts(...args),
  },
}));

import { useProjectArtifacts } from "./useProjectArtifacts";
import type { Artifact } from "../bindings";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "artifact-1",
  project_id: "project-1",
  filename: "notes.md",
  body: "# Notes",
  logical_name: "notes",
  metadata: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  ...overrides,
});

describe("useProjectArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
  });

  it("reads the active project's artifact projections", async () => {
    const item = artifact();
    mockListProjectArtifacts.mockResolvedValue({ status: "ok", data: [item] });

    const { result } = renderHook(() => useProjectArtifacts(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.artifacts).toEqual([item]);
    expect(mockListProjectArtifacts).toHaveBeenCalledOnce();
    expect(
      queryClient.getQueryData(
        queryKeys.artifacts.project(getProjectScopeGeneration())
      )
    ).toEqual([item]);
  });

  it("discards a response from the previous project scope", async () => {
    let resolveFetch!: (value: { status: "ok"; data: Artifact[] }) => void;
    mockListProjectArtifacts.mockResolvedValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockListProjectArtifacts.mockResolvedValueOnce({ status: "ok", data: [] });

    const { result } = renderHook(() => useProjectArtifacts(), { wrapper });
    await waitFor(() => expect(mockListProjectArtifacts).toHaveBeenCalledOnce());

    act(() => resetProjectScopedStores());
    await act(async () => resolveFetch({ status: "ok", data: [artifact()] }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.artifacts).toEqual([]);
  });
});
