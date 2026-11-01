import { ChatSessionContext } from "../toolChange/ChatSessionContext";
import { Fragment, useContext, useId, useState, type ReactNode } from "react";
import type { ToolMessage } from "../types";
import { activityNames } from "./classification";
import { activitySummary } from "./grouping";
import { useDecisionActivities } from "./useDecisionActivities";
import { useActivities } from "./useActivities";
import type { ActivityAnalysis } from "./types";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`tool-activity-chevron${open ? " is-open" : ""}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m6 4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function callState(call: ToolMessage) {
  if (call.error || call.status === "err")
    return { tone: "error", label: "Recorded error" };
  if (call.status === "pending")
    return { tone: "pending", label: "Awaiting result" };
  return null;
}

function RecordedData({
  kind,
  content,
}: {
  kind: "Arguments" | "Recorded result";
  content?: ReactNode;
}) {
  const argumentsPanel = kind === "Arguments";
  return (
    <section className="tool-activity-raw-panel" aria-label={kind}>
      <div className="tool-activity-raw-heading">
        {argumentsPanel ? "Arguments" : "Result"}
        <span>
          {content === undefined ? "not yet recorded" : "as recorded"}
        </span>
      </div>
      {typeof content === "string" ? (
        <pre
          tabIndex={0}
          aria-label={argumentsPanel ? "Raw arguments" : "Raw recorded result"}
        >
          {content}
        </pre>
      ) : content != null ? (
        <div className="tool-activity-recorded-body">{content}</div>
      ) : (
        <div className="tool-activity-empty">No result recorded</div>
      )}
    </section>
  );
}

function CallDisclosure({
  call,
  analysis,
  onSelect,
  selected,
  rawOpen,
  onToggleRaw,
}: {
  call: ToolMessage;
  analysis: ActivityAnalysis;
  onSelect?: () => void;
  selected?: boolean;
  rawOpen: boolean;
  onToggleRaw: () => void;
}) {
  const open = call.onToggle ? call.collapsed === false : rawOpen;
  const rawId = useId();
  const state = callState(call);
  const operations = analysis.operations;
  const labels = [
    ...new Set(
      operations.flatMap((op) =>
        op.activities.map((label) => activityNames.get(label) ?? label)
      )
    ),
  ];
  const label =
    analysis.analysisState === "loading"
      ? "Analyzing…"
      : analysis.analysisState === "unavailable"
        ? "Analysis unavailable"
        : labels.length
          ? labels.slice(0, 2).join(" · ") +
            (labels.length > 2 ? ` · +${labels.length - 2} more` : "")
          : "Unclassified";
  const targets = [...new Set(operations.flatMap((op) => op.targets ?? []))];
  const relationships = [
    ...new Set(operations.flatMap((op) => op.relationships)),
  ].filter((r) => r !== "shell wrapper (requested)");
  return (
    <li
      className={`tool-activity-call${selected ? " sel" : ""}`}
      data-evt={call.evt}
    >
      <button
        type="button"
        className="tool-activity-call-toggle"
        aria-label={`${label} — Raw arguments and recorded result`}
        aria-expanded={open}
        aria-controls={open ? rawId : undefined}
        onClick={() => {
          onSelect?.();
          (call.onToggle ?? onToggleRaw)();
        }}
      >
        <Chevron open={open} />
        <span className="tool-activity-call-label">{label}</span>
        {operations.some((op) => op.inferredActivities?.length) ? (
          <span
            className="tool-activity-inferred"
            title="Activity inferred by the decision model"
          >
            inferred
          </span>
        ) : null}
        {state ? (
          <span
            className={`tool-activity-status is-${state.tone}`}
            title={state.label}
          >
            <span className="tool-activity-status-dot" aria-hidden="true" />
            <span className="sr-only">{state.label}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="tool-activity-raw" id={rawId}>
          <div className="tool-activity-note">
            Requested activity <span>Individual execution is unconfirmed</span>
          </div>
          <div className="tool-activity-provider">
            Tool:{" "}
            <span>{call.name ?? call.activityInput?.name ?? "Shell call"}</span>
          </div>
          {targets.length ? (
            <div className="tool-activity-detail-targets">
              {targets.map((target) => (
                <code className="tool-activity-target" key={target}>
                  {target}
                </code>
              ))}
            </div>
          ) : null}
          {relationships.length ? (
            <div className="tool-activity-call-relationships tool-activity-relationships">
              {relationships.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </div>
          ) : null}
          {[
            ...new Set(
              operations.flatMap((op) => (op.unresolved ? [op.unresolved] : []))
            ),
          ].map((reason) => (
            <div className="tool-activity-unresolved" key={reason}>
              {reason}
            </div>
          ))}

          {call.activityInput ? (
            <RecordedData
              kind="Arguments"
              content={
                call.rawInput ??
                JSON.stringify(call.activityInput.input, null, 2)
              }
            />
          ) : null}
          {!call.activityInput && call.args ? (
            <RecordedData kind="Arguments" content={call.args} />
          ) : null}
          <RecordedData
            kind="Recorded result"
            content={call.recordedResult ?? call.body}
          />
        </div>
      ) : null}
    </li>
  );
}

function ActivityGroup({
  calls,
  renderChanges,
  selectedEvt,
  onSelect,
}: {
  calls: ToolMessage[];
  selectedEvt?: string | null;
  onSelect?: (evt: string) => void;
  renderChanges?: (call: ToolMessage) => ReactNode;
}) {
  const [open, setOpen] = useState(() =>
    calls.some((call) => call.onToggle && call.collapsed === false)
  );
  const [rawExpanded, setRawExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const id = useId();
  const [retryToken, setRetryToken] = useState(0);
  const parsed = useActivities(calls, retryToken);
  const sessionId = useContext(ChatSessionContext);
  const rows = useDecisionActivities(parsed, sessionId, open);
  const summary = activitySummary(rows);
  const pending = calls.filter((call) => call.status === "pending").length;
  const errors = calls.filter(
    (call) => call.error || call.status === "err"
  ).length;
  return (
    <>
      <div className={`tool-activity-group${open ? " is-open" : ""}`}>
        <button
          type="button"
          className="tool-activity-summary"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <Chevron open={open} />
          <span className="tool-activity-count">
            {calls.length} {calls.length === 1 ? "call" : "calls"}
          </span>
          {" for "}
          <span className="tool-activity-label">
            {summary.labels.join(", ") || "tool activity"}
          </span>
          {summary.overflow ? (
            <span className="tool-activity-overflow">
              {" "}
              +{summary.overflow} more
            </span>
          ) : null}
          {pending || errors ? (
            <span className="tool-activity-summary-status">
              {pending ? <span>{pending} awaiting results</span> : null}
              {errors ? (
                <span className="is-error">{errors} recorded errors</span>
              ) : null}
            </span>
          ) : null}
        </button>
        {open ? (
          <div className="tool-activity-details" id={id}>
            {rows.some((row) => row.analysisState === "unavailable") ? (
              <button
                type="button"
                className="tool-activity-retry"
                onClick={() => setRetryToken((value) => value + 1)}
              >
                Retry analysis
              </button>
            ) : null}
            <ol className="tool-activity-calls">
              {calls.map((call, i) => (
                <CallDisclosure
                  key={call.toolId ?? call.evt}
                  call={call}
                  analysis={rows[i]}
                  selected={selectedEvt === call.evt}
                  onSelect={onSelect ? () => onSelect(call.evt) : undefined}
                  rawOpen={rawExpanded.has(call.toolId ?? call.evt)}
                  onToggleRaw={() =>
                    setRawExpanded((current) => {
                      const next = new Set(current);
                      const key = call.toolId ?? call.evt;
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
              ))}
            </ol>
          </div>
        ) : null}
      </div>
      {renderChanges
        ? calls.map((call) => (
            <Fragment key={call.toolId ?? call.evt}>
              {renderChanges(call)}
            </Fragment>
          ))
        : null}
    </>
  );
}

export function ToolActivityGroup(props: {
  calls: ToolMessage[];
  renderChanges?: (call: ToolMessage) => ReactNode;
  selectedEvt?: string | null;
  onSelect?: (evt: string) => void;
}) {
  const sessionId = useContext(ChatSessionContext);
  return <ActivityGroup key={sessionId ?? "trace"} {...props} />;
}
