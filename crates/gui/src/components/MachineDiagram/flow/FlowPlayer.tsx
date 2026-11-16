import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button, Icon } from "../../atoms";
import { SegmentedControl } from "../../molecules";
import type { DiagramInteraction } from "../interaction";
import { type FitInsets, ZOOM_GUTTER } from "../MachineDiagramViewport";
import { roleColor } from "../palette";
import { beatOutcome, nextSpeed, SPEEDS } from "./clockModel";
import type {
  BeatChange,
  CompiledBeat,
  CompiledFlow,
  DiagramTimeline,
} from "./compile";
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
import { useReducedMotion } from "../useReducedMotion";
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

/**
 * The arrangement shown first: the first one marked against the baseline
 * (After, option A); for phases the first phase, where the story starts.
 */
const firstShown = (flow: CompiledFlow): ArrangementName =>
  (
    (!flow.phased &&
      flow.arrangements.find((a) => a.arrangement !== flow.baseline)) ||
    flow.arrangements[0]
  ).arrangement;

/** The phase beat `i` is in (the first beat's before it starts; `fallback` without beats). */
const phaseAt = (
  d: DiagramTimeline,
  i: number,
  fallback: ArrangementName
): ArrangementName => d.beats[Math.max(0, i)]?.phase ?? fallback;

/** Index of the first beat of `phase` on `d`, or -1. */
const firstBeatOf = (d: DiagramTimeline, phase: ArrangementName) =>
  d.beats.findIndex((b) => b.phase === phase);

const speedLabel = (s: number) => `${s}×`;

/** A borderless glass card laid on the diagram, sized to its content. */
const glass =
  "rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--color-bg-1)_86%,transparent)] shadow-[var(--shadow-2)] backdrop-blur-md";
/** Floating panels take input (the overlay layer itself does not). */
const floating = `pointer-events-auto ${glass}`;

/** Height kept under a fitted diagram for the floating transport. */
const CONTROLS_ROOM = 56;
/** The beat hairline over the transport, with its gap. */
const HAIRLINE_ROOM = 28;
/** The beat note over the hairline: two caption lines, a phase line, step marks. */
const NOTE_ROOM = 100;
const insets = (bottom: number) => (): FitInsets => ({ right: 0, bottom });
const insetsBare = insets(CONTROLS_ROOM);
const insetsRail = insets(CONTROLS_ROOM + HAIRLINE_ROOM);
const insetsNote = insets(CONTROLS_ROOM + HAIRLINE_ROOM + NOTE_ROOM);

/** Width of the centred note and hairline (`max-w-[32rem]`). */
const STAGE_WIDTH = 512;
/** Narrowest evidence column worth showing beside the centred stage. */
const MIN_SIDE = 200;
/** Widest the evidence column grows on a wide frame. */
const MAX_SIDE = 360;
/**
 * Room left of the centred stage for the evidence column on a frame `width`
 * wide, or null when the frame is too narrow and evidence folds into the
 * transport. An unmeasured frame (0) gets a default column.
 */
function sideRoom(width: number): number | null {
  if (width <= 0) return 288;
  const side = (width - ZOOM_GUTTER - 16 - STAGE_WIDTH) / 2 - 16;
  return side < MIN_SIDE ? null : Math.min(MAX_SIDE, side);
}

/** Tracks an element's width; 0 until measured (and where there is no layout). */
function useWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

