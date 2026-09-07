import { describe, it, expect, beforeEach } from "vitest";
import type { DaemonCommandError } from "../bindings";
import { CommandResultError } from "../query/commandResult";
import { queryClient, queryKeys } from "../query";
import {
  daemonErrorKind,
  resetDaemonConnectionScope,
  retireDaemonQueriesForIdentity,
  STALE_CONNECTION_MESSAGE,
  assertCurrentDaemonSnapshot,
} from "./errors";

describe("daemon error and connection scope", () => {
  beforeEach(() => {
    queryClient.clear();
    resetDaemonConnectionScope();
  });

  it("reads stale_connection from a CommandResultError cause", () => {
    const cause: DaemonCommandError = {
      kind: "stale_connection",
      message: STALE_CONNECTION_MESSAGE,
    };
    const error = new CommandResultError(STALE_CONNECTION_MESSAGE, cause);
    expect(daemonErrorKind(error)).toBe("stale_connection");
  });

  it("throws the same stale_connection command error from the snapshot guard", () => {
    queryClient.setQueryData(queryKeys.sacrumConnection(), "identity-b");
    expect(() =>
      assertCurrentDaemonSnapshot("identity-a", "identity-a")
    ).toThrow(CommandResultError);
    try {
      assertCurrentDaemonSnapshot("identity-a", "identity-a");
    } catch (error) {
      expect(daemonErrorKind(error)).toBe("stale_connection");
    }
  });

  it("retires daemon queries for a previous identity without a mounted hook", () => {
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-a"), []);
    queryClient.setQueryData(queryKeys.daemons.fleet("identity-b"), []);
    retireDaemonQueriesForIdentity("identity-a");
    retireDaemonQueriesForIdentity("identity-b");
    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-a"))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.daemons.fleet("identity-b"))
    ).toEqual([]);
  });
});
