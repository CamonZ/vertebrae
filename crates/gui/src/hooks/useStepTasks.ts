import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events, type Task, type TaskChangeType } from "../bindings";

// Per-step task list maintained outside the global taskStore: the pipeline
// view never bulk-fetches all project tasks, so reading from a partially
// populated store would render a wrong subset. The global store is still
// kept fresh by useTaskChangeListener for other views.
export function useStepTasks(stepId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepIdRef = useRef<string | null>(stepId);
  useEffect(() => {
    stepIdRef.current = stepId;
  }, [stepId]);

  const fetchTasks = useCallback(async () => {
    if (!stepId) {
      setTasks([]);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.listTasks({
        step_names: null,
        levels: null,
        tags: null,
        root_only: null,
        children_of: null,
        include_done: true,
        search: null,
        workflow_id: null,
        step_id: stepId,
      });

      if (stepIdRef.current !== stepId) return;

      if (result.status === "ok") {
        setTasks(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      if (stepIdRef.current !== stepId) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (stepIdRef.current === stepId) {
        setIsLoading(false);
      }
    }
  }, [stepId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    const unlistenPromise = events.taskChangedEvent.listen((event) => {
      const { task_id, change_type, task } = event.payload;
      const currentStepId = stepIdRef.current;
      if (!currentStepId) return;

      const ct: TaskChangeType = change_type;

      if (ct === "Deleted") {
        setTasks((prev) => {
          const next = prev.filter((t) => t.id !== task_id);
          return next.length === prev.length ? prev : next;
        });
        return;
      }

      if (!task) return;

      const belongsHere = task.current_step_id === currentStepId;

      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task_id);
        if (belongsHere) {
          if (idx === -1) return [...prev, task];
          if (prev[idx] === task) return prev;
          const next = prev.slice();
          next[idx] = task;
          return next;
        }
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return { tasks, isLoading, error, refetch: fetchTasks };
}
