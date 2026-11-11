import { useCallback, useState } from "react";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { openRunInChat, resolveTaskRunTarget } from "../../utils/openRunInChat";

interface RunsInChatButtonProps {
  taskId: string;
}

/**
 * Run entry point at the bottom of the task detail body (`.t-traces`): a
 * dashed full-width button with the live subtree run/execution counts that
 * opens the task's run read-only in the maximized chat panel.
 */
export function RunsInChatButton({ taskId }: RunsInChatButtonProps) {
  const closeEntityPanel = useEntityPanelStore((state) => state.close);
  const { rollups, executions } = useSubtreeExecutions(taskId);
  const [error, setError] = useState<string | null>(null);

  const runs = rollups.totalRuns;
  const attempts = rollups.totalAttempts;

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      const target = await resolveTaskRunTarget(taskId, executions);
      if (!target) {
        setError("No runs to open yet.");
        return;
      }
      // The maximized chat covers the viewport; drop the shell-level detail
      // overlay so it does not sit above the run.
      closeEntityPanel();
      openRunInChat(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [closeEntityPanel, executions, taskId]);

  return (
    <div className="t-traces-slot">
      <button
        type="button"
        className="t-traces"
        onClick={() => void handleOpen()}
        data-testid="task-detail-runs-in-chat"
        disabled={runs === 0}
      >
        <span>
          Open in chat · <em>{runs}</em> subtree {runs === 1 ? "run" : "runs"} ·{" "}
          {attempts} {attempts === 1 ? "execution" : "executions"}
        </span>
        <span className="arr" aria-hidden>
          →
        </span>
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-err)]">
          {error}
        </p>
      )}
    </div>
  );
}
