import { describe, expect, it } from "vitest";
import type {
  Daemon,
  DaemonCredentialMetadata,
  DaemonEnrollmentMetadata,
} from "../bindings";
import {
  countDaemonsByStatus,
  daemonRequiresReenrollment,
  filterDaemons,
  formatDaemonCapabilityReadiness,
  formatDaemonHeartbeatAge,
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
    max_concurrency: null,
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

  it("formats only server-provided telemetry values", () => {
    const now = Date.parse("2026-09-18T10:00:00Z");
    expect(formatDaemonHeartbeatAge("2026-09-18T09:58:30Z", now)).toBe(
      "1m ago"
    );
    expect(formatDaemonHeartbeatAge(null, now)).toBe("Unavailable");
    expect(
      formatDaemonCapabilityReadiness({
        providers: { openai: true, anthropic: false },
        harnesses: { codex: true },
      })
    ).toBe("2/3 ready (1 unavailable)");
    expect(formatDaemonCapabilityReadiness({})).toBe("Unknown");
  });
});

describe("daemonRequiresReenrollment", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const credential = (
    overrides: Partial<DaemonCredentialMetadata>
  ): DaemonCredentialMetadata => ({
    id: "credential-1",
    credential_kind: "reconnect",
    status: "active",
    expires_at: "2026-11-19T12:00:00Z",
    consumed_at: null,
    revoked_at: null,
    inserted_at: null,
    updated_at: null,
    ...overrides,
  });
  const metadata = (
    credentials: DaemonCredentialMetadata[],
    overrides: Partial<DaemonEnrollmentMetadata> = {}
  ): DaemonEnrollmentMetadata => ({
    daemon_id: "daemon-1",
    status: "active",
    enrolled_at: "2026-09-12T09:00:00Z",
    credentials,
    ...overrides,
  });

  it("is false while an unexpired reconnect credential is active", () => {
    expect(daemonRequiresReenrollment(metadata([credential({})]), now)).toBe(
      false
    );
  });

  it("is true once every reconnect credential is expired or revoked", () => {
    expect(
      daemonRequiresReenrollment(
        metadata([
          credential({ expires_at: "2026-10-15T19:42:16Z" }),
          credential({ id: "credential-2", status: "revoked" }),
          credential({ id: "bootstrap", credential_kind: "bootstrap" }),
        ]),
        now
      )
    ).toBe(true);
  });

  it("ignores pending enrollments and missing metadata", () => {
    expect(daemonRequiresReenrollment(null, now)).toBe(false);
    expect(
      daemonRequiresReenrollment(
        metadata([], { status: "pending", enrolled_at: null }),
        now
      )
    ).toBe(false);
  });
});
