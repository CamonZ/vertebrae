import { useCallback, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ModePlaceholder,
  ModeToggle,
  SubtreeRail,
  TracesHeader,
  UnifiedChatView,
  type TraceMode,
} from "../components/Traces";
import { useTask } from "../hooks";
import { useSubtreeExecutions } from "../hooks/useSubtreeExecutions";
import { useTaskStore } from "../stores/taskStore";

export function TracesPage(): ReactNode {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const tasks = useTaskStore((state) => state.tasks);

  const [mode, setMode] = useState<TraceMode>("thread");
  const [railCollapsed, setRailCollapsed] = useState(false);

  const safeTaskId = taskId ?? null;
  const { task, isLoading: isTaskLoading, error: taskError } = useTask(safeTaskId);
  const {
    rollups,
    executions,
    subtreeTaskIds,
    isLoading: isSubtreeLoading,
    error: subtreeError,
  } = useSubtreeExecutions(safeTaskId);

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleToggleRail = useCallback(() => {
    setRailCollapsed((v) => !v);
  }, []);

  if (!taskId) {
    return (
      <div
        data-testid="traces-empty-state"
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
      >
        <h1 className="text-base font-semibold text-text-primary">
          No task selected
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          Open a task from the task list and use Explore traces to view its
          subtree here.
        </p>
        <button
          type="button"
          onClick={() => navigate("/tasks")}
          className="mt-2 rounded border border-border bg-bg-tertiary px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover"
        >
          Go to tasks
        </button>
      </div>
    );
  }

  const headerError = taskError ?? subtreeError;
  const headerLoading = isTaskLoading || isSubtreeLoading;
  const taskTitle = task?.title ?? null;
  const taskLevel = task?.level ?? null;

  return (
    <div
      data-testid="traces-page"
      className="flex h-full min-h-0 flex-col"
    >
      <TracesHeader
        taskId={taskId}
        title={taskTitle}
        level={taskLevel}
        rollups={rollups}
        isLoading={headerLoading}
        error={headerError}
        onBack={handleBack}
      />

      <div className="flex min-h-0 flex-1 flex-row">
        <SubtreeRail
          rootTaskId={taskId}
          tasks={tasks}
          subtreeTaskIds={subtreeTaskIds}
          executions={executions}
          collapsed={railCollapsed}
          onToggleCollapsed={handleToggleRail}
        />

        <main
          data-testid="traces-center-pane"
          className="flex min-w-0 flex-1 flex-col gap-3 p-4"
        >
          <ModeToggle mode={mode} onChange={setMode} />
          <div className="flex-1 min-h-0">
            {mode === "thread" ? (
              <UnifiedChatView
                rootTaskId={taskId}
                executions={executions}
                tasks={tasks}
                isLoading={isSubtreeLoading}
                error={subtreeError}
              />
            ) : (
              <ModePlaceholder mode={mode} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
