import { describe, expect, it } from "vitest";
import {
  CommandResultError,
  errorMessage,
  unwrapCommand,
} from "./commandResult";

describe("command result helpers", () => {
  it("unwraps ok command results", async () => {
    await expect(
      unwrapCommand(Promise.resolve({ status: "ok", data: "ready" }))
    ).resolves.toBe("ready");
  });

  it("throws CommandResultError for error command results", async () => {
    const commandError = { message: "backend said no" };

    await expect(
      unwrapCommand(Promise.resolve({ status: "error", error: commandError }))
    ).rejects.toMatchObject({
      name: "CommandResultError",
      message: "backend said no",
      cause: commandError,
    });
  });

  it("normalizes error-like values to display messages", () => {
    expect(errorMessage(new Error("plain error"))).toBe("plain error");
    expect(errorMessage({ message: "object error" })).toBe("object error");
    expect(errorMessage("string error")).toBe("string error");
  });

  it("sets a stable error name and cause", () => {
    const cause = { message: "nested" };
    const error = new CommandResultError("top-level", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CommandResultError");
    expect(error.message).toBe("top-level");
    expect(error.cause).toBe(cause);
  });
});
