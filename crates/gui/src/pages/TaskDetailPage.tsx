import { useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { TaskDetailPanel } from "../components/TaskDetail";
import { WindowLayout } from "../components/WindowLayout";
import { useTasks } from "../hooks";
import { useTaskStore } from "../stores";
import { takeStashedTask } from "../utils";

/**
 * Standalone page rendered by the `/task/:taskId` pop-out window. Clicking
 * a dependency task updates local state in place so the window keeps its
 * label/identity instead of triggering a route change.
 *
 * Seeds the per-window task store synchronously from the `localStorage`
 * stash written by the parent so the first paint has full data without a
 * backend round-trip. `useTasks()` then refreshes in the background and
 * also acts as the fall-back when the stash is missing (e.g. the window
 * was reopened from the OS).
 */
export function TaskDetailPage() {
  const { taskId: routeTaskId } = useParams<{ taskId: string }>();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    routeTaskId ?? null,
  );

  const seededRef = useRef(false);
  if (!seededRef.current && routeTaskId) {
    seededRef.current = true;
    const stashed = takeStashedTask(routeTaskId);
    if (stashed) {
      useTaskStore.getState().setTasks([stashed.task, ...stashed.related]);
    }
  }

  useTasks();

  return (
    <WindowLayout>
      <TaskDetailPanel
        taskId={activeTaskId}
        onTaskSelect={setActiveTaskId}
        standalone
      />
    </WindowLayout>
  );
}
