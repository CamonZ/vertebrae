/**
 * Thread — the recursive rendering primitive.
 *
 * A faithful React/TS port of docs/design/lib/lib-thread.jsx. One component over
 * the canonical tree (Task › Run › Thread › Turn › Message); chat and Traces are
 * the SAME component, differing only by capability flags:
 *   · chat   → mode="bare"  reveal="shallow" showHead={false}  interactive
 *   · traces → mode="timed" reveal="deep"     focus-drill nav   readOnly
 *
 * A Thread renders:
 *   · a HEAD — root (depth 0): a quiet step-divider rule (from thread.step);
 *              nested (depth > 0): a collapsible summary line with a kind-colored
 *              left spine.
 *   · its TURNS — each an ordered series of messages drawn by <EventRow>. A turn
 *     that contains a SpawnMessage renders a child <Thread depth+1> in its place.
 *
 * SINGLE-RUN model (constraint #1): the only nesting axis is intra-run subagents
 * via SpawnMessage (constraint #2). wait_for_children is a terminal WaitMessage,
 * never an inlined subtree (constraint #3).
 *
 * Styling lives in the co-located thread.css, imported once by index.ts.
 */

import { Fragment, useState, type ReactNode } from "react";

import { IdChip } from "../shared/HearthPrimitives";

import { EventRow } from "./EventRow";
import type {
  Message,
  StepKind,
  ThreadStep,
  Thread as ThreadModel,
  ThreadMode,
  ThreadNavNode,
  ThreadReveal,
  ThreadStatus,
  Turn as TurnModel,
} from "./types";

// ===========================================================================
// Status mark — the subthread summary status dot / spinner.
// ===========================================================================

function StatusMark({ status }: { status?: ThreadStatus }): ReactNode {
  if (status === "running") return <span className="sth-spin" />;
  const c =
    status === "err"
      ? "var(--err)"
      : status === "waiting"
        ? "var(--warn)"
        : "var(--ok)";
  return <span className="sth-status" style={{ background: c }} />;
}

// ===========================================================================
// Shared interaction props threaded down the tree.
// ===========================================================================

interface SharedProps {
  mode: ThreadMode;
  reveal: ThreadReveal;
  /** Currently-selected evt / thread id (drives the .sel ring). */
  selectedEvt?: string | null;
  /** Select a message evt or thread id. */
  onSelect?: (id: string) => void;
  /** Register a DOM node for scroll-into-view (rail jump). */
  registerRef?: (id: string, el: HTMLElement | null) => void;
  /** Focus-drill into a subthread (Traces). */
  onFocus?: (thread: ThreadModel) => void;
  /** Follow a wait row's navigable child-run link (constraint #3). */
  onChildRun?: (runId: string) => void;
}

// ===========================================================================
// Turn — the ordered message series; a spawn becomes a child Thread.
// ===========================================================================

interface TurnProps extends SharedProps {
  turn: TurnModel;
  tindex: number;
  showSep: boolean;
  depth: number;
}

function Turn(props: TurnProps): ReactNode {
  const {
    turn,
    tindex,
    showSep,
    mode,
    depth,
    reveal,
    selectedEvt,
    onSelect,
    registerRef,
    onFocus,
    onChildRun,
  } = props;
  const msgs = turn.messages ?? [];
  return (
    <Fragment>
      {showSep ? (
        <div className={"turn-sep " + mode}>
          {mode === "timed" ? <div /> : null}
          <div className="lab">turn {tindex + 1}</div>
        </div>
      ) : null}
      {msgs.map((m: Message, i: number) => {
        if (m.type === "spawn") {
          return (
            <Thread
              key={m.thread.id}
              thread={m.thread}
              depth={depth + 1}
              mode={mode}
              reveal={reveal}
              selectedEvt={selectedEvt}
              onSelect={onSelect}
              registerRef={registerRef}
              onFocus={onFocus}
              onChildRun={onChildRun}
            />
          );
        }
        if (reveal === "shallow" && m.type === "system") return null;
        return (
          <EventRow
            key={m.evt || i}
            {...m}
            selected={selectedEvt === m.evt}
            onClick={onSelect ? () => onSelect(m.evt) : undefined}
            onChildRun={onChildRun}
          />
        );
      })}
    </Fragment>
  );
}

// ===========================================================================
// Thread — recursive. depth 0 = a run's step head; depth > 0 = a subthread.
// ===========================================================================

export interface ThreadProps extends Partial<SharedProps> {
  /** The (sub)tree to render. */
  thread: ThreadModel;
  /** 0 = root run-step head; > 0 = nested subagent spine. */
  depth?: number;
  mode?: ThreadMode;
  reveal?: ThreadReveal;
  /** Chat passes false to suppress the step head. */
  showHead?: boolean;
  /** Capability flag — interactive (chat) vs read-only (Traces today). */
  interactive?: boolean;
  /** Convenience inverse of interactive. */
  readOnly?: boolean;
}

