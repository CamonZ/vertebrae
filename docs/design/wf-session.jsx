/* ──────────────────────────────────────────────────────────────────
   Hearth · Workflow Graph — Session log body (window.WfSessionBody)
   The Traces event stream, docked inside the graph inspector. Renders
   window.WFSessions[wfId] as a grouped <EventLog>, streams the live
   group in on open, auto-tails, and reports the hovered/clicked step up
   so the canvas can light the matching node.

   props: { session, traceStepId, onTraceStep(stepId|null),
            onFrameStep(stepId) }
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef } = React;

  function StatusChip({ state, label }) {
    const live = state === 'running' || state === 'waiting' || state === 'active';
    return (
      <span className={'wfsx-status s-' + state + (live ? ' live' : '')}>
        {live ? <span className="pulse" /> : null}{label || state}
      </span>
    );
  }

  function FollowSwitch({ on, onToggle }) {
    return (
      <button type="button" className={'wfsx-follow' + (on ? ' on' : '')} onClick={onToggle}
        title={on ? 'Following the live tail' : 'Paused — click to follow'}>
        <span className="dot" />{on ? 'Following' : 'Paused'}
      </button>
    );
  }

  function WfSessionBody({ session, traceStepId, onTraceStep, onFrameStep }) {
    const EventLog = window.EventLog, EventRow = window.EventRow, IdChip = window.IdChip;
    const groups = session.groups || [];
    const liveIdx = groups.findIndex((g) => g.step.live);
    const liveGroupIdx = liveIdx === -1 ? groups.length - 1 : liveIdx;
    const liveGroup = groups[liveGroupIdx];
    const liveCount = liveGroup ? liveGroup.events.length : 0;

    // stream the live group's events in, one at a time
    const [revealed, setRevealed] = useState(session.live ? 1 : liveCount);
    const [follow, setFollow] = useState(true);
    const [selEvt, setSelEvt] = useState(null);
    const streamRef = useRef(null);

    // reset reveal when the session changes
    useEffect(() => { setRevealed(session.live ? 1 : liveCount); }, [session.taskId]);

    useEffect(() => {
      if (!session.live || revealed >= liveCount) return;
      const id = setTimeout(() => setRevealed((n) => Math.min(n + 1, liveCount)), 1500);
      return () => clearTimeout(id);
    }, [revealed, liveCount, session.live, session.taskId]);

    // auto-tail to the bottom as events arrive, unless the user scrolled up
    useEffect(() => {
      const el = streamRef.current; if (!el || !follow) return;
      el.scrollTop = el.scrollHeight;
    }, [revealed, follow]);

    function onScroll() {
      const el = streamRef.current; if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
      if (!atBottom && follow) setFollow(false);
    }

    const stepNo = groups.indexOf(liveGroup) + 1;
    const total = groups.length;

    function renderGroup(g, gi) {
      const isLive = gi === liveGroupIdx && session.live;
      const evs = isLive ? g.events.slice(0, revealed) : g.events;
      const traced = traceStepId === g.step.stepId;
      return (
        <React.Fragment key={g.step.stepId + '.' + gi}>
          <div
            onMouseEnter={() => onTraceStep && onTraceStep(g.step.stepId)}
            onMouseLeave={() => onTraceStep && onTraceStep(null)}
            onClick={() => { onFrameStep && onFrameStep(g.step.stepId); setSelEvt(g.step.stepId + ':' + gi); }}>
            <EventRow type="step" to={g.step.to} kind={g.step.kind}
              at={g.step.at} rel={g.step.rel} runtime={g.step.runtime}
              selected={traced || selEvt === g.step.stepId + ':' + gi} />
          </div>
          {evs.map((e) => (
            <EventRow key={e.evt} {...e}
              selected={selEvt === e.evt}
              onClick={() => setSelEvt(e.evt)} />
          ))}
        </React.Fragment>
      );
    }

    return (
      <div className="wfd-session">
        {/* pinned session sub-header */}
        <div className="wfsx-hd">
          <div className="wfsx-row">
            <span className="wfsx-eyebrow"><span className="ember" />Live session</span>
            <StatusChip state={session.state} label={session.stateLabel} />
          </div>
          <div className="wfsx-task">{session.taskTitle}</div>
          <div className="wfsx-meta">
            {IdChip ? <IdChip id={session.taskId} /> : <span className="mono">{session.taskId}</span>}
            <span className="sep">·</span>
            <span>run {IdChip ? <IdChip id={session.runId} /> : session.runId}</span>
            <span className="sep">·</span>
            <span>started {session.started}</span>
          </div>
          <div className="wfsx-progress">
            <span className="wfsx-step">
              step <b>{stepNo}</b> / {total}
              <span className="cur"> · {liveGroup ? liveGroup.step.to : '—'}</span>
            </span>
            <span className="wfsx-elapsed">{session.elapsed}</span>
            <FollowSwitch on={follow} onToggle={() => { setFollow((v) => !v); }} />
          </div>
        </div>

        {/* scrollable, auto-tailing event stream */}
        <div className="wfsx-stream evlog evlog--timed" ref={streamRef} onScroll={onScroll} data-no-pan>
          {groups.map(renderGroup)}
          {session.live ? (
            <div className="wfsx-tail">
              <span className="bar" /><span className="lbl">live · streaming from run {session.runId}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  window.WfSessionBody = WfSessionBody;
})();
