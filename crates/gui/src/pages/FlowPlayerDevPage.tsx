/**
 * Dev-only review surface for the interactive flow player: the reference
 * flow specs in FlowPlayer, with the part-activation callback logged.
 * Reached at `/dev/flows` in dev builds only (router.tsx).
 */
import { useMemo, useState } from "react";
import inlineDiscussions from "../components/MachineDiagram/flow/__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "../components/MachineDiagram/flow/__fixtures__/mechanisms.flow.yaml?raw";
import {
  compileFlowOrThrow,
  FlowPlayer,
  parseFlowSpec,
  useFlowRegistry,
} from "../components/MachineDiagram";
import { useShellHeader } from "../hooks/useShellHeader";

const SPECS = [
  ["inline discussions", inlineDiscussions],
  ["mechanisms", mechanisms],
] as const;

export function FlowPlayerDevPage() {
  useShellHeader("Flow player (dev)");
  const registry = useFlowRegistry();
  const flows = useMemo(
    () =>
      SPECS.map(([name, source]) => {
        const parsed = parseFlowSpec(source);
        if (!parsed.ok) throw new Error(`${name} does not parse`);
        return [name, compileFlowOrThrow(parsed.value, { registry })] as const;
      }),
    [registry]
  );
  const [activated, setActivated] = useState<string[]>([]);
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-4">
      <div className="font-mono text-xs text-[var(--color-fg-mute)]">
        activated: {activated.join(", ") || "—"}
      </div>
      {flows.map(([name, flow]) => (
        <section
          key={name}
          className="max-w-[1100px] rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-3"
        >
          <FlowPlayer
            flow={flow}
            onActivatePart={(id) =>
              setActivated((a) => [...a.slice(-5), `${name}:${id}`])
            }
          />
        </section>
      ))}
    </div>
  );
}
