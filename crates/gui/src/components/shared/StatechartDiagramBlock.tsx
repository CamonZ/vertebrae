import { useMemo } from "react";
import { commands } from "../../bindings";
import { StatechartPreview } from "../Artifacts/StatechartPreview";
import { parseStatechart } from "../Artifacts/statechart";
import { ChatDiagramBlock } from "./ChatDiagramBlock";

const saveStatechart = (body: string, ticketId: string) =>
  commands.saveStatechartArtifact(body, ticketId);

export function StatechartDiagramBlock({ source }: { source: string }) {
  const valid = useMemo(() => {
    try {
      parseStatechart(source);
      return true;
    } catch {
      return false;
    }
  }, [source]);
  return (
    <ChatDiagramBlock
      source={source}
      valid={valid}
      save={saveStatechart}
      testId="component-diagram"
    >
      <StatechartPreview body={source} />
    </ChatDiagramBlock>
  );
}
