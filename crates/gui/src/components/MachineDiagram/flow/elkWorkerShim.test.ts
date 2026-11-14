import { afterEach, expect, test, vi } from "vitest";

/* Load the bundled elkjs the way a dedicated worker does: `self` exists and
   `document` does not. */
const page = Object.getOwnPropertyDescriptor(globalThis, "document")!;
const asWorker = () => {
  delete (globalThis as { document?: unknown }).document;
};
const graph = {
  id: "root",
  children: [
    { id: "a", width: 10, height: 10 },
    { id: "b", width: 10, height: 10 },
  ],
  edges: [{ id: "e", sources: ["a"], targets: ["b"] }],
};

afterEach(() => {
  Object.defineProperty(globalThis, "document", page);
  vi.resetModules();
});

test("the shim lets elkjs lay out in a worker scope", async () => {
  asWorker();
  await import("./elkWorkerShim");
  const { elk } = await import("../../../hooks/useElkLayout");
  await import("./elkWorkerUnshim");
  // Nothing after the shim pair sees a document that is not a DOM.
  expect("document" in globalThis).toBe(false);
  const laid = await elk.layout(graph);
  expect(laid.children?.map((c) => c.id)).toEqual(["a", "b"]);
});
