import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "../bindings";
import { ArtifactInspectorPanel } from "../components/Artifacts/ArtifactInspectorPanel";
import { Spinner } from "../components/Spinner";
import { usePanelExitTransition } from "../hooks/usePanelExitTransition";
import { useProjectArtifacts } from "../hooks/useProjectArtifacts";
import { useShellHeader } from "../hooks/useShellHeader";

function displayName(artifact: Artifact) {
  return artifact.logical_name ?? artifact.filename;
}

function artifactCue(artifact: Artifact) {
  const metadata = artifact.metadata;
  if (!metadata) return "raw";
  return metadata.content_kind === "conversation"
    ? "conversation"
    : metadata.format;
}

export function ArtifactsPage() {
  const { artifacts, isLoading, error } = useProjectArtifacts();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null
  );
  const lastSelectedArtifactRef = useRef<Artifact | null>(null);
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
      if (artifacts.length === 0) return;
      const currentIndex = artifacts.findIndex(
        (artifact) => artifact.id === selectedArtifactId
      );
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const start = currentIndex < 0 ? 0 : currentIndex;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.max(0, Math.min(artifacts.length - 1, start + delta));
      setSelectedArtifactId(artifacts[next].id);
    },
    [artifacts, selectedArtifactId]
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
          role="listbox"
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
            artifacts.map((artifact) => {
              const selected = artifact.id === selectedArtifactId;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectArtifact(artifact)}
                    className={`relative mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    selected
                      ? "bg-[var(--color-selection)] text-fg before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-[var(--color-accent)] before:content-['']"
                      : "hover:bg-bg-1 text-fg"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {displayName(artifact)}
                  </span>
                  <span className="shrink-0 font-mono text-2xs uppercase text-fg-mute">
                    {artifactCue(artifact)}
                  </span>
                </button>
              );
            })
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
