import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button, Icon } from "../../atoms";
import { SegmentedControl } from "../../molecules";
import type { DiagramInteraction } from "../interaction";
import { roleColor } from "../palette";
import { beatOutcome, nextSpeed, SPEEDS } from "./clockModel";
import type { CompiledFlow, DiagramTimeline } from "./compile";
import { AttachmentPanel } from "./AttachmentPanel";
import { FlowDiagram } from "./FlowDiagram";
import { leaveToTarget, playerCommand, PLAYER_SHORTCUTS } from "./playerKeys";
import type { ArrangementName } from "./spec";
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
}

const ARRANGEMENT_LABELS: Record<ArrangementName, string> = {
  before: "Before",
  after: "After",
  current: "Current",
};

const speedLabel = (s: number) => `${s}×`;

/**
 * An interactive flow explorer: beats as a list of chapters beside the
 * diagram (below it in a narrow container; paused by default), beat
 * and frame stepping, optional playback at a chosen speed, a Before/After
 * toggle that keeps the beat, hover/focus on a part to inspect its state and
 * source refs, and click a card to follow it with a narrated caption. Every
 * control has a keyboard shortcut; beat captions and the followed card are
 * announced through a live region.
 */
export function FlowPlayer({
  flow,
  reducedMotion,
  onActivatePart,
}: FlowPlayerProps) {
  const names = flow.arrangements.map((a) => a.arrangement);
  const [selected, setSelected] = useState<ArrangementName>(
    names[names.length - 1]
  );
  const diagram =
    flow.arrangements.find((a) => a.arrangement === selected) ??
    flow.arrangements[0];
  const clock = useFlowClock(diagram.travel, { reducedMotion });
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [followed, setFollowed] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  const toggleArrangement = () => {
    if (names.length !== 2) return;
    setSelected(names[0] === diagram.arrangement ? names[1] : names[0]);
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
        if (names.length !== 2) return;
        toggleArrangement();
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
      aria-keyshortcuts="Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="@container flex flex-col gap-2 rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
      data-testid="flow-player"
      data-arrangement={diagram.arrangement}
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
      <div className="flex flex-col gap-3 @2xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <FlowDiagram
            diagram={diagram}
            t={clock.t}
            label={
              flow.title ? `${flow.title} · ${diagram.arrangement}` : undefined
            }
            reducedMotion={clock.reducedMotion}
            interaction={interaction}
          />
          <Controls
            clock={clock}
            names={names}
            arrangement={diagram.arrangement}
            onArrangement={setSelected}
            help={help}
            onHelp={() => setHelp((h) => !h)}
          />
          {help && <ShortcutHelp />}
          {followed && (
            <div
              className="flex items-center gap-2 text-sm text-fg"
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
          <AttachmentPanel
            attachments={flow.attachments}
            label="Flow evidence"
          />
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
          {(inspected || followed) && (
            <div className="grid gap-2 sm:grid-cols-2">
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
        </div>
        {diagram.beats.length > 0 && (
          <Chapters diagram={diagram} clock={clock} />
        )}
      </div>
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

function Chapters({
  diagram,
  clock,
}: {
  diagram: DiagramTimeline;
  clock: FlowClock;
}) {
  const beats = diagram.beats;
  const period = diagram.travel.period;
  const list = useRef<HTMLOListElement>(null);

  // Keep the current beat in view inside the list, without scrolling the page.
  useEffect(() => {
    const ol = list.current;
    const li = ol?.children[clock.beat] as HTMLElement | undefined;
    if (!ol || !li) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < ol.scrollTop) ol.scrollTop = top;
    else if (bottom > ol.scrollTop + ol.clientHeight)
      ol.scrollTop = bottom - ol.clientHeight;
  }, [clock.beat]);

  return (
    <div className="relative @2xl:min-h-96 @2xl:w-72 @2xl:shrink-0">
      <ol
        ref={list}
        className="relative flex max-h-72 flex-col gap-1 overflow-y-auto @2xl:absolute @2xl:inset-0 @2xl:max-h-none"
        aria-label="Beats"
        data-testid="flow-chapters"
      >
        {beats.map((b, i) => {
          const end = i + 1 < beats.length ? beats[i + 1].t : period;
          const span = Math.max(0.1, end - b.t);
          const current = i === clock.beat;
          const progress = current
            ? Math.max(0, Math.min(1, (clock.t - b.t) / span))
            : i < clock.beat
              ? 1
              : 0;
          return (
            <li key={b.id ?? i}>
              <button
                type="button"
                className={`relative flex w-full items-start gap-2 overflow-hidden rounded-[var(--radius-sm,4px)] border py-1.5 pr-2 pl-3 text-left text-xs leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                  current
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-fg"
                    : i < clock.beat
                      ? "border-[var(--color-line)] bg-[var(--color-bg-1)] text-fg-soft hover:border-[var(--color-line-strong)]"
                      : "border-[var(--color-line)] bg-[var(--color-bg-1)] text-fg-mute hover:border-[var(--color-line-strong)] hover:text-fg-soft"
                }`}
                aria-label={`Beat ${i + 1} of ${beats.length}: ${b.caption}`}
                aria-current={current ? "step" : undefined}
                title={current ? undefined : b.caption}
                onClick={() => clock.playBeat(i)}
              >
                <span
                  className="absolute inset-y-0 left-0 w-0.5 origin-top bg-[var(--color-accent)]"
                  style={{ transform: `scaleY(${progress})` }}
                  aria-hidden
                />
                <span className="w-4 shrink-0 text-right font-mono text-fg-mute">
                  {i + 1}
                </span>
                <span className={current ? "min-w-0" : "min-w-0 line-clamp-2"}>
                  {b.caption}
                </span>
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

/* ---------- controls ---------- */

const ICONS = {
  prevBeat: (
    <>
      <path d="M6 5v14" />
      <path d="M18 6l-9 6 9 6z" fill="currentColor" />
    </>
  ),
  prevFrame: <path d="M15 6l-6 6 6 6" />,
  play: <path d="M8 5l11 7-11 7z" fill="currentColor" />,
  pause: (
    <>
      <path d="M9 5v14" strokeWidth={3} />
      <path d="M15 5v14" strokeWidth={3} />
    </>
  ),
  nextFrame: <path d="M9 6l6 6-6 6" />,
  nextBeat: (
    <>
      <path d="M18 5v14" />
      <path d="M6 6l9 6-9 6z" fill="currentColor" />
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
}: {
  label: string;
  keys: string;
  shortcut: string;
  icon: keyof typeof ICONS;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
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
      title={`${label} (${keys})`}
    >
      <Icon size="sm">{ICONS[icon]}</Icon>
    </Button>
  );
}

function Controls({
  clock,
  names,
  arrangement,
  onArrangement,
  help,
  onHelp,
}: {
  clock: FlowClock;
  names: readonly ArrangementName[];
  arrangement: ArrangementName;
  onArrangement: (a: ArrangementName) => void;
  help: boolean;
  onHelp: () => void;
}) {
  const noBeats = clock.beatCount === 0;
  const frameNote = clock.reducedMotion ? " (a beat with reduced motion)" : "";
  return (
    <div className="flex flex-wrap items-center gap-1">
      <IconButton
        label="Previous beat"
        keys="←"
        shortcut="ArrowLeft"
        icon="prevBeat"
        onClick={clock.stepBack}
        disabled={noBeats}
      />
      <IconButton
        label={`Previous frame${frameNote}`}
        keys=", or ⇧←"
        shortcut="Shift+ArrowLeft"
        icon="prevFrame"
        onClick={clock.frameBack}
      />
      <IconButton
        label={clock.playing ? "Pause" : "Play"}
        keys="Space"
        shortcut="Space"
        icon={clock.playing ? "pause" : "play"}
        onClick={clock.toggle}
      />
      <IconButton
        label={`Next frame${frameNote}`}
        keys=". or ⇧→"
        shortcut="Shift+ArrowRight"
        icon="nextFrame"
        onClick={clock.frameForward}
      />
      <IconButton
        label="Next beat"
        keys="→"
        shortcut="ArrowRight"
        icon="nextBeat"
        onClick={clock.stepForward}
        disabled={noBeats}
      />
      <IconButton
        label="Loop"
        keys={clock.loop ? "L · on: play loops" : "L · off: play once"}
        shortcut="L"
        icon="loop"
        onClick={() => clock.setLoop(!clock.loop)}
        pressed={clock.loop}
      />
      {clock.beatCount > 0 && (
        <span className="ml-1 font-mono text-xs text-fg-mute">
          beat {Math.max(0, clock.beat) + 1}/{clock.beatCount}
        </span>
      )}
      <SegmentedControl
        className="ml-2"
        ariaLabel="Speed"
        options={SPEEDS.map((s) => ({
          value: String(s),
          label: speedLabel(s),
        }))}
        value={String(clock.speed)}
        onChange={(v) => clock.setSpeed(Number(v))}
      />
      <div className="ml-auto flex items-center gap-2">
        {names.length === 2 && (
          <SegmentedControl
            ariaLabel="Arrangement"
            options={names.map((n) => ({
              value: n,
              label: ARRANGEMENT_LABELS[n],
            }))}
            value={arrangement}
            onChange={onArrangement}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          className="!px-2 font-mono"
          onClick={onHelp}
          aria-label="Keyboard shortcuts"
          aria-expanded={help}
          aria-keyshortcuts="?"
          title="Keyboard shortcuts (?)"
        >
          ?
        </Button>
      </div>
    </div>
  );
}

function ShortcutHelp() {
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2 text-xs"
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

const panel =
  "min-w-0 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2 text-xs";

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
      className={panel}
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