/**
 * An interactive flow explorer. The diagram fills a resizable frame; a
 * player floats centred over its foot: the transport, a hairline with one
 * dot per beat over it (paused by default), and the current beat's note over
 * that, which can be hidden. Evidence and inspectors float bottom-left, or
 * fold into the transport on a narrow frame; nothing floats on the right,
 * where the changes view opens. Beat and frame stepping, optional playback at a chosen speed, an
 * arrangement selector (Before/After, or options A, B…) that keeps the beat
 * — or, for a migration told in phases, a phase strip, the story itself
 * moving the diagram from phase to phase —, hover/focus on a part to inspect its state and
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
  const phased = flow.phased;
  const [selected, setSelected] = useState<ArrangementName>(() =>
    firstShown(flow)
  );
  const diagram =
    flow.arrangements.find((a) => a.arrangement === selected) ??
    flow.arrangements[0];
  const prefersReduced = useReducedMotion();
  const { morph, start: startMorph } = useArrangementMorph(
    reducedMotion ?? prefersReduced
  );
  // A phase morph plays before the beat's steps: playback holds meanwhile.
  const clock = useFlowClock(diagram.travel, {
    reducedMotion,
    phased,
    held: phased && morph !== undefined,
  });
  // With phases the story picks the arrangement: crossing into a beat of
  // another phase (playing, stepping, seeking, looping) morphs once to it,
  // and the clock keeps its place in the beat (see `retarget`).
  const phase = phased
    ? phaseAt(diagram, clock.beat, diagram.arrangement)
    : diagram.arrangement;
  if (phase !== diagram.arrangement) {
    startMorph(diagram, clock.t);
    setSelected(phase);
  }
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [followed, setFollowed] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [noteShown, setNoteShown] = useState(true);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const noteId = useId();
  const evidenceId = useId();
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const side = sideRoom(useWidth(overlay));
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

  // Announced once per beat: the phase, the caption, and where the followed card ends up.
  const phaseNote =
    phased && clock.beat >= 0
      ? `Phase ${names.indexOf(phase) + 1} of ${names.length}: ${flow.labels[phase] ?? phase}. `
      : "";
  const announcement =
    clock.beat < 0
      ? ""
      : phaseNote +
        beatAnnouncement(
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
  // A phase is reached through the story: seek to its first beat.
  const seekPhase = (a: ArrangementName) => {
    const i = firstBeatOf(diagram, a);
    if (i >= 0) clock.seek(i);
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
        (phased ? seekPhase : choose)(
          cycleArrangement(names, diagram.arrangement, cmd.dir)
        );
        break;
      case "beats":
        if (!hasBeats) return;
        setNoteShown((b) => !b);
        break;
      case "clear":
        if (!followed && !pinned && !help && !evidenceOpen) return;
        setFollowed(null);
        setPinned(null);
        setHelp(false);
        setEvidenceOpen(false);
        break;
      case "help":
        setHelp((h) => !h);
        break;
    }
    e.preventDefault();
  }

  const label = flow.title ? `Flow player: ${flow.title}` : "Flow player";

  const phaseLabel =
    phased && names.length > 1
      ? `Phase ${names.indexOf(phase) + 1} of ${names.length} · ${flow.labels[phase] ?? phase}`
      : undefined;
  const narration = followed
    ? narrateCard(flow, diagram, followed, clock.t, clock.reducedMotion)
    : undefined;

  const inspectors = (inspected || followed) && (
    <div
      className={
        side === null
          ? "grid w-full max-w-3xl gap-2 sm:grid-cols-2"
          : "flex w-full flex-col gap-2"
      }
    >
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
  );

  const railsWithEvidence = diagram.rails.filter(
    (rail) => rail.presence !== "absent" && rail.attachments.length > 0
  );
  const evidenceCount =
    flow.attachments.length +
    railsWithEvidence.reduce((n, rail) => n + rail.attachments.length, 0);
  const evidence = evidenceCount > 0 && (
    <>
      {flow.attachments.length > 0 && (
        // Collapsed until asked for, like rail evidence: open, it
        // would cover a small diagram the whole time.
        <Fold
          className={`${panel} max-w-xl`}
          label="Flow evidence"
          count={flow.attachments.length}
          testId="flow-evidence"
        >
          <AttachmentPanel
            attachments={flow.attachments}
            label="Flow evidence"
          />
        </Fold>
      )}
      {railsWithEvidence.map((rail) => (
        <Fold
          key={rail.id}
          className={panel}
          label={`Rail: ${rail.label ?? rail.id}`}
          count={rail.attachments.length}
        >
          <AttachmentPanel
            attachments={rail.attachments}
            label={`Rail ${rail.label ?? rail.id} evidence`}
          />
        </Fold>
      ))}
    </>
  );

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
      data-phased={phased ? "true" : undefined}
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
        fitInsets={!hasBeats ? insetsBare : noteShown ? insetsNote : insetsRail}
      />
      {overlay &&
        createPortal(
          <>
            {side !== null && (inspectors || evidence) && (
              <div
                className="pointer-events-none absolute bottom-4 flex max-h-[calc(100%-2rem)] flex-col items-start justify-end gap-2 overflow-y-auto"
                style={{ left: ZOOM_GUTTER, width: side }}
                data-testid="flow-side-panel"
              >
                {/* Inspectors sit above the evidence: the stack is anchored
                    at its foot, so one opening on hover moves nothing under
                    the pointer. */}
                {inspectors}
                {evidence}
              </div>
            )}
            <div
              className="pointer-events-none absolute right-4 bottom-4 flex max-h-[calc(100%-2rem)] flex-col items-center justify-end gap-2"
              style={{ left: ZOOM_GUTTER }}
              data-testid="flow-bottom-panel"
            >
              {side === null && inspectors}
              {/* One card: note, hairline, transport. Popovers rise over it. */}
              <div
                className={`${floating} relative flex flex-col items-center ${
                  hasBeats || narration ? "w-full max-w-[32rem]" : "max-w-full"
                }`}
                data-testid="flow-player-card"
              >
                {(hasBeats || narration) && (
                  <BeatNote
                    id={noteId}
                    shown={noteShown}
                    beats={diagram.beats}
                    index={clock.beat}
                    phase={phaseLabel}
                    narration={narration}
                  />
                )}
                {hasBeats && <BeatRail diagram={diagram} clock={clock} />}
                {help && (
                  <div className="absolute right-0 bottom-full mb-2">
                    <ShortcutHelp />
                  </div>
                )}
                {side === null && evidence && (
                  <div
                    id={evidenceId}
                    hidden={!evidenceOpen}
                    className="absolute bottom-full left-1/2 mb-2 flex w-max max-w-[min(28rem,80vw)] -translate-x-1/2 flex-col items-stretch gap-2"
                    data-testid="flow-evidence-popover"
                  >
                    {evidence}
                  </div>
                )}
                <div className="max-w-full p-0.5" data-testid="flow-transport">
                  <Controls
                    clock={clock}
                    names={phased ? [] : names}
                    labels={flow.labels}
                    arrangement={diagram.arrangement}
                    onArrangement={choose}
                    help={help}
                    onHelp={() => setHelp((h) => !h)}
                    note={
                      hasBeats
                        ? {
                            shown: noteShown,
                            controls: noteId,
                            onToggle: () => setNoteShown((b) => !b),
                          }
                        : undefined
                    }
                    evidence={
                      side === null && evidence
                        ? {
                            count: evidenceCount,
                            open: evidenceOpen,
                            controls: evidenceId,
                            onToggle: () => setEvidenceOpen((o) => !o),
                          }
                        : undefined
                    }
                  />
                </div>
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

