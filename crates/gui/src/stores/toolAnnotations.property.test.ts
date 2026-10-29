import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { LocalChatAnnotation } from "../bindings";
import {
  mergeToolAnnotations,
  toolAnnotationEntries,
  type ToolAnnotations,
} from "./toolAnnotations";

const TARGET = "chat-a";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const annotation = gs.record<LocalChatAnnotation>({
  session_id: gs.sampledFrom([TARGET, "chat-b"]),
  tool_id: gs.sampledFrom(["t0", "t1", "t2"]),
  kind: gs.sampledFrom(["worktree_delta", "other"]),
  payload: gs.integers(),
  recorded_at: gs.just("2026-01-01T00:00:00Z"),
});

/** The spec: the last entry of this session wins per (tool, kind). */
function expected(entries: LocalChatAnnotation[]): Map<string, unknown> {
  const wanted = new Map<string, unknown>();
  for (const e of entries) {
    if (e.session_id === TARGET)
      wanted.set(`${e.tool_id}/${e.kind}`, e.payload);
  }
  return wanted;
}

function flatten(annotations: ToolAnnotations): Map<string, unknown> {
  return new Map(
    toolAnnotationEntries(annotations).map((e) => [
      `${e.tool_id}/${e.kind}`,
      e.payload,
    ])
  );
}

function sameMap(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

test("hydration keeps one entry per (tool, kind), the last, and only this session's", () =>
  hegel.test((tc) => {
    const entries = tc.draw(gs.arrays(annotation, { maxSize: 12 }));
    const merged = mergeToolAnnotations(TARGET, undefined, entries);
    check(
      sameMap(flatten(merged), expected(entries)),
      "merge diverges from spec"
    );
  }));

test("applying entries live one by one equals hydrating them at once", () =>
  hegel.test((tc) => {
    const entries = tc.draw(gs.arrays(annotation, { maxSize: 12 }));
    let live: ToolAnnotations | undefined;
    for (const e of entries) live = mergeToolAnnotations(TARGET, live, [e]);
    const hydrated = mergeToolAnnotations(TARGET, undefined, entries);
    check(
      sameMap(flatten(live ?? {}), flatten(hydrated)),
      "live and hydrated state differ"
    );
  }));

test("hydrating on top of live entries lets the later entries win", () =>
  hegel.test((tc) => {
    const early = tc.draw(gs.arrays(annotation, { maxSize: 8 }));
    const late = tc.draw(gs.arrays(annotation, { maxSize: 8 }));
    const base = mergeToolAnnotations(TARGET, undefined, early);
    const merged = mergeToolAnnotations(TARGET, base, late);
    check(
      sameMap(flatten(merged), expected([...early, ...late])),
      "later entries did not win"
    );
  }));
