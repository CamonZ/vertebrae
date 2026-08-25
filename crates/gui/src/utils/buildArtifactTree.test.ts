import { describe, expect, it } from "vitest";
import type { Artifact } from "../bindings";
import {
  artifactPathSegments,
  buildArtifactTree,
  flattenVisibleArtifactLeaves,
} from "./buildArtifactTree";

function artifact(
  id: string,
  logicalName: string | null,
  filename = `${id}.txt`
): Artifact {
  return {
    id,
    project_id: "project-1",
    filename,
    body: id,
    logical_name: logicalName,
    metadata: null,
    created_at: null,
    updated_at: null,
  };
}

function shape(nodes: ReturnType<typeof buildArtifactTree>): unknown[] {
  return nodes.map((node) =>
    node.kind === "folder"
      ? {
          kind: "folder",
          id: node.id,
          path: node.path,
          label: node.label,
          children: shape(node.children),
        }
      : {
          kind: "artifact",
          id: node.id,
          label: node.label,
          displayName: node.displayName,
        }
  );
}

describe("buildArtifactTree", () => {
  it("builds root leaves and merges shared nested prefixes", () => {
    const tree = buildArtifactTree([
      artifact("guide", "docs/guide.md"),
      artifact("types", "docs/api/types.md"),
      artifact("readme", "docs/api/readme.md"),
      artifact("root", "README.md"),
      artifact("fallback", null, "fallback.md"),
    ]);

    expect(shape(tree)).toEqual([
      {
        kind: "folder",
        id: "folder:docs",
        path: "docs",
        label: "docs",
        children: [
          {
            kind: "folder",
            id: "folder:docs/api",
            path: "docs/api",
            label: "api",
            children: [
              {
                kind: "artifact",
                id: "readme",
                label: "readme.md",
                displayName: "docs/api/readme.md",
              },
              {
                kind: "artifact",
                id: "types",
                label: "types.md",
                displayName: "docs/api/types.md",
              },
            ],
          },
          {
            kind: "artifact",
            id: "guide",
            label: "guide.md",
            displayName: "docs/guide.md",
          },
        ],
      },
      {
        kind: "artifact",
        id: "root",
        label: "README.md",
        displayName: "README.md",
      },
      {
        kind: "artifact",
        id: "fallback",
        label: "fallback.md",
        displayName: "fallback.md",
      },
    ]);
  });

  it("normalizes both separators and ignores repeated or boundary separators", () => {
    expect(artifactPathSegments("\\/src\\\\//main.ts/\\")).toEqual([
      "src",
      "main.ts",
    ]);

    const tree = buildArtifactTree([
      artifact("slash", "/src//main.ts/"),
      artifact("backslash", "src\\main.ts"),
      artifact("plain", "notes"),
      artifact("only-separators", "///"),
    ]);

    expect(shape(tree)).toEqual([
      {
        kind: "folder",
        id: "folder:src",
        path: "src",
        label: "src",
        children: [
          {
            kind: "artifact",
            id: "backslash",
            label: "main.ts",
            displayName: "src\\main.ts",
          },
          {
            kind: "artifact",
            id: "slash",
            label: "main.ts",
            displayName: "/src//main.ts/",
          },
        ],
      },
      {
        kind: "artifact",
        id: "only-separators",
        label: "///",
        displayName: "///",
      },
      { kind: "artifact", id: "plain", label: "notes", displayName: "notes" },
    ]);
  });

  it("keeps duplicate basenames and file/folder prefix collisions distinct", () => {
    const tree = buildArtifactTree([
      artifact("reports-file", "reports"),
      artifact("summary", "reports/summary.md"),
      artifact("summary-other", "reports\\summary.md"),
      artifact("same-z", "same.txt"),
      artifact("same-a", "same.txt"),
    ]);

    expect(shape(tree)).toEqual([
      {
        kind: "folder",
        id: "folder:reports",
        path: "reports",
        label: "reports",
        children: [
          {
            kind: "artifact",
            id: "summary",
            label: "summary.md",
            displayName: "reports/summary.md",
          },
          {
            kind: "artifact",
            id: "summary-other",
            label: "summary.md",
            displayName: "reports\\summary.md",
          },
        ],
      },
      {
        kind: "artifact",
        id: "reports-file",
        label: "reports",
        displayName: "reports",
      },
      {
        kind: "artifact",
        id: "same-a",
        label: "same.txt",
        displayName: "same.txt",
      },
      {
        kind: "artifact",
        id: "same-z",
        label: "same.txt",
        displayName: "same.txt",
      },
    ]);

    const leaves = flattenVisibleArtifactLeaves(
      tree,
      new Set(["folder:reports"])
    );
    expect(leaves.map((leaf) => leaf.id)).toEqual([
      "summary",
      "summary-other",
      "reports-file",
      "same-a",
      "same-z",
    ]);
  });

  it("skips leaves under collapsed folders without changing their identity", () => {
    const tree = buildArtifactTree([
      artifact("one", "docs/one.md"),
      artifact("two", "docs/two.md"),
      artifact("root", "root.md"),
    ]);

    expect(
      flattenVisibleArtifactLeaves(tree, new Set()).map((leaf) => leaf.id)
    ).toEqual(["root"]);
    expect(
      flattenVisibleArtifactLeaves(tree, new Set(["folder:docs"])).map(
        (leaf) => leaf.id
      )
    ).toEqual(["one", "two", "root"]);
  });
});
