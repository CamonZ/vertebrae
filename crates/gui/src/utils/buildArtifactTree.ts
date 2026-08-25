import type { Artifact } from "../bindings";

export interface ArtifactTreeLeaf {
  kind: "artifact";
  /** Artifact IDs remain the identity used by selection and React keys. */
  id: string;
  /** The basename shown in the tree row. */
  label: string;
  /** The unmodified logical name or filename shown by the inspector. */
  displayName: string;
  artifact: Artifact;
}

export interface ArtifactTreeFolder {
  kind: "folder";
  /** Synthetic folder IDs are namespaced so they cannot shadow artifact IDs. */
  id: string;
  /** Normalized path used as the stable folder identity. */
  path: string;
  label: string;
  children: ArtifactTreeNode[];
}

export type ArtifactTreeNode = ArtifactTreeFolder | ArtifactTreeLeaf;

interface MutableChildren {
  folders: Map<string, MutableFolder>;
  leaves: ArtifactTreeLeaf[];
}

interface MutableFolder extends MutableChildren {
  path: string;
  label: string;
}

export function artifactDisplayName(artifact: Artifact): string {
  return artifact.logical_name ?? artifact.filename;
}

/**
 * Split path-like artifact names without changing the stored display name.
 * Both separators are accepted and empty segments are deliberately discarded.
 */
export function artifactPathSegments(displayName: string): string[] {
  return displayName.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function compareLabels(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNodes(left: ArtifactTreeNode, right: ArtifactTreeNode): number {
  // Folders always precede leaves, including when a real artifact has the
  // same label as a synthetic folder (for example, reports and reports/x.md).
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;

  const labelOrder = compareLabels(left.label, right.label);
  if (labelOrder !== 0) return labelOrder;

  if (left.kind === "artifact" && right.kind === "artifact") {
    return compareLabels(left.id, right.id);
  }

  if (left.kind === "folder" && right.kind === "folder") {
    return compareLabels(left.path, right.path);
  }

  return 0;
}

function sortedNodes(children: MutableChildren): ArtifactTreeNode[] {
  const folders: ArtifactTreeFolder[] = [...children.folders.values()].map(
    (folder) => ({
      kind: "folder",
      id: `folder:${folder.path}`,
      path: folder.path,
      label: folder.label,
      children: sortedNodes(folder),
    })
  );

  return [...folders, ...children.leaves].sort(compareNodes);
}

/**
 * Build the project artifact hierarchy entirely on the frontend.
 *
 * Every input artifact produces exactly one leaf. Folder nodes are synthesized
 * only for path prefixes, so a file/folder prefix collision retains both rows.
 */
export function buildArtifactTree(artifacts: Artifact[]): ArtifactTreeNode[] {
  const root: MutableChildren = { folders: new Map(), leaves: [] };

  for (const artifact of artifacts) {
    const displayName = artifactDisplayName(artifact);
    const segments = artifactPathSegments(displayName);
    const leafLabel = segments[segments.length - 1] ?? displayName;
    const leaf: ArtifactTreeLeaf = {
      kind: "artifact",
      id: artifact.id,
      label: leafLabel,
      displayName,
      artifact,
    };

    if (segments.length < 2) {
      root.leaves.push(leaf);
      continue;
    }

    let parent = root;
    const pathSegments: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      pathSegments.push(segment);
      const path = pathSegments.join("/");
      let folder = parent.folders.get(path);
      if (!folder) {
        folder = { path, label: segment, folders: new Map(), leaves: [] };
        parent.folders.set(path, folder);
      }
      parent = folder;
    }
    parent.leaves.push(leaf);
  }

  return sortedNodes(root);
}

export function collectArtifactFolderIds(nodes: ArtifactTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "folder"
      ? [node.id, ...collectArtifactFolderIds(node.children)]
      : []
  );
}

/** Flatten only currently visible leaves in the same depth-first order as rendering. */
export function flattenVisibleArtifactLeaves(
  nodes: ArtifactTreeNode[],
  expandedNodeIds: ReadonlySet<string>
): ArtifactTreeLeaf[] {
  const visible: ArtifactTreeLeaf[] = [];
  for (const node of nodes) {
    if (node.kind === "artifact") {
      visible.push(node);
    } else if (expandedNodeIds.has(node.id)) {
      visible.push(
        ...flattenVisibleArtifactLeaves(node.children, expandedNodeIds)
      );
    }
  }
  return visible;
}
