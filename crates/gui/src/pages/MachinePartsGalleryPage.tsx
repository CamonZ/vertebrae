/**
 * Dev-only gallery of the machine-diagram catalogue parts: every part ×
 * scenario × universal state × change mark, with light/dark and labels-off
 * toggles. Reached at `/dev/machine-parts` in dev builds only (router.tsx);
 * a review surface for component tickets, not a product page.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/atoms/Button";
import { Chip } from "../components/atoms/Chip";
import {
  MachineDiagram,
  UNIVERSAL_STATES,
  useReducedMotion,
  type UniversalState,
} from "../components/MachineDiagram";
import type { ChangeMark } from "../components/MachineDiagram/accessibility";
import {
  CatalogPart,
  MACHINE_PARTS,
  type CatalogView,
  type MachinePartDef,
  type MachinePartName,
} from "../components/MachineDiagram/parts";
import { useShellHeader } from "../hooks/useShellHeader";
import { useUIStore } from "../stores/uiStore";

const CHANGE_MARKS: readonly ChangeMark[] = [
  "unchanged",
  "added",
  "changed",
  "removed",
];

const MARK_LABEL: Record<ChangeMark, string> = {
  unchanged: "unchanged",
  added: "+ added",
  changed: "~ changed",
  removed: "− removed",
};

const THEMES = ["dark", "light", "system"] as const;

type Column =
  | { readonly kind: "scenario"; readonly index: number; readonly name: string }
  | { readonly kind: "state"; readonly state: UniversalState };

function columnsFor(def: MachinePartDef): Column[] {
  return [
    ...def.scenarios.map((s, index) => ({
      kind: "scenario" as const,
      index,
      name: s.name,
    })),
    ...UNIVERSAL_STATES.map((state) => ({ kind: "state" as const, state })),
  ];
}

const columnLabel = (c: Column) =>
  c.kind === "scenario" ? `scenario · ${c.name}` : `state · ${c.state}`;

/**
 * Filter chip whose selection stays visible: the atom's `filter` variant
 * background otherwise wins over its `active` styling.
 */
function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Chip
      variant="filter"
      active={active}
      onClick={onClick}
      className={
        active
          ? "!border-[var(--color-accent)] !bg-[var(--color-accent-wash)] !text-[var(--color-accent)]"
          : undefined
      }
    >
      {children}
    </Chip>
  );
}

/** Seconds since playback started, advanced every animation frame. */
function useClock(playing: boolean): number {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const start = performance.now() - clock * 1000;
    const tick = (now: number) => {
      setClock((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The start offset is captured once per play; clock is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  return clock;
}

interface CellProps {
  name: string;
  def: MachinePartDef;
  column: Column;
  mark: ChangeMark;
  labels: boolean;
  clock: number | null;
  reducedMotion: boolean;
}

function GalleryCell({
  name,
  def,
  column,
  mark,
  labels,
  clock,
  reducedMotion,
}: CellProps) {
  let view: CatalogView;
  if (column.kind === "scenario") {
    const sc = def.scenarios[column.index];
    const t = clock == null ? sc.still : clock % sc.timeline.period;
    view = { kind: "scenario", index: column.index, t };
  } else {
    view = { kind: "state", state: column.state };
  }
  const caption = `${columnLabel(column)} · ${MARK_LABEL[mark]}`;
  return (
    <figure
      className="flex flex-col gap-1"
      data-testid={`gallery-cell-${name}`}
    >
      <MachineDiagram
        label={`${name} · ${caption}`}
        labels={labels}
        className="h-auto w-[240px] rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)]"
      >
        <CatalogPart
          def={def}
          view={view}
          change={mark}
          changeNote={mark === "changed" ? "config edited" : undefined}
          labels={labels}
          reducedMotion={reducedMotion}
        />
      </MachineDiagram>
      <figcaption className="text-xs text-[var(--color-fg-mute)]">
        {caption}
      </figcaption>
    </figure>
  );
}

export function MachinePartsGalleryPage() {
  useShellHeader("Machine parts (dev)");
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const reducedMotion = useReducedMotion();
  const [partFilter, setPartFilter] = useState<MachinePartName | "all">("all");
  const [markFilter, setMarkFilter] = useState<ChangeMark | "all">("all");
  const [labels, setLabels] = useState(true);
  // Animate by default; reduced-motion users start on the still frames.
  const [playing, setPlaying] = useState(() => !reducedMotion);
  const clock = useClock(playing);

  const parts = useMemo(
    () =>
      (Object.keys(MACHINE_PARTS) as MachinePartName[]).filter(
        (n) => partFilter === "all" || n === partFilter
      ),
    [partFilter]
  );
  const marks =
    markFilter === "all"
      ? CHANGE_MARKS
      : CHANGE_MARKS.filter((m) => m === markFilter);

  return (
    <div className="flex h-full flex-col overflow-auto p-4">
      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label="Gallery controls"
      >
        <span className="text-xs text-[var(--color-fg-mute)]">Theme</span>
        {THEMES.map((t) => (
          <ToggleChip key={t} active={theme === t} onClick={() => setTheme(t)}>
            {t}
          </ToggleChip>
        ))}
        <span className="ml-3 text-xs text-[var(--color-fg-mute)]">Mark</span>
        {(["all", ...CHANGE_MARKS] as const).map((m) => (
          <ToggleChip
            key={m}
            active={markFilter === m}
            onClick={() => setMarkFilter(m)}
          >
            {m === "all" ? "all" : MARK_LABEL[m]}
          </ToggleChip>
        ))}
        <Button
          size="sm"
          className="ml-3"
          aria-pressed={!labels}
          onClick={() => setLabels((v) => !v)}
        >
          {labels ? "Labels off" : "Labels on"}
        </Button>
        <Button
          size="sm"
          aria-pressed={playing}
          onClick={() => setPlaying((v) => !v)}
        >
          {playing ? "Show stills" : "Play scenarios"}
        </Button>
      </div>
      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label="Parts"
      >
        {(["all", ...Object.keys(MACHINE_PARTS)] as const).map((n) => (
          <ToggleChip
            key={n}
            active={partFilter === n}
            onClick={() => setPartFilter(n as MachinePartName | "all")}
          >
            {n}
          </ToggleChip>
        ))}
      </div>
      {parts.map((name) => {
        const def = MACHINE_PARTS[name] as unknown as MachinePartDef;
        const columns = columnsFor(def);
        return (
          <section
            key={name}
            aria-label={`${name} part`}
            className="mb-8"
            data-testid={`gallery-part-${name}`}
          >
            <h2 className="mb-2 text-sm font-medium text-[var(--color-fg)]">
              {name}{" "}
              <span className="text-[var(--color-fg-mute)]">
                · {def.part.job} · {def.family} · {def.footprint}
              </span>
            </h2>
            <div className="flex flex-col gap-3">
              {marks.map((mark) => (
                <div key={mark} className="flex flex-wrap gap-3">
                  {columns.map((column) => (
                    <GalleryCell
                      key={columnLabel(column)}
                      name={name}
                      def={def}
                      column={column}
                      mark={mark}
                      labels={labels}
                      clock={playing ? clock : null}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
