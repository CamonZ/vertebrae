import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button, Icon } from "../../atoms";
import { SegmentedControl } from "../../molecules";
import type { DiagramInteraction } from "../interaction";
import { type FitInsets, ZOOM_GUTTER } from "../MachineDiagramViewport";
import { roleColor } from "../palette";
import { beatOutcome, nextSpeed, SPEEDS } from "./clockModel";
import type { BeatChange, CompiledFlow, DiagramTimeline } from "./compile";
import { AttachmentPanel } from "./AttachmentPanel";
import { FlowDiagram } from "./FlowDiagram";
import {
  cycleArrangement,
  leaveToTarget,
  playerCommand,
  PLAYER_SHORTCUTS,
} from "./playerKeys";
import type { ArrangementName } from "./spec";
import { useArrangementMorph } from "./useArrangementMorph";
import { useFlowClock, type FlowClock } from "./useFlowClock";
import {
  beatAnnouncement,
  cardLabel,
  cardsInPart,
  narrateCard,
  partStatusAt,
} from "./whereabouts";

export interface FlowPlayerProps {
  flow: CompiledFlow;
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
  /**
   * A part was activated (click, or Enter/Space while focused). The single
   * hook for evidence panels and drill-down; the player also pins the part
   * in its inspector.
   */
  onActivatePart?: (partId: string) => void;
  /**
   * Hidden behind a drill-down: playback pauses so the beat is where it was
   * left when the player is shown again.
   */
  suspended?: boolean;
}

/** The arrangement shown first: the first one marked against the baseline (After, option A). */
const firstShown = (flow: CompiledFlow): ArrangementName =>
  (
    flow.arrangements.find((a) => a.arrangement !== flow.baseline) ??
    flow.arrangements[0]
  ).arrangement;

const speedLabel = (s: number) => `${s}×`;

/** A borderless glass card laid on the diagram, sized to its content. */
const glass =
  "rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--color-bg-1)_86%,transparent)] shadow-[var(--shadow-2)] backdrop-blur-md";
/** Floating panels take input (the overlay layer itself does not). */
const floating = `pointer-events-auto ${glass}`;

/** Height kept under a fitted diagram for the floating controls bar. */
const CONTROLS_ROOM = 56;
/** Width of the floating beats panel (`w-72 max-w-[45%]`) and its margins. */
const beatsRoom = (width: number) => Math.min(288, width * 0.45) + 32;
const insetsBelow = (): FitInsets => ({ right: 0, bottom: CONTROLS_ROOM });
const insetsBeside = (width: number): FitInsets => ({
  right: beatsRoom(width),
  bottom: CONTROLS_ROOM,
});

/**
 * An interactive flow explorer. The diagram fills a resizable frame; the
 * beats (a list of chapters, paused by default) float over its right side
 * and can be hidden, and the controls, evidence and inspectors float over
 * its foot. Beat and frame stepping, optional playback at a chosen speed, an
 * arrangement selector (Before/After, or options A, B…) that keeps the beat, hover/focus on a part to inspect its state and
 * source refs, and click a card to follow it with a narrated caption. Every
 * control has a keyboard shortcut; beat captions and the followed card are
 * announced through a live region.
 */
