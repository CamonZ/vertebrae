/* ──────────────────────────────────────────────────────────────────
   Hearth · Run Console — docked glass HUD for the workflow canvas.
   Global view of task runs + a launch surface, toggled Ready ↔ Running.
   Reads window.HEARTH_DATA (shared task data). Self-contained; the run
   state it mutates lives in component state (a live demo stream).
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const D = window.HEARTH_DATA;
  const TASKS = D.TASKS;
  const byId = D.byId;

  const ICON = {
    play:   <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>,
    stop:   <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>,
    search: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>,
    chev:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="9 18 15 12 9 6"/></svg>,
    bolt:   <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h8l-1 8 10-12h-8z"/></svg>,
    x:      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  };

  // step hue class for the left tick + pipeline segments
  const KIND_CLASS = {
    execute: 'k-execute', eval: 'k-eval', route: 'k-route',
    human: 'k-human', wait: 'k-wait', entry: 'k-entry', final: 'k-final',
  };

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  // current step of an in-flight task (from its pipeline if present)
  function currentStep(t) {
    if (t.pipeline) {
      const r = t.pipeline.find((p) => p.state === 'running');
      if (r) return r.kind;
      const q = t.pipeline.find((p) => p.state === 'queued');
      if (q) return q.kind;
    }
    return t.stepKind || (t._run === 'waiting' ? 'wait' : 'execute');
  }

  function Pipe({ pipeline, kind }) {
    if (!pipeline || !pipeline.length) return null;
    return (
      <div className="rc-pipe">
        {pipeline.map((p, i) => (
          <span key={i} className={'rc-seg ' + (KIND_CLASS[p.kind] || '') + ' ' +
            (p.state === 'completed' ? 'done' : p.state === 'running' ? 'run' : 'queued')} />
        ))}
      </div>
    );
  }

  function Row({ t, mode, onRun, onStop, onSelect, selected, now }) {
    const kc = KIND_CLASS[t.stepKind] || (mode === 'ready' ? 'k-entry' : 'k-execute');
    const meta = mode === 'running'
      ? (function () {
          const step = currentStep(t);
          const mc = t._run === 'waiting' ? 'var(--step-wait)' : 'var(--accent)';
          const rt = t._started ? fmtElapsed(now - t._started) : (t.runtime || '');
          return (
            <span className="rc-meta" style={{ '--mc': mc }}>
              <span className="pulse" />
              <span className="step">{step}</span>
              {rt ? <span>· {rt}</span> : null}
            </span>
          );
        })()
      : <span className="rc-meta">{t.when || ''}</span>;

    return (
      <div className={'rc-row' + (t._flash ? ' flash' : '') + (selected ? ' sel' : '')}
        onClick={() => onSelect(t.id)}>
        <span className={'rc-kind ' + kc} />
        <div className="rc-main">
          <div className="rc-top">
            <span className="rc-id">{t.id}</span>
            {t.priority === 'hi' ? <span className="rc-prio hi" title="high priority" /> : null}
            {t.priority === 'md' ? <span className="rc-prio md" title="medium priority" /> : null}
            {meta}
          </div>
          <div className="rc-title">{t.title}</div>
          <Pipe pipeline={t.pipeline} kind={t.stepKind} />
        </div>
        {mode === 'ready'
          ? <button className="rc-act run" title="Run this task" onClick={(e) => { e.stopPropagation(); onRun(t.id); }}>{ICON.play}</button>
          : <button className="rc-act stop" title="Stop run" onClick={(e) => { e.stopPropagation(); onStop(t.id); }}>{ICON.stop}</button>}
      </div>
    );
  }

  // ── Task Details panel — reuses the canonical window.TaskDetail in a
  //    right-docked glass shell, so it is the SAME panel as the Tasks list. ──
  function DetailPanel({ task, onSelect, onClose }) {
    const [shown, setShown] = useState(false);
    useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);
    const TaskDetail = window.TaskDetail;
    if (!task || !TaskDetail) return null;
    return (
      <div className={'rd' + (shown ? ' shown' : '')} data-no-pan>
        <TaskDetail task={task} onSelect={onSelect} onClose={onClose}
          onTraces={() => { location.href = 'traces-v2.html'; }} />
      </div>
    );
  }

  function RunConsole() {
    const [open, setOpen] = useState(false);
    const [shown, setShown] = useState(false);
    const [tab, setTab] = useState('ready');
    const [query, setQuery] = useState('');
    // live overrides keyed by task id: { run, started }
    const [ov, setOv] = useState({});
    const [flash, setFlash] = useState({});
    const [sel, setSel] = useState(null);
    const [now, setNow] = useState(Date.now());

    // tick for live runtimes
    useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

    // slide the HUD in on open (class-toggle transition, not a fill-mode animation)
    useEffect(() => {
      if (open) { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }
      setShown(false);
    }, [open]);

    const stateOf = (t) => (ov[t.id] ? ov[t.id].run : t.runState);

    const enriched = useMemo(() => TASKS.map((t) => Object.assign({}, t, {
      _run: stateOf(t),
      _started: ov[t.id] ? ov[t.id].started : null,
      _flash: !!flash[t.id],
    })), [ov, flash]);

    const isRunning = (rs) => rs === 'running' || rs === 'waiting';
    const isReady = (rs) => rs == null || rs === 'queued';

    const q = query.trim().toLowerCase();
    const match = (t) => !q || t.title.toLowerCase().includes(q) || t.id.includes(q) ||
      (t.tags && t.tags.some((g) => g.includes(q)));

    const running = enriched.filter((t) => isRunning(t._run) && match(t));
    const ready = enriched.filter((t) => isReady(t._run) && match(t))
      // launchable-first: never-run before queued
      .sort((a, b) => (a._run === 'queued' ? 1 : 0) - (b._run === 'queued' ? 1 : 0));

    const runCount = enriched.filter((t) => isRunning(t._run)).length;
    const readyCount = enriched.filter((t) => isReady(t._run)).length;
    const selTask = sel ? enriched.find((t) => t.id === sel) : null;

    function doFlash(id) {
      setFlash((f) => Object.assign({}, f, { [id]: true }));
      setTimeout(() => setFlash((f) => { const n = Object.assign({}, f); delete n[id]; return n; }), 700);
    }
    function onRun(id) {
      setOv((o) => Object.assign({}, o, { [id]: { run: 'running', started: Date.now() } }));
      doFlash(id);
      setTab('running');
    }
    function onStop(id) {
      setOv((o) => Object.assign({}, o, { [id]: { run: null, started: null } }));
    }
    function runAll() {
      const ids = ready.slice(0, 6).map((t) => t.id); // launch the top of the ready queue
      setOv((o) => { const n = Object.assign({}, o); ids.forEach((id) => { n[id] = { run: 'running', started: Date.now() }; }); return n; });
      ids.forEach(doFlash);
      setTab('running');
    }

    const list = tab === 'running' ? running : ready;

    return (
      <React.Fragment>
        {open ? (
        <div className={'rc' + (shown ? ' shown' : '')} data-no-pan>
          <div className="rc-hd">
            <div className="rc-hd-top">
              <span className="rc-eyebrow"><span className="ember" />Run Console</span>
              <span className="rc-live"><span className="pulse" />{runCount} running</span>
              <button className="rc-collapse" title="Collapse" onClick={() => setOpen(false)}>{ICON.x}</button>
            </div>
            <div className="rc-tabs">
              <button className={'rc-tab' + (tab === 'ready' ? ' on' : '')} onClick={() => setTab('ready')}>
                Ready<span className="n">{readyCount}</span>
              </button>
              <button className={'rc-tab' + (tab === 'running' ? ' on' : '')} onClick={() => setTab('running')}>
                Running<span className="n">{runCount}</span>
              </button>
            </div>
            <div className="rc-search">
              {ICON.search}
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tasks by name, id, tag…" />
            </div>
          </div>

          <div className="rc-list">
            {list.length === 0
              ? <div className="rc-empty">{tab === 'running' ? 'No runs in flight.' : 'No ready tasks match.'}</div>
              : list.map((t) => <Row key={t.id} t={t} mode={tab} onRun={onRun} onStop={onStop} onSelect={setSel} selected={sel === t.id} now={now} />)}
          </div>

          <div className="rc-ft">
            <span className="rc-ag">
              <b>{runCount}</b> running <span className="dot">·</span> <b>{readyCount}</b> ready <span className="dot">·</span> $0
            </span>
            {tab === 'ready' && ready.length > 0
              ? <button className="btn primary" onClick={runAll}>{ICON.bolt}Run all</button>
              : null}
          </div>
        </div>
        ) : (
          <button className="rc-fab" data-no-pan onClick={() => setOpen(true)} title="Open run controls">
            <span className="rc-fab-ico">{ICON.bolt}</span>
            <span className="rc-fab-label">Runs</span>
            {runCount > 0 ? <span className="rc-fab-count"><span className="pulse" />{runCount}</span> : null}
          </button>
        )}

        {selTask ? <DetailPanel key={selTask.id} task={Object.assign({}, selTask, { runState: selTask._run })} onSelect={setSel} onClose={() => setSel(null)} /> : null}
      </React.Fragment>
    );
  }

  window.RunConsole = RunConsole;
})();
