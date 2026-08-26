import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSubtreeExecutions } from "../../hooks/useSubtreeExecutions";
import { useEntityPanelStore } from "../../stores/entityPanelStore";

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
  const closeEntityPanel = useEntityPanelStore((state) => state.close);
  const { rollups } = useSubtreeExecutions(taskId);

  const handleExplore = useCallback(() => {
    // The task detail host is mounted at the shell level, so route navigation
    // alone would leave it over the traces page. Close it before navigating so
    // the new page owns the viewport without a stale global overlay.
    closeEntityPanel();
    navigate(`/traces/${taskId}`);
  }, [closeEntityPanel, navigate, taskId]);

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
