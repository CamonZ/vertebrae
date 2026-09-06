import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { queryClient } from "../query";
import { useSacrumConnectionStore } from "../stores/sacrumConnectionStore";

const mockCreateDaemon = vi.fn();
const mockRenameDaemon = vi.fn();
const mockRevokeDaemon = vi.fn();
const mockUnregisterDaemon = vi.fn();
const mockRotateDaemonCredentials = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    createDaemon: (...args: unknown[]) => mockCreateDaemon(...args),
    renameDaemon: (...args: unknown[]) => mockRenameDaemon(...args),
    revokeDaemon: (...args: unknown[]) => mockRevokeDaemon(...args),
    unregisterDaemon: (...args: unknown[]) => mockUnregisterDaemon(...args),
    rotateDaemonCredentials: (...args: unknown[]) =>
      mockRotateDaemonCredentials(...args),
  },
}));

import { useDaemonMutations } from "./useDaemonMutations";
import type {
  Daemon,
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
  created_at: "2026-09-05T10:00:00+00:00",
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
    useSacrumConnectionStore.getState().setIdentity("identity-a");
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
    let bootstrap = null as Awaited<ReturnType<typeof result.current.createDaemon>>;
    await act(async () => {
      bootstrap = await result.current.createDaemon("Farm bot");
    });

    expect(mockCreateDaemon).toHaveBeenCalledWith("Farm bot");
    expect(mockCreateDaemon).toHaveBeenCalledTimes(1);
    expect(bootstrap?.enrollment_token).toBe("dtoken_dummy");
    expect(result.current.error).toBeNull();
    // Creating a daemon only appends to the fleet; the invalidation is
    // scoped to the fleet list rather than the whole daemon subtree.
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
    let bootstrap: Awaited<ReturnType<typeof result.current.createDaemon>> = null;
    await act(async () => {
      bootstrap = await result.current.createDaemon(null);
    });

    // Exactly one mutation attempt; recovery is explicit, never automatic.
    expect(mockCreateDaemon).toHaveBeenCalledTimes(1);
    expect(bootstrap).toBeNull();
    expect(result.current.errorKind).toBe("ambiguous_transport");
    expect(result.current.error).toContain("may have been applied");
    // Safe metadata was refreshed for the UI to reconcile.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["sacrum", "identity-a", "daemons"],
    });
  });

  it("discards a late result from a retired connection without invalidating anything", async () => {
    mockRotateDaemonCredentials.mockImplementation(async () => {
      // The account switches while the rotation is in flight.
      useSacrumConnectionStore.getState().setIdentity("identity-b");
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
    // The old account's one-time token never reaches the caller.
    expect(bootstrap).toBeNull();
    expect(result.current.error).toContain("retired connection");
    // Neither connection's cache was touched by the retired result.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("surfaces structured refusal kinds for terminal errors", async () => {
    mockRevokeDaemon.mockResolvedValue({
      status: "error",
      error: {
        kind: "terminal_state",
        message: "daemon is in a terminal state (revoked or removed)",
      },
    });

    const { result } = renderHook(() => useDaemonMutations());
    let revoked: Awaited<ReturnType<typeof result.current.revokeDaemon>> = null;
    await act(async () => {
      revoked = await result.current.revokeDaemon(daemon.id);
    });

    expect(revoked).toBeNull();
    expect(result.current.errorKind).toBe("terminal_state");
    expect(result.current.error).toContain("terminal state");
    // Definitive refusals do not refresh anything.
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

    expect(mockRenameDaemon).toHaveBeenCalledWith(daemon.id, { kind: "clear" });
  });

  it("refuses to mutate without a backend connection", async () => {
    useSacrumConnectionStore.getState().setIdentity(null);

    const { result } = renderHook(() => useDaemonMutations());
    let revoked: Awaited<ReturnType<typeof result.current.revokeDaemon>> = null;
    await act(async () => {
      revoked = await result.current.revokeDaemon(daemon.id);
    });

    expect(mockRevokeDaemon).not.toHaveBeenCalled();
    expect(revoked).toBeNull();
    expect(result.current.errorKind).toBe("no_backend");
  });
});
