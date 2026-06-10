/* ──────────────────────────────────────────────────────────────────
   Hearth · Workflow Atlas — all workflows at once (the MAP).
   Same single source of truth as the Graph page (window.WFGraph), but
   laid out by WFElk.layoutCondensed(): step-level edges are aggregated
   up to workflow→workflow, then ELK lays the workflow-only graph out
   left→right. ELK's LAYERS become the value-stream columns — so the
   "stages" are derived from the data, never hand-placed.

   Inside each card the step sequence is reduced four ways (switchable):
     Ribbon · Pipeline · Grouped (run-length) · Tally (composition).
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useMemo, useRef, useLayoutEffect } = React;
  const { AppShell, LiveCount, SearchBar, SegControl, KnobToggle, KindLegend, StepStrip, ZoomWidget, GraphEdge, GraphMarkers, RunConsole } = window;

  function roundedPath(pts, r) {
    if (!pts || pts.length < 2) return '';
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const v1x = Math.sign(p1.x - p0.x), v1y = Math.sign(p1.y - p0.y);
      const v2x = Math.sign(p2.x - p1.x), v2y = Math.sign(p2.y - p1.y);
      const r1 = Math.min(r, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2);
      const r2 = Math.min(r, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2);
      d += ` L${p1.x - v1x * r1},${p1.y - v1y * r1} Q${p1.x},${p1.y} ${p1.x + v2x * r2},${p1.y + v2y * r2}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${last.x},${last.y}`;
    return d;
  }

  const STEP_MODES = [['ribbon', 'Ribbon'], ['pipeline', 'Pipeline'], ['grouped', 'Grouped'], ['tally', 'Tally']];

  function Atlas({ layout, data }) {
    const [mode, setMode] = useState('grouped');
    const [showCond, setShowCond] = useState(true);
    const [hover, setHover] = useState(null);
    const [query, setQuery] = useState('');
    const [scale, setScale] = useState(1);
    const canvasRef = useRef(null);
    const pz = window.usePanZoom(canvasRef, { w: layout.width, h: layout.height }, { min: 0.25, max: 2.2 });

    const wfById = useMemo(() => Object.fromEntries(data.workflows.map((w) => [w.id, w])), [data]);
    const nodeById = useMemo(() => Object.fromEntries(layout.nodes.map((n) => [n.id, n])), [layout]);
    const runningTotal = useMemo(() => data.workflows.reduce((n, w) => n + (w.running || 0), 0), [data]);

    useLayoutEffect(() => { pz.fit(); }, [layout]);

    const connected = useMemo(() => {
      if (!hover) return null;
      const set = new Set([hover]);
      layout.edges.forEach((e) => { if (e.from === hover) set.add(e.to); if (e.to === hover) set.add(e.from); });
      return set;
    }, [hover, layout]);

    const q = query.trim().toLowerCase();
    const matches = (id) => !q || wfById[id].name.toLowerCase().indexOf(q) !== -1;
    const cardState = (id) => { if (q && !matches(id)) return 'dim'; if (connected) return connected.has(id) ? 'lit' : 'dim'; return ''; };
    const edgeState = (e) => { if (connected) return (e.from === hover || e.to === hover) ? 'lit' : 'dim'; if (q) return (matches(e.from) && matches(e.to)) ? '' : 'dim'; return ''; };

    return (
      <AppShell page="Atlas" active="design" activity={<><LiveCount running={runningTotal} /><span className="total"><b>{layout.nodes.length}</b> workflows</span></>}>
        <main className="canvas-main">
          <header className="canvas-head">
            <div className="ch-title">
              <div className="crumb">design · all workflows · elk</div>
              <h1>Workflow <em>Atlas</em></h1>
            </div>
            <div className="ch-controls">
              <SegControl items={[{ id: 'map', label: 'Map', on: true }, { id: 'graph', label: 'Graph', href: 'atlas-graph.html' }]} />
              <SearchBar value={query} onChange={setQuery} placeholder="Find a workflow…" hint="/" />
              <SegControl label="Steps" title="How steps inside each workflow are grouped"
                items={STEP_MODES.map(([id, lbl]) => ({ id, label: lbl, on: mode === id, onClick: () => setMode(id) }))} />
              <KnobToggle on={showCond} onToggle={() => setShowCond(!showCond)} label="Conditions" title="Show transition conditions" />
            </div>
          </header>

          <div className="graph-canvas" ref={canvasRef}>
            <div className="graph-scaler" style={{ transform: pz.transform }}>
              <div className="graph-board" style={{ width: layout.width, height: layout.height }}>

              {/* column headers = value-stream phases (from data) */}
              {layout.columns.map((col) => (
                <div key={col.i} className="stage-col-head" style={{ left: col.x, top: 8, width: nodeById[col.members[0]].w }}>
                  {col.phase || ('Layer ' + (col.i + 1))}<span className="n">{col.members.length}</span><span className="ln" />
                </div>
              ))}

              {/* edges — workflow→workflow handoffs, drawn solid on the map */}
              <svg className="graph-edges" width={layout.width} height={layout.height} viewBox={'0 0 ' + layout.width + ' ' + layout.height}>
                <GraphMarkers />
                {layout.edges.slice().sort((a, b) => (edgeState(a) === 'lit' ? 1 : 0) - (edgeState(b) === 'lit' ? 1 : 0)).map((e) => (
                  <GraphEdge key={e.id} kind="handoff" solid state={edgeState(e)} d={roundedPath(e.points, 9)} />
                ))}
              </svg>

              {/* condition chips */}
              {showCond && layout.edges.map((e) => {
                if (!e.labelPos) return null;
                const st = edgeState(e);
                const lbl = e.labels[0] + (e.labels.length > 1 ? ' +' + (e.labels.length - 1) : '');
                return <div key={'c' + e.id} className={'edge-label' + (st ? ' ' + st : '')} style={{ left: e.labelPos.x, top: e.labelPos.y }}>{lbl}</div>;
              })}

              {/* workflow cards */}
              {layout.nodes.map((n) => {
                const w = wfById[n.id], state = cardState(n.id);
                const shape = w.steps.map((s) => s.kind);
                return (
                  <div key={n.id} className={'vs-card' + (w.running ? ' live' : '') + (state ? ' ' + state : '')}
                    style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                    onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                    <div className="vs-hd">
                      <span className="vs-name">{w.name}</span>
                      {w.running ? <span className="vs-live"><span className="pulse" />{w.running} running</span> : null}
                    </div>
                    <div className="vs-steps"><StepStrip shape={shape} mode={mode} /></div>
                    <div className="vs-meta">
                      <span>{w.steps.length} steps</span><span className="sep">·</span>
                      <span>{w.runs24h}/24h</span><span className="sep">·</span>
                      <span>{w.avg}</span>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
            <ZoomWidget floating onZoomIn={pz.zoomIn} onZoomOut={pz.zoomOut} onFit={pz.fit} />

            <RunConsole />
          </div>

          <KindLegend
            items={[['entry', 'entry'], ['execute', 'execute'], ['eval', 'eval'], ['route', 'route'], ['wait', 'wait'], ['human', 'human'], ['final', 'done']]}
            hint="columns = value-stream phases (from data) · hover a workflow to trace its handoffs · → carries the trigger condition" />
        </main>
      </AppShell>
    );
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<div className="graph-loading" style={{ position: 'fixed', inset: 0 }}><div className="sp" />laying out atlas…</div>);
  WFElk.layoutCondensed(window.WFGraph, { boxW: 264, boxH: 140 }).then((layout) => {
    root.render(<Atlas layout={layout} data={window.WFGraph} />);
  }).catch((err) => {
    root.render(<pre style={{ padding: 24, color: 'red', fontFamily: 'monospace' }}>{'ELK layout failed:\n' + (err && err.stack || err)}</pre>);
    console.error(err);
  });
})();
