/**
 * Shared trace-filter state for /traces/:taskId, persisted in URL query params
 * so the view is shareable. The same state is consumed by THREAD, FLIGHT-STRIP
 * and CORRIDOR modes.
 *
 * Query keys:
 *   - status   : execution status filter (one of "pending" | "in_progress" |
 *                "completed" | "failed" | "skipped")
 *   - step     : step name filter (free-form string match, exact)
 *   - model    : execution model id filter (exact)
 *   - q        : free-text search across event content
 *   - rootOnly : "1" to collapse the subtree to just the root task
 *   - scope    : TaskRun lineage scope ("selected" | "descendants" | "lineage")
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface TraceFilters {
  status: string | null;
  stepName: string | null;
  model: string | null;
  search: string;
  rootOnly: boolean;
  lineageScope: TraceLineageScope | null;
}

export interface UseTraceFiltersResult {
  filters: TraceFilters;
  setStatus: (v: string | null) => void;
  setStepName: (v: string | null) => void;
  setModel: (v: string | null) => void;
  setSearch: (v: string) => void;
  setRootOnly: (v: boolean) => void;
  setLineageScope: (v: TraceLineageScope | null) => void;
  clear: () => void;
}

export type TraceLineageScope = "selected" | "descendants" | "lineage";

export const TRACE_LINEAGE_SCOPE_OPTIONS = [
  { value: "selected", label: "Selected run" },
  { value: "descendants", label: "Selected + descendants" },
  { value: "lineage", label: "Full lineage" },
] as const satisfies readonly {
  value: TraceLineageScope;
  label: string;
}[];

function parseLineageScope(value: string | null): TraceLineageScope | null {
  if (!value) return null;
  return (
    TRACE_LINEAGE_SCOPE_OPTIONS.find((option) => option.value === value)
      ?.value ?? null
  );
}

const FILTER_PARAM_KEYS = [
  "status",
  "step",
  "model",
  "q",
  "rootOnly",
  "scope",
] as const;

export function useTraceFilters(): UseTraceFiltersResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const querySearch = searchParams.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState(querySearch);

  useEffect(() => {
    setSearchDraft(querySearch);
  }, [querySearch]);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null || value === "") next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  useEffect(() => {
    if (searchDraft === querySearch) return;

    const timeout = window.setTimeout(() => {
      updateParam("q", searchDraft);
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [querySearch, searchDraft, updateParam]);

  const filters = useMemo<TraceFilters>(
    () => ({
      status: searchParams.get("status") || null,
      stepName: searchParams.get("step") || null,
      model: searchParams.get("model") || null,
      search: searchDraft,
      rootOnly: searchParams.get("rootOnly") === "1",
      lineageScope: parseLineageScope(searchParams.get("scope")),
    }),
    [searchDraft, searchParams]
  );

  const setStatus = useCallback(
    (v: string | null) => updateParam("status", v),
    [updateParam]
  );
  const setStepName = useCallback(
    (v: string | null) => updateParam("step", v),
    [updateParam]
  );
  const setModel = useCallback(
    (v: string | null) => updateParam("model", v),
    [updateParam]
  );
  const setSearch = useCallback((v: string) => {
    setSearchDraft(v);
  }, []);
  const setRootOnly = useCallback(
    (v: boolean) => updateParam("rootOnly", v ? "1" : null),
    [updateParam]
  );
  const setLineageScope = useCallback(
    (v: TraceLineageScope | null) => updateParam("scope", v),
    [updateParam]
  );

  const clear = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of FILTER_PARAM_KEYS) next.delete(key);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  return {
    filters,
    setStatus,
    setStepName,
    setModel,
    setSearch,
    setRootOnly,
    setLineageScope,
    clear,
  };
}
