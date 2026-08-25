import { useState } from "react";
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import type { StepType, TaskLevel, TaskRunStatus } from "../../bindings";
import {
  deriveHearthRunChipState,
  type HearthRunChipState,
  type HearthRunState,
} from "../../utils/runState";
import {
  hearthStepKind,
  hearthStepStyle,
  stepTypeStyle,
  type HearthStepKind,
} from "../WorkflowPipeline/stepTypeStyling";
import { Card } from "../molecules/Card";
import { formatEntityId, type EntityIdKind } from "./EntityId";
import { LevelMark } from "./LevelMark";

type StepDotVariant = "done" | "running" | "waiting" | "queued";

interface RunChipProps extends HTMLAttributes<HTMLSpanElement> {
  status?: TaskRunStatus | null;
  state?: HearthRunState | null;
  label?: string;
  runtime?: ReactNode;
  small?: boolean;
  force?: boolean;
}

interface IdChipProps {
  id: string | null | undefined;
  kind?: EntityIdKind;
  level?: TaskLevel | null;
  className?: string;
  testId?: string;
}

interface KindChipProps extends HTMLAttributes<HTMLSpanElement> {
  stepType?: StepType | null;
  kind?: HearthStepKind;
  label?: ReactNode;
}

export interface PipelineSegment {
  stepType?: StepType | null;
  kind?: HearthStepKind;
  state?: "completed" | "running" | "waiting" | "queued";
  label?: string;
}

type PipelineInput = PipelineSegment | StepType | HearthStepKind;

interface PipelineProps extends HTMLAttributes<HTMLSpanElement> {
  segments: PipelineInput[];
  width?: number | string;
  height?: number | string;
}

interface StateBreakdownProps {
  done?: number;
  running?: number;
  waiting?: number;
  queued?: number;
  className?: string;
}

interface DetailHeaderProps {
  title: string;
  mark?: string;
  id?: string | null;
  crumbs?: Array<{ text: ReactNode; em?: boolean; onClick?: () => void }>;
  children?: ReactNode;
}

interface HeroStatusProps extends HTMLAttributes<HTMLDivElement> {
  status?: TaskRunStatus | null;
  state?: HearthRunState | null;
  stepType?: StepType | null;
  label?: ReactNode;
  runtime?: ReactNode;
  step?: { n?: number | null; kind?: StepType | null; label?: ReactNode };
  finished?: ReactNode;
  right?: ReactNode;
}

interface CompactTaskCardProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "id" | "title" | "onClick" | "onKeyDown" | "role" | "tabIndex"
> {
  title: ReactNode;
  id?: string | null;
  level?: TaskLevel | null;
  stepType?: StepType | null;
  stepLabel?: ReactNode;
  priority?: "hi" | "md" | "lo";
  pipeline?: PipelineSegment[];
  breakdown?: StateBreakdownProps;
  tags?: string[];
  runStatus?: TaskRunStatus | null;
  when?: ReactNode;
  selected?: boolean;
  completed?: boolean;
}

interface CompactRunCardProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "id" | "onClick" | "onKeyDown" | "role" | "tabIndex"
> {
  status: TaskRunStatus;
  id?: string | null;
  when?: ReactNode;
  reason?: ReactNode;
  selected?: boolean;
}

interface WorkflowRailItemProps extends HTMLAttributes<HTMLDivElement> {
  name: ReactNode;
  shape: Array<StepType | HearthStepKind>;
  live?: number;
  steps?: number;
  tasks?: number;
  daily?: ReactNode;
  avg?: ReactNode;
  selected?: boolean;
}

