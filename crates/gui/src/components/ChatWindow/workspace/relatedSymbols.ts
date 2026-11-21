import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedSymbols,
  LineSpan,
  Resolution,
  Side,
  SymbolEdit,
} from "../../../bindings";
import type { FilePatch } from "../../thread/toolChange/diffLineMapper";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import type { SemanticFile } from "./useChangeFiles";

export interface SymbolLink {
  text: string;
  location: SourceLocation;
}

export interface SymbolGraphRequest {
  key: string;
  load(): Promise<ChangedSymbols>;
}

export function useRelatedSymbols(
  request: SymbolGraphRequest | undefined,
  patches: ReadonlyMap<string, FilePatch>
) {
  const latest = useRef(request);
  latest.current = request;
  const key = request?.key;
  const [result, setResult] = useState<{
    key: string;
    graph?: ChangedSymbols;
  }>();
  useEffect(() => {
    const load = latest.current?.load;
    if (key === undefined || !load) return;
    let current = true;
    void load().then(
      (graph) => {
        if (current) setResult({ key, graph });
      },
      () => {
        if (current) setResult({ key });
      }
    );
    return () => {
      current = false;
    };
  }, [key]);
  const graph = result?.key === key ? result?.graph : undefined;
  return useMemo(() => {
    const links = new Map<string, Map<number, Map<string, SymbolLink>>>();
    if (!graph)
      return { links, incomplete: key !== undefined && result?.key === key };
    const locations = new Map<
      SymbolEdit,
      Partial<Record<Side, SourceLocation>>
    >();
    for (const symbol of graph.symbols) {
      for (const edit of symbol.edits) {
        const patch = patches.get(edit.path);
        if (patch)
          locations.set(edit, {
            old: editLocation(edit, patch, "old"),
            new: editLocation(edit, patch, "new"),
          });
      }
    }
    const relations = new Map<
      string,
      {
        from: number;
        to: number;
        quality: Resolution["quality"];
        side: Side;
      }
    >();
    for (const edge of graph.calls) {
      if (edge.changed_caller === null) continue;
      const quality = edge.call.resolution.quality;
      for (const to of edge.changed_targets) {
        const from = edge.changed_caller;
        if (from === to) continue;
        const key = JSON.stringify([from, to, quality]);
        if (edge.side === "new" || !relations.has(key)) {
          relations.set(key, { from, to, quality, side: edge.side });
        }
      }
    }
    const add = (
      from: number,
      to: number,
      direction: string,
      side: Side,
      detail: string
    ) => {
      const source = graph.symbols[from];
      const target = graph.symbols[to];
      const destination = (at: Side) =>
        target.edits.map((edit) => locations.get(edit)?.[at]).find(Boolean);
      const location =
        destination(side) ?? destination(side === "old" ? "new" : "old");
      if (!location) return;
      const name = target.id.scope.at(-1) ?? target.id.path;
      const change =
        target.change === "modified"
          ? "changed"
          : target.change.replace("_", " ");
      const text = `${direction} ${name} (${change})${detail}`;
      for (const edit of source.edits) setLink(links, edit, { text, location });
    };
    for (const { from, to, quality, side } of relations.values()) {
      const resolution =
        quality === "ambiguous"
          ? " · ambiguous"
          : quality === "name_match"
            ? " · name match"
            : "";
      const detail = resolution + (side === "old" ? " · base" : "");
      add(from, to, "Calls", side, detail);
      add(to, from, "Called by", side, detail);
    }
    for (const symbol of graph.symbols) {
      const [target, base] = symbol.edits;
      if (!base) continue;
      const from = locations.get(base)?.old;
      const to = locations.get(target)?.new;
      if (!from || !to) continue;
      setLink(links, target, {
        text: `Moved from ${from.path}`,
        location: from,
      });
      setLink(links, base, { text: `Moved to ${to.path}`, location: to });
    }
    return { links, incomplete: graph.incomplete };
  }, [graph, key, patches, result?.key]);
}

function setLink(
  links: Map<string, Map<number, Map<string, SymbolLink>>>,
  edit: SymbolEdit,
  link: SymbolLink
) {
  const key = JSON.stringify([edit.path, edit.old_revision, edit.new_revision]);
  const byDeclaration = links.get(key) ?? new Map();
  links.set(key, byDeclaration);
  const byDestination = byDeclaration.get(edit.index) ?? new Map();
  byDeclaration.set(edit.index, byDestination);
  byDestination.set(JSON.stringify([link.text, link.location]), link);
}

export function linksForFile(
  links: ReturnType<typeof useRelatedSymbols>["links"],
  path: string,
  file: SemanticFile | null
) {
  if (file?.status !== "semantic") return undefined;
  return links.get(JSON.stringify([path, file.oldRevision, file.newRevision]));
}

export function linksAt(
  declarations: ReturnType<typeof linksForFile>,
  indices: readonly number[]
): SymbolLink[] {
  const unique = new Map<string, SymbolLink>();
  for (const index of indices) {
    for (const [key, link] of declarations?.get(index) ?? [])
      unique.set(key, link);
  }
  return [...unique.values()];
}

function editLocation(
  edit: SymbolEdit,
  patch: FilePatch,
  side: Side
): SourceLocation | undefined {
  const { change, parts } = edit.declaration;
  const spans = [change, ...parts].flatMap((edit): LineSpan[] => {
    const span =
      side === "old" && "old" in edit
        ? edit.old
        : side === "new" && "new" in edit
          ? edit.new
          : null;
    return span ? [span] : [];
  });
  for (const hunk of patch.hunks) {
    for (const row of hunk.rows) {
      if (row.kind !== (side === "old" ? "del" : "add")) continue;
      const line = side === "old" ? row.oldLine : row.newLine;
      if (
        line !== null &&
        spans.some((span) => span.start <= line && line <= span.end)
      ) {
        return { path: edit.path, line, side };
      }
    }
  }
}
