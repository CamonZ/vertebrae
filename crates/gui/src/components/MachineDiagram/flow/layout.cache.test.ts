import { beforeEach, expect, test, vi } from "vitest";
import { elk } from "../../../hooks/useElkLayout";
import { compileFlowOrThrow } from "./compile";
import { layoutFlow, layoutFrom, resetLayoutCache } from "./layout";

// The level cache is module-wide; keep every case's layout independent.
beforeEach(resetLayoutCache);

const spec = (id: string, scale = 0.75, label = "ok") => ({
  version: 1,
  parts: [
    { id: `a-${id}`, kind: "aggregator", scale },
    { id: `b-${id}`, kind: "aggregator" },
  ],
  rails: [{ id: "wire", from: `a-${id}.out`, to: `b-${id}.in`, label }],
});

test("identical level geometry shares work and uncached replay remains identical", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    const flow = compileFlowOrThrow(spec("shared"));
    const [a, b] = await Promise.all([layoutFlow(flow), layoutFlow(flow)]);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    const fresh = await layoutFlow(flow, { cache: false });
    expect(observed).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual(a);
    expect(
      compileFlowOrThrow(spec("shared"), { layout: layoutFrom(a) })
    ).toEqual(
      compileFlowOrThrow(spec("shared"), { layout: layoutFrom(fresh) })
    );
  } finally {
    observed.mockRestore();
  }
});

test("port geometry, extents and label changes invalidate the value cache", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    await layoutFlow(compileFlowOrThrow(spec("changed")));
    await layoutFlow(compileFlowOrThrow(spec("changed", 0.5)));
    await layoutFlow(
      compileFlowOrThrow(spec("changed", 0.5, "a longer reserved label"))
    );
    expect(observed).toHaveBeenCalledTimes(3);
  } finally {
    observed.mockRestore();
  }
});

test("eviction is bounded and a rejected computation can be retried", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    for (let i = 0; i < 65; i++)
      await layoutFlow(compileFlowOrThrow(spec(`evict-${i}`)));
    await layoutFlow(compileFlowOrThrow(spec("evict-0")));
    expect(observed).toHaveBeenCalledTimes(66);
    observed.mockRejectedValueOnce(new Error("transient layout failure"));
    await expect(layoutFlow(compileFlowOrThrow(spec("retry")))).rejects.toThrow(
      "transient layout failure"
    );
    await expect(
      layoutFlow(compileFlowOrThrow(spec("retry")))
    ).resolves.toHaveProperty("positions");
    expect(observed).toHaveBeenCalledTimes(68);
  } finally {
    observed.mockRestore();
  }
});

test("resetting the cache forces a fresh layout of the same geometry", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    const flow = compileFlowOrThrow(spec("reset"));
    const before = await layoutFlow(flow);
    await layoutFlow(flow);
    expect(observed).toHaveBeenCalledTimes(1);
    resetLayoutCache();
    expect(await layoutFlow(flow)).toEqual(before);
    expect(observed).toHaveBeenCalledTimes(2);
  } finally {
    observed.mockRestore();
  }
});

test("live-header reservation has a distinct structural cache identity", async () => {
  const observed = vi.spyOn(elk, "layout");
  try {
    const base = spec("header");
    const regions = [
      { id: "region", label: "Workflow", parts: base.parts.map((p) => p.id) },
    ];
    await layoutFlow(compileFlowOrThrow({ ...base, regions }));
    const live = compileFlowOrThrow({
      ...base,
      regions: regions.map((r) => ({ ...r, liveHeader: true })),
    });
    await layoutFlow(live);
    expect(observed).toHaveBeenCalledTimes(2);
    await layoutFlow(live);
    expect(observed).toHaveBeenCalledTimes(2);
  } finally {
    observed.mockRestore();
  }
});
