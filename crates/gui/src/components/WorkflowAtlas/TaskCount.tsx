/**
 * Task-count chips shared by workflow boxes (both faces) and step nodes on the
 * Workflow Atlas / Graph canvas.
 *
 * Two chips, both class/token-driven (palette in WorkflowAtlas.css):
 *   - an always-on neutral TOTAL badge — every work item (epic + ticket + task)
 *     parked at this workflow/step. Hidden only when nothing is parked.
 *   - a RUNNING pill that appears solely while some of those have an active
 *     TaskRun, with a pulsing dot.
 *
 * This replaces the old binary "live" ember: on a busy system everything would
 * read as active, so we surface the real magnitudes instead — how much work sits
 * here, and how much of it is moving.
 */
export interface TaskCountProps {
  /** Work items parked here (epic + ticket + task). */
  total: number;
  /** How many of those have an active TaskRun. */
  running: number;
  /** Extra class on the wrapper (e.g. a size variant). */
  className?: string;
}

export function TaskCount({ total, running, className }: TaskCountProps) {
  if (total <= 0 && running <= 0) return null;
  return (
    <span className={"uv-tc" + (className ? " " + className : "")}>
      {total > 0 ? (
        <span className="uv-tasks" title={`${total} task(s)`}>
          {total}
        </span>
      ) : null}
      {running > 0 ? (
        <span className="uv-running" title={`${running} active`}>
          <span className="pulse" />
          {running}
        </span>
      ) : null}
    </span>
  );
}
