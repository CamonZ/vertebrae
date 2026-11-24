import { useMemo } from "react";
import { parseStatechart } from "./statechart";
import { StatechartViewer } from "./StatechartViewer";
import { diagramFillClass, useDiagramBox } from "../shared/diagramBox";

export function StatechartPreview({ body }: { body: string }) {
  const fill = diagramFillClass(useDiagramBox());
  const result = useMemo(() => {
    try {
      const machine = parseStatechart(body);

      return { machine };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid statechart.";

      return { error: message };
    }
  }, [body]);

  if (!result.machine) {
    return (
      <span role="alert">Unable to render statechart: {result.error}</span>
    );
  }

  return (
    <span className={`block ${fill}`} data-testid="statechart-preview">
      <span className="block font-semibold">{result.machine.name}</span>
      <StatechartViewer key={body} machine={result.machine} />
    </span>
  );
}