export function Thread(props: ThreadProps): ReactNode {
  const {
    thread,
    depth = 0,
    mode = "timed",
    reveal = "deep",
    showHead = true,
    selectedEvt,
    onSelect,
    registerRef,
    onFocus,
    onChildRun,
  } = props;

  const nested = depth > 0;
  // root threads open; subthreads start collapsed (prototype behavior).
  const [open, setOpen] = useState(!nested);

  const kind: StepKind =
    (thread.step && thread.step.kind) || thread.kind || "execute";
  const sum = thread.summary ?? {};
  const turns = thread.turns ?? [];
  const showTurns = reveal === "deep" && turns.length > 1;

  const shared: SharedProps = {
    mode,
    reveal,
    selectedEvt,
    onSelect,
    registerRef,
    onFocus,
    onChildRun,
  };

  const bodyTurns = (
    <div className="thread-body">
      {turns.map((t, i) => (
        <Turn
          key={t.id || i}
          turn={t}
          tindex={i}
          showSep={showTurns}
          depth={depth}
          {...shared}
        />
      ))}
    </div>
  );

  if (nested) {
    return (
      <div className={"thr-row " + mode}>
        {mode === "timed" ? <div /> : null}
        <div
          className={"subthread k-" + kind + (open ? " open" : "")}
          ref={(el) => registerRef?.(thread.id, el)}
        >
          <div
            className="sth-sum"
            onClick={() => {
              setOpen((o) => !o);
              onSelect?.(thread.id);
            }}
          >
            <span className="sth-spawn">⤷</span>
            <StatusMark status={sum.status} />
            <span className="sth-kind">{thread.spawnLabel || "subagent"}</span>
            <span className="sth-name">{thread.label}</span>
            <span className="sth-meta">
              {sum.turns != null ? sum.turns + " turns" : null}
              {sum.tools != null ? " · " + sum.tools + " tools" : null}
              {sum.dur ? " · " + sum.dur : null}
            </span>
            <IdChip id={thread.id} />
            {onFocus ? (
              <button
                type="button"
                className="sth-focus"
                title="Open in focus"
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus(thread);
                }}
              >
                ⤢
              </button>
            ) : null}
            <span className="sth-chev">▾</span>
          </div>
          {open ? <div className="sth-body">{bodyTurns}</div> : null}
        </div>
      </div>
    );
  }

  // root thread = step divider head + turns
  const stepName = (thread.step && thread.step.to) || thread.label;
  const st: Partial<ThreadStep> = thread.step ?? {};
  const sel = selectedEvt === thread.id ? " sel" : "";
  return (
    <div className="thread" ref={(el) => registerRef?.(thread.id, el)}>
      {showHead ? (
        <div className={"thread-head " + mode + sel + " k-" + kind}>
          {mode === "timed" ? (
            <div className="evwhen">
              {st.at}
              {st.rel ? <span className="rel">{st.rel}</span> : null}
            </div>
          ) : null}
          <div className="th-bar" onClick={() => onSelect?.(thread.id)}>
            <span className="th-tick" />
            <span className="th-arrow">→</span>
            <span className="th-name">{stepName}</span>
            <span className="th-kind">{kind}</span>
            {sum.turns != null ? (
              <span className="th-sum">
                {sum.turns} turns · {sum.tools} tools
              </span>
            ) : null}
            {thread.id ? <IdChip id={thread.id} /> : null}
            {st.runtime ? <span className="th-rt">{st.runtime}</span> : null}
          </div>
        </div>
      ) : null}
      {bodyTurns}
    </div>
  );
}

// ===========================================================================
// flattenThreads — flatten a run's thread tree into rail nav nodes.
// ===========================================================================

// eslint-disable-next-line react-refresh/only-export-components -- rail-nav flattener is co-located with its only consumer (the recursive Thread); it is not a React component.
export function flattenThreads(
  threads: ThreadModel[],
  depth = 0,
  out: ThreadNavNode[] = []
): ThreadNavNode[] {
  (threads ?? []).forEach((th) => {
    out.push({
      id: th.id,
      label: ((th.step && th.step.to) || th.label) ?? "",
      kind: (th.step && th.step.kind) || th.kind || "execute",
      depth,
      summary: th.summary ?? {},
    });
    (th.turns ?? []).forEach((t) =>
      (t.messages ?? []).forEach((m) => {
        if (m.type === "spawn") flattenThreads([m.thread], depth + 1, out);
      })
    );
  });
  return out;
}
