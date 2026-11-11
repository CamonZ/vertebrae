import { useState } from "react";
import { Button } from "../../atoms";
import { SegmentedControl } from "../../molecules";
import type { ArrangementName } from "./spec";
import type { CompiledFlow } from "./compile";
import { FlowDiagram } from "./FlowDiagram";
import { useFlowClock } from "./useFlowClock";

export interface FlowPlayerProps {
  flow: CompiledFlow;
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
}

const ARRANGEMENT_LABELS: Record<ArrangementName, string> = {
  before: "Before",
  after: "After",
  current: "Current",
};

/**
 * A compiled flow with play/pause, step back/forward by beat and, when the
 * flow has two arrangements, a Before/After toggle that keeps the beat.
 */
export function FlowPlayer({ flow, reducedMotion }: FlowPlayerProps) {
  const names = flow.arrangements.map((a) => a.arrangement);
  const [selected, setSelected] = useState<ArrangementName>(
    names[names.length - 1]
  );
  const diagram =
    flow.arrangements.find((a) => a.arrangement === selected) ??
    flow.arrangements[0];
  const clock = useFlowClock(diagram.travel, { reducedMotion });
  const caption = clock.beat >= 0 ? diagram.beats[clock.beat]?.caption : "";

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="flow-player"
      data-arrangement={diagram.arrangement}
      data-t={clock.t}
      data-beat={clock.beat}
      data-playing={clock.playing ? "true" : "false"}
    >
      {flow.title && (
        <div className="text-sm font-medium text-fg">{flow.title}</div>
      )}
      <FlowDiagram
        diagram={diagram}
        t={clock.t}
        label={
          flow.title ? `${flow.title} · ${diagram.arrangement}` : undefined
        }
        reducedMotion={clock.reducedMotion}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={clock.stepBack}
          disabled={clock.beatCount === 0}
          aria-label="Previous beat"
          title="Previous beat"
        >
          ◀︎
        </Button>
        <Button
          size="sm"
          onClick={clock.toggle}
          aria-label={clock.playing ? "Pause" : "Play"}
          title={clock.playing ? "Pause" : "Play"}
        >
          {clock.playing ? "Pause" : "Play"}
        </Button>
        <Button
          size="sm"
          onClick={clock.stepForward}
          disabled={clock.beatCount === 0}
          aria-label="Next beat"
          title="Next beat"
        >
          ▶︎
        </Button>
        {clock.beatCount > 0 && (
          <span className="font-mono text-xs text-fg-mute" aria-live="polite">
            beat {Math.max(0, clock.beat) + 1}/{clock.beatCount}
          </span>
        )}
        {names.length === 2 && (
          <SegmentedControl
            className="ml-auto"
            ariaLabel="Arrangement"
            options={names.map((n) => ({
              value: n,
              label: ARRANGEMENT_LABELS[n],
            }))}
            value={diagram.arrangement}
            onChange={setSelected}
          />
        )}
      </div>
      {caption && (
        <div className="text-sm text-fg-soft" data-testid="flow-caption">
          {caption}
        </div>
      )}
    </div>
  );
}
