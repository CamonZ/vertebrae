import { useEffect } from "react";
import { commands, events } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import {
  deriveGateChatStatus,
  gateChatBinding,
  isSameGate,
} from "../utils/gateChat";
import { resolveHumanInputGate } from "../utils/humanInputGate";
import { refreshGateChat } from "./useGateChat";

/** Coalesces the bursts of run and execution updates one transition emits. */
const GATE_SYNC_DELAY_MS = 150;

function gateChatSessionIds(runId: string): string[] {
  return Object.values(useChatStore.getState().sessions)
    .filter((session) => session.gate?.task_run_id === runId)
    .map((session) => session.id);
}

function boundRunIds(): string[] {
  const runIds = new Set<string>();
  for (const session of Object.values(useChatStore.getState().sessions)) {
    if (session.gate) runIds.add(session.gate.task_run_id);
  }
  return [...runIds].sort();
}

/**
 * Bring every open chat bound to `runId` up to date with the run: record each
 * chat's gate phase, and rebind a chat whose gate is waiting at a newer
 * execution, which delivers the review's verdict to a live chat.
 */
export async function syncGateChatsForRun(runId: string): Promise<void> {
  if (gateChatSessionIds(runId).length === 0) return;
  let trace;
  try {
    const result = await commands.getTaskRunTrace(runId);
    if (result.status !== "ok") return;
    trace = result.data;
  } catch {
    return;
  }
  const run = trace.task_runs?.find((candidate) => candidate.id === runId);
  if (!run) return;
  const executions = trace.step_executions ?? [];
  const waitingContext = resolveHumanInputGate(run, executions);
  const waitingGate = waitingContext ? gateChatBinding(waitingContext) : null;

  const refreshes: Promise<void>[] = [];
  for (const sessionId of gateChatSessionIds(runId)) {
    const store = useChatStore.getState();
    const gate = store.sessions[sessionId]?.gate;
    if (!gate) continue;
    const status = deriveGateChatStatus(gate, run, executions);
    store.setGateChatStatus(sessionId, status);
    if (
      waitingGate &&
      status?.waitingExecutionId === waitingGate.execution_id &&
      waitingGate.execution_id !== gate.execution_id &&
      isSameGate(waitingGate, gate)
    ) {
      refreshes.push(refreshGateChat(sessionId, waitingGate));
    }
  }
  await Promise.all(refreshes);
}

/**
 * Keeps gate chats in step with their runs. Mounted once at the app root:
 * TaskRun and StepExecution updates for a bound run re-read its trace, and
 * newly bound or restored chats are synced as soon as they appear.
 */
export function useGateChatSync() {
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (runId: string | null | undefined) => {
      if (!runId || gateChatSessionIds(runId).length === 0) return;
      const pending = timers.get(runId);
      if (pending) clearTimeout(pending);
      timers.set(
        runId,
        setTimeout(() => {
          timers.delete(runId);
          void syncGateChatsForRun(runId);
        }, GATE_SYNC_DELAY_MS)
      );
    };

    let knownRuns = boundRunIds();
    knownRuns.forEach(schedule);
    const unsubscribeStore = useChatStore.subscribe(() => {
      const runs = boundRunIds();
      if (runs.join("\n") === knownRuns.join("\n")) return;
      const added = runs.filter((runId) => !knownRuns.includes(runId));
      knownRuns = runs;
      added.forEach(schedule);
    });
    const unlistenRuns = events.taskRunChangedEvent.listen((event) =>
      schedule(event.payload.task_run_id)
    );
    const unlistenExecutions = events.stepExecutionChangedEvent.listen(
      (event) => schedule(event.payload.task_run_id)
    );

    return () => {
      unsubscribeStore();
      void unlistenRuns.then((unlisten) => unlisten());
      void unlistenExecutions.then((unlisten) => unlisten());
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);
}
