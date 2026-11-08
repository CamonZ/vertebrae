import { useEffect, useId, useMemo, useState } from "react";
import { InlineResizeHandle } from "../shared/InlineResizeHandle";
import type { Statechart } from "./statechart";
import { useStatechartViewport } from "./useStatechartViewport";
import {
  layoutStatechart,
  wrapStatechartText,
  type StatechartLayout,
} from "./statechartLayout";

type LayoutState =
  | { status: "loading" }
  | { status: "ready"; layout: StatechartLayout }
  | { status: "error"; message: string };

// Theme tokens adjust for light and dark surfaces. Colors distinguish events;
// labels remain authoritative when a large machine reuses the palette.
const EVENT_COLORS = [
  "var(--color-info)",
  "var(--color-step-llm)",
  "var(--color-ok)",
  "var(--color-accent)",
  "var(--color-step-structured)",
  "var(--color-err)",
  "var(--color-warn)",
];
const ARROW_COLORS = [...EVENT_COLORS, "var(--color-fg-mute)"];

export function StatechartViewer({ machine }: { machine: Statechart }) {
  const [result, setResult] = useState<LayoutState>({ status: "loading" });
  const [zoom, setZoom] = useState(1);
  const viewport = useStatechartViewport();
  const { canvasRef } = viewport;
  const [colorMode, setColorMode] = useState("event");
  const eventColors = useMemo(() => {
    const names = machine.transitions.map((transition) => transition.eventType);
    const unique = new Set(names);
    const events = [...unique].sort();
    const entries = events.map((event, index) => {
      const marker = index % EVENT_COLORS.length;

      return [event, { color: EVENT_COLORS[marker], marker }] as const;
    });

    return new Map(entries);
  }, [machine]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const marker = `statechart-arrow-${markerId}`;
  const selected = machine.nodes.find((node) => node.id === selectedId);
  const selectedTransitions = useMemo(() => {
    return machine.transitions.filter(
      (transition) => transition.source === selectedId
    );
  }, [machine, selectedId]);

  useEffect(() => {
    let retired = false;
    setResult({ status: "loading" });

    layoutStatechart(machine)
      .then((layout) => {
        if (!retired) setResult({ status: "ready", layout });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Layout failed.";

        if (!retired) setResult({ status: "error", message });
      });

    return () => {
      retired = true;
    };
  }, [machine]);

  if (result.status === "error")
    return (
      <span role="alert">Unable to render statechart: {result.message}</span>
    );
  if (result.status === "loading")
    return <span role="status">Laying out statechart…</span>;

  const { layout } = result;

  function fit() {
    const canvas = canvasRef.current;

    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;

    const horizontal = (canvas.clientWidth - 16) / layout.width;
    const vertical = (canvas.clientHeight - 16) / layout.height;
    const fitted = Math.max(0.05, Math.min(1, horizontal, vertical));

    setZoom(fitted);
    viewport.resetPan();
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
  }

  return (
    <span
      className="flex min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-border bg-bg"
      ref={viewport.containerRef}
      style={{
        width: "90%",
        maxWidth: "90%",
        marginInline: "auto",
        height: viewport.height,
      }}
      data-testid="statechart-viewer"
    >
      <span className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="mr-auto font-mono text-xs text-fg-mute">
          XState · read-only statechart
        </span>
        <select
          aria-label="Transition colors"
          value={colorMode}
          onChange={(event) => setColorMode(event.target.value)}
          className="rounded border border-border bg-bg px-2 py-1 text-xs"
        >
          <option value="event">Colors by event</option>
          <option value="single">Single color</option>
        </select>
        <button
          type="button"
          aria-label="Zoom out statechart"
          onClick={() => setZoom((value) => Math.max(0.05, value / 1.25))}
          className="rounded border border-border px-2"
        >
          −
        </button>
        <span className="text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in statechart"
          onClick={() => setZoom((value) => Math.min(3, value * 1.25))}
          className="rounded border border-border px-2"
        >
          +
        </button>
        <button
          type="button"
          onClick={fit}
          aria-label="Fit statechart"
          className="rounded border border-border px-2 text-xs"
        >
          Fit
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="rounded border border-border px-2 text-xs"
        >
          Reset zoom
        </button>
      </span>
      {colorMode === "event" && (
        <span
          className="flex max-h-20 shrink-0 flex-wrap gap-x-4 gap-y-1 overflow-auto border-b border-border px-3 py-2 text-xs"
          aria-label="Transition color legend"
        >
          {[...eventColors].map(([event, { color }]) => (
            <span key={event} className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                style={{ backgroundColor: color, width: 16, height: 3 }}
              />
              {event.startsWith("xstate.done.state.")
                ? "done"
                : event || "always"}
            </span>
          ))}
        </span>
      )}
      <span
        className="block min-h-24 flex-1 overflow-auto overscroll-contain p-2 select-none"
        aria-label="Scrollable statechart canvas"
        ref={canvasRef}
        tabIndex={0}
        style={{
          touchAction: "none",
          cursor: viewport.dragging ? "grabbing" : "grab",
        }}
        {...viewport.panHandlers}
      >
        <svg
          role="group"
          data-testid="native-statechart-svg"
          aria-label={`${machine.name} statechart`}
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block max-w-none"
          style={{
            color: "var(--color-fg)",
            transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px)`,
          }}
        >
          <defs>
            {ARROW_COLORS.map((color, index) => (
              <marker
                key={color}
                id={`${marker}-${index}`}
                markerWidth="10"
                markerHeight="10"
                refX="9"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path
                  d="M 0 1 L 9 5 L 0 9"
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                />
              </marker>
            ))}
          </defs>
          {layout.states.map((state) => {
            const selected = state.id === selectedId;
            const labelLines = wrapStatechartText(state.label, 24);
            const header = Math.max(48, labelLines.length * 18 + 24);
            const select = () => setSelectedId(state.id);

            return (
              <g
                key={state.id}
                data-state-id={state.id}
                data-state-type={state.type}
                data-parent-id={state.parentId}
                data-state-label={state.label}
                role="button"
                tabIndex={0}
                aria-label={`Inspect ${state.label} ${state.type} state`}
                aria-pressed={selected}
                onClick={select}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                  }
                }}
                className="cursor-pointer outline-none focus-visible:stroke-fg-soft"
              >
                <title>
                  {state.description ?? `${state.label} · ${state.type}`}
                </title>
                <rect
                  x={state.x}
                  y={state.y}
                  width={state.width}
                  height={state.height}
                  rx="10"
                  fill="var(--color-bg)"
                  stroke={
                    selected ? "var(--color-fg-soft)" : "var(--color-border)"
                  }
                  strokeWidth={selected ? 2 : 1.5}
                  strokeDasharray={state.region ? "7 5" : undefined}
                  data-state-boundary="true"
                />
                {state.children.length > 0 && (
                  <line
                    x1={state.x}
                    y1={state.y + header}
                    x2={state.x + state.width}
                    y2={state.y + header}
                    stroke="var(--color-border)"
                  />
                )}
                {state.type === "final" && (
                  <g aria-label="Final state marker">
                    <circle
                      cx={state.x + 20}
                      cy={state.y + 28}
                      r="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <circle
                      cx={state.x + 20}
                      cy={state.y + 28}
                      r="6"
                      fill="currentColor"
                    />
                  </g>
                )}
                <text
                  x={state.x + (state.type === "final" ? 40 : 14)}
                  y={state.y + 24}
                  fill="currentColor"
                  fontSize="14"
                  fontFamily="ui-monospace, monospace"
                >
                  {labelLines.map((line, index) => (
                    <tspan
                      key={index}
                      x={state.x + (state.type === "final" ? 40 : 14)}
                      dy={index ? 18 : 0}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
                {state.children.length > 0 && (
                  <text
                    x={state.x + state.width - 12}
                    y={state.y + header - 10}
                    textAnchor="end"
                    fill="var(--color-fg-mute)"
                    fontSize="10"
                  >
                    {state.type === "parallel" ? "parallel ∥" : "compound"}
                  </text>
                )}
              </g>
            );
          })}
          {layout.initials.map((initial) => (
            <circle
              key={initial.id}
              data-initial-owner={initial.owner}
              cx={initial.x}
              cy={initial.y}
              r="6"
              fill="currentColor"
            >
              <title>Initial state</title>
            </circle>
          ))}
          {layout.transitions.map((transition) => {
            const [start, ...rest] = transition.points;
            const segments = rest.map((point) => `L ${point.x} ${point.y}`);
            const path = `M ${start.x} ${start.y} ${segments.join(" ")}`;
            const emphasized =
              transition.source === selectedId ||
              transition.target === selectedId;
            const lines = wrapStatechartText(transition.label);
            const eventColor = eventColors.get(transition.eventType);
            const colorIndex = transition.initial
              ? EVENT_COLORS.length
              : colorMode === "single"
                ? 3
                : (eventColor?.marker ?? 0);
            const color = ARROW_COLORS[colorIndex];
            const arrow = `url(#${marker}-${colorIndex})`;

            return (
              <g
                key={transition.id}
                data-transition-id={transition.id}
                data-source={transition.source}
                data-target={transition.target}
                data-event={transition.event}
                data-transition-kind={transition.kind}
                data-initial={transition.initial ? "true" : undefined}
              >
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={emphasized ? 2 : 1.3}
                  strokeDasharray={
                    transition.kind === "internal" ? "4 3" : undefined
                  }
                  markerEnd={arrow}
                  opacity={selectedId && !emphasized ? 0.35 : 0.8}
                />
                {transition.label && (
                  <g>
                    <rect
                      x={transition.labelPosition.x - 3}
                      y={transition.labelPosition.y - 2}
                      width={Math.min(28, transition.label.length) * 7 + 12}
                      height={lines.length * 16 + 8}
                      rx="4"
                      fill="var(--color-bg)"
                      stroke="var(--color-border)"
                    />
                    <text
                      x={transition.labelPosition.x + 3}
                      y={transition.labelPosition.y + 13}
                      fill="currentColor"
                      fontSize="12"
                      fontFamily="ui-monospace, monospace"
                    >
                      {lines.map((line, index) => (
                        <tspan
                          key={index}
                          x={transition.labelPosition.x + 3}
                          dy={index ? 16 : 0}
                        >
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </span>
      <span
        className="block min-h-0 max-h-36 overflow-auto border-t border-border px-3 py-2 text-sm"
        aria-live="polite"
        data-testid="statechart-inspection"
      >
        {selected ? (
          <>
            <span className="block font-mono">
              {selected.id} · {selected.type}
            </span>
            {selected.description && (
              <span className="block">{selected.description}</span>
            )}
            {selected.type === "parallel" && (
              <span className="block text-fg-mute">
                All child regions are active together.
              </span>
            )}
            {selectedTransitions.map((transition) => (
              <span className="block font-mono text-xs" key={transition.id}>
                {transition.event}
                {transition.guard ? ` [${transition.guard}]` : ""} →{" "}
                {transition.target}
                {transition.kind === "internal" ? " · internal" : ""}
                {transition.reenter ? " · reenter" : ""}
              </span>
            ))}
          </>
        ) : (
          "Select a state to inspect its description and transitions. Drag or scroll to pan; use + and − to zoom."
        )}
      </span>
      <InlineResizeHandle
        label="Resize statechart"
        value={viewport.height}
        minimum={320}
        maximum={1600}
        resizing={viewport.dragging}
        {...viewport.resizeHandlers}
      />
    </span>
  );
}
