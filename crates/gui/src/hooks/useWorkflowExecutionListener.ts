import { useEffect, useCallback, useRef } from 'react';
import { events } from '../bindings';

export interface WorkflowExecutionEventHandler {
  onStarted?: (taskId: string) => void;
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
  const onStepStartedRef = useRef(handlers.onStepStarted);
  const onStepProgressRef = useRef(handlers.onStepProgress);
  const onStepCompletedRef = useRef(handlers.onStepCompleted);
  const onStepFailedRef = useRef(handlers.onStepFailed);
  const onCompletedRef = useRef(handlers.onCompleted);
  const onFailedRef = useRef(handlers.onFailed);

  // Update refs when handlers change
  onStartedRef.current = handlers.onStarted;
  onStepStartedRef.current = handlers.onStepStarted;
  onStepProgressRef.current = handlers.onStepProgress;
  onStepCompletedRef.current = handlers.onStepCompleted;
  onStepFailedRef.current = handlers.onStepFailed;
  onCompletedRef.current = handlers.onCompleted;
  onFailedRef.current = handlers.onFailed;

  const handleExecutionEvent = useCallback(
    (event: { payload: any }) => {
      // Only process events for this workflow
      if (event.payload.workflow_id !== workflowId) return;

      const { event_type } = event.payload;

      // Handle each event type (discriminated union)
      if (event_type === 'Started' && onStartedRef.current) {
        onStartedRef.current(event.payload.task_id);
      } else if (typeof event_type === 'object' && event_type !== null) {
        if ('StepStarted' in event_type && onStepStartedRef.current) {
          const data = event_type.StepStarted;
          onStepStartedRef.current(event.payload.task_id, data.step_name);
        } else if ('StepProgress' in event_type && onStepProgressRef.current) {
          const data = event_type.StepProgress;
          onStepProgressRef.current(data.execution_id, data.output_lines);
        } else if ('StepCompleted' in event_type && onStepCompletedRef.current) {
          onStepCompletedRef.current(event_type.StepCompleted.execution_id);
        } else if ('StepFailed' in event_type && onStepFailedRef.current) {
          const data = event_type.StepFailed;
          onStepFailedRef.current(data.execution_id, data.error);
        } else if ('Completed' in event_type && onCompletedRef.current) {
          onCompletedRef.current(event.payload.task_id);
        } else if ('Failed' in event_type && onFailedRef.current) {
          onFailedRef.current(event.payload.task_id, event_type.Failed.error);
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
