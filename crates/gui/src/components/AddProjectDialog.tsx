import { useCallback, useRef, useState } from "react";
import {
  commands,
  events,
  InitializeProjectResult,
  ProjectInitProgressEvent,
} from "../bindings";
import { Modal } from "./molecules/Modal";
import { Button } from "./atoms/Button";
import {
  useSkillFileStates,
  type SkillFileState,
} from "../hooks/useSkillFileStates";

export type AddProjectPhase =
  | { status: "linking"; path: string }
  | { status: "done"; path: string; result: InitializeProjectResult }
  /** `path: null` means the directory picker itself failed — no retry target. */
  | { status: "error"; path: string | null; message: string };

function folderNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Drives sidebar project addition through the canonical initialization
 * command while mirroring per-file skill-link progress events into dialog
 * state. The flow cannot be closed while initialization is in flight.
 */
export function useAddProjectFlow(onSuccess: () => void) {
  const [phase, setPhase] = useState<AddProjectPhase | null>(null);
  const [skillFilePaths, setSkillFilePaths] = useState<string[]>([]);
  const inFlight = useRef(false);
  const {
    fileStates,
    queueFiles,
    markFileLinking,
    markAllLinked,
    resetFileStates,
  } = useSkillFileStates();

  const start = useCallback(
    async (path: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPhase({ status: "linking", path });
      setSkillFilePaths([]);
      resetFileStates();

      let unlisten: (() => void) | null = null;
      try {
        const slugResult = await commands.previewProjectSlug(
          folderNameFromPath(path)
        );
        if (slugResult.status === "error") {
          setPhase({
            status: "error",
            path,
            message: slugResult.error.message,
          });
          return;
        }
        const expectedSlug = slugResult.data;

        const skillsResult = await commands.listEmbeddedSkills();
        const files =
          skillsResult.status === "ok"
            ? skillsResult.data.map((skill) => `${skill}/SKILL.md`)
            : [];
        setSkillFilePaths(files);
        queueFiles(files);

        unlisten = await events.projectInitProgressEvent.listen((event) => {
          const payload = event.payload as ProjectInitProgressEvent;
          if (payload.project_slug !== expectedSlug) return;
          if (payload.kind === "SkillFileInstalled" && payload.relative_path) {
            markFileLinking(payload.relative_path);
          }
          if (payload.kind === "Completed" && payload.files_copied > 0) {
            markAllLinked(files);
          }
        });

        const result = await commands.initializeProject(path, null);
        if (result.status === "error") {
          setPhase({ status: "error", path, message: result.error.message });
          return;
        }
        markAllLinked(files);
        onSuccess();
        setPhase({ status: "done", path, result: result.data });
      } catch (error) {
        setPhase({
          status: "error",
          path,
          message:
            error instanceof Error ? error.message : "Failed to add project",
        });
      } finally {
        unlisten?.();
        inFlight.current = false;
      }
    },
    [markAllLinked, markFileLinking, onSuccess, queueFiles, resetFileStates]
  );

  const fail = useCallback((message: string) => {
    if (inFlight.current) return;
    setPhase({ status: "error", path: null, message });
  }, []);

  const retry = useCallback(() => {
    if (phase?.status === "error" && phase.path) void start(phase.path);
  }, [phase, start]);

  const close = useCallback(() => {
    if (inFlight.current) return;
    setPhase(null);
    setSkillFilePaths([]);
    resetFileStates();
  }, [resetFileStates]);

  return { phase, skillFilePaths, fileStates, start, fail, retry, close };
}

const fileStateClasses: Record<SkillFileState, string> = {
  idle: "text-[var(--color-fg-mute)]",
  queued: "text-[var(--color-fg-mute)]",
  linking: "text-[var(--color-accent)]",
  linked: "text-[var(--color-ok)]",
};

/**
 * Modal shown while a sidebar-added project receives its skill compatibility
 * links — the same per-file progress first-run setup renders, in dialog form.
 */
export function AddProjectDialog({
  phase,
  skillFilePaths,
  fileStates,
  onRetry,
  onClose,
}: {
  phase: AddProjectPhase | null;
  skillFilePaths: string[];
  fileStates: Record<string, SkillFileState>;
  onRetry: () => void;
  onClose: () => void;
}) {
  if (!phase) return null;

  const isLinking = phase.status === "linking";
  const linkedCount = skillFilePaths.filter(
    (path) => fileStates[path] === "linked"
  ).length;
  const title =
    phase.status === "done"
      ? "Project added"
      : phase.status === "error"
        ? "Failed to add project"
        : `Adding ${folderNameFromPath(phase.path)}…`;

  return (
    <Modal open onClose={onClose} hideClose={isLinking} title={title}>
      <div data-testid="add-project-dialog" className="space-y-3">
        {phase.status === "error" ? (
          <>
            <p role="alert" className="text-sm text-[var(--color-err)]">
              {phase.message}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {phase.path && (
                <Button
                  variant="primary"
                  onClick={onRetry}
                  data-testid="add-project-retry"
                >
                  Retry
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--color-fg-soft)]">
              {phase.status === "done"
                ? `${phase.result.skills_copied} skill links created — linked into ${phase.result.skills_target}`
                : "Linking Vertebrae skills into existing project skill directories…"}
            </p>
            {skillFilePaths.length > 0 && (
              <div
                data-testid="add-project-file-tree"
                className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-line)]"
              >
                {skillFilePaths.map((path) => {
                  const state = fileStates[path] ?? "queued";
                  return (
                    <div
                      key={path}
                      className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-3 py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 truncate font-mono text-xs text-[var(--color-fg)]">
                        {path}
                      </span>
                      <span
                        data-testid={`add-project-file-state-${path}`}
                        className={`font-mono text-xs ${fileStateClasses[state]}`}
                      >
                        {state}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-[var(--color-fg-mute)]">
                {isLinking &&
                  `${linkedCount} / ${skillFilePaths.length} skill files linked`}
              </span>
              {phase.status === "done" && (
                <Button
                  variant="primary"
                  onClick={onClose}
                  data-testid="add-project-done"
                >
                  Done
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
