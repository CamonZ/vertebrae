import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { queryClient } from "../query";

const mockListTaskArtifacts = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTaskArtifacts: (...args: unknown[]) => mockListTaskArtifacts(...args),
  },
}));

import { useTaskArtifacts } from "./useTaskArtifacts";
import type { Artifact } from "../bindings";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

const artifact: Artifact = {
  id: "artifact-1",
  project_id: "project-1",
  filename: "conversation.jsonl",
  body: "{\"type\":\"message\"}",
  logical_name: "conversation",
  metadata: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

describe("useTaskArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
  });

  it("reads only the selected task's artifact projections", async () => {
    mockListTaskArtifacts.mockResolvedValue({ status: "ok", data: [artifact] });
    const { result } = renderHook(() => useTaskArtifacts("task-1"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockListTaskArtifacts).toHaveBeenCalledWith("task-1");
    expect(result.current.artifacts).toEqual([artifact]);
  });

  it("does not fetch without a task", async () => {
    const { result } = renderHook(() => useTaskArtifacts(null), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockListTaskArtifacts).not.toHaveBeenCalled();
    expect(result.current.artifacts).toEqual([]);
  });
});
