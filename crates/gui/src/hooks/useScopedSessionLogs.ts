import { useShallow } from "zustand/react/shallow";
import {
  selectSessionLogBucketsForExecutionIds,
  useSessionLogStore,
  type ExecutionLogBucket,
} from "../stores/sessionLogStore";

/**
 * Read only the execution buckets needed by a consumer. Zustand's shallow
 * comparison keeps unrelated execution updates from notifying this consumer.
 */
export function useScopedSessionLogs(
  executionIds: readonly (string | null | undefined)[]
): Record<string, ExecutionLogBucket> {
  return useSessionLogStore(
    useShallow((state) =>
      selectSessionLogBucketsForExecutionIds(
        state.logsByExecutionId,
        executionIds
      )
    )
  );
}
