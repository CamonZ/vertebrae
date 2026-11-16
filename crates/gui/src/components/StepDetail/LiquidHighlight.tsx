import { PanelCode } from "../shared/PanelCode";

export function LiquidHighlight({
  source,
  className,
  "data-testid": testId = "liquid-highlight",
}: {
  source: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={className} data-testid={testId}>
      <PanelCode source={source} language="liquid" label="Liquid template" />
    </div>
  );
}
