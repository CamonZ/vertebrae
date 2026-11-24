import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { Artifact } from "../bindings";
import { TreeNode } from "../components/molecules/TreeNode";
import { EmptyState } from "../components/molecules/EmptyState";
import { Spinner } from "../components/Spinner";
import { ScopeChip } from "../components/molecules/ScopeChip";
import { useExpandedNodes } from "../hooks/useExpandedNodes";
import { useProjectArtifacts } from "../hooks/useProjectArtifacts";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import { useShellHeader } from "../hooks/useShellHeader";
import { formatRelative } from "../utils/formatRelative";
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
  if (["json", "yaml", "toml", "html", "csv", "xml"].includes(cue)) {
    return cue.toUpperCase();
  }
  return cue.charAt(0).toUpperCase() + cue.slice(1);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const encoder = new TextEncoder();

function artifactBytes(artifact: Artifact) {
  return encoder.encode(artifact.body).length;
}

function artifactUpdated(artifact: Artifact) {
  return artifact.updated_at ?? artifact.created_at ?? null;
}

/** Every artifact under a folder, at any depth. */
function folderArtifacts(node: ArtifactTreeNode): Artifact[] {
  return node.kind === "artifact"
    ? [node.artifact]
    : node.children.flatMap(folderArtifacts);
}

function latest(dates: (string | null)[]) {
  return dates.reduce<string | null>(
    (best, date) => (date && (!best || date > best) ? date : best),
    null
  );
}

/** Fixed columns shared by the header and every row: type · size · updated. */
function ArtifactColumns({
  type,
  typeKind,
  size,
  updated,
  typeTestId,
}: {
  type: string;
  typeKind?: string;
  size: string;
  updated: string | null;
  typeTestId?: string;
}) {
  return (
    <span className="artifact-cols">
      <span
        className="artifact-col-type"
        data-kind={typeKind}
        data-testid={typeTestId}
      >
        {type}
      </span>
      <span className="artifact-col-size">{size}</span>
      <span className="artifact-col-when">
        {updated ? formatRelative(updated) : ""}
      </span>
    </span>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="artifact-icon" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="artifact-icon folder" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round">
      <path d="M3 6h6l2 2h10v11H3z" />
    </svg>
  );
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
          icon={<FileIcon />}
          right={
            <ArtifactColumns
              type={artifactTypeLabel(node.artifact)}
              typeKind={artifactCue(node.artifact)}
              typeTestId={`artifact-tree-type-${node.id}`}
              size={formatSize(artifactBytes(node.artifact))}
              updated={artifactUpdated(node.artifact)}
            />
          }
          showGuides
          testId={`artifact-tree-leaf-${node.id}`}
        >
          {node.label}
        </TreeNode>
      );
    }

    const expanded = expandedNodeIds.has(node.id);
    const contents = folderArtifacts(node);
    return (
      <Fragment key={node.id}>
        <TreeNode
          depth={depth}
          hasChildren={node.children.length > 0}
          expanded={expanded}
          onToggle={() => onToggle(node.id)}
          icon={<FolderIcon />}
          right={
            <ArtifactColumns
              type={`${contents.length} item${contents.length === 1 ? "" : "s"}`}
              size={formatSize(
                contents.reduce((sum, item) => sum + artifactBytes(item), 0)
              )}
              updated={latest(contents.map(artifactUpdated))}
            />
          }
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

/** Type filters present in the project, most common first. */
function artifactTypeCounts(artifacts: Artifact[]) {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    const label = artifactTypeLabel(artifact);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    ([leftLabel, left], [rightLabel, right]) =>
      right - left || leftLabel.localeCompare(rightLabel)
  );
}

export function ArtifactsPage() {
  const { artifacts: allArtifacts, isLoading, error } = useProjectArtifacts();
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const typeCounts = useMemo(
    () => artifactTypeCounts(allArtifacts),
    [allArtifacts]
  );
  const activeType =
    typeFilter && typeCounts.some(([label]) => label === typeFilter)
      ? typeFilter
      : null;
  const artifacts = useMemo(
    () =>
      activeType
        ? allArtifacts.filter(
            (artifact) => artifactTypeLabel(artifact) === activeType
          )
        : allArtifacts,
    [activeType, allArtifacts]
  );
  const expandedNodes = useExpandedNodes();
  const selectedArtifactId = useEntityPanelStore((state) => state.artifactId);
  const openArtifact = useEntityPanelStore((state) => state.openArtifact);
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
  // Retain explicit /artifacts?artifactId= destinations for existing links.
  const [searchParams] = useSearchParams();
  const linkedArtifactId = searchParams.get("artifactId");
  useEffect(() => {
    if (linkedArtifactId) openArtifact(linkedArtifactId);
  }, [linkedArtifactId, openArtifact]);

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
      openArtifact(visibleLeaves[next].id);
    },
    [openArtifact, selectedArtifactId, visibleLeaves]
  );

  useShellHeader("Artifacts");

  return (
    <div className="tasks-v2 flex min-h-0 flex-1">
      <main className="list-col" aria-label="Project artifacts">
        <h1 className="sr-only">Artifacts</h1>
        <div className="list-head">
          <div className="scope-row" data-testid="artifacts-type-filter">
            <div
              className="scope-primary"
              role="group"
              aria-label="Filter artifacts by type"
            >
              <ScopeChip
                active={activeType === null}
                count={isLoading || error ? undefined : allArtifacts.length}
                label="All"
                onClick={() => setTypeFilter(null)}
              />
              {typeCounts.map(([label, count]) => (
                <ScopeChip
                  key={label}
                  active={activeType === label}
                  count={count}
                  label={label}
                  onClick={() =>
                    setTypeFilter(activeType === label ? null : label)
                  }
                />
              ))}
            </div>
          </div>
          <div className="artifact-list-head" aria-hidden>
            <span>Name</span>
            <span className="artifact-cols">
              <span className="artifact-col-type">Type</span>
              <span className="artifact-col-size">Size</span>
              <span className="artifact-col-when">Updated</span>
            </span>
          </div>
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
            <p role="alert" className="p-4 text-content text-err">
              {error}
            </p>
          ) : artifacts.length === 0 ? (
            <EmptyState
              title="No project artifacts yet"
              description="Artifacts attached to this project appear here."
            />
          ) : (
            <ArtifactTreeRows
              nodes={tree}
              depth={0}
              expandedNodeIds={expandedNodes.expandedNodeIds}
              selectedArtifactId={selectedArtifactId}
              onToggle={expandedNodes.toggleNode}
              onSelect={(artifact) => openArtifact(artifact.id)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
