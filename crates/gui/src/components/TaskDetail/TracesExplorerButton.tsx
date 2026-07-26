import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";

interface TracesExplorerButtonProps {
  taskId: string;
}

/**
 * Compact traces entry point shown at the bottom of the task detail body,
 * mirroring docs/design `tasks-detail.jsx` (`.t-traces`): a dashed full-width
 * button reading "Explore <N> subtree runs · <M> attempts →" that turns
 * solid-accent on hover. Counts are the live subtree rollups for the task.
 */
export function TracesExplorerButton({ taskId }: TracesExplorerButtonProps) {
  const navigate = useNavigate();
  const { rollups } = useSubtreeExecutions(taskId);

  const handleExplore = useCallback(() => {
    navigate(`/traces/${taskId}`);
  }, [navigate, taskId]);

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
