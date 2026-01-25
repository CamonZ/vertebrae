import { useEffect, useCallback, useRef } from 'react';
import { events, type WorkflowExecutionEvent } from '../bindings';

export interface WorkflowExecutionEventHandler {
  onStarted?: (taskId: string) => void;
  onOrchestratorStarted?: (taskId: string, stepName: string) => void;
  onOrchestratorCompleted?: (executionId: string) => void;
  onOrchestratorFailed?: (executionId: string, error: string) => void;
  onStepStarted?: (taskId: string, stepName: string) => void;
  onStepProgress?: (executionId: string, outputLines: string[]) => void;
  onStepCompleted?: (executionId: string) => void;
  onStepFailed?: (executionId: string, error: string) => void;
  onCompleted?: (taskId: string) => void;
  onFailed?: (taskId: string, error: string) => void;
}

/**
 * Listen to workflow execution events for a specific workflow
 *
 * Filters events by workflow_id and calls appropriate handlers for each event type.
 */
export function useWorkflowExecutionListener(
  workflowId: string,
  handlers: WorkflowExecutionEventHandler
) {
  // Use refs to avoid effect re-runs when handlers change
  const onStartedRef = useRef(handlers.onStarted);
  const onOrchestratorStartedRef = useRef(handlers.onOrchestratorStarted);
  const onOrchestratorCompletedRef = useRef(handlers.onOrchestratorCompleted);
  const onOrchestratorFailedRef = useRef(handlers.onOrchestratorFailed);
  const onStepStartedRef = useRef(handlers.onStepStarted);
  const onStepProgressRef = useRef(handlers.onStepProgress);
  const onStepCompletedRef = useRef(handlers.onStepCompleted);
  const onStepFailedRef = useRef(handlers.onStepFailed);
  const onCompletedRef = useRef(handlers.onCompleted);
  const onFailedRef = useRef(handlers.onFailed);

  // Update refs when handlers change
  onStartedRef.current = handlers.onStarted;
  onOrchestratorStartedRef.current = handlers.onOrchestratorStarted;
  onOrchestratorCompletedRef.current = handlers.onOrchestratorCompleted;
  onOrchestratorFailedRef.current = handlers.onOrchestratorFailed;
  onStepStartedRef.current = handlers.onStepStarted;
  onStepProgressRef.current = handlers.onStepProgress;
  onStepCompletedRef.current = handlers.onStepCompleted;
  onStepFailedRef.current = handlers.onStepFailed;
  onCompletedRef.current = handlers.onCompleted;
  onFailedRef.current = handlers.onFailed;

  const handleExecutionEvent = useCallback(
    (event: { payload: WorkflowExecutionEvent }) => {
      // Only process events for this workflow
      if (event.payload.workflow_id !== workflowId) return;

      const { event_type, task_id } = event.payload;

      // Handle string literal event types
      if (event_type === 'Started') {
        onStartedRef.current?.(task_id);
        return;
      }
      if (event_type === 'Completed') {
        onCompletedRef.current?.(task_id);
        return;
      }

      // Handle object event types (discriminated union)
      if (typeof event_type === 'object' && event_type !== null) {
        if ('OrchestratorStarted' in event_type) {
          const data = event_type.OrchestratorStarted;
          onOrchestratorStartedRef.current?.(task_id, data.step_name);
        } else if ('OrchestratorCompleted' in event_type) {
          onOrchestratorCompletedRef.current?.(event_type.OrchestratorCompleted.execution_id);
        } else if ('OrchestratorFailed' in event_type) {
          const data = event_type.OrchestratorFailed;
          onOrchestratorFailedRef.current?.(data.execution_id, data.error);
        } else if ('StepStarted' in event_type) {
          const data = event_type.StepStarted;
          onStepStartedRef.current?.(task_id, data.step_name);
        } else if ('StepProgress' in event_type) {
          const data = event_type.StepProgress;
          onStepProgressRef.current?.(data.execution_id, data.output_lines);
        } else if ('StepCompleted' in event_type) {
          onStepCompletedRef.current?.(event_type.StepCompleted.execution_id);
        } else if ('StepFailed' in event_type) {
          const data = event_type.StepFailed;
          onStepFailedRef.current?.(data.execution_id, data.error);
        } else if ('Failed' in event_type) {
          onFailedRef.current?.(task_id, event_type.Failed.error);
        }
      }
    },
    [workflowId]
  );

  useEffect(() => {
    if (!workflowId) return;

    // Subscribe to workflow execution events
    const unlistenPromise = events.workflowExecutionEvent.listen(handleExecutionEvent);

    // Cleanup on unmount or when workflowId changes
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch((error) => {
        console.error('Failed to unlisten from workflow execution event:', error);
      });
    };
  }, [workflowId, handleExecutionEvent]);
}
