import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileFlow, compileFlowOrThrow } from "../compile";
import { FlowDiagram } from "../FlowDiagram";
import { parseFlowSpec } from "../parse";
import type { StepSpec } from "../spec";

type Step = Omit<StepSpec, "part">;
function run(kind: string, steps: readonly Step[]) {
  return compileFlowOrThrow({
    version: 1,
    parts: [{ id: "p", kind }],
    cards: [{ id: "write", token: "request", label: "write" }],
    story: [{ steps: steps.map((s) => ({ ...s, part: "p" })) }],
  }).arrangements[0];
}
const lines = (kind: string, steps: readonly Step[]) =>
  run(kind, steps).parts[0].timeline.notes.map((n) => n[1]);
const ack = (replica: number): Step => ({ verb: "ack", args: { replica } });
const vote = (participant: number, yes = true): Step => ({
  verb: "vote",
  args: { participant, yes },
});

describe("distributed protocol verbs", () => {
  it("counts distinct quorum replies and fails without a majority", () => {
    expect(
      lines("quorum", [
        { verb: "replicate" },
        ack(1),
        ack(1),
        { verb: "decide" },
      ])
    ).toContain("no quorum · write fails");
    expect(
      lines("quorum", [
        { verb: "replicate" },
        ack(1),
        ack(2),
        { verb: "decide" },
      ])
    ).toContain("2 acks · quorum · ok");
  });
  it("replication waits for both followers and resets acknowledgements for a new write", () => {
    const steps: Step[] = [
      { verb: "replicate", card: "write" },
      { verb: "ack", args: { follower: 1 } },
      { verb: "commit" },
    ];
    expect(lines("replication", steps)).toContain(
      "followers still catching up"
    );
    expect(
      lines("replication", [
        ...steps,
        { verb: "ack", args: { follower: 2 } },
        { verb: "commit" },
      ])
    ).toContain("2 of 2 followers at v8");
    expect(
      lines("replication", [
        ...steps,
        { verb: "replicate" },
        { verb: "commit" },
        { verb: "fail" },
      ])
    ).toEqual(
      expect.arrayContaining(["followers still catching up", "leader crashed"])
    );
  });
  it("elects only after three distinct votes, then emits heartbeats", () => {
    const steps: Step[] = [
      { verb: "elect" },
      { verb: "vote", args: { node: 2 } },
      { verb: "vote", args: { node: 2 } },
    ];
    expect(
      lines("leader election", steps).some((n) => n.includes("leader · term"))
    ).toBe(false);
    expect(
      lines("leader election", [
        ...steps,
        { verb: "vote", args: { node: 3 } },
        { verb: "heartbeat" },
        { verb: "fail" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "n1 leader · term 2",
        "heartbeats hold it",
        "3 votes · no majority",
      ])
    );
  });
  it("failure detector can recover from suspicion when a late beat arrives", () => {
    expect(
      lines("failure detector", [
        { verb: "heartbeat" },
        { verb: "wait" },
        { verb: "suspect" },
        { verb: "fail" },
        { verb: "heartbeat" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "alive · timer resets",
        "0.7 s silent · suspect",
        "1.4 s silent · declared dead",
      ])
    );
  });
  it("gossip does not spread a rumour from a peer that has not learned it", () => {
    expect(
      lines("gossip", [
        { verb: "send" },
        { verb: "spread", args: { from: 2, to: 3 } },
        { verb: "spread", args: { from: 1, to: 2 } },
        { verb: "spread", args: { from: 2, to: 3 } },
        { verb: "fail" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "n2 has no news to spread",
        "3 of 6 know",
        "3 of 6 know · partitioned",
      ])
    );
  });
  it("routes clockwise including wraparound, and only rebalances B's interval", () => {
    expect(
      lines("shard ring", [
        { verb: "route", args: { angle: 330 } },
        { verb: "rebalance" },
        { verb: "route", args: { angle: 80 } },
      ])
    ).toEqual(
      expect.arrayContaining([
        "next node clockwise · A",
        "only 40°–100° moves · B → D",
        "A and C untouched",
        "next node clockwise · D",
      ])
    );
  });
  it("keeps concurrent siblings and merges them into one causally later value", () => {
    expect(
      lines("version vector", [
        { verb: "record", args: { a: 2, b: 0 } },
        { verb: "compare" },
        { verb: "record", args: { a: 1, b: 1 } },
        { verb: "compare" },
        { verb: "merge" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "newer · replace",
        "concurrent · keep both",
        "one value again",
      ])
    );
  });
  it("rejects the old lease holder after the new fencing token writes", () => {
    expect(
      lines("fencing token", [
        { verb: "fence", args: { token: 34 } },
        { verb: "record" },
        { verb: "record", args: { token: 33 } },
        { verb: "fail" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "34 ≥ 33 · accepted",
        "rejected · 33 < 34",
        "stale token rejected",
      ])
    );
  });
  it("requires all three yes votes and a living coordinator to commit", () => {
    const prepare: Step[] = [
      { verb: "stage", card: "write" },
      vote(1),
      vote(2),
    ];
    expect(
      lines("two-phase commit", [...prepare, { verb: "commit" }])
    ).toContain("can't commit · need 3 yes votes");
    expect(
      lines("two-phase commit", [...prepare, vote(3), { verb: "commit" }])
    ).toContain("all committed");
    expect(
      lines("two-phase commit", [
        ...prepare,
        vote(3, false),
        { verb: "rollback" },
      ])
    ).toEqual(
      expect.arrayContaining(["p3 can't prepare", "rolled back · locks freed"])
    );
    const blocked = lines("two-phase commit", [
      ...prepare,
      vote(3),
      { verb: "fail" },
      { verb: "commit" },
    ]);
    expect(blocked).toContain("blocked · locks held");
    expect(blocked).not.toContain("all committed");
  });
  it("keeps a crashed service discoverable until its registration expires", () => {
    expect(
      lines("service registry", [
        { verb: "register" },
        { verb: "fail" },
        { verb: "resolve" },
        { verb: "expire" },
        { verb: "resolve" },
      ])
    ).toEqual(
      expect.arrayContaining([
        "call s2 · connection refused",
        "entry removed",
        "lookup → s1 only",
        "call s1 · ok",
      ])
    );
  });
  it("returns a fenced write through its declared result port", () => {
    const flow = compileFlowOrThrow({
      version: 1,
      parts: [
        { id: "storage", kind: "fencing token" },
        { id: "view", kind: "client" },
      ],
      rails: [{ id: "reply", from: "storage.out", to: "view.result" }],
      cards: [{ id: "write", token: "request" }],
      story: [
        {
          steps: [
            { part: "storage", verb: "record", card: "write" },
            { part: "view", verb: "render", card: "write", via: "reply" },
          ],
        },
      ],
    }).arrangements[0];
    expect(flow.parts[1].timeline.notes.map((n) => n[1])).toContain("rendered");
  });
  it("rejects invalid node indices at the authored spec path", () => {
    const result = compileFlow({
      version: 1,
      parts: [{ id: "p", kind: "quorum" }],
      story: [{ steps: [{ verb: "ack", part: "p", args: { replica: 4 } }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "story[0].steps[0].args.replica" }),
        ])
      );
  });
  it("renders a parsed flow block with the actual distributed mechanisms", () => {
    const parsed = parseFlowSpec(`version: 1
parts:
  - { id: leader, kind: leader election }
  - { id: replicas, kind: replication }
  - { id: votes, kind: quorum }
story:
  - steps:
      - { part: leader, verb: elect }
      - { part: leader, verb: vote, args: { node: 2 } }
      - { part: leader, verb: vote, args: { node: 3 } }
      - { part: replicas, verb: replicate }
      - { part: votes, verb: replicate }
      - { part: votes, verb: ack, args: { replica: 1 } }
      - { part: votes, verb: ack, args: { replica: 2 } }
      - { part: votes, verb: decide }
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const diagram = compileFlowOrThrow(parsed.value).arrangements[0];
    for (const t of [
      0,
      ...diagram.beats.map((b) => b.t),
      diagram.period - 0.1,
    ]) {
      const html = renderToStaticMarkup(
        <FlowDiagram diagram={diagram} t={t} reducedMotion={false} />
      );
      expect(html).toContain("md-lamp");
      expect(html).toContain("md-box");
      expect(html).not.toMatch(/NaN|Infinity/);
    }
  });
});
