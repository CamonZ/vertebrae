/* ──────────────────────────────────────────────────────────────────
   Hearth · Operations v2 — App (React)
   A calm operations overview — sectioned, scannable, lightly editorial.
   Serif section heads for warmth; clean component-built lists for the work.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { RunChip, IdChip, Pipeline, StateBreakdown, Glyph, WorkflowRailItem, AppShell, LiveCount } = window;
  const D = window.HEARTH_DATA;
  const { TASKS, byId, isActiveRun } = D;

  const RUN_LABEL = { running: 'Running', waiting: 'Waiting', queued: 'Queued' };
  const running = TASKS.filter(t => t.runState === 'running');
  const waiting = TASKS.filter(t => t.runState === 'waiting');
  const queued = TASKS.filter(t => t.runState === 'queued');
  const done = TASKS.filter(t => t.runState === 'completed');

  function childBreakdown(t) {
    let d = 0, r = 0, w = 0, q = 0;
    (t.children || []).forEach(cid => {
      const c = byId[cid]; if (!c) return;
      if (c.runState === 'completed') d++;
      else if (c.runState === 'running') r++;
      else if (c.runState === 'waiting') w++;
      else if (c.runState === 'queued') q++;
    });
    return { done: d, running: r, waiting: w, queued: q };
  }

  function OpRow({ t }) {
    const bd = t.children && t.children.length ? childBreakdown(t) : null;
    return (
      <a className="op-row" href={'tasks-v2.html#' + t.id}>
        <Glyph level={t.level} accent={t.runState === 'running'} />
        <div className="op-main">
          <span className="op-title">{t.title}</span>
          <span className="op-meta">
            {isActiveRun(t.runState) ? <RunChip state={t.runState} label={RUN_LABEL[t.runState]} runtime={t.runtime} sm /> : null}
            {t.pipeline && t.pipeline.length ? <Pipeline width={104} segments={t.pipeline.map(s => ({ kind: s.kind, state: s.state }))} /> : null}
            {bd && (bd.done || bd.running || bd.waiting || bd.queued) ? <StateBreakdown {...bd} /> : null}
            <IdChip id={t.id} />
          </span>
        </div>
        <span className="op-when">{t.when}</span>
      </a>
    );
  }

  const SecTitle = ({ children, count }) => (
    <div className="sec-title-row">
      <h2 className="sec-title">{children}</h2>
      {count != null ? <span className="sec-count">{count}</span> : null}
    </div>
  );

  function Signal({ kind, text, sub, when }) {
    const dot = kind === 'error' ? 'err' : kind === 'wait' ? 'wait' : kind === 'ok' ? 'ok' : 'run';
    return (
      <div className="sig-row">
        <span className={'sig-dot ' + dot} />
        <span className="sig-text">{text}{sub ? <span className="sub"> · {sub}</span> : null}</span>
        <span className="sig-when">{when}</span>
      </div>
    );
  }

  function OperationsApp() {
    const summary = running.length === 1
      ? 'One run working'
      : `${running.length} runs working`;
    return (
      <AppShell page="Operations" active="ops" kbd={false} activity={
        <>
          <LiveCount running={running.length} />
          <span className="total"><b>{TASKS.length}</b> tasks</span>
        </>
      }>
        <main className="ops">
          <div className="ops-wrap">

            {/* Header */}
            <header className="ops-header">
              <div>
                <h1 className="ops-title">Operations</h1>
                <p className="ops-sub">{summary}, one holding on children for <em>7h 36m</em>. Queue is deep but moving.</p>
              </div>
              <div className="ops-summary">
                <div className="op-cell"><div className="n accent">{running.length}</div><div className="l">running</div></div>
                <div className="op-cell"><div className="n warn">{waiting.length}</div><div className="l">waiting</div></div>
                <div className="op-cell"><div className="n">{queued.length}</div><div className="l">queued</div></div>
                <div className="op-cell"><div className="n ok">{done.length}</div><div className="l">filed</div></div>
              </div>
            </header>

            {/* Body */}
            <div className="ops-body">
              <div className="ops-main">
                <section className="ops-block">
                  <SecTitle count={running.length}>In <span className="it">flight</span></SecTitle>
                  <div className="op-list">
                    {running.map(t => <OpRow key={t.id} t={t} />)}
                    {running.length === 0 ? <div className="op-empty">Nothing running.</div> : null}
                  </div>
                </section>

                <section className="ops-block">
                  <SecTitle count={waiting.length + queued.length}>Holding &amp; <span className="it">queued</span></SecTitle>
                  <div className="op-list">
                    {waiting.map(t => <OpRow key={t.id} t={t} />)}
                    {queued.slice(0, 6).map(t => <OpRow key={t.id} t={t} />)}
                  </div>
                </section>
              </div>

              <aside className="ops-rail">
                <section className="side-card">
                  <SecTitle>Needs a <span className="it">look</span></SecTitle>
                  <div className="sig-list">
                    <Signal kind="error" text="run_tests failed" sub="2/41 · retried green" when="+9m" />
                    <Signal kind="wait" text="wait_for_children" sub="3 children · 7h 36m" when="+36m" />
                    <Signal kind="run" text="tool fan-out → mutate" sub="durable write" when="+41m" />
                    <Signal kind="ok" text="project_activity emitted" when="+7h" />
                  </div>
                </section>

                <section className="side-card">
                  <SecTitle>Workflows</SecTitle>
                  <div className="wf-list">
                    <WorkflowRailItem name="Chat Runner Lifecycle" live={1} steps={7} daily={10}
                      shape={['execute', 'eval', 'route', 'execute', 'wait', 'execute', 'terminal']} />
                    <WorkflowRailItem name="OpenRouter · Streaming" steps={4} daily={88}
                      shape={['execute', 'execute', 'execute', 'terminal']} />
                    <WorkflowRailItem name="Tracker · Mutation" steps={5} daily={31}
                      shape={['execute', 'execute', 'eval', 'execute', 'terminal']} />
                  </div>
                </section>
              </aside>
            </div>

          </div>
        </main>
      </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<OperationsApp />);
})();
