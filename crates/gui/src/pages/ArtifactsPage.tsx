import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Artifact } from "../bindings";
import { Badge } from "../components/atoms/Badge";
import { ArtifactInspectorPanel } from "../components/Artifacts/ArtifactInspectorPanel";
import { TreeNode } from "../components/molecules/TreeNode";
import { Spinner } from "../components/Spinner";
import { usePanelExitTransition } from "../hooks/usePanelExitTransition";
import { useExpandedNodes } from "../hooks/useExpandedNodes";
import { useProjectArtifacts } from "../hooks/useProjectArtifacts";
import { useShellHeader } from "../hooks/useShellHeader";
import {
  buildArtifactTree,
  collectArtifactFolderIds,
  flattenVisibleArtifactLeaves,
  type ArtifactTreeNode,
} from "../utils/buildArtifactTree";

function artifactCue(artifact: Artifact) {
  const metadata = artifact.metadata;
  if (!metadata) return "raw";
  return metadata.content_kind === "conversation"
    ? "conversation"
    : metadata.format;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function artifactTypeLabel(artifact: Artifact) {
  const cue = artifactCue(artifact);
  if (cue === "conversation") return "Conversation";
  if (cue === "raw") return "Raw";
  return cue.charAt(0).toUpperCase() + cue.slice(1);
}

interface ArtifactTreeRowsProps {
  nodes: ArtifactTreeNode[];
  depth: number;
  expandedNodeIds: ReadonlySet<string>;
  selectedArtifactId: string | null;
  onToggle: (nodeId: string) => void;
  onSelect: (artifact: Artifact) => void;
}

function ArtifactTreeRows({
  nodes,
  depth,
  expandedNodeIds,
  selectedArtifactId,
  onToggle,
  onSelect,
}: ArtifactTreeRowsProps) {
  return nodes.map((node) => {
    if (node.kind === "artifact") {
      return (
        <TreeNode
          key={node.id}
          depth={depth}
          selected={node.id === selectedArtifactId}
          onSelect={() => onSelect(node.artifact)}
          right={
            <Badge
              size="sm"
              className="uppercase tracking-[0.08em]"
              testId={`artifact-tree-type-${node.id}`}
            >
              {artifactTypeLabel(node.artifact)}
            </Badge>
          }
          showGuides
          testId={`artifact-tree-leaf-${node.id}`}
        >
          {node.label}
        </TreeNode>
      );
    }

    const expanded = expandedNodeIds.has(node.id);
    return (
      <Fragment key={node.id}>
        <TreeNode
          depth={depth}
          hasChildren={node.children.length > 0}
          expanded={expanded}
          onToggle={() => onToggle(node.id)}
          showGuides
          testId={`artifact-tree-folder-${node.id}`}
        >
          {node.label}
        </TreeNode>
        {expanded && (
          <div role="group" aria-label={`Contents of ${node.label}`}>
            <ArtifactTreeRows
              nodes={node.children}
              depth={depth + 1}
              expandedNodeIds={expandedNodeIds}
              selectedArtifactId={selectedArtifactId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          </div>
        )}
      </Fragment>
    );
  });
}

export function ArtifactsPage() {
  const { artifacts, isLoading, error } = useProjectArtifacts();
  const expandedNodes = useExpandedNodes();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null
  );
  const lastSelectedArtifactRef = useRef<Artifact | null>(null);
  const expansionProjectRef = useRef<string | null | undefined>(undefined);
  const initializedExpansionRef = useRef(false);
  const knownFolderIdsRef = useRef(new Set<string>());
  const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts]);
  const folderIds = useMemo(() => collectArtifactFolderIds(tree), [tree]);
  const projectId = artifacts[0]?.project_id ?? null;
  const visibleLeaves = useMemo(
    () => flattenVisibleArtifactLeaves(tree, expandedNodes.expandedNodeIds),
    [tree, expandedNodes.expandedNodeIds]
  );

  useEffect(() => {
    if (expansionProjectRef.current !== projectId) {
      expansionProjectRef.current = projectId;
      initializedExpansionRef.current = false;
      knownFolderIdsRef.current = new Set();
    }

    const validFolderIds = new Set(folderIds);
    const nextExpandedNodeIds = initializedExpansionRef.current
      ? new Set(
          [...expandedNodes.expandedNodeIds].filter((id) =>
            validFolderIds.has(id)
          )
        )
      : new Set(validFolderIds);

    // New prefixes are visible by default, while existing IDs retain an
    // explicit collapse/expand choice across query and CDC updates.
    if (initializedExpansionRef.current) {
      for (const id of validFolderIds) {
        if (!knownFolderIdsRef.current.has(id)) nextExpandedNodeIds.add(id);
      }
    }

    knownFolderIdsRef.current = validFolderIds;
    initializedExpansionRef.current = true;
    if (!sameIds(expandedNodes.expandedNodeIds, nextExpandedNodeIds)) {
      expandedNodes.expandAll([...nextExpandedNodeIds]);
    }
  }, [artifacts.length, expandedNodes, folderIds, projectId]);
  const selectedArtifact = useMemo(
    () =>
      artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId]
  );
  if (selectedArtifact) lastSelectedArtifactRef.current = selectedArtifact;

  useEffect(() => {
    if (
      selectedArtifactId &&
      !artifacts.some((artifact) => artifact.id === selectedArtifactId)
    ) {
      setSelectedArtifactId(null);
    }
  }, [artifacts, selectedArtifactId]);

  const {
    mounted: inspectorMounted,
    closing: inspectorClosing,
    onAnimationEnd: inspectorOnAnimationEnd,
  } = usePanelExitTransition(selectedArtifactId != null, 180);

  const selectArtifact = useCallback((artifact: Artifact) => {
    setSelectedArtifactId(artifact.id);
  }, []);
  const closeInspector = useCallback(() => setSelectedArtifactId(null), []);

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = visibleLeaves.findIndex(
        (leaf) => leaf.id === selectedArtifactId
      );
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (visibleLeaves.length === 0) return;
      const next =
        currentIndex < 0
          ? event.key === "ArrowDown"
            ? 0
            : visibleLeaves.length - 1
          : Math.max(
              0,
              Math.min(
                visibleLeaves.length - 1,
                currentIndex + (event.key === "ArrowDown" ? 1 : -1)
              )
            );
      setSelectedArtifactId(visibleLeaves[next].id);
    },
    [selectedArtifactId, visibleLeaves]
  );

  useShellHeader(
    "Artifacts",
    !isLoading && !error ? (
      <span className="text-eyebrow text-fg-mute">
        {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
      </span>
    ) : undefined
  );

  return (
    <div className="tasks-v2 flex min-h-0 flex-1">
      <main className="list-col" aria-label="Project artifacts">
        <h1 className="sr-only">Artifacts</h1>
        <div className="list-head">
          <span className="font-mono text-eyebrow uppercase tracking-wider text-fg-mute">
            Project attachments
          </span>
        </div>
        <div
          role="tree"
          aria-label="Project artifacts"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {isLoading && artifacts.length === 0 ? (
            <div
              className="flex justify-center py-8"
              aria-label="Loading artifacts"
            >
              <Spinner />
            </div>
          ) : error ? (
            <p role="alert" className="p-4 text-sm text-err">
              {error}
            </p>
          ) : artifacts.length === 0 ? (
            <p className="p-4 text-sm text-fg-mute">
              No project artifacts yet.
            </p>
          ) : (
            <ArtifactTreeRows
              nodes={tree}
              depth={0}
              expandedNodeIds={expandedNodes.expandedNodeIds}
              selectedArtifactId={selectedArtifactId}
              onToggle={expandedNodes.toggleNode}
              onSelect={selectArtifact}
            />
          )}
        </div>
      </main>
      {inspectorMounted && (
        <ArtifactInspectorPanel
          artifact={selectedArtifact ?? lastSelectedArtifactRef.current}
          closing={inspectorClosing}
          onClose={closeInspector}
          onExitAnimationEnd={inspectorOnAnimationEnd}
        />
      )}
    </div>
  );
}
