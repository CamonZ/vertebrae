import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { queryClient, queryKeys } from "../query";

const mockCreateDaemon = vi.fn();
const mockRenameDaemon = vi.fn();
const mockUnregisterDaemon = vi.fn();
const mockRotateDaemonCredentials = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    createDaemon: (...args: unknown[]) => mockCreateDaemon(...args),
    renameDaemon: (...args: unknown[]) => mockRenameDaemon(...args),
    unregisterDaemon: (...args: unknown[]) => mockUnregisterDaemon(...args),
    rotateDaemonCredentials: (...args: unknown[]) =>
      mockRotateDaemonCredentials(...args),
  },
}));

import { useDaemonMutations } from "./useDaemonMutations";
import type {
  Daemon,
  DaemonBootstrap,
  DaemonBootstrapResult,
  DaemonMutationResult,
} from "../bindings";

const daemon: Daemon = {
  id: "33333333-3333-3333-3333-333333333333",
  status: "pending",
  name: null,
  display_name: "33333333",
  enrolled_at: null,
  removed_at: null,
  inserted_at: "2026-09-05T10:00:00+00:00",
  updated_at: "2026-09-05T10:00:00+00:00",
};

function bootstrapResult(
  connectionId: string,
  token: string
): DaemonBootstrapResult {
  return {
    connection_id: connectionId,
    bootstrap: {
      daemon,
      enrollment_token: token,
      expires_at: "2026-09-05T12:00:00+00:00",
    },
  };
}

function mutationResult(connectionId: string): DaemonMutationResult {
  return { connection_id: connectionId, daemon };
}

describe("useDaemonMutations", () => {
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setQueryData(queryKeys.sacrumConnection(), "identity-a");
    invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(() => Promise.resolve());
  });

  it("creates a daemon, invalidates the fleet, and returns the one-time bootstrap", async () => {
    mockCreateDaemon.mockResolvedValue({
      status: "ok",
      data: bootstrapResult("identity-a", "dtoken_dummy"),
    });

    const { result } = renderHook(() => useDaemonMutations());
    let bootstrap = null as Awaited<
      ReturnType<typeof result.current.createDaemon>
    >;
    await act(async () => {
      bootstrap = await result.current.createDaemon("Farm bot");
    });

    expect(mockCreateDaemon).toHaveBeenCalledWith("identity-a", "Farm bot");
    expect(mockCreateDaemon).toHaveBeenCalledTimes(1);
    expect(bootstrap?.enrollment_token).toBe("dtoken_dummy");
    expect(result.current.error).toBeNull();
    // Creating only appends to the fleet, so invalidation is scoped to the fleet list.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["sacrum", "identity-a", "daemons", "fleet"],
    });
  });

  it("never auto-retries an ambiguous create and refreshes safe metadata instead", async () => {
    mockCreateDaemon.mockResolvedValue({
      status: "error",
      error: {
        kind: "ambiguous_transport",
        message:
          "network ambiguity: the daemon operation may have been applied; refresh the fleet and recover explicitly",
      },
    });

    const { result } = renderHook(() => useDaemonMutations());
    let bootstrap: Awaited<ReturnType<typeof result.current.createDaemon>> =
      null;
    await act(async () => {
      bootstrap = await result.current.createDaemon(null);
    });

    expect(mockCreateDaemon).toHaveBeenCalledTimes(1);
    expect(bootstrap).toBeNull();
    expect(result.current.errorKind).toBe("ambiguous_transport");
    expect(result.current.error).toContain("may have been applied");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["sacrum", "identity-a", "daemons"],
    });
  });

  it("discards a late result from a retired connection without invalidating anything", async () => {
    mockRotateDaemonCredentials.mockImplementation(async () => {
      queryClient.setQueryData(queryKeys.sacrumConnection(), "identity-b");
      return {
        status: "ok",
        data: bootstrapResult("identity-a", "dtoken_old_account"),
      };
    });

    const { result } = renderHook(() => useDaemonMutations());
    let bootstrap: Awaited<
      ReturnType<typeof result.current.rotateDaemonCredentials>
    > = null;
    await act(async () => {
      bootstrap = await result.current.rotateDaemonCredentials(daemon.id);
    });

    expect(mockRotateDaemonCredentials).toHaveBeenCalledTimes(1);
    expect(bootstrap).toBeNull();
    expect(result.current.errorKind).toBe("stale_connection");
    expect(result.current.error).toContain("connection changed");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("forwards the rename intent that preserves omitted-vs-null semantics", async () => {
    mockRenameDaemon.mockResolvedValue({
      status: "ok",
      data: mutationResult("identity-a"),
    });

    const { result } = renderHook(() => useDaemonMutations());
    await act(async () => {
      await result.current.renameDaemon(daemon.id, { kind: "clear" });
    });

    expect(mockRenameDaemon).toHaveBeenCalledWith("identity-a", daemon.id, {
      kind: "clear",
    });
  });

  it("reconciles confirmed rename results, but never removes on failure", async () => {
    const renamed = { ...daemon, name: "renamed", display_name: "renamed" };
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), [daemon]);
    queryClient.setQueryData(
      queryKeys.daemons.detail("identity-a", daemon.id),
      daemon
    );
    mockRenameDaemon.mockResolvedValue({
      status: "ok",
      data: { connection_id: "identity-a", daemon: renamed },
    });

    const { result } = renderHook(() => useDaemonMutations());
    await act(async () => {
      await result.current.renameDaemon(daemon.id, {
        kind: "set",
        value: "renamed",
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toEqual([renamed]);
    expect(
      queryClient.getQueryData(
        queryKeys.daemons.detail("identity-a", daemon.id)
      )
    ).toEqual(renamed);

    mockUnregisterDaemon.mockResolvedValue({
      status: "error",
      error: {
        kind: "active_session",
        message: "active session",
      },
    });
    await act(async () => {
      await result.current.unregisterDaemon(daemon.id);
    });
    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toEqual([renamed]);
  });

  it("refuses to mutate without a backend connection", async () => {
    queryClient.setQueryData(queryKeys.sacrumConnection(), null);

    const { result } = renderHook(() => useDaemonMutations());
    let unregistered: Awaited<
      ReturnType<typeof result.current.unregisterDaemon>
    > = null;
    await act(async () => {
      unregistered = await result.current.unregisterDaemon(daemon.id);
    });

    expect(mockUnregisterDaemon).not.toHaveBeenCalled();
    expect(unregistered).toBeNull();
    expect(result.current.errorKind).toBe("no_backend");
  });

  it("stays busy until every in-flight mutation has settled", async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    let resolveRename: (value: unknown) => void = () => {};
    mockCreateDaemon.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );
    mockRenameDaemon.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRename = resolve;
        })
    );

    const { result } = renderHook(() => useDaemonMutations());
    let createPromise: Promise<DaemonBootstrap | null> = Promise.resolve(null);
    let renamePromise: Promise<Daemon | null> = Promise.resolve(null);
    act(() => {
      createPromise = result.current.createDaemon(null);
      renamePromise = result.current.renameDaemon(daemon.id, {
        kind: "set",
        value: "renamed",
      });
    });
    expect(result.current.isBusy).toBe(true);

    await act(async () => {
      resolveCreate({
        status: "ok",
        data: bootstrapResult("identity-a", "dtoken_dummy"),
      });
      await createPromise;
    });
    // The first mutation completed; the second is still in flight.
    expect(result.current.isBusy).toBe(true);

    await act(async () => {
      resolveRename({ status: "ok", data: mutationResult("identity-a") });
      await renamePromise;
    });
    expect(result.current.isBusy).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
