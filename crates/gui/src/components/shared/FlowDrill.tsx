import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../query/queryClient";
import { useArtifactPresentations } from "../../hooks/useArtifactPresentations";
import { isFlowMetadata } from "../Artifacts/flowArtifact";
import { Button } from "../atoms";
import { FlowPlayer } from "../MachineDiagram/flow/FlowPlayer";
import type { CompiledFlow, DrillTarget } from "../MachineDiagram/flow";
import { FlowSpecErrors, FlowSpecProgress } from "./FlowSpecStatus";
import { useFlowSpec } from "./useFlowSpec";

/** One drill-down below the top diagram: the part opened and what it opens. */
interface DrillLevel {
  readonly partId: string;
  readonly name: string;
  readonly target: DrillTarget;
}

/** Opens part `partId` of `from`, the flow shown at that level. */
type OpenPart = (from: CompiledFlow, partId: string) => void;

function drillOf(flow: CompiledFlow, partId: string) {
  for (const a of flow.arrangements) {
    const p = a.parts.find((q) => q.id === partId && q.drill);
    if (p?.drill) return { name: p.identity.name, target: p.drill };
  }
  return undefined;
}

type Focus =
  | { readonly kind: "level"; readonly depth: number }
  | { readonly kind: "part"; readonly depth: number; readonly partId: string };

/**
 * A flow player that drills into parts with a sub-spec. Activating such a
 * part opens its diagram in the same place, with a breadcrumb back up. Every
 * level above stays mounted (hidden and paused), so going back finds its beat,
 * Before/After arrangement, pinned part and followed card as they were. Inline
 * sub-specs arrive compiled and laid out with the parent; artifact sub-specs
 * are loaded and laid out on their own. The way back up is the breadcrumb
 * (Esc belongs to the enclosing panel). `onActivatePart` hears the top
 * level's activations only.
 */
export function FlowDrill({
  flow,
  onActivatePart,
}: {
  flow: CompiledFlow;
  onActivatePart?: (partId: string) => void;
}) {
  const [path, setPath] = useState<readonly DrillLevel[]>([]);
  // A new spec starts at its top level.
  const [shown, setShown] = useState(flow);
  if (shown !== flow) {
    setShown(flow);
    setPath([]);
  }
  const levels = useRef<(HTMLDivElement | null)[]>([]);
  const focus = useRef<Focus | null>(null);

  useLayoutEffect(() => {
    const f = focus.current;
    focus.current = null;
    const level = f && levels.current[f.depth];
    if (!f || !level) return;
    const target =
      f.kind === "part"
        ? level.querySelector<SVGGElement>(
            `[data-part-id="${CSS.escape(f.partId)}"]`
          )
        : level.querySelector<HTMLElement>('[data-testid="flow-player"]');
    (target ?? level).focus();
  }, [path]);

  const onTopActivate = useRef(onActivatePart);
  useEffect(() => {
    onTopActivate.current = onActivatePart;
  }, [onActivatePart]);

  // One stable opener per level, so the players' interaction stays memoized.
  const openAt = useMemo(() => {
    const cache = new Map<number, OpenPart>();
    return (depth: number): OpenPart => {
      let open = cache.get(depth);
      if (!open) {
        open = (from, partId) => {
          if (depth === 0) onTopActivate.current?.(partId);
          const drill = drillOf(from, partId);
          if (!drill) return;
          focus.current = { kind: "level", depth: depth + 1 };
          setPath((p) => [...p.slice(0, depth), { partId, ...drill }]);
        };
        cache.set(depth, open);
      }
      return open;
    };
  }, []);

  const goTo = (depth: number) => {
    const opened = path[depth];
    if (!opened) return;
    focus.current = { kind: "part", depth, partId: opened.partId };
    setPath((p) => p.slice(0, depth));
  };

  const depth = path.length;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="flow-drill"
      data-depth={depth}
    >
      {depth > 0 && (
        <Breadcrumb root={flow.title ?? "Flow"} path={path} onGoTo={goTo} />
      )}
      <div
        ref={(el) => {
          levels.current[0] = el;
        }}
        hidden={depth > 0}
        tabIndex={-1}
        data-drill-level={0}
      >
        <LevelPlayer flow={flow} suspended={depth > 0} onOpen={openAt(0)} />
      </div>
      {path.map((level, i) => (
        <div
          key={`${i}:${level.partId}`}
          ref={(el) => {
            levels.current[i + 1] = el;
          }}
          hidden={i + 1 < depth}
          tabIndex={-1}
          className="focus-visible:outline-none"
          data-drill-level={i + 1}
          data-drill-part={level.partId}
        >
          <DrillBody
            target={level.target}
            suspended={i + 1 < depth}
            onOpen={openAt(i + 1)}
          />
        </div>
      ))}
    </div>
  );
}

