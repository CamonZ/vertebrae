import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { useTraceFilters } from "./useTraceFilters";

function wrapperWith(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
    );
  };
}

describe("useTraceFilters", () => {
  it("reads filters from URL query params on mount", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith(
        "/traces/abc?status=failed&step=in_progress&model=opus&q=foo&rootOnly=1"
      ),
    });
    expect(result.current.filters).toEqual({
      status: "failed",
      stepName: "in_progress",
      model: "opus",
      search: "foo",
      rootOnly: true,
      lineageScope: null,
    });
  });

  it("defaults missing params to null/empty/false", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc"),
    });
    expect(result.current.filters).toEqual({
      status: null,
      stepName: null,
      model: null,
      search: "",
      rootOnly: false,
      lineageScope: null,
    });
  });

  it("setStatus updates the URL state", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc"),
    });
    act(() => result.current.setStatus("failed"));
    expect(result.current.filters.status).toBe("failed");
    act(() => result.current.setStatus(null));
    expect(result.current.filters.status).toBeNull();
  });

  it("setStepName, setModel, setSearch update their URL params", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc"),
    });
    act(() => result.current.setStepName("review"));
    expect(result.current.filters.stepName).toBe("review");
    act(() => result.current.setModel("opus"));
    expect(result.current.filters.model).toBe("opus");
    act(() => result.current.setSearch("needle"));
    expect(result.current.filters.search).toBe("needle");
  });

  it("setSearch with empty string removes the param", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc?q=foo"),
    });
    expect(result.current.filters.search).toBe("foo");
    act(() => result.current.setSearch(""));
    expect(result.current.filters.search).toBe("");
  });

  it("setStatus(null) removes the status param entirely", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc?status=failed"),
    });
    expect(result.current.filters.status).toBe("failed");
    act(() => result.current.setStatus(null));
    expect(result.current.filters.status).toBeNull();
  });

  it("setRootOnly toggles rootOnly via the rootOnly=1 param", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith("/traces/abc"),
    });
    act(() => result.current.setRootOnly(true));
    expect(result.current.filters.rootOnly).toBe(true);
    act(() => result.current.setRootOnly(false));
    expect(result.current.filters.rootOnly).toBe(false);
  });

  it("clear empties all filter params", () => {
    const { result } = renderHook(() => useTraceFilters(), {
      wrapper: wrapperWith(
        "/traces/abc?status=failed&step=in_progress&model=opus&q=foo&rootOnly=1&scope=descendants"
      ),
    });
    act(() => result.current.clear());
    expect(result.current.filters).toEqual({
      status: null,
      stepName: null,
      model: null,
      search: "",
      rootOnly: false,
      lineageScope: null,
    });
  });
});
