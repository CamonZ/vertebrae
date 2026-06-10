/* ──────────────────────────────────────────────────────────────────
   Hearth · Workflow Views — Map + Graph unified on one canvas.
   Both ELK layouts (layoutFull = nested graph, layoutCondensed = map) are
   computed up front and held together. Toggling the view is an in-place
   shared-element morph: each workflow box animates between its graph rect
   and its map rect, the graph step-nodes + edges crossfade out as the
   condensed edges + column headers crossfade in, and the camera glides to
   reframe the active layout. No navigation, no reload — Run Console and
   pan position persist across the toggle.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useMemo, useRef, useEffect, useLayoutEffect } = React;
  const { AppShell, LiveCount, RunConsole, SearchBar, GraphEdge, GraphMarkers } = window;

  const ICON = {
    map:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><line x1="9" y1="3" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="21" /></svg>,
    graph: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="7" height="6" rx="1" /><rect x="14" y="14" width="7" height="6" rx="1" /><path d="M10 7h4a2 2 0 0 1 2 2v5" /></svg>,
  };

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
  function shortId(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 8).padStart(8, '0'); }
  const kindLabel = (k) => (k === 'final' ? 'done' : k);

  /* ── step-strip reductions (map face) ── */
  function groupShape(shape) {
    const out = [];
    shape.forEach((k) => { const l = out[out.length - 1]; if (l && l.kind === k) l.count++; else out.push({ kind: k, count: 1 }); });
    return out;
  }
  function tallyShape(shape) {
    const m = {}, order = [];
    shape.forEach((k) => { if (!(k in m)) { m[k] = 0; order.push(k); } m[k]++; });
    return order.map((k) => ({ kind: k, count: m[k] }));
  }
  function StepStrip({ shape, mode }) {
    if (mode === 'ribbon') return <div className="al-ribbon">{shape.map((k, i) => <span key={i} className={'seg k-' + k} />)}</div>;
    if (mode === 'pipeline') return (
      <div className="al-pipe">
        {shape.map((k, i) => <React.Fragment key={i}>{i > 0 ? <span className="al-link" /> : null}<span className={'al-dot k-' + k} title={kindLabel(k)} /></React.Fragment>)}
      </div>
    );
    if (mode === 'grouped') {
      const g = groupShape(shape);
      return <div className="al-chips">{g.map((s, i) => <React.Fragment key={i}>{i > 0 ? <span className="al-arrow">›</span> : null}<span className={'al-chip k-' + s.kind}>{kindLabel(s.kind)}{s.count > 1 ? <b>×{s.count}</b> : null}</span></React.Fragment>)}</div>;
    }
    const t = tallyShape(shape);
    return <div className="al-chips">{t.map((s, i) => <span key={i} className={'al-chip k-' + s.kind}>{kindLabel(s.kind)}<b>{s.count}</b></span>)}</div>;
  }
  const STEP_MODES = [['ribbon', 'Ribbon'], ['pipeline', 'Pipeline'], ['grouped', 'Grouped'], ['tally', 'Tally']];

  /* ── one workflow box: travels + resizes between layouts, crossfades faces ── */
  function WfBox({ w, rect, view, state, stepMode, onHover }) {
    const d = w.def;
    const shape = w.def.steps.map((s) => s.kind);
    return (
      <div className={'uv-wf' + (d.live ? ' live' : '') + (state ? ' ' + state : '')}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        onMouseEnter={() => onHover(w.id)} onMouseLeave={() => onHover(null)}>

        {/* graph face */}
        <div className={'uv-face uv-face-graph' + (view === 'graph' ? '' : ' hide')}>
          <div className="ag-wf-hd">
            <div className="ag-wf-top">
              <span className="ag-wf-name">{d.name}</span>
              <span className={'ag-status s-' + d.status}>{d.status === 'active' ? <span className="pulse" /> : null}{d.statusLabel}</span>
            </div>
            <div className="ag-wf-meta"><span className="id">{shortId(w.id)}</span><span className="sep">·</span><span>{d.steps.length} steps</span></div>
            <div className="ag-wf-desc">{d.desc}</div>
          </div>
        </div>

        {/* map face */}
        <div className={'uv-face uv-face-map' + (view === 'map' ? '' : ' hide')}>
          <div className="al-card-hd">
            <span className="al-name">{d.name}</span>
            {d.live ? <span className="al-live"><span className="pulse" />live</span> : null}
          </div>
          <div className="al-steps"><StepStrip shape={shape} mode={stepMode} /></div>
          <div className="al-meta"><span>{d.steps.length} steps</span><span className="sep">·</span><span>{d.runs24h}/24h</span><span className="sep">·</span><span>{d.avg}</span></div>
        </div>
      </div>
    );
  }

  function StepNode({ s, run, state }) {
    return (
      <div className={'ag-step k-' + s.kind + (run ? ' run' : '') + (state ? ' s-' + state : '')}
        style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
        <div className="ag-step-top"><span className="ag-step-num">{s.idx}</span><span className="ag-step-name">{s.name}</span></div>
        <div className="ag-step-rule" />
        <div className="ag-step-foot"><span className="rdot" />{s.role}<span className="ag-kind">{s.kind}</span></div>
      </div>
    );
  }

  function UnifiedViews({ full, cond, data }) {
    const [view, setView] = useState('graph');           // 'graph' | 'map'
    const [hover, setHover] = useState(null);
    const [showLabels, setShowLabels] = useState(true);   // graph: transition labels
    const [showCond, setShowCond] = useState(true);       // map: conditions
    const [stepMode, setStepMode] = useState('grouped');  // map: strip reduction
    const [query, setQuery] = useState('');               // map: search
    const [morphing, setMorphing] = useState(false);

    const canvasRef = useRef(null);

    // camera fits whichever layout is active
    const dims = view === 'graph' ? { w: full.width, h: full.height } : { w: cond.width, h: cond.height };
    const pz = window.usePanZoom(canvasRef, dims, { min: 0.12, max: 2.4 });
    const pzRef = useRef(pz); pzRef.current = pz;

    // lookups
    const fullWf = useMemo(() => Object.fromEntries(full.workflows.map((w) => [w.id, w])), [full]);
    const condNode = useMemo(() => Object.fromEntries(cond.nodes.map((n) => [n.id, n])), [cond]);
    const wfDef = useMemo(() => Object.fromEntries(data.workflows.map((w) => [w.id, w])), [data]);

    // shared world box (so neither layout clips during the morph)
    const boardW = Math.max(full.width, cond.width);
    const boardH = Math.max(full.height, cond.height);

    // initial fit, and a camera glide on every view change.
    // NB: use setTimeout (not rAF) — rAF is paused in hidden/background frames.
    const first = useRef(true);
    useLayoutEffect(() => {
      if (first.current) { first.current = false; pzRef.current.fit(); return; }
      setMorphing(true);                                   // arm the transition first
      const t0 = setTimeout(() => pzRef.current.fit(), 30); // then change transform → glides
      const t1 = setTimeout(() => setMorphing(false), 800);
      return () => { clearTimeout(t0); clearTimeout(t1); };
    }, [view]);

    // trace: connected set differs per view (graph cross-edges vs condensed edges)
    const connected = useMemo(() => {
      if (!hover) return null;
      const set = new Set([hover]);
      if (view === 'graph') full.cross.forEach((e) => { if (e.fromWf === hover) set.add(e.toWf); if (e.toWf === hover) set.add(e.fromWf); });
      else cond.edges.forEach((e) => { if (e.from === hover) set.add(e.to); if (e.to === hover) set.add(e.from); });
      return set;
    }, [hover, view, full, cond]);

    const q = query.trim().toLowerCase();
    const matches = (id) => !q || wfDef[id].name.toLowerCase().indexOf(q) !== -1;
    const wfState = (id) => {
      if (view === 'map' && q && !matches(id)) return 'dim';
      if (!connected) return '';
      return connected.has(id) ? 'lit' : 'dim';
    };
    const crossState = (e) => connected ? ((e.fromWf === hover || e.toWf === hover) ? 'lit' : 'dim') : '';
    const condEdgeState = (e) => { if (connected) return (e.from === hover || e.to === hover) ? 'lit' : 'dim'; if (q) return (matches(e.from) && matches(e.to)) ? '' : 'dim'; return ''; };

    // forward + loop intra edges, flattened with their workflow id (graph layer)
    const intra = useMemo(() => full.workflows.flatMap((w) => w.intra.map((e) => Object.assign({}, e, { wf: w.id }))), [full]);

    const isGraph = view === 'graph';
    // during a morph, strip all connective tissue so ONLY the boxes choreograph;
    // edges / step-nodes / labels / columns re-attach once the boxes have landed.
    const showGraphChrome = isGraph && !morphing;
    const showMapChrome = !isGraph && !morphing;

    const rectOf = (id) => {
      const g = fullWf[id], m = condNode[id];
      return isGraph ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: m.x, y: m.y, w: m.w, h: m.h };
    };

    return (
      <AppShell page={isGraph ? 'Graph' : 'Atlas'} active="design"
        activity={<><LiveCount running={1} /><span className="total"><b>{data.workflows.length}</b> workflows</span></>}>
        <main className="uv-main">
          <header className="uv-head">
            <div className="uv-name">
              <div className="crumb">design · workflow topology · elk</div>
              <h1>Workflow <em>{isGraph ? 'Graph' : 'Atlas'}</em></h1>
            </div>
            <div className="uv-controls">
              <div className="uv-modes">
                <button className={!isGraph ? 'on' : ''} onClick={() => setView('map')}>{ICON.map}Map</button>
                <button className={isGraph ? 'on' : ''} onClick={() => setView('graph')}>{ICON.graph}Graph</button>
              </div>

              {/* graph-only controls */}
              <div className="uv-ctxgroup" style={{ opacity: isGraph ? 1 : 0, pointerEvents: isGraph ? 'auto' : 'none', display: isGraph ? 'flex' : 'none' }}>
                <div className={'uv-toggle' + (showLabels ? ' on' : '')} onClick={() => setShowLabels(!showLabels)} title="Show transition labels"><span className="knob" />Labels</div>
              </div>

              {/* map-only controls */}
              <div className="uv-ctxgroup" style={{ opacity: isGraph ? 0 : 1, pointerEvents: isGraph ? 'none' : 'auto', display: isGraph ? 'none' : 'flex' }}>
                <SearchBar value={query} onChange={setQuery} placeholder="Find a workflow…" hint="/" />
                <div className="al-seg" title="How steps inside each workflow are grouped">
                  <span className="lab">Steps</span>
                  {STEP_MODES.map(([id, lbl]) => <button key={id} className={stepMode === id ? 'on' : ''} onClick={() => setStepMode(id)}>{lbl}</button>)}
                </div>
                <div className={'uv-toggle' + (showCond ? ' on' : '')} onClick={() => setShowCond(!showCond)} title="Show transition conditions"><span className="knob" />Conditions</div>
              </div>
            </div>
          </header>

          <div className="uv-canvas" ref={canvasRef}>
            <div className={'uv-scaler' + (morphing ? ' morphing' : '')} style={{ transform: pz.transform }}>
              <div className="uv-board" style={{ width: boardW, height: boardH }}>

                {/* column headers — map layer */}
                <div className={'uv-layer' + (showMapChrome ? '' : ' hide')}>
                  {cond.columns.map((col) => (
                    <div key={col.i} className="al-stagehd" style={{ left: condNode[col.members[0]].x, top: 8, width: condNode[col.members[0]].w }}>
                      {col.phase || ('Layer ' + (col.i + 1))}<span className="n">{col.members.length}</span><span className="ln" />
                    </div>
                  ))}
                </div>

                {/* condensed edges — map layer (workflow→workflow handoffs, solid) */}
                <svg className={'al-edges uv-layer' + (showMapChrome ? '' : ' hide')} width={boardW} height={boardH} viewBox={'0 0 ' + boardW + ' ' + boardH}>
                  <GraphMarkers />
                  {cond.edges.slice().sort((a, b) => (condEdgeState(a) === 'lit' ? 1 : 0) - (condEdgeState(b) === 'lit' ? 1 : 0)).map((e) => (
                    <GraphEdge key={e.id} kind="handoff" solid state={condEdgeState(e)} d={roundedPath(e.points, 9)} />
                  ))}
                </svg>

                {/* graph edges (cross + forward) — graph layer */}
                <svg className={'ag-edges uv-layer' + (showGraphChrome ? '' : ' hide')} width={boardW} height={boardH} viewBox={'0 0 ' + boardW + ' ' + boardH}>
                  {full.cross.slice().sort((a, b) => (crossState(a) === 'lit' ? 1 : 0) - (crossState(b) === 'lit' ? 1 : 0)).map((e) => {
                    const st = crossState(e);
                    // hub overlay edges (e.g. Human Review escalations/resumes) stay hidden
                    // at rest and only appear when you hover their endpoint to trace.
                    if (e.hub && st !== 'lit') return null;
                    return <GraphEdge key={e.id} kind="handoff" state={st} d={roundedPath(e.points, 10)} />;
                  })}
                  {intra.filter((e) => e.kind === 'forward').map((e) => (
                    <GraphEdge key={e.id} kind="step" state={wfState(e.wf)} d={roundedPath(e.points, 6)} />
                  ))}
                </svg>

                {/* step nodes — graph layer (above boxes so they read as the box contents) */}
                <div className={'uv-layer uv-steplayer' + (showGraphChrome ? '' : ' hide')}>
                  {full.workflows.map((w) => w.steps.map((s, i) => (
                    <StepNode key={w.id + '.' + s.id} s={Object.assign({}, s, { idx: i + 1 })} run={w.def.live && i === 0} state={wfState(w.id) === 'dim' ? 'dim' : (wfState(w.id) === 'lit' ? 'lit' : '')} />
                  )))}
                </div>

                {/* workflow boxes — the traveling element (always mounted) */}
                {data.workflows.map((w) => (
                  <WfBox key={w.id} w={fullWf[w.id]} rect={rectOf(w.id)} view={view} state={wfState(w.id)} stepMode={stepMode} onHover={setHover} />
                ))}

                {/* loop-backs — graph layer, above boxes */}
                <svg className={'ag-edges-top uv-layer' + (showGraphChrome ? '' : ' hide')} width={boardW} height={boardH} viewBox={'0 0 ' + boardW + ' ' + boardH}>
                  {intra.filter((e) => e.kind === 'loop').map((e) => {
                    const st = connected ? (hover === e.wf ? 'lit' : 'dim') : '';
                    return <GraphEdge key={e.id} kind="loop" state={st} d={roundedPath(e.points, 7)} />;
                  })}
                </svg>

                {/* graph transition labels */}
                {showGraphChrome && showLabels && full.cross.map((e) => {
                  if (!e.labelPos) return null;
                  const st = crossState(e);
                  // hub labels only when tracing that endpoint (otherwise dozens pile in a corner)
                  if (e.hub && st !== 'lit') return null;
                  return <div key={'gl' + e.id} className={'ag-elabel uv-layer' + (st ? ' ' + st : '')} style={{ left: e.labelPos.x, top: e.labelPos.y }}>{e.label}</div>;
                })}
                {showGraphChrome && showLabels && intra.filter((e) => e.kind === 'loop' && e.labelPos).map((e) => {
                  const vis = connected ? hover === e.wf : true;
                  return <div key={'gll' + e.id} className="ag-elabel" style={{ left: e.labelPos.x, top: e.labelPos.y, opacity: vis ? 0.9 : 0.1, color: 'var(--step-route-fg)', borderColor: 'color-mix(in oklch, var(--step-route) 40%, transparent)' }}>{e.label}</div>;
                })}

                {/* map condition chips */}
                {showMapChrome && showCond && cond.edges.map((e) => {
                  if (!e.labelPos) return null;
                  const st = condEdgeState(e);
                  const lbl = e.labels[0] + (e.labels.length > 1 ? ' +' + (e.labels.length - 1) : '');
                  return <div key={'cc' + e.id} className={'al-cond' + (st ? ' ' + st : '')} style={{ left: e.labelPos.x, top: e.labelPos.y }}>{lbl}</div>;
                })}
              </div>
            </div>

            <div className="uv-zoom" data-no-pan>
              <button onClick={pz.zoomIn} title="Zoom in">＋</button>
              <button onClick={pz.zoomOut} title="Zoom out">−</button>
              <button onClick={pz.fit} title="Fit">⊡</button>
            </div>

            <RunConsole />
          </div>

          <footer className="uv-legend">
            {[['entry', 'entry'], ['execute', 'execute'], ['eval', 'eval'], ['route', 'route'], ['wait', 'wait'], ['human', 'human'], ['final', isGraph ? 'final' : 'done']].map(([k, lbl]) => (
              <span key={k} className={'lg-item k-' + k}><span className="sw" />{lbl}</span>
            ))}
            <span className="lg-sep" />
            <span className="hint">{isGraph
              ? 'layout + routing by elk · dashed → cross-workflow · green ↩ loop back · hover to trace'
              : 'columns = value-stream phases (from data) · hover a workflow to trace its handoffs · → carries the trigger condition'}</span>
          </footer>
        </main>
      </AppShell>
    );
  }

  /* boot: compute BOTH layouts, then render the unified view */
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<div className="uv-loading" style={{ position: 'fixed', inset: 0 }}><div className="sp" />laying out workflow views…</div>);
  Promise.all([
    WFElk.layoutFull(window.WFGraph, { headH: 118, stepW: 150, stepH: 90 }),
    WFElk.layoutCondensed(window.WFGraph, { boxW: 264, boxH: 140 }),
  ]).then(([full, cond]) => {
    root.render(<UnifiedViews full={full} cond={cond} data={window.WFGraph} />);
  }).catch((err) => {
    root.render(<pre style={{ padding: 24, color: 'var(--danger, red)', fontFamily: 'monospace' }}>{'ELK layout failed:\n' + (err && err.stack || err)}</pre>);
    console.error(err);
  });
})();
