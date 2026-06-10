/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Thread (recursive)

   The canonical model:
     Task › Run › Thread › Turn › Message{ user · system · agent · tool }
   …where THREAD is recursive — a tool call of kind "spawn" opens a child
   Thread (an orchestrator step, or a subagent). Chat and Traces are the
   SAME component over this tree; the difference is a capability flag:
     · chat   → mode="bare"  reveal="shallow" interactive
     · traces → mode="timed" reveal="deep"     readOnly (for now)

   A Thread renders:
     · a HEAD (root: a quiet step rule · nested: a collapsible summary
       line with a left spine colored by step kind)
     · its TURNS — each turn is the ordered series of messages, drawn by
       the shared <EventRow> atoms (lib-eventlog). A turn that contains a
       spawn renders a child <Thread>, indented under its parent's spine.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState } = React;
  const EventRow = window.EventRow;
  const IdChip = window.IdChip || (() => null);

  const CSS = `
  /* ── root thread head — a quiet step rule that opens a thread ── */
  .thread { display: flex; flex-direction: column; width: 100%; }
  .thread-head { display: grid; gap: var(--s-3); align-items: center; }
  .thread-head.timed { grid-template-columns: 76px minmax(0, 1fr); padding: var(--s-4) 0 var(--s-1h); }
  .thread-head.bare  { grid-template-columns: minmax(0, 1fr); padding: var(--s-2) 0 0; }
  .thread:first-child .thread-head { padding-top: var(--s-1); }
  .th-bar { display: flex; align-items: center; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--line); cursor: pointer; min-width: 0; }
  .th-tick { width: 8px; height: 8px; border-radius: 2px; background: var(--kc, var(--step-execute)); flex-shrink: 0; }
  .th-arrow { color: var(--fg-ghost); font-family: var(--mono); font-size: var(--text-12); }
  .th-name { font-family: var(--mono); font-size: var(--text-12); color: var(--fg); letter-spacing: 0.01em; white-space: nowrap; }
  .thread-head.sel .th-name { color: var(--accent); }
  .th-bar:hover .th-name { color: var(--fg); }
  .th-kind { font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.16em; text-transform: uppercase; color: var(--kf, var(--step-execute-fg)); margin-left: var(--s-1); padding: 1px var(--s-1h); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-xs); flex-shrink: 0; }
  .th-sum { font-family: var(--mono); font-size: var(--text-9); color: var(--fg-faint); margin-left: var(--s-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .th-bar .c-id-chip { flex-shrink: 0; }
  .th-rt { margin-left: auto; font-family: var(--mono); font-size: var(--text-9); color: var(--fg-faint); letter-spacing: 0.04em; flex-shrink: 0; padding-left: var(--s-2); }
  .thread-head .evwhen { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); text-align: right; padding-top: var(--s-3); line-height: 1.35; }
  .thread-head .evwhen .rel { display: block; font-size: var(--text-9); color: var(--fg-mute); margin-top: 1px; }

  .thread-body { display: flex; flex-direction: column; }
  .evlog--timed .thread-body { gap: 1px; }
  .evlog--bare  .thread-body { gap: var(--s-4); }

  /* ── turn separator — the conversational-turn boundary, kept quiet ── */
  .turn-sep { display: grid; gap: var(--s-3); align-items: center; }
  .turn-sep.timed { grid-template-columns: 76px minmax(0, 1fr); padding: var(--s-3) 0 var(--s-1h); }
  .turn-sep.bare  { grid-template-columns: minmax(0, 1fr); padding: var(--s-2) 0 0; }
  .turn-sep .lab { display: flex; align-items: center; gap: var(--s-2); font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.16em; text-transform: uppercase; color: var(--fg-faint); }
  .turn-sep .lab::after { content: ''; flex: 1; height: 1px; background: var(--line); }

  /* ── spawn row — wraps a nested thread so it aligns to the content col ── */
  .thr-row { display: grid; gap: var(--s-3); }
  .thr-row.timed { grid-template-columns: 76px minmax(0, 1fr); }
  .thr-row.bare  { grid-template-columns: minmax(0, 1fr); }

  /* ── nested thread (subagent / sub-step) — spine + collapsible ── */
  .subthread { padding-left: var(--s-3); border-left: 2px solid color-mix(in oklch, var(--kc, var(--step-execute)) 55%, transparent); margin: var(--s-2) 0; min-width: 0; }
  .sth-sum { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-1h) var(--s-2h); background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-sm); cursor: pointer; font-family: var(--mono); font-size: var(--text-11); min-width: 0; transition: background var(--t-fast) var(--ease); }
  .sth-sum:hover { background: var(--bg-3); }
  .subthread.open > .sth-sum { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; }
  .sth-spawn { color: var(--kf, var(--step-execute-fg)); flex-shrink: 0; }
  .sth-kind { color: var(--kf, var(--step-execute-fg)); letter-spacing: 0.14em; text-transform: uppercase; font-size: var(--text-9); flex-shrink: 0; }
  .sth-name { color: var(--fg); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .sth-meta { color: var(--fg-faint); white-space: nowrap; flex-shrink: 0; }
  .sth-status { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .sth-spin { width: 9px; height: 9px; border: 1.5px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: th-spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes th-spin { to { transform: rotate(360deg); } }
  .sth-chev { margin-left: auto; color: var(--fg-faint); font-size: var(--text-9); flex-shrink: 0; transition: transform var(--t-fast) var(--ease); }
  .subthread:not(.open) .sth-chev { transform: rotate(-90deg); }
  .sth-focus { color: var(--fg-faint); cursor: pointer; flex-shrink: 0; display: inline-flex; padding: 0 var(--s-0); font-size: var(--text-12); }
  .sth-focus:hover { color: var(--accent); }
  .sth-body { padding: var(--s-2) 0 var(--s-2) var(--s-2h); border-left: 1px solid var(--line); margin-left: 1px; }
  .subthread.open > .sth-body { background: color-mix(in oklch, var(--bg-1) 40%, transparent); }
  `;

  function injectCSS() {
    if (typeof document === 'undefined' || document.getElementById('hearth-thread-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-thread-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  injectCSS();

  function StatusMark({ status }) {
    if (status === 'running') return <span className="sth-spin" />;
    const c = status === 'err' ? 'var(--err)' : status === 'waiting' ? 'var(--warn)' : 'var(--ok)';
    return <span className="sth-status" style={{ background: c }} />;
  }

  /* ── Turn — the ordered message series; a spawn becomes a child Thread ── */
  function Turn(props) {
    const { turn, tindex, showSep, mode, depth, reveal, selectedEvt, onSelect, registerRef, onFocus } = props;
    const msgs = turn.messages || [];
    return (
      <React.Fragment>
        {showSep ? (
          <div className={'turn-sep ' + mode}>
            {mode === 'timed' ? <div /> : null}
            <div className="lab">turn {tindex + 1}</div>
          </div>
        ) : null}
        {msgs.map((m, i) => {
          if (m.type === 'spawn') {
            return (
              <Thread key={m.thread.id} thread={m.thread} depth={depth + 1} mode={mode} reveal={reveal}
                selectedEvt={selectedEvt} onSelect={onSelect} registerRef={registerRef} onFocus={onFocus} />
            );
          }
          if (reveal === 'shallow' && m.type === 'system') return null;
          return <EventRow key={m.evt || i} {...m} selected={selectedEvt === m.evt} onClick={() => onSelect && onSelect(m.evt)} />;
        })}
      </React.Fragment>
    );
  }

  /* ── Thread — recursive. depth 0 = a run's step; depth>0 = a subthread ── */
  function Thread(props) {
    const { thread, depth = 0, mode = 'timed', reveal = 'deep', showHead = true, selectedEvt, onSelect, registerRef, onFocus } = props;
    const nested = depth > 0;
    const [open, setOpen] = useState(!nested); // root threads open; subthreads collapsed
    const kind = (thread.step && thread.step.kind) || thread.kind || 'execute';
    const sum = thread.summary || {};
    const turns = thread.turns || [];
    const showTurns = reveal === 'deep' && turns.length > 1;

    const bodyTurns = (
      <div className="thread-body">
        {turns.map((t, i) => (
          <Turn key={t.id || i} turn={t} tindex={i} showSep={showTurns}
            mode={mode} depth={depth} reveal={reveal}
            selectedEvt={selectedEvt} onSelect={onSelect} registerRef={registerRef} onFocus={onFocus} />
        ))}
      </div>
    );

    if (nested) {
      return (
        <div className={'thr-row ' + mode}>
          {mode === 'timed' ? <div /> : null}
          <div className={'subthread k-' + kind + (open ? ' open' : '')}
            ref={(el) => registerRef && registerRef(thread.id, el)}>
            <div className="sth-sum" onClick={() => { setOpen((o) => !o); onSelect && onSelect(thread.id); }}>
              <span className="sth-spawn">⤷</span>
              <StatusMark status={sum.status} />
              <span className="sth-kind">{thread.spawnLabel || 'subagent'}</span>
              <span className="sth-name">{thread.label}</span>
              <span className="sth-meta">
                {sum.turns != null ? sum.turns + ' turns' : null}
                {sum.tools != null ? ' · ' + sum.tools + ' tools' : null}
                {sum.dur ? ' · ' + sum.dur : null}
              </span>
              <IdChip id={thread.id} />
              {onFocus ? (
                <span className="sth-focus" title="Open in focus" onClick={(e) => { e.stopPropagation(); onFocus(thread); }}>⤢</span>
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
    const st = thread.step || {};
    const sel = selectedEvt === thread.id ? ' sel' : '';
    return (
      <div className="thread" ref={(el) => registerRef && registerRef(thread.id, el)}>
        {showHead ? (
          <div className={'thread-head ' + mode + sel + ' k-' + kind}>
            {mode === 'timed' ? (
              <div className="evwhen">{st.at}{st.rel ? <span className="rel">{st.rel}</span> : null}</div>
            ) : null}
            <div className="th-bar" onClick={() => onSelect && onSelect(thread.id)}>
              <span className="th-tick" />
              <span className="th-arrow">→</span>
              <span className="th-name">{stepName}</span>
              <span className="th-kind">{kind}</span>
              {sum.turns != null ? <span className="th-sum">{sum.turns} turns · {sum.tools} tools</span> : null}
              {thread.id ? <IdChip id={thread.id} /> : null}
              {st.runtime ? <span className="th-rt">{st.runtime}</span> : null}
            </div>
          </div>
        ) : null}
        {bodyTurns}
      </div>
    );
  }

  /* ── flatten a run's thread tree into rail nav nodes ── */
  function flattenThreads(threads, depth, out) {
    (threads || []).forEach((th) => {
      out.push({
        id: th.id,
        label: (th.step && th.step.to) || th.label,
        kind: (th.step && th.step.kind) || th.kind || 'execute',
        depth: depth,
        summary: th.summary || {},
      });
      (th.turns || []).forEach((t) => (t.messages || []).forEach((m) => {
        if (m.type === 'spawn') flattenThreads([m.thread], depth + 1, out);
      }));
    });
    return out;
  }

  Object.assign(window, { Thread, flattenThreads });
})();