interface RecentItemProps {
  variant?: "done" | "running" | "waiting";
  title: ReactNode;
  when: ReactNode;
  muted?: boolean;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function normalizeHearthKind(
  kind: HearthStepKind | StepType | null | undefined
): HearthStepKind {
  if (kind === "eval" || kind === "human" || kind === "wait") return kind;
  return hearthStepKind(kind as StepType | null | undefined);
}

function pipelineSegmentKind(segment: PipelineInput): HearthStepKind {
  if (typeof segment === "string") return normalizeHearthKind(segment);
  if ("kind" in segment || "stepType" in segment) {
    return segment.kind ?? hearthStepKind(segment.stepType);
  }
  return "unknown";
}

function pipelineSegmentState(
  segment: PipelineInput
): PipelineSegment["state"] | undefined {
  return typeof segment === "object" && "state" in segment
    ? segment.state
    : undefined;
}

function pipelineSegmentLabel(segment: PipelineInput): string | undefined {
  return typeof segment === "object" && "label" in segment
    ? segment.label
    : undefined;
}

function statusFromState(
  state: HearthRunState | null | undefined
): TaskRunStatus | null {
  if (!state) return null;
  return state === "running" ? "executing" : state;
}

function forcedRunChipState({
  status,
  state,
  label,
}: {
  status?: TaskRunStatus | null;
  state?: HearthRunState | null;
  label?: string;
}): HearthRunChipState | null {
  const derivedStatus = status ?? statusFromState(state);
  const chip = deriveHearthRunChipState(derivedStatus, {
    includeTerminal: true,
  });
  if (!chip) return null;
  return label ? { ...chip, label } : chip;
}

export function RunChip({
  status,
  state,
  label,
  runtime,
  small = false,
  force = false,
  className,
  ...rest
}: RunChipProps): ReactNode {
  const chip = force
    ? forcedRunChipState({ status, state, label })
    : deriveHearthRunChipState(status ?? statusFromState(state));

  if (!chip) return null;
  const displayChip = label ? { ...chip, label } : chip;

  return (
    <span
      {...rest}
      data-state={displayChip.state}
      aria-label={`Run status: ${displayChip.label}`}
      className={classNames(
        "c-run-chip",
        displayChip.state,
        small ? "sm" : "",
        className
      )}
    >
      {displayChip.state === "running" && (
        <span aria-hidden className="spinner" />
      )}
      <span>{displayChip.label}</span>
      {runtime && <span className="runtime">· {runtime}</span>}
    </span>
  );
}

export function IdChip({
  id,
  kind = "task",
  level,
  className,
  testId,
}: IdChipProps): ReactNode {
  const [copied, setCopied] = useState(false);

  if (!id) {
    return (
      <span data-testid={testId} className={classNames("c-id-chip", className)}>
        -
      </span>
    );
  }

  // Lowercase noun for the copy affordance, e.g. "ticket" / "task run".
  const label = kind === "task" && level ? level : kind;

  const copy = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>
  ) => {
    event.stopPropagation();
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    };
    navigator.clipboard?.writeText(id).then(done).catch(done);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      copy(event);
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      data-testid={testId}
      data-full-id={id}
      aria-label={`Copy full ${label} ID`}
      title="Click to copy"
      onClick={copy}
      onKeyDown={handleKeyDown}
      className={classNames("c-id-chip", copied && "copied", className)}
    >
      <span className="id-text">{formatEntityId(id)}</span>
      <svg
        className="copy-mark"
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <rect x="9" y="9" width="13" height="13" rx="1" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <svg
        className="ok-mark"
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

export function KindChip({
  stepType,
  kind,
  label,
  className,
  ...rest
}: KindChipProps): ReactNode {
  const hearthKindValue = kind ?? hearthStepKind(stepType);
  const style = hearthStepStyle(hearthKindValue);
  const display =
    label ?? (stepType ? stepTypeStyle(stepType).label : style.label);

  return (
    <span
      {...rest}
      data-kind={hearthKindValue}
      aria-label={`Step kind: ${display}`}
      className={classNames(
        "c-kind-chip inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-2 font-mono text-2xs font-medium uppercase tracking-[0.12em]",
        `kind-${hearthKindValue}`,
        className
      )}
      style={{ color: `var(${style.fgVar})`, ...rest.style }}
    >
      <span
        aria-hidden
        className="swatch h-2 w-2 rounded-full"
        style={{ backgroundColor: `var(${style.barVar})` }}
      />
      {display}
    </span>
  );
}

export function Pipeline({
  segments,
  width = 140,
  height = 4,
  className,
  style,
  ...rest
}: PipelineProps): ReactNode {
  return (
    <span
      {...rest}
      aria-label={`${segments.length} step pipeline`}
      className={classNames(
        "c-pipeline inline-flex overflow-hidden rounded-[var(--radius-xs)] bg-[var(--color-bg-3)]",
        className
      )}
      style={{ width, height, ...style }}
    >
      {segments.map((segment, index) => {
        const kind = pipelineSegmentKind(segment);
        const style = hearthStepStyle(kind);
        const state = pipelineSegmentState(segment);
        return (
          <span
            key={`${kind}-${index}`}
            className={classNames(
              "seg flex-1",
              `kind-${kind}`,
              state && `s-${state}`,
              state === "queued" && "opacity-30",
              state === "waiting" && "opacity-70",
              state === "running" &&
                "opacity-100 shadow-[0_0_8px_var(--color-accent-glow)]"
            )}
            title={pipelineSegmentLabel(segment)}
            style={{ backgroundColor: `var(${style.barVar})` }}
          />
        );
      })}
    </span>
  );
}

export function StepDot({ variant = "queued" }: { variant?: StepDotVariant }) {
  return (
    <span
      aria-label={`Step ${variant}`}
      className={classNames(
        "c-dot inline-flex h-2.5 w-2.5 rounded-full border",
        variant,
        variant === "done" && "border-[var(--color-ok)] bg-[var(--color-ok)]",
        variant === "running" &&
          "border-[var(--color-accent)] bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent-glow)]",
        variant === "waiting" &&
          "border-[var(--color-warn)] bg-[var(--color-warn)]",
        variant === "queued" && "border-[var(--color-fg-faint)] bg-transparent"
      )}
    />
  );
}

export function StateBreakdown({
  done = 0,
  running = 0,
  waiting = 0,
  queued = 0,
  className,
}: StateBreakdownProps): ReactNode {
  // Glyphs match the design reference (docs/design/lib/lib-primitives.jsx):
  // ✓ done · ▶ running · ⏸ waiting · ○ queued.
  const parts = [
    ["b-done text-[var(--color-ok)]", "done", "✓", done],
    ["b-run text-[var(--color-accent)]", "running", "▶", running],
    ["b-wait text-[var(--color-warn)]", "waiting", "⏸", waiting],
    ["b-q text-[var(--color-fg-mute)]", "queued", "○", queued],
  ] as const;

  return (
    <span
      className={classNames(
        "c-breakdown inline-flex items-center gap-1.5 font-mono text-2xs",
        className
      )}
      aria-label={`State breakdown: ${done} done, ${running} running, ${waiting} waiting, ${queued} queued`}
    >
      {parts
        .filter(([, , , value]) => value > 0)
        .map(([classes, labelText, glyph, value], index) => (
          <span key={labelText} className="inline-flex items-center gap-1">
            {index > 0 && (
              <span className="sep text-[var(--color-fg-ghost)]">·</span>
            )}
            <span className={classNames(classes, "tabular-nums")}>
              <span aria-hidden>{glyph}</span> {value}
            </span>
          </span>
        ))}
    </span>
  );
}

export function Glyph({
  level = "task",
  accent = false,
}: {
  level?: TaskLevel | null;
  accent?: boolean;
}) {
  return (
    <LevelMark
      level={level ?? null}
      className={classNames(
        "c-glyph h-4 w-4",
        accent && "[&_[data-shape=dot]]:bg-[var(--color-accent)]",
        accent && "[&_[data-shape=diamond-filled]]:bg-[var(--color-accent)]",
        accent && "[&_[data-shape=diamond-hollow]]:border-[var(--color-accent)]"
      )}
    />
  );
}

export function DetailHeader({
  title,
  mark,
  id,
  crumbs = [],
  children,
}: DetailHeaderProps): ReactNode {
  const markedTitle =
    mark && title.includes(mark)
      ? title.split(mark).flatMap((part, index) =>
          index === 0
            ? [part]
            : [
                <em
                  key={`${mark}-${index}`}
                  className="text-[var(--color-accent)]"
                >
                  {mark}
                </em>,
                part,
              ]
        )
      : title;

  return (
    <header className="detail-header">
      <h2 className="dh-title font-serif text-3xl leading-tight text-[var(--color-fg)]">
        {markedTitle}
      </h2>
      <div className="dh-crumb mt-2 flex flex-wrap items-center gap-2 font-mono text-2xs text-[var(--color-fg-mute)]">
        {id && <IdChip id={id} kind="task" />}
        {crumbs.map((crumb, index) => (
          <span key={index} className="inline-flex items-center gap-2">
            <span aria-hidden className="text-[var(--color-fg-ghost)]">
              ·
            </span>
            {crumb.onClick ? (
              <button
                type="button"
                onClick={crumb.onClick}
                className={classNames(
                  "rounded-sm text-left hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
                  crumb.em && "font-serif italic"
                )}
              >
                {crumb.text}
              </button>
            ) : (
              <span className={classNames(crumb.em && "font-serif italic")}>
                {crumb.text}
              </span>
            )}
          </span>
        ))}
      </div>
      {children}
    </header>
  );
}

export function HeroStatus({
  status,
  state,
  stepType,
  label,
  runtime,
  step,
  finished,
  right,
  children,
  className,
  style: containerStyle,
  ...rest
}: HeroStatusProps): ReactNode {
  const chip = forcedRunChipState({
    status,
    state,
    label: typeof label === "string" ? label : undefined,
  });
  const kind = hearthStepKind(step?.kind ?? stepType);
  const stepStyle = hearthStepStyle(kind);

  return (
    <div
      {...rest}
      aria-label={
        rest["aria-label"] ??
        (chip ? `Hero status: ${chip.label}` : "Hero status")
      }
      className={classNames(
        "hero-status rounded-[var(--radius-md)] border border-[var(--color-line)] border-l-2 bg-[var(--color-bg-1)] px-4 py-3",
        `edge-${kind}`,
        className
      )}
      data-step-kind={kind}
      style={containerStyle}
    >
      <div className="hero-line flex flex-wrap items-center gap-2">
        {chip && (
          <RunChip
            status={chip.status}
            force
            aria-label={`Hero status: ${chip.label}`}
          />
        )}
        {label && typeof label !== "string" && (
          <span className="state font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-soft)]">
            {label}
          </span>
        )}
        {runtime && (
          <span className="runtime font-mono text-2xs text-[var(--color-accent)]">
            · {runtime}
          </span>
        )}
        {step && (
          <span className="at font-mono text-2xs text-[var(--color-fg-mute)]">
            · at step{" "}
            <em
              className="font-serif italic"
              style={{ color: `var(${stepStyle.fgVar})` }}
            >
              {step.n != null ? `${step.n} · ` : ""}
              {step.label ?? stepTypeStyle(step.kind).label}
            </em>
          </span>
        )}
        {finished && (
          <span className="font-mono text-2xs text-[var(--color-fg-mute)]">
            · {finished}
          </span>
        )}
        {right && <span className="hero-right ml-auto">{right}</span>}
      </div>
      {children}
    </div>
  );
}

function cardStyleForStep(
  stepType: StepType | null | undefined
): CSSProperties {
  const style = stepTypeStyle(stepType);
  return {
    borderTopColor: `var(${style.barVar})`,
    backgroundColor: `color-mix(in oklch, var(${style.washVar}) 12%, var(--color-bg-1))`,
  };
}

export function CompactTaskCard({
  title,
  id,
  level = "ticket",
  stepType,
  stepLabel,
  priority,
  pipeline,
  breakdown,
  tags = [],
  runStatus,
  when,
  selected,
  completed,
  className,
  ...rest
}: CompactTaskCardProps): ReactNode {
  const hearthKindValue = hearthStepKind(stepType);

  return (
    <Card
      {...rest}
      variant="default"
      data-kind={hearthKindValue}
      className={classNames(
        "board-card border-t-2 p-0",
        `kind-${hearthKindValue}`,
        selected && "ring-1 ring-[var(--color-accent)]",
        completed && "opacity-60",
        className
      )}
      style={{ ...cardStyleForStep(stepType), ...rest.style }}
    >
      <div className="space-y-2">
        <div className="bc-title flex items-start gap-2">
          <Glyph level={level} accent={runStatus === "executing"} />
          <span className="ttl min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-fg)]">
            {title}
          </span>
          {priority && (
            <span
              title={`${priority} priority`}
              className="bc-pri font-mono text-xs text-[var(--color-fg-faint)]"
            >
              {priority === "hi" ? "↑" : priority === "md" ? "→" : "↓"}
            </span>
          )}
        </div>
        {stepLabel && <KindChip stepType={stepType} label={stepLabel} />}
        {pipeline?.length ? (
          <Pipeline segments={pipeline} width="100%" height={3} />
        ) : null}
        {breakdown && <StateBreakdown {...breakdown} />}
        {tags.length > 0 && (
          <div className="bc-tags flex flex-wrap gap-1.5 font-mono text-2xs text-[var(--color-fg-faint)]">
            {tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="tag border-b border-dotted border-[var(--color-fg-ghost)]"
              >
                {tag}
              </span>
            ))}
            {tags.length > 2 && <span>+{tags.length - 2}</span>}
          </div>
        )}
        <div className="bc-foot flex items-center gap-2">
          <RunChip status={runStatus} small />
          {id && <IdChip id={id} kind="task" level={level} />}
          {when && (
            <span className="when ml-auto font-mono text-2xs text-[var(--color-fg-faint)]">
              {when}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

export function CompactRunCard({
  status,
  id,
  when,
  reason,
  selected,
  className,
  ...rest
}: CompactRunCardProps): ReactNode {
  return (
    <Card
      {...rest}
      variant="default"
      className={classNames(
        "run-card p-0",
        selected && "ring-1 ring-[var(--color-accent)]",
        className
      )}
    >
      <div className="space-y-1">
        <div className="head flex items-center gap-2">
          <RunChip status={status} force />
          {id && <IdChip id={id} kind="task run" />}
        </div>
        {(when || reason) && (
          <div className="when font-mono text-2xs text-[var(--color-fg-faint)]">
            {when}
            {reason && (
              <span className="err text-[var(--color-err)]"> · {reason}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function WorkflowRailItem({
  name,
  shape,
  live,
  steps,
  tasks,
  daily,
  avg,
  selected,
  className,
  ...rest
}: WorkflowRailItemProps): ReactNode {
  const meta = [
    live ? (
      <span key="live" className="live text-[var(--color-accent)]">
        {live} running
      </span>
    ) : null,
    steps ? <span key="steps">{steps} steps</span> : null,
    tasks !== undefined ? <span key="tasks">{tasks} tasks</span> : null,
    daily ? <span key="daily">{daily} / 24h</span> : null,
    avg ? <span key="avg">avg {avg}</span> : null,
  ].filter(Boolean);

  return (
    <div
      {...rest}
      className={classNames(
        "wf-rail-item rounded-[var(--radius-md)] border border-transparent p-3 hover:bg-[var(--color-bg-2)]",
        selected && "selected bg-[var(--color-accent-wash)]",
        className
      )}
    >
      <div className="name truncate font-serif italic text-sm text-[var(--color-fg)]">
        {name}
      </div>
      <Pipeline className="mt-2" width="100%" segments={shape} />
      <div className="meta mt-2 flex flex-wrap items-center gap-1.5 font-mono text-2xs text-[var(--color-fg-faint)]">
        {meta.map((item, index) => (
          <span key={index} className="inline-flex items-center gap-1.5">
            {index > 0 && (
              <span className="sep text-[var(--color-fg-ghost)]"> · </span>
            )}
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RecentItem({
  variant = "done",
  title,
  when,
  muted,
}: RecentItemProps): ReactNode {
  return (
    <div
      className={classNames(
        "recent-item flex items-center gap-2",
        muted && "muted"
      )}
    >
      <StepDot variant={variant === "done" ? "done" : variant} />
      <span className="ri-title min-w-0 flex-1 truncate text-xs text-[var(--color-fg)]">
        {title}
      </span>
      <span
        className={classNames(
          "ri-when font-mono text-2xs",
          variant === "running"
            ? "text-[var(--color-accent)]"
            : "text-[var(--color-fg-faint)]"
        )}
      >
        {when}
      </span>
    </div>
  );
}
