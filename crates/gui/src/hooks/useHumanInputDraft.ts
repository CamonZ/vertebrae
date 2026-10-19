import { useQuery } from "@tanstack/react-query";
import { commands, type GateDraft, type JsonValue } from "../bindings";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/**
 * The draft of a waiting human_input execution as Sacrum reports it; null
 * when the gate is not draftable. `draftUpdatedAt` comes from realtime
 * execution updates: when it moves, the draft (and so its missing, invalid
 * and complete report) is read again rather than derived here.
 */
export function useHumanInputDraft(
  executionId: string | null | undefined,
  draftUpdatedAt?: string | null
) {
  const generation = useProjectScopeGeneration();
  // The app-wide client, so gate surfaces render outside a provider too.
  const query = useQuery(
    {
      queryKey: queryKeys.humanInputDrafts.detail(
        generation,
        executionId ?? "",
        draftUpdatedAt ?? null
      ),
      queryFn: () => unwrapCommand(commands.getHumanInputDraft(executionId!)),
      enabled: Boolean(executionId),
      // Keep showing the draft while its newer version loads, but never
      // another execution's draft after the gate is re-entered.
      placeholderData: (previous) =>
        previous?.execution_id === executionId ? previous : undefined,
    },
    queryClient
  );
  return {
    draft: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
  };
}

function refreshDraftQueries(executionId: string): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.humanInputDrafts.byExecution(
      getProjectScopeGeneration(),
      executionId
    ),
  });
}

/** Merge answers into the draft; a null value clears a field. */
export async function setGateDraft(
  executionId: string,
  values: Record<string, JsonValue>
): Promise<GateDraft> {
  const draft = await unwrapCommand(
    commands.setHumanInputDraft(executionId, values)
  );
  refreshDraftQueries(executionId);
  return draft;
}

/** Resolve the gate from its complete draft. */
export async function submitGateDraft(executionId: string): Promise<GateDraft> {
  const draft = await unwrapCommand(
    commands.submitHumanInputDraft(executionId)
  );
  refreshDraftQueries(executionId);
  return draft;
}

/** The draft right now, or null when the gate is not draftable or unreadable. */
export async function readGateDraft(
  executionId: string
): Promise<GateDraft | null> {
  try {
    const result = await commands.getHumanInputDraft(executionId);
    return result.status === "ok" ? result.data : null;
  } catch {
    return null;
  }
}
