import { describe, expect, it } from "vitest";
import {
  DAEMON_NAME_MAX_LENGTH,
  daemonNameUpdate,
  normalizeDaemonName,
  validateDaemonName,
} from "./name";

describe("daemon name policy", () => {
  it("uses the same trim and length policy for registration and rename", () => {
    expect(normalizeDaemonName("  rack-03  ")).toBe("rack-03");
    expect(validateDaemonName("  rack-03  ")).toBeNull();
    expect(validateDaemonName("x".repeat(DAEMON_NAME_MAX_LENGTH))).toBeNull();
    expect(
      validateDaemonName("x".repeat(DAEMON_NAME_MAX_LENGTH + 1))
    ).toContain(`${DAEMON_NAME_MAX_LENGTH}`);
  });

  it("allows an omitted registration name and explicit rename clearing", () => {
    expect(validateDaemonName("   ")).toBeNull();
    expect(validateDaemonName("   ", { allowEmpty: false })).toBe(
      "Daemon name cannot be empty."
    );
    expect(daemonNameUpdate("  ")).toEqual({ kind: "clear" });
    expect(daemonNameUpdate("  rack-04  ")).toEqual({
      kind: "set",
      value: "rack-04",
    });
  });
});