function LevelPlayer({
  flow,
  suspended,
  onOpen,
}: {
  flow: CompiledFlow;
  suspended: boolean;
  onOpen: OpenPart;
}) {
  const onActivatePart = useCallback(
    (id: string) => onOpen(flow, id),
    [onOpen, flow]
  );
  return (
    <FlowPlayer
      flow={flow}
      suspended={suspended}
      onActivatePart={onActivatePart}
    />
  );
}

function Breadcrumb({
  root,
  path,
  onGoTo,
}: {
  root: string;
  path: readonly DrillLevel[];
  onGoTo: (depth: number) => void;
}) {
  const names = [root, ...path.map((l) => l.name)];
  const parent = names[names.length - 2];
  return (
    <nav
      aria-label="Diagram levels"
      className="flex flex-wrap items-center gap-2 text-xs"
      data-testid="flow-breadcrumb"
    >
      <Button
        size="sm"
        variant="ghost"
        className="!px-2"
        onClick={() => onGoTo(path.length - 1)}
        title={`Back to ${parent}`}
      >
        ← Back
      </Button>
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        {names.map((name, i) => {
          const current = i === names.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <span className="text-fg-mute" aria-hidden>
                  /
                </span>
              )}
              {current ? (
                <span
                  className="truncate font-medium text-fg"
                  aria-current="page"
                >
                  {name}
                </span>
              ) : (
                <button
                  type="button"
                  className="truncate rounded text-fg-soft underline decoration-dotted underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  onClick={() => onGoTo(i)}
                >
                  {name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function DrillBody({
  target,
  suspended,
  onOpen,
}: {
  target: DrillTarget;
  suspended: boolean;
  onOpen: OpenPart;
}) {
  if (target.kind === "inline")
    return (
      <LevelPlayer flow={target.flow} suspended={suspended} onOpen={onOpen} />
    );
  return (
    <QueryClientProvider client={queryClient}>
      <ArtifactDrill
        id={target.artifact}
        suspended={suspended}
        onOpen={onOpen}
      />
    </QueryClientProvider>
  );
}

function DrillError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="text-sm text-err"
      data-testid="flow-drill-error"
    >
      {children}
    </div>
  );
}

/** A sub-spec saved as a flow artifact: load it, then lay it out on its own. */
function ArtifactDrill({
  id,
  suspended,
  onOpen,
}: {
  id: string;
  suspended: boolean;
  onOpen: OpenPart;
}) {
  const { artifacts, isLoading, error, refetch } = useArtifactPresentations();
  if (error)
    return (
      <DrillError>
        Unable to load drill-down artifact {id}: {error}{" "}
        <Button size="sm" variant="ghost" onClick={refetch}>
          Retry
        </Button>
      </DrillError>
    );
  if (isLoading)
    return <FlowSpecProgress>Loading the drill-down diagram…</FlowSpecProgress>;
  const artifact = artifacts.find((a) => a.id === id);
  if (!artifact)
    return (
      <DrillError>
        Drill-down artifact {id} was not found in this project.
      </DrillError>
    );
  if (!isFlowMetadata(artifact.metadata))
    return (
      <DrillError>
        Drill-down artifact {artifact.filename} is not a flow spec.
      </DrillError>
    );
  return (
    <ArtifactFlow
      key={artifact.id}
      source={artifact.body}
      suspended={suspended}
      onOpen={onOpen}
    />
  );
}

function ArtifactFlow({
  source,
  suspended,
  onOpen,
}: {
  source: string;
  suspended: boolean;
  onOpen: OpenPart;
}) {
  const state = useFlowSpec(source);
  if (state.status === "invalid")
    return <FlowSpecErrors errors={state.errors} />;
  if (state.status === "laying-out") return <FlowSpecProgress />;
  return (
    <LevelPlayer flow={state.flow} suspended={suspended} onOpen={onOpen} />
  );
}
