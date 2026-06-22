/**
 * EventRow — the atom family of the unified event log.
 *
 * A faithful React/TS port of docs/design/lib/lib-eventlog.jsx. One row in the
 * log, dispatched by its message `type`:
 *   step · user · system · agent · tool · wait · error · activity
 *
 * NOTE on `spawn`: EventRow does NOT handle `type: "spawn"`. The enclosing Turn
 * (Thread.tsx) intercepts a SpawnMessage and renders a nested <Thread> instead.
 * EventRow only covers user | system | agent | tool | wait | error | activity
 * (+ the stand-alone StepDivider, exported for completeness).
 *
 * Styling lives in the co-located thread.css (ported verbatim from the
 * prototype's self-injected CSS), imported once by index.ts. Mode
 * (timed | bare) is supplied by the enclosing EventLog wrapper class
 * (evlog--timed / evlog--bare), not per-row.
 */

import { useState, type ReactNode } from "react";

import { IdChip } from "../shared/HearthPrimitives";
import {
  MarkdownContent,
  prettyPrintJsonIfPossible,
} from "../shared/MarkdownContent";

import type {
  ActivityMessage,
  AgentMessage,
  ErrorMessage,
  Message,
  ResultMessage,
  StepKind,
  SystemMessage,
  ToolMessage,
  UserMessage,
  UserRole,
  WaitMessage,
} from "./types";

function LogProse({
  prose,
  proseFormat = "markdown",
  streaming,
}: {
  prose?: ReactNode;
  proseFormat?: AgentMessage["proseFormat"];
  streaming?: boolean;
}): ReactNode {
  if (prose == null && !streaming) return null;
  const inner =
    typeof prose === "string" && proseFormat !== "plain" ? (
      <MarkdownContent text={prose} />
    ) : (
      prose
    );
  return (
    <div className="evprose">
      {inner}
      {streaming ? <span className="ev-cursor" /> : null}
    </div>
  );
}

// ===========================================================================
// ToolRow — the merged tool (fn card · shell line).
// ===========================================================================

type ToolRowProps = Omit<ToolMessage, "type" | "evt" | "at" | "rel" | "id">;

