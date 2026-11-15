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
  const now = Date.parse("2026-11-15T01:06:00Z");
  const credential = (
    overrides: Partial<DaemonCredentialMetadata>
  ): DaemonCredentialMetadata => ({
    id: "credential-1",
    credential_kind: "refresh",
    status: "active",
    expires_at: "2026-12-15T01:05:19.237178Z",
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

  const access = credential({
    id: "access-1",
    credential_kind: "access",
    expires_at: "2026-11-15T02:05:19.237178Z",
  });
  const bootstrap = credential({
    id: "bootstrap-1",
    credential_kind: "bootstrap",
    status: "consumed",
    consumed_at: "2026-11-15T01:05:19.237178Z",
  });

  it.each([
    ["valid", access.expires_at],
    ["expired", "2026-11-15T01:05:00Z"],
  ])("allows refresh recovery with %s access", (_, expires_at) => {
    expect(
      daemonRequiresReenrollment(
        metadata([bootstrap, { ...access, expires_at }, credential({})]),
        now
      )
    ).toBe(false);
  });

  it.each([
    ["missing", []],
    [
      "revoked",
      [credential({ status: "revoked", revoked_at: "2026-11-15T01:05:30Z" })],
    ],
    ["expired", [credential({ expires_at: "2026-11-15T01:05:00Z" })]],
    ["invalid expiry", [credential({ expires_at: "invalid" })]],
    ["legacy reconnect only", [credential({ credential_kind: "reconnect" })]],
  ])(
    "requires recovery when refresh is %s, even with valid access",
    (_, credentials) => {
      expect(
        daemonRequiresReenrollment(
          metadata([bootstrap, access, ...credentials]),
          now
        )
      ).toBe(true);
    }
  );

  it("requires recovery at the exact refresh expiry boundary", () => {
    const enrollment = metadata([
      credential({ expires_at: new Date(now).toISOString() }),
    ]);
    expect(daemonRequiresReenrollment(enrollment, now - 1)).toBe(false);
    expect(daemonRequiresReenrollment(enrollment, now)).toBe(true);
    expect(daemonRequiresReenrollment(enrollment, now + 1)).toBe(true);
  });

  it("allows recovery when one refresh credential remains usable", () => {
    expect(
      daemonRequiresReenrollment(
        metadata([
          credential({ status: "revoked" }),
          credential({ id: "refresh-2" }),
        ]),
        now
      )
    ).toBe(false);
  });

  it("ignores pending enrollments and missing metadata", () => {
    expect(daemonRequiresReenrollment(null, now)).toBe(false);
    expect(daemonRequiresReenrollment(undefined, now)).toBe(false);
    expect(
      daemonRequiresReenrollment(metadata([], { enrolled_at: null }), now)
    ).toBe(false);
    for (const status of ["pending", "revoked", "removed"]) {
      expect(daemonRequiresReenrollment(metadata([], { status }), now)).toBe(
        false
      );
    }
    expect(
      daemonRequiresReenrollment(
        metadata([], { status: "pending", enrolled_at: null }),
        now
      )
    ).toBe(false);
  });
});
