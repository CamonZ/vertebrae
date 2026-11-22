/**
 * Review gallery of the full-width thinking-line shaders (ticket
 * ad9bcd0f). Every line renders through the one shared WebGL2 renderer, so
 * the toolbar shows the loop's frame rate and per-frame CPU cost. Theme and
 * accent chips drive the real app settings, since the lines derive their
 * colours from them. Reached at `/galleries/thinking-lines` in every build
 * (router.tsx; sidebar icon behind ⌃⌥⌘⇧G); a review surface, not a product
 * page.
 */
import { useEffect, useState } from "react";
import { Chip } from "../components/atoms/Chip";
import {
  getThinkingLineRenderer,
  ThinkingLine,
  THINKING_LINE_VARIANTS,
  type ThinkingLineMode,
  type ThinkingLineStats,
} from "../components/ThinkingLine";
import { useShellHeader } from "../hooks/useShellHeader";
import { ACCENTS, useUIStore } from "../stores/uiStore";

const THEMES = ["dark", "light", "system"] as const;
const HEIGHTS = [12, 20, 32, 48] as const;
const SPEEDS = [0.5, 1, 2] as const;
const MODES = ["thinking", "compacting", "auto"] as const;
/** Auto mode alternates every this many milliseconds. */
const AUTO_PERIOD_MS = 4000;

type ModeChoice = (typeof MODES)[number];
type Variant = (typeof THINKING_LINE_VARIANTS)[number];

function useRendererStats(): ThinkingLineStats {
  const [stats, setStats] = useState(() =>
    getThinkingLineRenderer().getStats()
  );
  useEffect(() => {
    const id = window.setInterval(
      () => setStats(getThinkingLineRenderer().getStats()),
      500
    );
    return () => window.clearInterval(id);
  }, []);
  return stats;
}

function useAutoMode(choice: ModeChoice): ThinkingLineMode {
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (choice !== "auto") return;
    const id = window.setInterval(() => setFlip((f) => !f), AUTO_PERIOD_MS);
    return () => window.clearInterval(id);
  }, [choice]);
  if (choice === "auto") return flip ? "compacting" : "thinking";
  return choice;
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <span className="ml-3 text-xs text-[var(--color-fg-mute)] first:ml-0">
        {label}
      </span>
      {children}
    </>
  );
}

export function ThinkingLinesGalleryPage() {
  useShellHeader("Thinking lines gallery");
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);
  const [modeChoice, setModeChoice] = useState<ModeChoice>("thinking");
  const [height, setHeight] = useState<(typeof HEIGHTS)[number]>(20);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [paused, setPaused] = useState(false);
  const mode = useAutoMode(modeChoice);
  const stats = useRendererStats();

  return (
    <div className="flex h-full flex-col overflow-auto p-4">
      <div
        className="sticky top-0 z-10 -mx-4 -mt-4 mb-4 flex flex-wrap items-center gap-2 bg-[var(--color-bg)] px-4 py-3"
        role="toolbar"
        aria-label="Gallery controls"
      >
        <Group label="Theme">
          {THEMES.map((t) => (
            <Chip
              key={t}
              variant="filter"
              active={theme === t}
              onClick={() => setTheme(t)}
            >
              {t}
            </Chip>
          ))}
        </Group>
        <Group label="Accent">
          {ACCENTS.map((a) => (
            <Chip
              key={a.value}
              variant="filter"
              active={accent === a.value}
              onClick={() => setAccent(a.value)}
            >
              {a.label}
            </Chip>
          ))}
        </Group>
        <Group label="Mode">
          {MODES.map((m) => (
            <Chip
              key={m}
              variant="filter"
              active={modeChoice === m}
              onClick={() => setModeChoice(m)}
            >
              {m === "auto" ? `auto (${mode})` : m}
            </Chip>
          ))}
        </Group>
        <Group label="Height">
          {HEIGHTS.map((h) => (
            <Chip
              key={h}
              variant="filter"
              active={height === h}
              onClick={() => setHeight(h)}
            >
              {h}px
            </Chip>
          ))}
        </Group>
        <Group label="Speed">
          {SPEEDS.map((s) => (
            <Chip
              key={s}
              variant="filter"
              active={speed === s}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </Chip>
          ))}
        </Group>
        <Chip
          variant="filter"
          active={paused}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "paused" : "pause"}
        </Chip>
        <span
          className="ml-auto font-mono text-xs tabular-nums text-[var(--color-fg-mute)]"
          data-testid="thinking-lines-stats"
        >
          {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(2)} ms/frame CPU ·{" "}
          {stats.drawn}/{stats.instances} drawn
        </span>
      </div>

      <div className="flex flex-col gap-6">
        {THINKING_LINE_VARIANTS.map((v, i) => (
          <VariantRow
            key={v.id}
            index={i + 1}
            variant={v}
            mode={mode}
            height={height}
            speed={speed}
            paused={paused}
          />
        ))}
      </div>
    </div>
  );
}

function VariantRow({
  index,
  variant,
  mode,
  height,
  speed,
  paused,
}: {
  index: number;
  variant: Variant;
  mode: ThinkingLineMode;
  height: number;
  speed: number;
  paused: boolean;
}) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    const id = window.setTimeout(
      () => setError(getThinkingLineRenderer().getError(variant.id)),
      300
    );
    return () => window.clearTimeout(id);
  }, [variant.id]);
  const phrase =
    mode === "compacting" ? variant.compactingPhrase : variant.phrase;

  return (
    <section data-testid={`thinking-line-row-${variant.id}`}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-[var(--color-fg)]">
          <span className="mr-1.5 font-mono text-[var(--color-fg-mute)]">
            {String(index).padStart(2, "0")}
          </span>
          {variant.name}
        </h2>
        <span className="truncate text-xs text-[var(--color-fg-mute)]">
          {variant.blurb}
        </span>
      </div>
      {/* Mock chat column: the line spans the whole row. */}
      <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2">
        <ThinkingLine
          variant={variant.id}
          mode={mode}
          speed={speed}
          paused={paused}
          text={phrase}
          style={{ height }}
        />
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-[var(--color-fg-mute)]">
          compact
          <span className="inline-block w-10 overflow-hidden rounded-sm bg-[var(--color-bg-2)]">
            <ThinkingLine
              variant={variant.id}
              mode={mode}
              speed={speed}
              paused={paused}
              text={phrase}
              style={{ height: 10 }}
            />
          </span>
        </div>
      </div>
      {error && (
        <pre className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-err)]">
          {error}
        </pre>
      )}
    </section>
  );
}
