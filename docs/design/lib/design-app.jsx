/* ──────────────────────────────────────────────────────────────────
   Hearth · Design v2 — App (React)
   Workflow catalog + graph canvas + runtime overlay + inspector,
   built on the component library.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;
  const {
    WorkflowRailItem, StepNode, GraphEdge, Minimap, ZoomWidget,
    OverlayToggle, KindChip, RecentItem, FieldRow, RunChip, IdChip,
    SearchBar, IconButton, AppShell, LiveCount,
  } = window;

  const WORKFLOWS = [
    { id: 'chat-runner-lifecycle', name: 'Chat Runner Lifecycle', shape: ['execute', 'eval', 'route', 'execute', 'execute', 'execute', 'wait', 'execute', 'terminal'], steps: 7, runsLive: 1, runs24h: 10, avg: '4m 12s' },
    { id: 'authoring-verifier-gate', name: 'Authoring · Verifier Gate', shape: ['execute', 'eval', 'human', 'execute', 'terminal'], steps: 5, runsLive: 0, runs24h: 14, avg: '1m 38s' },
    { id: 'work-breakdown-draft', name: 'Work Breakdown · Draft to Tasks', shape: ['execute', 'eval', 'route', 'execute', 'execute', 'terminal'], steps: 6, runsLive: 0, runs24h: 4, avg: '2m 04s' },
    { id: 'tracker-mutation', name: 'Tracker · Mutation Pipeline', shape: ['execute', 'execute', 'eval', 'execute', 'terminal'], steps: 5, runsLive: 0, runs24h: 31, avg: '0m 22s' },
    { id: 'openrouter-stream', name: 'OpenRouter · Streaming Inference', shape: ['execute', 'execute', 'execute', 'terminal'], steps: 4, runsLive: 0, runs24h: 88, avg: '11s' },
    { id: 'investigation-resume', name: 'Investigation · Wait & Resume', shape: ['execute', 'wait', 'eval', 'human', 'execute', 'terminal'], steps: 6, runsLive: 0, runs24h: 2, avg: '38m 11s' },
    { id: 'human-review', name: 'Human Review · Approval Loop', shape: ['execute', 'human', 'route', 'terminal'], steps: 4, runsLive: 0, runs24h: 7, avg: '12m 09s' },
    { id: 'session-rehydrate', name: 'Session · Rehydration', shape: ['execute', 'execute', 'eval', 'execute', 'terminal'], steps: 5, runsLive: 0, runs24h: 16, avg: '0m 41s' },
    { id: 'planning-investigate', name: 'Planning · Investigation Run', shape: ['eval', 'route', 'execute', 'execute', 'eval', 'terminal'], steps: 6, runsLive: 0, runs24h: 6, avg: '8m 22s' },
    { id: 'artifact-attach', name: 'Artifact · Attach & Project', shape: ['execute', 'eval', 'execute', 'terminal'], steps: 4, runsLive: 0, runs24h: 22, avg: '0m 19s' },
  ];

  const NODES = [
    { step: 'accept', kind: 'execute', num: 1, title: 'accept_user_turn', desc: 'Ingest user signal, validate, persist.', left: 30, top: 200 },
    { step: 'eval', kind: 'eval', num: 2, title: 'classify_intent', desc: 'Model-evaluate intent & tools needed.', left: 220, top: 200 },
    { step: 'route', kind: 'route', num: 3, title: 'route_to_tools', desc: 'Dispatch parallel tool invocations.', left: 410, top: 200 },
    { step: 'exec_a', kind: 'execute', num: '4a', title: 'tool · read', desc: 'Read-only tool calls.', left: 600, top: 110 },
    { step: 'exec_b', kind: 'execute', num: '4b', title: 'tool · mutate', desc: 'Mutating tool calls, durable.', left: 600, top: 200, done: '✓ 2m ago · 12s' },
    { step: 'exec_c', kind: 'execute', num: '4c', title: 'tool · llm', desc: 'Sub-model inference calls.', left: 600, top: 290 },
    { step: 'wait', kind: 'wait', num: 5, title: 'wait_for_children', desc: 'Suspend until fan-out completes.', left: 790, top: 200, active: true, runs: '1 running · 7h 36m' },
    { step: 'project', kind: 'execute', num: 6, title: 'project_activity', desc: 'Emit client-safe activity events.', left: 980, top: 200 },
    { step: 'complete', kind: 'terminal', num: 7, title: 'return', left: 1170, top: 200, width: 90 },
  ];
  const EDGES = [
    { d: 'M186,232 C203,232 203,232 220,232' },
    { d: 'M376,232 C393,232 393,232 410,232' },
    { d: 'M566,232 C583,232 583,142 600,142' },
    { d: 'M566,232 C583,232 583,232 600,232' },
    { d: 'M566,232 C583,232 583,322 600,322' },
    { d: 'M756,142 C773,142 773,232 790,232' },
    { d: 'M756,232 C773,232 773,232 790,232', live: true },
    { d: 'M756,322 C773,322 773,232 790,232' },
    { d: 'M946,232 C963,232 963,232 980,232' },
    { d: 'M1136,232 C1153,232 1153,232 1170,232' },
  ];

  function DesignApp() {
    const [query, setQuery] = useState('');
    const [selectedWf, setSelectedWf] = useState('chat-runner-lifecycle');
    const [selectedNode, setSelectedNode] = useState(null);
    const [overlay, setOverlay] = useState('active');
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [selectedRun, setSelectedRun] = useState('40628099');
    const canvasRef = useRef(null);

    const live = overlay !== 'off';
    const workflows = useMemo(() => WORKFLOWS.filter(w => !query || w.name.toLowerCase().indexOf(query.toLowerCase()) !== -1), [query]);

    // center on active node once
    useEffect(() => {
      const canvas = canvasRef.current; if (!canvas) return;
      const active = canvas.querySelector('.step-node.active');
      if (active && active.offsetLeft > 0) {
        canvas.scrollLeft = Math.max(0, active.offsetLeft - (canvas.clientWidth - active.offsetWidth) / 2);
      }
    }, []);

    function openNode(step) {
      setSelectedNode(step);
      setInspectorOpen(true);
    }

    return (
      <AppShell page="Design" active="design" activity={
        <>
          <LiveCount running={1} />
          <span className="total"><b>10</b> workflows</span>
        </>
      }>
        <main className="design-main">
          {/* Workflow list */}
          <aside className="wf-list">
            <header className="wf-list-head">
              <div>
                <div className="h-title">Workflow Pipelines</div>
                <div className="h-meta"><b>10</b> definitions</div>
              </div>
              <SearchBar value={query} onChange={setQuery} placeholder="Search workflows…" hint={null} />
            </header>
            <div className="wf-list-body">
              {workflows.map(w => (
                <WorkflowRailItem key={w.id} name={w.name} shape={w.shape}
                  live={w.runsLive} steps={w.steps} daily={w.runs24h} avg={w.avg}
                  selected={w.id === selectedWf} onClick={() => setSelectedWf(w.id)} />
              ))}
            </div>
          </aside>

          {/* Canvas */}
          <section className="canvas-col">
            <header className="canvas-head">
              <div className="wf-name">
                <div className="crumb">workflow · live-chat</div>
                <h1>Chat Runner <em>Lifecycle</em></h1>
              </div>
              <div className="canvas-controls">
                <OverlayToggle defaultValue="active" onChange={setOverlay} options={[
                  { id: 'active', label: 'Active runs', pulse: true }, { id: 'recent', label: 'Recent' }, { id: 'off', label: 'Off' },
                ]} />
                <IconButton title="Fit" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>} />
                <IconButton title="Toggle inspector" onClick={() => setInspectorOpen(o => !o)} icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="13" height="18" rx="1.5" /><line x1="18" y1="8" x2="21" y2="8" /><line x1="18" y1="12" x2="21" y2="12" /><line x1="18" y1="16" x2="21" y2="16" /></svg>} />
              </div>
            </header>

            <div className="canvas" ref={canvasRef}>
              <div className="canvas-inner">
                <svg className="edges" viewBox="0 0 1280 480" preserveAspectRatio="none">
                  <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)" /></marker>
                  </defs>
                  {EDGES.map((e, i) => (e.live && !live)
                    ? null
                    : <GraphEdge key={i} d={e.d} live={e.live} markerEnd={e.live ? null : 'url(#arrow)'} />)}
                </svg>

                {NODES.map(n => {
                  const isActive = n.active && live;
                  const style = { position: 'absolute', left: n.left, top: n.top };
                  if (n.width) style.width = n.width;
                  return (
                    <StepNode key={n.step} num={n.num} kind={n.kind} title={n.title} desc={n.desc}
                      active={isActive} selected={selectedNode === n.step} runs={isActive ? n.runs : null}
                      style={style} onClick={() => openNode(n.step)}>
                      {n.done ? <div className="sn-done">{n.done}</div> : null}
                    </StepNode>
                  );
                })}
              </div>

              <div style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 3 }}><ZoomWidget /></div>
              <div style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 3 }}><Minimap /></div>
            </div>

            {/* Active runs strip */}
            <footer className="runs-strip">
              <span className="lbl">Active runs <span style={{ color: 'var(--accent)' }}>·</span></span>
              <div className={'strip-run' + (selectedRun === '40628099' ? ' sel' : '')} onClick={() => setSelectedRun('40628099')}>
                <RunChip state="waiting" label="Waiting" runtime="7h 36m" />
                <span className="run-title">Emit chat runner activity events</span>
                <span className="at-step">at step <em>5 · wait</em></span>
                <IdChip id="40628099" />
              </div>
              <span style={{ color: 'var(--fg-faint)', fontFamily: 'var(--mono)', fontSize: 10 }}>10 completions in last 24h · avg 4m 12s</span>
            </footer>
          </section>

          {/* Inspector */}
          <aside className={'inspector' + (inspectorOpen ? '' : ' closed')}>
            <header className="inspector-head">
              <div className="pre">step 5 of 7</div>
              <div className="title">wait_for_children</div>
              <div className="kind-row">
                <KindChip kind="wait" label="wait" />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>• 1 running</span>
              </div>
            </header>
            <div className="inspector-body">
              <div className="sub-lbl">Contract</div>
              <div className="prose">
                <p>Suspend execution until all fanned-out child runs reach a terminal state. Resume the parent with the merged outputs.</p>
                <p style={{ marginTop: 'var(--s-2)' }}>Listens on <span style={{ fontFamily: 'var(--mono)', color: 'var(--fg-mute)' }}>child.terminal</span> signals via the session AgentServer.</p>
              </div>

              <div className="sub-lbl">Currently running</div>
              <RecentItem variant="running" title="Emit chat runner activity events" when="7h 36m" />

              <div className="sub-lbl">Recent completions</div>
              <RecentItem variant="done" muted title="Stream live chat — turn 184" when="2m" />
              <RecentItem variant="done" muted title="Drive authoring intents — verifier pass" when="11m" />
              <RecentItem variant="done" muted title="Expose tracker operations — chat turn" when="38m" />

              <div className="sub-lbl">Stats</div>
              <FieldRow k="Step kind" v="wait" tone="wait" />
              <FieldRow k="Avg duration" v="3m 47s" />
              <FieldRow k="p95" v="14m 02s" />
              <FieldRow k="Outliers (24h)" v="1 · 7h 36m" tone="accent" />
              <FieldRow k="Error rate" v="0.0%" tone="ok" />
              <FieldRow k="Throughput" v="~3 runs / hr" />
            </div>
          </aside>
        </main>
      </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<DesignApp />);
})();
