/**
 * Dev-only review surface for the interactive flow player: the reference
 * flow specs in FlowPlayer, with the part-activation callback logged, plus
 * the reference examples with their hand-given positions dropped so
 * auto-layout places them. Reached at `/dev/flows` in dev builds only
 * (router.tsx).
 */
import { useMemo, useState } from "react";
import inlineDiscussions from "../components/MachineDiagram/flow/__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "../components/MachineDiagram/flow/__fixtures__/mechanisms.flow.yaml?raw";
import burstOptions from "../components/MachineDiagram/flow/__fixtures__/burstOptions.flow.yaml?raw";
import sessionMigration from "../components/MachineDiagram/flow/__fixtures__/sessionMigration.flow.yaml?raw";
import {
  FlowPlayer,
  parseFlowSpec,
  useFlowRegistry,
  useLaidOutFlow,
  type FlowSpec,
} from "../components/MachineDiagram";
import { useShellHeader } from "../hooks/useShellHeader";

const SPECS = [
  ["inline discussions", inlineDiscussions, false],
  ["mechanisms", mechanisms, false],
  ["three options", burstOptions, false],
  ["migration in phases", sessionMigration, false],
  ["inline discussions · auto-layout", inlineDiscussions, true],
  ["mechanisms · auto-layout", mechanisms, true],
] as const;

/** Drop hand-given positions; frame the inline-discussion session and its tool guard as one process. */
function unplaced(spec: FlowSpec): FlowSpec {
  const ids = new Set(spec.parts.map((p) => p.id));
  return {
    ...spec,
    parts: spec.parts.map((p) => {
      const q = { ...p };
      delete (q as { position?: unknown }).position;
      return q;
    }),
    ...(ids.has("process") && ids.has("tools")
      ? {
          regions: [
            {
              id: "proc",
              label: "CLAUDE PROCESS",
              parts: ["process", "tools"],
            },
          ],
        }
      : {}),
  };
}

function DevFlow({
  name,
  source,
  autoLayout,
  onActivate,
}: {
  name: string;
  source: string;
  autoLayout: boolean;
  onActivate: (id: string) => void;
}) {
  const registry = useFlowRegistry();
  const spec = useMemo(() => {
    const parsed = parseFlowSpec(source);
    if (!parsed.ok) throw new Error(`${name} does not parse`);
    const s = parsed.value as FlowSpec;
    return autoLayout ? unplaced(s) : s;
  }, [name, source, autoLayout]);
  const state = useLaidOutFlow(spec, { registry });
  if (state.status === "pending")
    return <div className="font-mono text-xs">laying out {name}…</div>;
  if (!state.result.ok) throw new Error(`${name} does not compile`);
  return <FlowPlayer flow={state.result.flow} onActivatePart={onActivate} />;
}

export function FlowPlayerDevPage() {
  useShellHeader("Flow player (dev)");
  const [activated, setActivated] = useState<string[]>([]);
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-4">
      <div className="font-mono text-xs text-[var(--color-fg-mute)]">
        activated: {activated.join(", ") || "—"}
      </div>
      {SPECS.map(([name, source, autoLayout]) => (
        <section
          key={name}
          className="max-w-[1100px] rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-3"
        >
          <DevFlow
            name={name}
            source={source}
            autoLayout={autoLayout}
            onActivate={(id) =>
              setActivated((a) => [...a.slice(-5), `${name}:${id}`])
            }
          />
        </section>
      ))}
    </div>
  );
}