export function FlowPlayer({
  flow,
  reducedMotion,
  onActivatePart,
  suspended = false,
}: FlowPlayerProps) {
  const names = flow.arrangements.map((a) => a.arrangement);
  const [selected, setSelected] = useState<ArrangementName>(() =>
    firstShown(flow)
  );
  const diagram =
    flow.arrangements.find((a) => a.arrangement === selected) ??
    flow.arrangements[0];
  const clock = useFlowClock(diagram.travel, { reducedMotion });
  const { morph, start: startMorph } = useArrangementMorph(clock.reducedMotion);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [followed, setFollowed] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [beatsShown, setBeatsShown] = useState(true);
  const chaptersId = useId();
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const hasBeats = diagram.beats.length > 0;
  const root = useRef<HTMLDivElement>(null);
  const playingHidden = suspended && clock.playing;
  useEffect(() => {
    if (playingHidden) clock.pause();
    // `clock` is a fresh object each render; only the hidden-and-playing edge matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingHidden]);

  const inspected = diagram.parts.find(
    (p) => p.id === (pinned ?? hovered) && p.presence !== "absent"
  );

  const interaction = useMemo<DiagramInteraction>(
    () => ({
      onActivatePart: (id) => {
        setPinned((p) => (p === id ? null : id));
        onActivatePart?.(id);
      },
      onInspectPart: setHovered,
      onActivateCard: (id) => setFollowed((f) => (f === id ? null : id)),
      activePart: pinned,
      followedCard: followed,
    }),
    [onActivatePart, pinned, followed]
  );

  // Announced once per beat: the caption, and where the followed card ends up.
  const announcement =
    clock.beat < 0
      ? ""
      : beatAnnouncement(
          diagram,
          clock.beat,
          followed
            ? narrateCard(
                flow,
                diagram,
                followed,
                beatOutcome(diagram.travel, clock.beat),
                clock.reducedMotion
              )
            : undefined
        );

  // Switching arrangement keeps the beat; with motion the marked parts
  // morph from the one being left, frozen where it was.
  const choose = (a: ArrangementName) => {
    if (a === diagram.arrangement) return;
    startMorph(diagram, clock.t);
    setSelected(a);
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || !root.current) return;
    const cmd = playerCommand(e.key, e);
    if (!cmd || leaveToTarget(e.target, root.current, e.key)) return;
    switch (cmd.kind) {
      case "toggle":
        clock.toggle();
        break;
      case "step":
        if (cmd.dir === 1) clock.stepForward();
        else clock.stepBack();
        break;
      case "frame":
        if (cmd.dir === 1) clock.frameForward();
        else clock.frameBack();
        break;
      case "seek":
        if (clock.beatCount === 0) return;
        clock.seek(cmd.beat < 0 ? clock.beatCount - 1 : cmd.beat);
        break;
      case "speed":
        clock.setSpeed(nextSpeed(clock.speed, cmd.dir));
        break;
      case "loop":
        clock.setLoop(!clock.loop);
        break;
      case "arrangement":
        if (names.length < 2) return;
        choose(cycleArrangement(names, diagram.arrangement, cmd.dir));
        break;
      case "beats":
        if (!hasBeats) return;
        setBeatsShown((b) => !b);
        break;
      case "clear":
        if (!followed && !pinned && !help) return;
        setFollowed(null);
        setPinned(null);
        setHelp(false);
        break;
      case "help":
        setHelp((h) => !h);
        break;
    }
    e.preventDefault();
  }

  const label = flow.title ? `Flow player: ${flow.title}` : "Flow player";

  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      aria-keyshortcuts={`Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End C${names.length > 1 ? " B Shift+B" : ""}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
      data-testid="flow-player"
      data-arrangement={diagram.arrangement}
      data-morph={
        morph ? `${morph.from.arrangement}→${diagram.arrangement}` : undefined
      }
      data-t={clock.t}
      data-beat={clock.beat}
      data-playing={clock.playing ? "true" : "false"}
      data-speed={clock.speed}
      data-loop={clock.loop ? "true" : "false"}
      data-following={followed ?? undefined}
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
        interaction={interaction}
        morph={morph}
        overlayRef={setOverlay}
        fitInsets={hasBeats && beatsShown ? insetsBeside : insetsBelow}
      />
      {overlay &&
        createPortal(
          <>
            {hasBeats && (
              <Chapters
                id={chaptersId}
                shown={beatsShown}
                diagram={diagram}
                clock={clock}
              />
            )}
            <div
              className={`pointer-events-none absolute bottom-4 flex max-h-[calc(100%-2rem)] flex-col items-start justify-end gap-2 overflow-y-auto ${
                hasBeats && beatsShown
                  ? "right-[calc(min(18rem,45%)+2rem)]"
                  : "right-4"
              }`}
              style={{ left: ZOOM_GUTTER }}
              data-testid="flow-bottom-panel"
            >
              {/* Inspectors sit above the rest: the stack is anchored at its
                  foot, so one opening on hover moves nothing under the pointer. */}
              {(inspected || followed) && (
                <div className="grid w-full max-w-3xl gap-2 sm:grid-cols-2">
                  {inspected && (
                    <PartInspector
                      diagram={diagram}
                      partId={inspected.id}
                      t={clock.t}
                      reducedMotion={clock.reducedMotion}
                      pinned={pinned === inspected.id}
                      flow={flow}
                      onFollow={setFollowed}
                    />
                  )}
                  {followed && (
                    <CardInspector
                      flow={flow}
                      cardId={followed}
                      onStop={() => setFollowed(null)}
                    />
                  )}
                </div>
              )}
              {help && <ShortcutHelp />}
              {followed && (
                <div
                  className={`${floating} flex max-w-xl items-center gap-2 px-3 py-1.5 text-sm text-fg`}
                  data-testid="flow-narration"
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]"
                    aria-hidden
                  />
                  <span>
                    {narrateCard(
                      flow,
                      diagram,
                      followed,
                      clock.t,
                      clock.reducedMotion
                    )}
                  </span>
                </div>
              )}
              {flow.attachments.length > 0 && (
                // Collapsed until asked for, like rail evidence: open, it
                // would cover a small diagram the whole time.
                <details
                  className={`${panel} max-w-xl`}
                  data-testid="flow-evidence"
                >
                  <summary className="cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
                    Flow evidence ({flow.attachments.length})
                  </summary>
                  <AttachmentPanel
                    attachments={flow.attachments}
                    label="Flow evidence"
                  />
                </details>
              )}
              {diagram.rails
                .filter(
                  (rail) =>
                    rail.presence !== "absent" && rail.attachments.length > 0
                )
                .map((rail) => (
                  <details key={rail.id} className={panel}>
                    <summary className="cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
                      Rail: {rail.label ?? rail.id}
                    </summary>
                    <AttachmentPanel
                      attachments={rail.attachments}
                      label={`Rail ${rail.label ?? rail.id} evidence`}
                    />
                  </details>
                ))}
              <div className={`${floating} max-w-full p-0.5`}>
                <Controls
                  clock={clock}
                  names={names}
                  labels={flow.labels}
                  arrangement={diagram.arrangement}
                  onArrangement={choose}
                  help={help}
                  onHelp={() => setHelp((h) => !h)}
                  beats={
                    hasBeats
                      ? {
                          shown: beatsShown,
                          controls: chaptersId,
                          onToggle: () => setBeatsShown((b) => !b),
                        }
                      : undefined
                  }
                />
              </div>
            </div>
          </>,
          overlay
        )}
      <div className="sr-only" aria-live="polite" data-testid="flow-announcer">
        {announcement}
        {inspected
          ? ` Inspecting ${inspected.identity.name}; ${inspected.attachments.length} evidence items.`
          : ""}
      </div>
    </div>
  );
}

/* ---------- chapters ---------- */

/**
 * The beats list. Hidden rather than unmounted when the reader hides it, so
 * `aria-controls` keeps a target; shown again, it brings the current beat
 * back into view.
 */
function Chapters({
  id,
  shown,
  diagram,
  clock,
}: {
  id: string;
  shown: boolean;
  diagram: DiagramTimeline;
  clock: FlowClock;
}) {
  const beats = diagram.beats;
  const list = useRef<HTMLOListElement>(null);

  // Keep the current beat in view inside the list, without scrolling the page.
  useEffect(() => {
    const ol = list.current;
    const li = ol?.children[clock.beat] as HTMLElement | undefined;
    if (!shown || !ol || !li) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < ol.scrollTop) ol.scrollTop = top;
    else if (bottom > ol.scrollTop + ol.clientHeight)
      ol.scrollTop = bottom - ol.clientHeight;
  }, [clock.beat, shown]);

  return (
    <div
      id={id}
      hidden={!shown}
      className={`${floating} absolute top-4 right-4 flex max-h-[calc(100%-2rem)] w-72 max-w-[45%] py-1.5`}
      data-testid="flow-chapters-panel"
    >
      <ol
        ref={list}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
        aria-label="Beats"
        data-testid="flow-chapters"
      >
        {beats.map((b, i) => {
          // Progress runs from the beat's start to its outcome, so a beat
          // resting on its outcome (always, under reduced motion) reads full.
          const span = beatOutcome(diagram.travel, i) - b.t;
          const current = i === clock.beat;
          const progress = current
            ? span > 0
              ? Math.max(0, Math.min(1, (clock.t - b.t) / span))
              : 1
            : i < clock.beat
              ? 1
              : 0;
          return (
            <li key={b.id ?? i}>
              <button
                type="button"
                className={`relative flex w-full items-start gap-2.5 py-1.5 pr-3 pl-3 text-left text-xs leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
                  current
                    ? "text-fg"
                    : i < clock.beat
                      ? "text-fg-soft hover:text-fg"
                      : "text-fg-mute hover:text-fg-soft"
                }`}
                aria-label={`Beat ${i + 1} of ${beats.length}: ${b.caption}${
                  b.changes.length
                    ? `. Changed steps: ${b.changes.map((c) => `${c.change} ${c.label}`).join("; ")}`
                    : ""
                }`}
                aria-current={current ? "step" : undefined}
                title={current ? undefined : b.caption}
                onClick={() => clock.playBeat(i)}
              >
                <span
                  className="absolute inset-y-0 left-0 w-0.5 origin-top bg-[var(--color-accent)]"
                  style={{ transform: `scaleY(${progress})` }}
                  data-testid="flow-beat-progress"
                  aria-hidden
                />
                <span
                  className={`w-4 shrink-0 text-right tabular-nums ${current ? "text-[var(--color-accent)]" : "text-fg-mute"}`}
                >
                  {i + 1}
                </span>
                {b.changes.length > 0 ? (
                  <span className="flex min-w-0 flex-col gap-1">
                    <span
                      className={current ? "min-w-0" : "min-w-0 line-clamp-2"}
                    >
                      {b.caption}
                    </span>
                    <StepMarks changes={b.changes} />
                  </span>
                ) : (
                  <span
                    className={current ? "min-w-0" : "min-w-0 line-clamp-2"}
                  >
                    {b.caption}
                  </span>
                )}
              </button>
              {current && (
                <AttachmentPanel
                  attachments={b.attachments}
                  label={`Beat ${i + 1} evidence`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STEP_GLYPH = { added: "+", changed: "~", removed: "−" } as const;

/**
 * Marked story steps of a beat, as tags that read without colour: + solid,
 * ~ outlined, − dashed and struck through (it does not run in this
 * arrangement, only in the baseline).
 */
function StepMarks({ changes }: { changes: readonly BeatChange[] }) {
  return (
    <span className="flex flex-wrap gap-1" data-testid="flow-step-marks">
      {changes.map((c, k) => (
        <span
          key={k}
          data-mark={c.change}
          className={`rounded-[var(--radius-sm,4px)] border px-1 font-mono text-[11px] leading-4 ${
            c.change === "added"
              ? "border-fg bg-fg text-bg"
              : c.change === "changed"
                ? "border-fg text-fg"
                : "border-dashed border-fg-mute text-fg-mute line-through"
          }`}
        >
          {STEP_GLYPH[c.change]} {c.label}
        </span>
      ))}
    </span>
  );
}

/* ---------- controls ---------- */

const ICONS = {
  prevBeat: (
    <>
      <path d="M6 5v14" />
      <path d="M18 6l-9 6 9 6z" fill="currentColor" />
    </>
  ),
  play: <path d="M8 5l11 7-11 7z" fill="currentColor" />,
  pause: (
    <>
      <path d="M9 5v14" strokeWidth={3} />
      <path d="M15 5v14" strokeWidth={3} />
    </>
  ),
  nextBeat: (
    <>
      <path d="M18 5v14" />
      <path d="M6 6l9 6-9 6z" fill="currentColor" />
    </>
  ),
  beats: (
    <>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01" strokeWidth={3} />
      <path d="M4 12h.01" strokeWidth={3} />
      <path d="M4 18h.01" strokeWidth={3} />
    </>
  ),
  loop: (
    <>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </>
  ),
};

function IconButton({
  label,
  keys,
  shortcut,
  icon,
  onClick,
  disabled,
  pressed,
  expanded,
  controls,
}: {
  label: string;
  keys: string;
  shortcut: string;
  icon: keyof typeof ICONS;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** A disclosure toggle: what it shows and whether it is showing. */
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={
        pressed
          ? "!px-1.5 !bg-[var(--color-accent-wash)] !text-[var(--color-accent)]"
          : "!px-1.5"
      }
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      title={`${label} (${keys})`}
    >
      <Icon size="sm">{ICONS[icon]}</Icon>
    </Button>
  );
}

function Controls({
  clock,
  names,
  labels,
  arrangement,
  onArrangement,
  help,
  onHelp,
  beats,
}: {
  clock: FlowClock;
  names: readonly ArrangementName[];
  labels: Readonly<Record<ArrangementName, string>>;
  arrangement: ArrangementName;
  onArrangement: (a: ArrangementName) => void;
  help: boolean;
  onHelp: () => void;
  /** The beats list toggle; absent when the flow has no beats. */
  beats?: { shown: boolean; controls: string; onToggle: () => void };
}) {
  const noBeats = clock.beatCount === 0;
  const nextSpeedUp =
    SPEEDS[(SPEEDS.findIndex((v) => v === clock.speed) + 1) % SPEEDS.length];
  // Frame stepping stays on the keyboard (, . and ⇧←/⇧→), listed in the help.
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <IconButton
        label="Previous beat"
        keys="←"
        shortcut="ArrowLeft"
        icon="prevBeat"
        onClick={clock.stepBack}
        disabled={noBeats}
      />
      <IconButton
        label={clock.playing ? "Pause" : "Play"}
        keys="Space"
        shortcut="Space"
        icon={clock.playing ? "pause" : "play"}
        onClick={clock.toggle}
      />
      <IconButton
        label="Next beat"
        keys="→"
        shortcut="ArrowRight"
        icon="nextBeat"
        onClick={clock.stepForward}
        disabled={noBeats}
      />
      {clock.beatCount > 0 && (
        <span
          className="px-1.5 text-xs tabular-nums text-fg-soft"
          data-testid="flow-beat-count"
        >
          {Math.max(0, clock.beat) + 1}
          <span className="text-fg-mute"> / {clock.beatCount}</span>
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="!px-1.5 text-xs tabular-nums"
        onClick={() => clock.setSpeed(nextSpeedUp)}
        aria-label={`Speed ${speedLabel(clock.speed)}`}
        aria-keyshortcuts="+ -"
        title={`Speed: click for ${speedLabel(nextSpeedUp)} (− / +)`}
        data-testid="flow-speed"
      >
        {speedLabel(clock.speed)}
      </Button>
      <IconButton
        label="Loop"
        keys={clock.loop ? "L · on: play loops" : "L · off: play once"}
        shortcut="L"
        icon="loop"
        onClick={() => clock.setLoop(!clock.loop)}
        pressed={clock.loop}
      />
      {names.length > 1 && (
        <>
          <Divider />
          <SegmentedControl
            ariaLabel="Arrangement"
            options={names.map((n) => ({
              value: n,
              label: labels[n] ?? n,
            }))}
            value={arrangement}
            onChange={onArrangement}
          />
        </>
      )}
      <Divider />
      {beats && (
        <IconButton
          label={beats.shown ? "Hide beats" : "Show beats"}
          keys="C"
          shortcut="C"
          icon="beats"
          onClick={beats.onToggle}
          expanded={beats.shown}
          controls={beats.controls}
        />
      )}
      <Button
        size="sm"
        variant="ghost"
        className="!px-2"
        onClick={onHelp}
        aria-label="Keyboard shortcuts"
        aria-expanded={help}
        aria-keyshortcuts="?"
        title="Keyboard shortcuts (?)"
      >
        ?
      </Button>
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-[var(--color-line)]" aria-hidden />;
}

function ShortcutHelp() {
  return (
    <dl
      className={`${floating} grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 px-3 py-2 text-xs`}
      aria-label="Keyboard shortcuts"
      data-testid="flow-shortcuts"
    >
      {PLAYER_SHORTCUTS.map(([keys, what]) => (
        <div key={keys} className="contents">
          <dt className="font-mono text-fg">{keys}</dt>
          <dd className="text-fg-mute">{what}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- inspectors ---------- */

const panel = `${floating} min-w-0 px-3 py-2 text-xs`;
/**
 * A part inspector shown only while its part is hovered or focused: it lets
 * the pointer through, so where it covers the diagram it cannot take the
 * hover from the part that opened it. Pinned, it takes input.
 */
const passing = `pointer-events-none ${glass} min-w-0 px-3 py-2 text-xs`;

function PartInspector({
  flow,
  diagram,
  partId,
  t,
  reducedMotion,
  pinned,
  onFollow,
}: {
  flow: CompiledFlow;
  diagram: DiagramTimeline;
  partId: string;
  t: number;
  reducedMotion: boolean;
  pinned: boolean;
  onFollow: (id: string) => void;
}) {
  const part = diagram.parts.find((p) => p.id === partId)!;
  const status = partStatusAt(part, t, reducedMotion);
  const inside = cardsInPart(part, t);
  return (
    <section
      className={pinned ? panel : passing}
      aria-label={`Part ${part.identity.name}`}
      data-testid="flow-part-inspector"
      data-part-id={part.id}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-fg">
          {part.identity.name}
        </span>
        <span className="truncate text-fg-mute">{part.identity.job}</span>
        {pinned && (
          <span className="ml-auto text-[var(--color-accent)]">pinned</span>
        )}
      </div>
      {part.change !== "unchanged" && (
        <div className="text-fg-mute">
          {part.change}
          {part.changeNote ? ` · ${part.changeNote}` : ""}
        </div>
      )}
      <div
        className="mt-1 flex items-center gap-1.5"
        data-testid="flow-part-state"
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: roleColor(status.role) }}
          aria-hidden
        />
        <span className="text-fg-mute">now</span>
        <span className="font-mono text-fg">{status.text}</span>
      </div>
      {inside.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-fg-mute">holding</span>
          {inside.map((id) => (
            <button
              key={id}
              type="button"
              className="rounded border border-[var(--color-line-strong)] px-1.5 font-mono text-fg hover:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              onClick={() => onFollow(id)}
              aria-label={`Follow card ${cardLabel(flow, id)}`}
            >
              {cardLabel(flow, id)}
            </button>
          ))}
        </div>
      )}
      <AttachmentPanel attachments={part.attachments} />
    </section>
  );
}

function payloadValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function CardInspector({
  flow,
  cardId,
  onStop,
}: {
  flow: CompiledFlow;
  cardId: string;
  onStop: () => void;
}) {
  const card = flow.cards[cardId];
  const payload = card?.payload;
  return (
    <section
      className={panel}
      aria-label={`Card ${cardLabel(flow, cardId)}`}
      data-testid="flow-card-inspector"
      data-card-id={cardId}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-fg">
          {cardLabel(flow, cardId)}
        </span>
        {card && <span className="text-fg-mute">{card.token}</span>}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto !h-5 !px-1.5"
          onClick={onStop}
          aria-keyshortcuts="Escape"
          title="Stop following (Esc)"
        >
          Stop following
        </Button>
      </div>
      <AttachmentPanel attachments={card?.attachments ?? []} />
      {payload ? (
        <dl
          className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
          data-testid="flow-card-payload"
        >
          <dt className="text-fg-mute">{payload.type}</dt>
          <dd className="break-words font-mono text-fg">
            {payloadValue(payload.value)}
          </dd>
          {payload.eventTime !== undefined && (
            <>
              <dt className="text-fg-mute">event time</dt>
              <dd className="font-mono text-fg">{String(payload.eventTime)}</dd>
            </>
          )}
          {Object.entries(payload.fields ?? {}).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-mute">{k}</dt>
              <dd className="break-words font-mono text-fg">
                {payloadValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="mt-1 text-fg-mute">no payload</div>
      )}
    </section>
  );
}
