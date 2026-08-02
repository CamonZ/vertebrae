import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactChangedEvent } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
let handler: ((event: { payload: ArtifactChangedEvent }) => void) | null = null;

vi.mock("../bindings", () => ({
  events: { artifactChangedEvent: { listen } },
}));

import { useArtifactChangeListener } from "./useArtifactChangeListener";

const artifact = (body = "# Initial"): Artifact => ({
  id: "artifact-1",
  project_id: "project-1",
  filename: "notes.md",
  body,
  logical_name: "notes",
  metadata: {
    version: 1,
    content_kind: "document",
    format: "markdown",
    origin: "test",
    presentation: "rendered",
    extensions: {},
  },
  created_at: null,
  updated_at: null,
});

describe("useArtifactChangeListener", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    queryClient.clear();
    handler = null;
    listen.mockClear();
    listen.mockImplementation(
      (nextHandler: (event: { payload: ArtifactChangedEvent }) => void) => {
        handler = nextHandler;
        return Promise.resolve(() => {});
      }
    );
  });

  it("upserts and deletes initialized artifact projections without refetching", async () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(queryKeys.artifacts.project(generation), []);
    renderHook(() => useArtifactChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());

    act(() => {
      handler?.({
        payload: {
          artifact_id: "artifact-1",
          task_id: null,
          change_type: "Created",
          artifact: artifact("# Created"),
        },
      });
    });
    expect(
      queryClient.getQueryData<Artifact[]>(
        queryKeys.artifacts.project(generation)
      )
    ).toEqual([artifact("# Created")]);

    act(() => {
      handler?.({
        payload: {
          artifact_id: "artifact-1",
          task_id: null,
          change_type: "Deleted",
          artifact: null,
        },
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.artifacts.project(generation))
    ).toEqual([]);
  });

  it("ignores a delayed event from a previous project generation", async () => {
    renderHook(() => useArtifactChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    const staleHandler = handler!;

    act(() => resetProjectScopedStores());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(2));

    act(() => {
      staleHandler({
        payload: {
          artifact_id: "stale-artifact",
          task_id: null,
          change_type: "Created",
          artifact: { ...artifact(), id: "stale-artifact" },
        },
      });
    });
    expect(
      queryClient.getQueryData(
        queryKeys.artifacts.project(getProjectScopeGeneration())
      )
    ).toBeUndefined();
  });
});
