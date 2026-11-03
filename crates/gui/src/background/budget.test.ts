import { expect, it } from "vitest";
import { dataWeight, taskWeight } from "./budget";

it("counts text and object overhead without JSON serialization", () => {
  expect(dataWeight({ text: "hello" }, 1000)).toBeGreaterThan(10);
  expect(dataWeight({ text: "x".repeat(1000) }, 100)).toBeGreaterThan(100);
});

it("rejects callbacks and terminates on cycles without recursion", () => {
  expect(() => dataWeight({ callback() {} }, 1000)).toThrow("callbacks");

  const value: { self?: object } = {};
  value.self = value;
  expect(dataWeight(value, 1000)).toBeLessThan(1000);
});

it("bounds replay records and large patch payloads without stringifying", () => {
  expect(
    taskWeight(
      { kind: "patch", patches: ["x".repeat(1000)], review: false },
      100
    )
  ).toBeGreaterThan(100);

  expect(
    taskWeight(
      {
        kind: "replay",
        input: {
          kind: "initial",
          refresh: false,
          context: { id: "session", providerResumeId: null },
          lines: [],
          previousInstalled: [],
          messages: [
            { kind: "assistant", text: "x".repeat(1000), timestamp: "now" },
          ],
        },
      },
      100
    )
  ).toBeGreaterThan(100);
});
