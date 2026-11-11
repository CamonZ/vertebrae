import { useContext, useMemo, useRef, useState } from "react";
import { commands, type Artifact } from "../../bindings";
import { errorMessage, unwrapCommand } from "../../query";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../../stores/projectScopedStores";
import { useChatStore } from "../../stores/chatStore";
import { readRecord } from "../../hooks/useChatAssociation";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { StatechartPreview } from "../Artifacts/StatechartPreview";
import { parseStatechart } from "../Artifacts/statechart";
import { VtbEntityMarkdownLink } from "./VtbEntityLink";
import { parseVtbEntityHref } from "./vtbEntityLinkTarget";

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; artifact: Artifact }
  | { status: "error"; message: string };

export function StatechartDiagramBlock({ source }: { source: string }) {
  const generation = useProjectScopeGeneration();
  const sessionId = useContext(ChatSessionContext);
  const association = useChatStore((state) =>
    sessionId ? state.sessions[sessionId]?.association : null
  );
  const record = readRecord(association);
  const ticketId =
    (record.entityLevel ?? "ticket") === "ticket" ? record.ticketId : null;
  return (
    <ScopedStatechartBlock
      key={`${generation}:${ticketId}`}
      source={source}
      generation={generation}
      ticketId={ticketId}
    />
  );
}

function ScopedStatechartBlock({
  source,
  generation,
  ticketId,
}: {
  source: string;
  generation: number;
  ticketId: string | null;
}) {
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const saving = useRef(false);
  const valid = useMemo(() => {
    try {
      parseStatechart(source);
      return true;
    } catch {
      return false;
    }
  }, [source]);

  async function saveArtifact() {
    if (!ticketId || saving.current) return;
    saving.current = true;
    setSave({ status: "saving" });
    try {
      const artifact = await unwrapCommand(
        commands.saveStatechartArtifact(source, ticketId)
      );
      if (!isCurrentProjectScopeGeneration(generation)) return;
      // Seed links with the returned attachment before realtime delivery.
      queryClient.setQueryData<Artifact[]>(
        queryKeys.artifacts.presentations(generation),
        (items = []) => [
          ...items.filter((item) => item.id !== artifact.id),
          artifact,
        ]
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.artifacts.task(generation, ticketId),
      });
      setSave({ status: "saved", artifact });
    } catch (error) {
      if (isCurrentProjectScopeGeneration(generation))
        setSave({ status: "error", message: errorMessage(error) });
    } finally {
      saving.current = false;
    }
  }

  const target =
    save.status === "saved"
      ? parseVtbEntityHref(`vtb://artifact/${save.artifact.id}`)
      : null;
  return (
    <div
      className="mb-2 max-w-full overflow-hidden rounded-md border border-border/50 bg-bg p-3 whitespace-normal"
      data-testid="component-diagram"
    >
      {!target && <StatechartPreview body={source} />}
      {valid &&
        ticketId &&
        (target ? (
          <VtbEntityMarkdownLink target={target}>
            Saved artifact
          </VtbEntityMarkdownLink>
        ) : (
          <button
            type="button"
            className="mt-2 rounded border border-border px-2 py-1 text-sm text-accent disabled:opacity-50"
            disabled={save.status === "saving"}
            onClick={() => void saveArtifact()}
          >
            {save.status === "saving" ? "Saving…" : "Save as artifact"}
          </button>
        ))}
      {save.status === "error" && (
        <div role="alert">Unable to save artifact: {save.message}</div>
      )}
    </div>
  );
}