/* ---------- beat note and hairline ---------- */
/**
 * The current beat's note, centred over the hairline: its phase, number and
 * caption (two lines kept for it, clamped; whole on hover or focus), its
 * marked steps and its evidence. A followed card's narration is a second
 * row. Hidden rather than unmounted when the reader hides it, so
 * `aria-controls` keeps a target.
 */
function BeatNote({
  id,
  shown,
  beats,
  index,
  phase,
  narration,
}: {
  id: string;
  shown: boolean;
  beats: readonly CompiledBeat[];
  index: number;
  phase?: string;
  narration?: string;
}) {
  const i = Math.max(0, index);
  const beat = beats[i];
  const showsBeat = !!beat && shown;
  return (
    <div
      className="group w-full px-3 pt-2.5 text-xs"
      hidden={!showsBeat && !narration}
      data-testid="flow-note-card"
    >
      {beat && (
        <div id={id} hidden={!shown} data-testid="flow-beat-note">
          {phase && (
            <div
              className="mb-0.5 text-center text-[11px] text-fg-mute"
              data-testid="flow-note-phase"
            >
              {phase}
            </div>
          )}
          <p
            className="flex min-h-[2lh] items-center justify-center text-center leading-snug text-fg"
            title={beat.caption}
          >
            <span className="line-clamp-2 group-hover:line-clamp-none group-focus-within:line-clamp-none">
              <span className="mr-1.5 font-mono tabular-nums text-fg-mute">
                {i + 1}
              </span>
              <span data-testid="flow-note-caption">{beat.caption}</span>
            </span>
          </p>
          {beat.changes.length > 0 && (
            <div className="mt-1.5 flex justify-center">
              <StepMarks changes={beat.changes} />
            </div>
          )}
          {beat.attachments.length > 0 && (
            // Keyed by beat: a new beat opens with its evidence folded.
            <Fold
              key={i}
              className="mx-auto mt-1.5 w-max max-w-full"
              label="Evidence"
              count={beat.attachments.length}
              testId="flow-beat-evidence"
            >
              <AttachmentPanel
                attachments={beat.attachments}
                label={`Beat ${i + 1} evidence`}
              />
            </Fold>
          )}
        </div>
      )}
      {narration && (
        <div
          className={`flex items-center justify-center gap-2 text-sm text-fg ${
            showsBeat ? "mt-2 border-t border-[var(--color-line)] pt-2" : ""
          }`}
          data-testid="flow-narration"
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg-soft"
            aria-hidden
          />
          <span>{narration}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The story as a hairline: one dot per beat, placed by its start across the
 * period (each segment at least `min-w-4`), phases as gaps. Played dots
 * are small and filled, the current one large and ringed, those ahead
 * hollow; the line fills from a beat's start to its outcome. A dot plays its
 * beat; hovering or focusing another shows its caption above it.
 */
function BeatRail({
  diagram,
  clock,
}: {
  diagram: DiagramTimeline;
  clock: FlowClock;
}) {
  const beats = diagram.beats;
  const [peek, setPeek] = useState<number | null>(null);
  const period = diagram.period;
  const unpeek = (i: number) => setPeek((p) => (p === i ? null : p));
  return (
    <ol
      className="flex h-6 w-full items-center px-5"
      aria-label="Beats"
      data-testid="flow-beats"
    >
      {beats.map((b, i) => {
        const next = i + 1 < beats.length ? beats[i + 1].t : period;
        // Progress runs from the beat's start to its outcome: a beat just
        // landed on reads empty, one played out (always, under reduced
        // motion) reads full.
        const span = beatOutcome(diagram.travel, i) - b.t;
        const current = i === clock.beat;
        const played = i < clock.beat;
        const progress = current
          ? span > 0
            ? Math.max(0, Math.min(1, (clock.t - b.t) / span))
            : 1
          : played
            ? 1
            : 0;
        const at = period > 0 ? b.t / period : i / beats.length;
        const align =
          at < 0.25
            ? "left-0"
            : at > 0.75
              ? "left-0 -translate-x-full"
              : "left-0 -translate-x-1/2";
        const phaseStart = i > 0 && b.phase !== beats[i - 1].phase;
        return (
          <li
            key={b.id ?? i}
            className={`relative flex h-full min-w-4 items-center ${phaseStart ? "ml-4" : ""}`}
            style={{ flex: `${Math.max(0, next - b.t)} 1 0px` }}
            data-beat-index={i}
            data-phase={b.phase}
            data-phase-start={phaseStart ? "true" : undefined}
          >
            <span
              className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-line-strong)]"
              aria-hidden
            />
            <span
              className="absolute inset-x-0 top-1/2 -mt-px h-0.5 origin-left bg-[var(--color-accent)]"
              style={{ transform: `scaleX(${progress})` }}
              data-testid="flow-beat-progress"
              aria-hidden
            />
            <button
              type="button"
              className="group/dot absolute top-1/2 left-0 z-[1] flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              aria-label={`Beat ${i + 1} of ${beats.length}: ${b.caption}${
                b.changes.length
                  ? `. Changed steps: ${b.changes.map((c) => `${c.change} ${c.label}`).join("; ")}`
                  : ""
              }`}
              aria-current={current ? "step" : undefined}
              data-state={current ? "current" : played ? "played" : "ahead"}
              onClick={() => clock.playBeat(i)}
              onMouseEnter={() => setPeek(i)}
              onMouseLeave={() => unpeek(i)}
              onFocus={() => setPeek(i)}
              onBlur={() => unpeek(i)}
            >
              <span
                className={`block rounded-full transition-transform group-hover/dot:scale-125 ${
                  current
                    ? "h-2.5 w-2.5 bg-[var(--color-accent)] ring-2 ring-[var(--color-accent-wash)]"
                    : played
                      ? "h-1.5 w-1.5 bg-fg-soft"
                      : "h-2 w-2 border border-fg-mute bg-[var(--color-bg-1)]"
                }`}
                aria-hidden
              />
            </button>
            {peek === i && !current && (
              <span
                role="tooltip"
                className={`pointer-events-none absolute bottom-full z-[2] mb-2 w-max max-w-64 rounded-[var(--radius-md)] bg-[var(--color-bg-2)] px-2 py-1 text-xs leading-snug text-fg shadow-[var(--shadow-2)] ${align}`}
                data-testid="flow-beat-peek"
              >
                <span className="mr-1.5 tabular-nums text-fg-mute">
                  {i + 1}
                </span>
                {b.caption}
              </span>
            )}
            {i === beats.length - 1 && (
              // The story's end: the line closes on a dot, not a cut.
              <span
                className={`absolute top-1/2 right-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 rounded-full ${
                  progress >= 1 && clock.t >= period
                    ? "bg-fg-soft"
                    : "border border-fg-mute bg-[var(--color-bg-1)]"
                }`}
                data-testid="flow-beat-end"
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
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
    <span
      className="flex flex-wrap justify-center gap-1"
      data-testid="flow-step-marks"
    >
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

/**
 * A folded evidence group: a quiet chevron, its name and a mono count, in
 * place of the browser's disclosure triangle.
 */
function Fold({
  className,
  label,
  count,
  testId,
  children,
}: {
  className?: string;
  label: string;
  count: number;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <details className={`group/fold ${className ?? ""}`} data-testid={testId}>
      <summary className="flex w-max cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-sm,4px)] text-fg-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3 shrink-0 text-fg-mute transition-transform group-open/fold:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span>{label}</span>
        <span className="font-mono tabular-nums text-fg-mute">{count}</span>
      </summary>
      {children}
    </details>
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
  note: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10h10" />
      <path d="M7 14h6" />
    </>
  ),
  evidence: (
    <>
      <path d="M8 3h8l4 4v14H8z" />
      <path d="M16 3v4h4" />
      <path d="M4 7v14h10" />
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
  note,
  evidence,
}: {
  clock: FlowClock;
  names: readonly ArrangementName[];
  labels: Readonly<Record<ArrangementName, string>>;
  arrangement: ArrangementName;
  onArrangement: (a: ArrangementName) => void;
  help: boolean;
  onHelp: () => void;
  /** The beat note toggle; absent when the flow has no beats. */
  note?: { shown: boolean; controls: string; onToggle: () => void };
  /** Flow and rail evidence folded into the transport on a narrow frame. */
  evidence?: {
    count: number;
    open: boolean;
    controls: string;
    onToggle: () => void;
  };
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
      {note && (
        <IconButton
          label={note.shown ? "Hide beat note" : "Show beat note"}
          keys="C"
          shortcut="C"
          icon="note"
          onClick={note.onToggle}
          expanded={note.shown}
          controls={note.controls}
        />
      )}
      {evidence && (
        <Button
          size="sm"
          variant="ghost"
          className={`!gap-1 !px-1.5 text-xs tabular-nums ${
            evidence.open
              ? "!bg-[var(--color-accent-wash)] !text-[var(--color-accent)]"
              : ""
          }`}
          onClick={evidence.onToggle}
          aria-label={`Evidence (${evidence.count})`}
          aria-expanded={evidence.open}
          aria-controls={evidence.controls}
          title="Flow and rail evidence"
          iconLeft={<Icon size="sm">{ICONS.evidence}</Icon>}
          data-testid="flow-evidence-toggle"
        >
          {evidence.count}
        </Button>
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
