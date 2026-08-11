import { describe, expect, it } from "vitest";
import { isDebugConsoleShortcut } from "./debugShortcut";

const event = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    code: "",
    key: "",
    ...overrides,
  }) as KeyboardEvent;

describe("isDebugConsoleShortcut", () => {
  it("accepts the macOS shortcut by key code", () => {
    expect(
      isDebugConsoleShortcut(
        event({ metaKey: true, shiftKey: true, code: "KeyD" })
      )
    ).toBe(true);
  });

  it("falls back to the key value when code is unavailable", () => {
    expect(
      isDebugConsoleShortcut(
        event({ metaKey: true, shiftKey: true, key: "d" })
      )
    ).toBe(true);
  });

  it("supports the control-key equivalent", () => {
    expect(
      isDebugConsoleShortcut(
        event({ ctrlKey: true, shiftKey: true, key: "D" })
      )
    ).toBe(true);
  });

  it("rejects incomplete shortcuts", () => {
    expect(isDebugConsoleShortcut(event({ metaKey: true, key: "d" }))).toBe(
      false
    );
  });
});
