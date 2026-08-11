import { describe, expect, it } from "vitest";
import {
  crateNameFromTarget,
  formatDebugLogMessage,
  inferDebugCrate,
  splitDebugLogTarget,
} from "./debugLog";

describe("debug log helpers", () => {
  it("extracts the full Rust log target", () => {
    expect(
      splitDebugLogTarget(
        "[vertebrae_harness_claude::runtime::session] [LOCAL_CHAT_TRACE] {}"
      )
    ).toEqual({
      target: "vertebrae_harness_claude::runtime::session",
      message: "[LOCAL_CHAT_TRACE] {}",
    });
  });

  it("normalizes Rust crate names for display", () => {
    expect(crateNameFromTarget("vertebrae_harness_codex::runtime")).toBe(
      "harness-codex"
    );
    expect(crateNameFromTarget("gui_lib::commands")).toBe("gui-tauri");
  });

  it("uses the target to identify the emitting crate", () => {
    expect(
      inferDebugCrate("[vertebrae_harness_claude::runtime::events] warning")
    ).toBe("harness-claude");
    expect(inferDebugCrate("startup complete")).toBe("unattributed");
  });

  it("removes only the Rust target prefix for display", () => {
    expect(
      formatDebugLogMessage("[vertebrae_harness_codex::runtime] [Codex] websocket closed")
    ).toBe("[Codex] websocket closed");
  });
});