export function ToolRow(props: ToolRowProps): ReactNode {
  // When a surface supplies onToggle (chat) the row is controlled by that
  // surface; otherwise (read-only Traces) it self-manages its open/closed
  // state so the result body can still be expanded and collapsed.
  const controlled = props.onToggle != null;
  const [localCollapsed, setLocalCollapsed] = useState(!!props.collapsed);
  const status: "err" | "pending" | "ok" = props.error
    ? "err"
    : props.status === "pending"
      ? "pending"
      : props.status === "err"
        ? "err"
        : "ok";
  const isShell =
    props.kind === "shell" || (props.cmd != null && props.name == null);
  const name = props.name != null ? props.name : props.cmd;

  let args = props.args;
  if (args == null && (props.flag != null || props.em != null)) {
    args = (
      <>
        {props.flag ? <span className="flag">{props.flag} </span> : null}
        {props.em ? <em>{props.em}</em> : null}
      </>
    );
  }

  const pending = status === "pending";
  const hasBody = !pending && props.body != null && props.body !== "";
  const collapsed = controlled ? !!props.collapsed : localCollapsed;
  const toggle = controlled
    ? props.onToggle
    : () => setLocalCollapsed((c) => !c);
  const cls =
    "evtool" +
    (status === "err" ? " err" : pending ? " pending" : "") +
    (hasBody ? " has-body" : "") +
    (hasBody && collapsed ? " collapsed" : "");

  return (
    <div className={cls}>
      <div
        className="evtool-hd"
        onClick={hasBody ? toggle : undefined}
      >
        {pending ? (
          <span className="evtool-spin" />
        ) : (
          <span className="evtool-dot" />
        )}
        {isShell ? <span className="evtool-prompt">$</span> : null}
        <span className="evtool-name">{name}</span>
        {args ? <span className="evtool-args">{args}</span> : null}
        {props.summary ? (
          <span className="evtool-sum">
            {pending ? "running…" : props.summary}
          </span>
        ) : null}
        {props.dur ? <span className="evtool-dur">{props.dur}</span> : null}
        {hasBody ? <span className="evtool-chev">▾</span> : null}
      </div>
      {hasBody ? (
        <div className="evtool-bd">
          {typeof props.body === "string"
            ? prettyPrintJsonIfPossible(props.body)
            : props.body}
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// Time gutter — at / rel / id chip (hidden in bare mode by CSS).
// ===========================================================================

function EventWhen({
  at,
  rel,
  id,
}: {
  at?: string;
  rel?: string;
  id?: string;
}): ReactNode {
  if (at == null && rel == null && id == null) return <div className="evwhen" />;
  return (
    <div className="evwhen">
      {at}
      {rel ? <span className="rel">{rel}</span> : null}
      {id ? <IdChip id={id} /> : null}
    </div>
  );
}

// ===========================================================================
// StepDivider — STRUCTURE. Quiet rule that opens a step group.
//
// In the production primitive the root-thread HEAD (Thread.tsx) plays this role
// for a step_execution; this stand-alone divider is exported for parity with
// the prototype and for any surface that wants a bare divider.
// ===========================================================================

export interface StepDividerProps {
  at?: string;
  rel?: string;
  to?: string;
  kind?: StepKind;
  runtime?: string;
  selected?: boolean;
  onClick?: () => void;
}

export function StepDivider({
  at,
  rel,
  to,
  kind = "execute",
  runtime,
  selected,
  onClick,
}: StepDividerProps): ReactNode {
  return (
    <div className={"evstep kind-" + kind + (selected ? " sel" : "")}>
      <EventWhen at={at} rel={rel} />
      <div className="evstep-head" onClick={onClick}>
        <span className="evstep-tick" />
        <span className="evstep-arrow">→</span>
        <span className="evstep-name">{to}</span>
        <span className="evstep-kind">{kind}</span>
        {runtime ? <span className="evstep-rt">{runtime}</span> : null}
      </div>
    </div>
  );
}

// ===========================================================================
// UserBody — human prompt or interpolated step prompt (also reused by system).
// ===========================================================================

function UserBody({
  role = "human",
  label,
  text,
  body,
}: {
  role?: UserRole;
  label?: string;
  text?: string;
  body?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const isPrompt = role === "prompt";
  return (
    <div className="evbody">
      <div className="ev-promptline">
        <span className="ev-you">
          {label || (isPrompt ? "Prompt" : "You")}
        </span>
        {body ? (
          <button
            className={"ev-expand" + (open ? " open" : "")}
            onClick={() => setOpen(!open)}
          >
            <span className="chev">▸</span>
            {open ? "hide input" : "show input"}
          </button>
        ) : null}
      </div>
      {text ? <div className="ev-text">{text}</div> : null}
      {body && open ? <div className="ev-prompt-body">{body}</div> : null}
    </div>
  );
}

// ===========================================================================
// AgentBody — speaker · model · tools · prose.
// ===========================================================================

function AgentBody({
  speaker,
  model,
  prose,
  proseFormat,
  tools = [],
  streaming,
}: {
  speaker?: string;
  model?: string;
  prose?: ReactNode;
  proseFormat?: AgentMessage["proseFormat"];
  tools?: ToolMessage[];
  streaming?: boolean;
}): ReactNode {
  return (
    <div className="evbody">
      <div className="ev-speaker">
        {streaming ? (
          <span className="evtool-spin" />
        ) : (
          <span className="ev-ember" />
        )}
        {speaker || "sacrum"}
        {model ? <span className="model">{model}</span> : null}
      </div>
      {tools.length ? (
        <div className="ev-tools">
          {tools.map((t, i) => (
            <ToolRow key={t.evt || i} {...t} />
          ))}
        </div>
      ) : null}
      <LogProse prose={prose} proseFormat={proseFormat} streaming={streaming} />
    </div>
  );
}

// ===========================================================================
// EventRow — one line in the log, dispatched by `type`.
// ===========================================================================

/**
 * EventRow accepts a single Message (minus `spawn`, which the Turn intercepts)
 * plus the per-row interaction props injected by the Turn.
 */
export type EventRowProps = Exclude<Message, { type: "spawn" }> & {
  /** Whether this row carries the selection ring (selectedEvt === m.evt). */
  selected?: boolean;
  /** Click handler — selects this row's evt (interactive surfaces). */
  onClick?: () => void;
  /** Optional click handler for a wait row's navigable child-run link. */
  onChildRun?: (runId: string) => void;
};

export function EventRow(props: EventRowProps): ReactNode {
  const type = props.type;

  if (type === "wait") return <WaitRow {...props} />;
  if (type === "error") return <ErrorRow {...props} />;
  if (type === "result") return <ResultRow {...props} />;
  if (type === "activity") return <ActivityRow {...props} />;

  // user / system / agent / tool
  const sel = props.selected ? " sel" : "";
  // system renders with the user/prompt visual vocabulary (quiet, collapsible)
  const renderType = type === "system" ? "user" : type;
  const promptMod =
    type === "user" && (props as UserMessage).role === "prompt"
      ? " is-prompt"
      : type === "system"
        ? " is-prompt is-system"
        : "";
  const clickable = props.onClick ? { "data-clickable": "" } : {};

  let body: ReactNode = null;
  if (type === "system") {
    const m = props as SystemMessage;
    body = (
      <UserBody role="prompt" label={m.label || "System"} text={m.text} body={m.body} />
    );
  } else if (type === "user") {
    const m = props as UserMessage;
    body = <UserBody role={m.role} label={m.label} text={m.text} body={m.body} />;
  } else if (type === "agent") {
    const m = props as AgentMessage;
    body = (
      <AgentBody
        speaker={m.speaker}
        model={m.model}
        prose={m.prose}
        proseFormat={m.proseFormat}
        tools={m.tools}
        streaming={m.streaming}
      />
    );
  } else if (type === "tool") {
    body = (
      <div className="evbody">
        <ToolRow {...(props as ToolMessage)} />
      </div>
    );
  }

  return (
    <div
      className={"evrow evrow--" + renderType + promptMod + sel}
      onClick={props.onClick}
      {...clickable}
    >
      <EventWhen at={props.at} rel={props.rel} id={props.id} />
      {body}
    </div>
  );
}

// ── EXCEPTION rows ──

function ActivityRow(
  props: ActivityMessage & {
    selected?: boolean;
    onClick?: () => void;
  }
): ReactNode {
  const sel = props.selected ? " sel" : "";
  const clickable = props.onClick ? { "data-clickable": "" } : {};
  const tone = props.tone === "warn" ? " warn" : "";
  return (
    <div
      className={"evrow evrow--activity" + tone + sel}
      onClick={props.onClick}
      {...clickable}
    >
      <EventWhen at={props.at} rel={props.rel} id={props.id} />
      <div className="evbody">
        <div className={`evactivity ${props.variant}`}>
          <span className="evactivity-dot" />
          <span className="evactivity-label">{props.label}</span>
          <span className="evactivity-text">{props.text}</span>
        </div>
      </div>
    </div>
  );
}

function WaitRow(
  props: WaitMessage & {
    selected?: boolean;
    onClick?: () => void;
    onChildRun?: (runId: string) => void;
  }
): ReactNode {
  const sel = props.selected ? " sel" : "";
  const clickable = props.onClick ? { "data-clickable": "" } : {};
  const links = props.childRunIds ?? [];
  return (
    <div
      className={"evrow evrow--wait" + sel}
      onClick={props.onClick}
      {...clickable}
    >
      <EventWhen at={props.at} rel={props.rel} id={props.id} />
      <div className="evbody">
        <span>{props.text}</span>
        <span className="flow" />
        {/* Child runs render as navigable LINKS — never an inlined subtree
            (constraint #3). With no handler they fall back to plain text. */}
        {links.length ? (
          <span className="wlinks">
            {links.map((runId) =>
              props.onChildRun ? (
                <button
                  key={runId}
                  className="wlink"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onChildRun?.(runId);
                  }}
                >
                  {runId}
                </button>
              ) : (
                <span key={runId} className="wid">
                  {runId}
                </span>
              )
            )}
          </span>
        ) : props.wid ? (
          <span className="wid">{props.wid}</span>
        ) : null}
      </div>
    </div>
  );
}

function ErrorRow(
  props: ErrorMessage & { selected?: boolean; onClick?: () => void }
): ReactNode {
  const sel = props.selected ? " sel" : "";
  const clickable = props.onClick ? { "data-clickable": "" } : {};
  return (
    <div
      className={"evrow evrow--error" + sel}
      onClick={props.onClick}
      {...clickable}
    >
      <EventWhen at={props.at} rel={props.rel} id={props.id} />
      <div className="evbody">
        <b>{props.title}</b>
        {props.sub ? <span className="sub">{props.sub}</span> : null}
      </div>
    </div>
  );
}

// A step execution's final structured output. Shown expanded and prominent;
// the body is pretty-printed when it parses as JSON / an Elixir map.
function ResultRow(
  props: ResultMessage & { selected?: boolean; onClick?: () => void }
): ReactNode {
  const sel = props.selected ? " sel" : "";
  const clickable = props.onClick ? { "data-clickable": "" } : {};
  return (
    <div
      className={"evrow evrow--result" + sel}
      onClick={props.onClick}
      {...clickable}
    >
      <EventWhen at={props.at} rel={props.rel} id={props.id} />
      <div className="evbody">
        <div className="evresult">
          <div className="evresult-hd">{props.label || "output"}</div>
          {/* MarkdownContent renders markdown AND pretty-prints bare JSON, so
              the output is formatted whether it's prose or structured. */}
          <div className="evresult-bd">
            <MarkdownContent text={props.body} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// EventLog — wrapper that sets the grouping/gutter mode.
// ===========================================================================

export interface EventLogProps {
  mode?: "timed" | "bare";
  className?: string;
  children?: ReactNode;
}

export function EventLog({
  mode = "timed",
  className = "",
  children,
}: EventLogProps): ReactNode {
  return (
    <div className={"evlog evlog--" + mode + (className ? " " + className : "")}>
      {children}
    </div>
  );
}
