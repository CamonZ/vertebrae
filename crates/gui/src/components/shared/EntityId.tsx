import {
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { TaskLevel } from "../../bindings";
import { levelTextColor } from "./TaskLevelLabel";

export type EntityIdKind =
  | "task"
  | "step"
  | "workflow"
  | "step execution"
  | "task run"
  | "chat session"
  | "application";

interface BaseEntityIdProps {
  id: string | null | undefined;
  kind?: EntityIdKind;
  className?: string;
  testId?: string;
  emptyValue?: string;
  copyable?: boolean;
  level?: TaskLevel | null;
}

function taskLevelColor(
  kind: EntityIdKind | undefined,
  level: TaskLevel | null | undefined
): string | undefined {
  if (kind !== "task" || level == null) return undefined;
  return levelTextColor(level);
}

interface FormattedEntityIdOptions {
  length?: number;
  full?: boolean;
  emptyValue?: string;
}

interface CopyIdButtonProps {
  id: string;
  label: string;
  className?: string;
}

export function formatEntityId(
  id: string | null | undefined,
  options: FormattedEntityIdOptions = {}
): string {
  if (!id) return options.emptyValue ?? "-";
  if (options.full) return id;
  return id.slice(0, options.length ?? 8);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function kindLabel(kind: EntityIdKind): string {
  return capitalize(kind);
}

function CopyIcon(): ReactNode {
  return (
    <svg
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" strokeWidth={1.7} />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.7}
        d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
      />
    </svg>
  );
}

function CopyIdButton({ id, label, className }: CopyIdButtonProps): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error("Failed to copy entity ID", error);
    }
  };

  const handleCopy = async (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await copy();
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      await copy();
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleCopy}
      onKeyDown={handleKeyDown}
      className={[
        "inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-fg-mute transition-colors hover:bg-bg-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={copied ? "Copied" : `Copy full ${label} ID`}
      aria-label={copied ? `Copied ${label} ID` : `Copy full ${label} ID`}
    >
      <CopyIcon />
    </span>
  );
}

function EntityIdShell({
  id,
  kind = "task",
  className,
  testId,
  full = false,
  copyClassName,
  emptyValue,
  copyable = true,
  level,
  children,
}: BaseEntityIdProps & {
  full?: boolean;
  copyClassName?: string;
  children: ReactNode;
}): ReactNode {
  const label = kind === "task" && level ? capitalize(level) : kindLabel(kind);

  if (!id) {
    return (
      <span data-testid={testId} className={className} title="-">
        {emptyValue ?? "-"}
      </span>
    );
  }

  return (
    <span
      data-testid={testId}
      className={["inline-flex items-center gap-1", className]
        .filter(Boolean)
        .join(" ")}
      title={`${label} ID: ${id}`}
      data-full-id={id}
      data-id-display={full ? "full" : "short"}
    >
      {children}
      {copyable && (
        <CopyIdButton
          id={id}
          label={label.toLowerCase()}
          className={copyClassName}
        />
      )}
    </span>
  );
}

export function ScanIdentifier({
  id,
  kind = "task",
  className,
  testId,
  emptyValue,
  copyable,
  level,
}: BaseEntityIdProps): ReactNode {
  const textColor = taskLevelColor(kind, level) ?? "text-fg-mute";
  return (
    <EntityIdShell
      id={id}
      kind={kind}
      level={level}
      emptyValue={emptyValue}
      copyable={copyable}
      className={["font-mono text-xs", textColor, className]
        .filter(Boolean)
        .join(" ")}
      testId={testId}
    >
      <code>{formatEntityId(id)}</code>
    </EntityIdShell>
  );
}

export function IdentityBadge({
  id,
  kind = "task",
  className,
  testId,
  emptyValue,
  copyable,
  level,
}: BaseEntityIdProps): ReactNode {
  // The level is conveyed by surrounding affordances (e.g. the tree's level
  // mark), so the badge renders in a single neutral tone rather than a
  // per-level tint. `level` is still used for the accessible label/title.
  const textColor = "text-fg-mute";
  return (
    <EntityIdShell
      id={id}
      kind={kind}
      level={level}
      emptyValue={emptyValue}
      copyable={copyable}
      className={[
        "rounded bg-bg-2 px-1.5 py-0.5 font-mono text-2xs",
        textColor,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      testId={testId}
    >
      <code>{formatEntityId(id)}</code>
    </EntityIdShell>
  );
}

export function NavigableReference({
  id,
  kind = "task",
  className,
  testId,
  emptyValue,
  copyable,
  level,
}: BaseEntityIdProps): ReactNode {
  const textColor = taskLevelColor(kind, level) ?? "text-fg-soft";
  return (
    <EntityIdShell
      id={id}
      kind={kind}
      level={level}
      emptyValue={emptyValue}
      copyable={copyable}
      className={["font-mono text-xs transition-colors", textColor, className]
        .filter(Boolean)
        .join(" ")}
      testId={testId}
    >
      <code>{formatEntityId(id)}</code>
    </EntityIdShell>
  );
}

export function DiagnosticId({
  id,
  kind = "task run",
  className,
  testId,
  emptyValue,
  copyable,
  level,
}: BaseEntityIdProps): ReactNode {
  const textColor = taskLevelColor(kind, level) ?? "text-fg";
  return (
    <EntityIdShell
      id={id}
      kind={kind}
      level={level}
      full
      emptyValue={emptyValue}
      copyable={copyable}
      className={["break-all font-mono text-xs", textColor, className]
        .filter(Boolean)
        .join(" ")}
      testId={testId}
      copyClassName="self-start"
    >
      <code className="break-all">{formatEntityId(id, { full: true })}</code>
    </EntityIdShell>
  );
}
