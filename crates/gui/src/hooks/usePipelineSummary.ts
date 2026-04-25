import { useCallback, useEffect, useRef, useState } from "react";
import {
  commands,
  events,
  type PipelineSummary,
  type PipelineWorkflow,
  type PipelineStep,
  type PipelineTaskCounts,
  type StepExecutionStatus,
  type TaskChangeType,
  type StepExecutionChangeType,
} from "../bindings";
import { useWebSocketStatus } from "./useWebSocketStatus";

type TrackedTask = {
  workflow_id: string | null;
  current_step_id: string | null;
  level: keyof PipelineTaskCounts;
};

type TrackedExecution = {
  step_id: string;
  was_running: boolean;
};

const ZERO_COUNTS: PipelineTaskCounts = { epic: 0, ticket: 0, task: 0 };

// If the tab was hidden for less than this, the live WS stream is reliable
// enough that a refetch on visibility-change is wasted work.
const STALE_AFTER_HIDDEN_MS = 30_000;

function levelKey(level: string | null | undefined): keyof PipelineTaskCounts {
  if (level === "epic") return "epic";
  if (level === "ticket") return "ticket";
  return "task";
}

function applyTaskCountDelta(
  workflows: PipelineWorkflow[],
  stepId: string,
  level: keyof PipelineTaskCounts,
  delta: number,
): PipelineWorkflow[] {
  if (delta === 0) return workflows;
  let changed = false;
  const next = workflows.map((wf) => {
    let stepChanged = false;
    const newSteps = wf.workflow_steps.map((s) => {
      if (s.id !== stepId) return s;
      stepChanged = true;
      return {
        ...s,
        task_counts: {
          ...s.task_counts,
          [level]: Math.max(0, s.task_counts[level] + delta),
        },
      };
    });
    if (!stepChanged) return wf;
    changed = true;
    return { ...wf, workflow_steps: newSteps };
  });
  return changed ? next : workflows;
}

function applyRunningDelta(
  workflows: PipelineWorkflow[],
  stepId: string,
  delta: number,
): PipelineWorkflow[] {
  if (delta === 0) return workflows;
  let changed = false;
  const next = workflows.map((wf) => {
    let stepChanged = false;
    const newSteps = wf.workflow_steps.map((s) => {
      if (s.id !== stepId) return s;
      stepChanged = true;
      return { ...s, running_count: Math.max(0, s.running_count + delta) };
    });
    if (!stepChanged) return wf;
    changed = true;
    return { ...wf, workflow_steps: newSteps };
  });
  return changed ? next : workflows;
}

function isRunning(status: StepExecutionStatus): boolean {
  return status === "Running";
}

function isTerminal(status: StepExecutionStatus): boolean {
  return status === "Completed" || status === "Failed";
}

export function usePipelineSummary() {
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const taskIndexRef = useRef<Map<string, TrackedTask>>(new Map());
  const execStatusRef = useRef<Map<string, TrackedExecution>>(new Map());
  const hasSummaryRef = useRef(false);

  const wsStatus = useWebSocketStatus();
  const prevWsStatus = useRef(wsStatus);

  const fetchSummary = useCallback(async () => {
    try {
      const result = await commands.getPipelineSummary();
      if (result.status === "ok") {
        setSummary(result.data);
        hasSummaryRef.current = true;
        setError(null);
        taskIndexRef.current.clear();
        execStatusRef.current.clear();
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    const wasDown =
      prevWsStatus.current === "reconnecting" ||
      prevWsStatus.current === "disconnected" ||
      prevWsStatus.current === "connecting";
    if (wsStatus === "connected" && wasDown && hasSummaryRef.current) {
      fetchSummary();
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, fetchSummary]);

  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const elapsed = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (elapsed >= STALE_AFTER_HIDDEN_MS) {
        fetchSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchSummary]);

  useEffect(() => {
    const unlistenPromise = events.taskChangedEvent.listen((event) => {
      const { task_id, change_type, task } = event.payload;
      const prev = taskIndexRef.current.get(task_id);
      const ct: TaskChangeType = change_type;

      if (ct === "Deleted") {
        if (prev && prev.workflow_id && prev.current_step_id) {
          setSummary((s) =>
            s
              ? {
                  workflows: applyTaskCountDelta(
                    s.workflows,
                    prev.current_step_id!,
                    prev.level,
                    -1,
                  ),
                }
              : s,
          );
        }
        taskIndexRef.current.delete(task_id);
        return;
      }

      if (!task) return;

      const next: TrackedTask = {
        workflow_id: task.workflow_id ?? null,
        current_step_id: task.current_step_id ?? null,
        level: levelKey(task.level),
      };

      // First-seen Updated event: the initial summary already counts this
      // task. Recording the snapshot without applying a delta avoids
      // double-counting on subsequent moves.
      if (ct === "Updated" && !prev) {
        taskIndexRef.current.set(task_id, next);
        return;
      }

      const prevHasBucket =
        !!prev && !!prev.current_step_id && !!prev.workflow_id;
      const nextHasBucket = !!next.current_step_id && !!next.workflow_id;

      const sameBucket =
        prevHasBucket &&
        nextHasBucket &&
        prev!.current_step_id === next.current_step_id &&
        prev!.level === next.level;

      if (sameBucket) {
        taskIndexRef.current.set(task_id, next);
        return;
      }

      setSummary((s) => {
        if (!s) return s;
        let workflows = s.workflows;
        if (prevHasBucket) {
          workflows = applyTaskCountDelta(
            workflows,
            prev!.current_step_id!,
            prev!.level,
            -1,
          );
        }
        if (nextHasBucket) {
          workflows = applyTaskCountDelta(
            workflows,
            next.current_step_id!,
            next.level,
            +1,
          );
        }
        return workflows === s.workflows ? s : { workflows };
      });

      taskIndexRef.current.set(task_id, next);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = events.stepExecutionChangedEvent.listen((event) => {
      const { execution_id, task_id, status, change_type } = event.payload;
      const ct: StepExecutionChangeType = change_type;

      // Resolve the step from the cached taskIndex — never trust step_name.
      const tracked = taskIndexRef.current.get(task_id);
      const stepId = tracked?.current_step_id ?? null;

      const prevExec = execStatusRef.current.get(execution_id);
      const wasRunning = prevExec?.was_running ?? false;
      const nowRunning = isRunning(status);

      // Decrements should target the step the increment was originally
      // attributed to, in case the task's current_step_id has since advanced.
      const targetStepIdForDecrement = prevExec?.step_id ?? stepId;
      const targetStepIdForIncrement = stepId;

      const delta = (nowRunning ? 1 : 0) - (wasRunning ? 1 : 0);
      const targetStepId =
        delta > 0 ? targetStepIdForIncrement : targetStepIdForDecrement;

      if ((ct === "Created" || ct === "StatusChanged") && delta !== 0 && targetStepId) {
        setSummary((s) =>
          s
            ? { workflows: applyRunningDelta(s.workflows, targetStepId, delta) }
            : s,
        );
      }

      if (isTerminal(status)) {
        execStatusRef.current.delete(execution_id);
      } else if (targetStepIdForIncrement) {
        execStatusRef.current.set(execution_id, {
          step_id: targetStepIdForIncrement,
          was_running: nowRunning,
        });
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return {
    summary,
    isLoading,
    error,
    refetch: fetchSummary,
    zeroCounts: ZERO_COUNTS,
  };
}

export type { PipelineSummary, PipelineWorkflow, PipelineStep, PipelineTaskCounts };
