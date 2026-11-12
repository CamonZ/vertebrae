import { commands } from "../../bindings";
import { ChatDiagramBlock } from "./ChatDiagramBlock";
import { FlowSpecBody } from "./FlowSpecView";
import { useFlowSpec } from "./useFlowSpec";

const saveFlow = (body: string, ticketId: string) =>
  commands.saveFlowArtifact(body, ticketId);

/**
 * A ```flow block: play the spec or list its errors, and offer Save as
 * artifact in a chat associated with a ticket.
 */
export function FlowBlock({
  source,
  onActivatePart,
}: {
  source: string;
  onActivatePart?: (partId: string) => void;
}) {
  const state = useFlowSpec(source);
  return (
    <ChatDiagramBlock
      source={source}
      valid={state.status === "ready"}
      save={saveFlow}
      testId="flow-block"
    >
      <FlowSpecBody state={state} onActivatePart={onActivatePart} />
    </ChatDiagramBlock>
  );
}
