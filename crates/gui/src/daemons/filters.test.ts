import { describe, expect, it } from "vitest";
import type { Daemon } from "../bindings";
import {
  countDaemonsByStatus,
  filterDaemons,
  groupDaemonsByStatus,
  normalizedDaemonStatus,
} from "./filters";

const daemon = (
  overrides: Partial<Daemon> & Record<string, unknown> = {}
): Daemon =>
  ({
    id: "daemon-a",
    status: "active",
    name: "Alpha",
    display_name: "Alpha",
    enrolled_at: null,
    removed_at: null,
    inserted_at: null,
    updated_at: null,
    ...overrides,
  }) as Daemon;

describe("daemon fleet projections", () => {
  it("counts and groups known, terminal, and unknown statuses", () => {
    const daemons = [
      daemon({ id: "active", status: "active" }),
      daemon({ id: "pending", status: "pending" }),
      daemon({ id: "revoked", status: "revoked" }),
      daemon({ id: "removed", status: "removed" }),
      daemon({ id: "foreign", status: "paused" }),
    ];

    expect(countDaemonsByStatus(daemons)).toEqual({
      all: 5,
      active: 1,
      pending: 1,
      revoked: 1,
      removed: 1,
      unknown: 1,
    });
    expect(groupDaemonsByStatus(daemons).map((group) => group.status)).toEqual([
      "active",
      "pending",
      "unknown",
      "revoked",
      "removed",
    ]);
    expect(normalizedDaemonStatus("PAUSED")).toBe("unknown");
  });

  it("intersects status and case-insensitive search across available fields", () => {
    const alpha = daemon({
      id: "daemon-alpha",
      status: "active",
      name: "Alpha",
      host: "worker-01",
      os: "Linux",
      architecture: "aarch64",
      harness: "codex",
    });
    const pending = daemon({
      id: "daemon-pending",
      status: "pending",
      name: "Beta",
      host: "worker-02",
    });

    expect(filterDaemons([alpha, pending], "WORKER-01", "all")).toEqual([
      alpha,
    ]);
    expect(filterDaemons([alpha, pending], "beta", "active")).toEqual([]);
    expect(filterDaemons([alpha, pending], "worker", "pending")).toEqual([
      pending,
    ]);
    expect(filterDaemons([alpha, pending], "aarch64", "active")).toEqual([
      alpha,
    ]);
  });
});
