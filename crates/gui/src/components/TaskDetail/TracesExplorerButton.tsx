import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";
import { popOut } from "../../utils";

interface TracesExplorerButtonProps {
  taskId: string;
  /**
   * When the panel is itself a pop-out window, navigating to the in-app
   * `/traces/:taskId` route would swap the whole app shell into this small
   * window. Pop a dedicated traces window instead.
   */
  standalone?: boolean;
}

/**
 * Compact traces entry point shown at the bottom of the task detail body,
 * mirroring docs/design `tasks-detail.jsx` (`.t-traces`): a dashed full-width
 * button reading "Explore <N> subtree runs · <M> attempts →" that turns
 * solid-accent on hover. Counts are the live subtree rollups for the task.
 */
export function TracesExplorerButton({
  taskId,
  standalone = false,
}: TracesExplorerButtonProps) {
  const navigate = useNavigate();
  const { rollups } = useSubtreeExecutions(taskId);

  const handleExplore = useCallback(async () => {
    if (standalone) {
      await popOut(`/traces-window/${taskId}`, `traces-${taskId}`, {
        title: "Traces",
        width: 1100,
        height: 800,
      });
      return;
    }
    navigate(`/traces/${taskId}`);
  }, [navigate, standalone, taskId]);

  const runs = rollups.totalRuns;
  const attempts = rollups.totalAttempts;

  return (
    <div className="t-traces-slot">
      <button
        type="button"
        className="t-traces"
        onClick={handleExplore}
        data-testid="task-detail-traces"
      >
        <span>
          Explore <em>{runs}</em> subtree {runs === 1 ? "run" : "runs"} ·{" "}
          {attempts} {attempts === 1 ? "execution" : "executions"}
        </span>
        <span className="arr" aria-hidden>
          →
        </span>
      </button>
    </div>
  );
}
