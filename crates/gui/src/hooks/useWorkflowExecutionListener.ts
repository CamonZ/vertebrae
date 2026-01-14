import { useEffect } from 'react';
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
  useEffect(() => {
    if (!workflowId) return;

    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await events.workflowExecutionEvent.listen((event) => {
        // Only process events for this workflow
        if (event.payload.workflow_id !== workflowId) return;

        const { event_type } = event.payload;

        // Handle each event type (discriminated union)
        if (event_type === 'Started' && handlers.onStarted) {
          handlers.onStarted(event.payload.task_id);
        } else if (typeof event_type === 'object' && event_type !== null) {
          if ('StepStarted' in event_type && handlers.onStepStarted) {
            const data = event_type.StepStarted;
            handlers.onStepStarted(event.payload.task_id, data.step_name);
          } else if ('StepProgress' in event_type && handlers.onStepProgress) {
            const data = event_type.StepProgress;
            handlers.onStepProgress(data.execution_id, data.output_lines);
          } else if ('StepCompleted' in event_type && handlers.onStepCompleted) {
            handlers.onStepCompleted(event_type.StepCompleted.execution_id);
          } else if ('StepFailed' in event_type && handlers.onStepFailed) {
            const data = event_type.StepFailed;
            handlers.onStepFailed(data.execution_id, data.error);
          } else if ('Completed' in event_type && handlers.onCompleted) {
            handlers.onCompleted(event.payload.task_id);
          } else if ('Failed' in event_type && handlers.onFailed) {
            handlers.onFailed(event.payload.task_id, event_type.Failed.error);
          }
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [workflowId, handlers]);
}
