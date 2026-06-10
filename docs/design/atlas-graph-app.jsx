/* ──────────────────────────────────────────────────────────────────
   Hearth · Workflow Graph — full topology, laid out by ELK from data.
   Positions + orthogonal edge routing come from WFElk.layoutFull(WFGraph);
   nothing here is hand-placed. Visual language (containers, step nodes,
   loop-backs, focus-to-trace) is unchanged from the hand-built draft.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useMemo, useRef, useLayoutEffect, useEffect } = React;
  const { AppShell, LiveCount, RunConsole, SegControl, KnobToggle, KindLegend, ZoomWidget, GraphEdge, GraphMarkers, WfInspector } = window;

  /* rounded orthogonal path through ELK points */
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

  function StepNode({ s, run, state, selected, onSelect }) {
    return (
      <div className={'graph-step k-' + s.kind + (run ? ' run' : '') + (state ? ' s-' + state : '') + (selected ? ' sel' : '')}
        style={{ left: s.x, top: s.y, width: s.w, height: s.h, cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); onSelect && onSelect(); }}>
        <div className="gs-top">
          <span className="gs-num">{s.idx}</span>
          <span className="gs-name">{s.name}</span>
        </div>
        <div className="gs-rule" />
        <div className="gs-foot"><span className="rdot" />{s.role}<span className="gs-kind">{s.kind === 'final' ? 'final' : s.kind}</span></div>
      </div>
    );
  }

  function WfBox({ w, state, onHover, sel, onSelect }) {
    const d = w.def;
    const isLive = d.live || (d.running || 0) > 0;
    const wfSel = sel && sel.type === 'workflow' && sel.wfId === w.id;
    return (
      <React.Fragment>
        <div className={'graph-wf' + (isLive ? ' active' : '') + (state ? ' ' + state : '') + (wfSel ? ' sel' : '')}
          style={{ left: w.x, top: w.y, width: w.w, height: w.h, cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); onSelect({ type: 'workflow', wfId: w.id }); }}
          onMouseEnter={() => onHover(w.id)} onMouseLeave={() => onHover(null)}>
          <div className="gw-hd">
            <div className="gw-top">
              <span className="gw-name">{d.name}</span>
              <span className={'gw-status s-' + d.status}>{d.status === 'active' ? <span className="pulse" /> : null}{d.statusLabel}</span>
            </div>
            <div className="gw-meta"><span className="id">{shortId(w.id)}</span><span className="sep">·</span><span>{w.steps.length} steps</span></div>
            <div className="gw-desc">{d.desc}</div>
          </div>
        </div>
        {w.steps.map((s, i) => {
          // ELK namespaces step ids as "wfId.stepId"; the inspector + edges use the bare id.
          const bare = s.id.indexOf(w.id + '.') === 0 ? s.id.slice(w.id.length + 1) : s.id;
          return <StepNode key={s.id} s={Object.assign({}, s, { idx: i + 1 })} run={isLive && i === 0} state={state}
            selected={sel && sel.type === 'step' && sel.wfId === w.id && sel.stepId === bare}
            onSelect={() => onSelect({ type: 'step', wfId: w.id, stepId: bare })} />;
        })}
      </React.Fragment>
    );
  }
  function shortId(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 8).padStart(8, '0'); }

  function Graph({ layout }) {
    const [hover, setHover] = useState(null);
    const [sel, setSel] = useState(null);
    const [showLabels, setShowLabels] = useState(true);
    const canvasRef = useRef(null);
    const pz = window.usePanZoom(canvasRef, { w: layout.width, h: layout.height }, { min: 0.18, max: 2.4 });

    useLayoutEffect(() => { pz.fit(); }, [layout]);

    // Esc closes the inspector
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') setSel(null); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);

    // trace focus follows the pointer first, then the current selection
    const focus = hover || (sel ? sel.wfId : null);

    const connected = useMemo(() => {
      if (!focus) return null;
      const set = new Set([focus]);
      layout.cross.forEach((e) => { if (e.fromWf === focus) set.add(e.toWf); if (e.toWf === focus) set.add(e.fromWf); });
      return set;
    }, [focus, layout]);

    const wfState = (id) => connected ? (connected.has(id) ? 'lit' : 'dim') : '';
    const crossState = (e) => connected ? ((e.fromWf === focus || e.toWf === focus) ? 'lit' : 'dim') : '';

    // all forward + loop intra edges, flattened with their workflow id
    const intra = useMemo(() => layout.workflows.flatMap((w) => w.intra.map((e) => ({ ...e, wf: w.id }))), [layout]);

    return (
      <AppShell page="Graph" active="design" activity={<><LiveCount running={layout.workflows.reduce((n, w) => n + (w.def.running || 0), 0)} /><span className="total"><b>{layout.workflows.length}</b> workflows</span></>}>
        <main className="canvas-main">
          <header className="canvas-head">
            <div className="ch-title">
              <div className="crumb">design · workflow topology · elk</div>
              <h1>Workflow <em>Graph</em></h1>
            </div>
            <div className="ch-controls">
              <SegControl items={[{ id: 'map', label: 'Map', href: 'atlas.html' }, { id: 'graph', label: 'Graph', on: true }]} />
              <KnobToggle on={showLabels} onToggle={() => setShowLabels(!showLabels)} label="Labels" title="Show transition labels" />
            </div>
          </header>

          <div className="graph-canvas" ref={canvasRef}>
            <div className="graph-scaler" style={{ transform: pz.transform }}>
              <div className="graph-board" style={{ width: layout.width, height: layout.height }}>

                {/* under-node layer: cross-workflow edges + forward step links */}
                <svg className="graph-edges" width={layout.width} height={layout.height} viewBox={'0 0 ' + layout.width + ' ' + layout.height}>
                  <GraphMarkers />
                  {layout.cross.slice().sort((a, b) => (crossState(a) === 'lit' ? 1 : 0) - (crossState(b) === 'lit' ? 1 : 0)).map((e) => (
                    <GraphEdge key={e.id} kind="handoff" state={crossState(e)} d={roundedPath(e.points, 10)} />
                  ))}
                  {intra.filter((e) => e.kind === 'forward').map((e) => (
                    <GraphEdge key={e.id} kind="step" state={wfState(e.wf)} d={roundedPath(e.points, 6)} />
                  ))}
                </svg>

                {/* nodes */}
                {layout.workflows.map((w) => <WfBox key={w.id} w={w} state={wfState(w.id)} onHover={setHover} sel={sel} onSelect={setSel} />)}

                {/* over-node layer: loop-backs */}
                <svg className="graph-edges top" width={layout.width} height={layout.height} viewBox={'0 0 ' + layout.width + ' ' + layout.height}>
                  {intra.filter((e) => e.kind === 'loop').map((e) => {
                    const st = connected ? (focus === e.wf ? 'lit' : 'dim') : '';
                    return <GraphEdge key={e.id} kind="loop" state={st} d={roundedPath(e.points, 7)} />;
                  })}
                </svg>

                {/* labels */}
                {showLabels && layout.cross.map((e) => {
                  if (!e.labelPos) return null;
                  const st = crossState(e);
                  return <div key={'l' + e.id} className={'edge-label' + (st ? ' ' + st : '')} style={{ left: e.labelPos.x, top: e.labelPos.y }}>{e.label}</div>;
                })}
                {showLabels && intra.filter((e) => e.kind === 'loop' && e.labelPos).map((e) => {
                  const vis = connected ? focus === e.wf : true;
                  return <div key={'l' + e.id} className="edge-label" style={{ left: e.labelPos.x, top: e.labelPos.y, opacity: vis ? 0.9 : 0.1, color: 'var(--step-route-fg)', borderColor: 'color-mix(in oklch, var(--step-route) 40%, transparent)' }}>{e.label}</div>;
                })}
              </div>
            </div>

            <ZoomWidget floating onZoomIn={pz.zoomIn} onZoomOut={pz.zoomOut} onFit={pz.fit} />

            <RunConsole />

            {sel ? <WfInspector key={sel.type + ':' + sel.wfId + ':' + (sel.stepId || '')} sel={sel} onSelect={setSel} onClose={() => setSel(null)} /> : null}
          </div>

          <KindLegend
            items={[['entry', 'entry'], ['execute', 'execute'], ['eval', 'eval'], ['route', 'route'], ['wait', 'wait'], ['human', 'human'], ['final', 'final']]}
            hint="layout + routing by elk · dashed → cross-workflow · green ↩ loop back to an earlier step · hover to trace" />
        </main>
      </AppShell>
    );
  }

  /* boot: compute layout from data, then render */
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<div className="graph-loading" style={{ position: 'fixed', inset: 0 }}><div className="sp" />laying out graph…</div>);
  WFElk.layoutFull(window.WFGraph, { headH: 118, stepW: 150, stepH: 90 }).then((layout) => {
    root.render(<Graph layout={layout} />);
  }).catch((err) => {
    root.render(<pre style={{ padding: 24, color: 'var(--danger, red)', fontFamily: 'monospace' }}>{'ELK layout failed:\n' + (err && err.stack || err)}</pre>);
    console.error(err);
  });
})();
