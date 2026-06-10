/* ──────────────────────────────────────────────────────────────────
   Hearth · Unified Canvas
   One surface, three projections of the SAME set of runs:
     Status   — run-state columns (today's kanban / board)
     Phase    — value-stream phase columns (atlas columns, kanban discipline)
     Topology — runs ride as live tokens on the workflow they're parked in
   The run is the unifying unit: it has a status AND a position on the map.
   Cards morph between layouts (transform/width/height transition = FLIP).
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useMemo, useRef, useLayoutEffect, useEffect } = React;

  // ── Fixed design canvas ───────────────────────────────────────────
  const W = 1660, H = 920;
  const PAD = 28, KGAP = 16, HEAD_Y = 18, CARD_TOP = 64, CARDH = 96, CARDGAP = 12;
  const ST_TOP = 64, ROWH = 150, ST_HEAD = 28, TOKH = 30, TOKGAP = 6, TOKPAD = 12;

  // ── Workflows (stations on the map) — phase + grid position ────────
  const WF = {
    decomposition:   { name: 'Decomposition',  phase: 'Intake', col: 0, row: 0 },
    backlog:         { name: 'Backlog',         phase: 'Intake', col: 0, row: 2 },
    scaffold:        { name: 'Scaffold',        phase: 'Build',  col: 1, row: 0 },
    implementation:  { name: 'Implementation',  phase: 'Build',  col: 1, row: 1 },
    finalizer:       { name: 'Finalizer',       phase: 'Build',  col: 1, row: 4 },
    verification:    { name: 'Verification',    phase: 'Verify', col: 2, row: 0 },
    waitForChildren: { name: 'WaitForChildren', phase: 'Verify', col: 2, row: 2 },
    humanReview:     { name: 'Human Review',    phase: 'Review', col: 3, row: 1 },
    ship:            { name: 'Ship',            phase: 'Ship',   col: 4, row: 1 },
    done:            { name: 'done',            phase: 'Ship',   col: 4, row: 4 },
  };
  const PHASES = ['Intake', 'Build', 'Verify', 'Review', 'Ship'];
  const STATUSES = [
    { key: 'queued',  name: 'Queued' },
    { key: 'running', name: 'Running' },
    { key: 'waiting', name: 'Waiting' },
    { key: 'done',    name: 'Done' },
  ];
  const KC = { execute: 'var(--step-execute)', eval: 'var(--step-eval)', route: 'var(--step-route)', human: 'var(--step-human)', wait: 'var(--step-wait)', final: 'var(--ok)' };

  // ── Runs — each is an instance flowing through a workflow ───────────
  const RUNS = [
    { id: 'fe0a3c08', title: 'Explore backend chat sessions & app-owned workflows', wf: 'implementation',  kind: 'execute', status: 'running', time: '12m' },
    { id: 'c794b783', title: 'Hydrate chat runner state and resume pending work',    wf: 'implementation',  kind: 'eval',    status: 'running', time: '2m 14s' },
    { id: '2d297d56', title: 'Add ChatRun investigation wait/resume with artifacts',  wf: 'implementation',  kind: 'execute', status: 'running', time: '4m 02s' },
    { id: '081f5160', title: 'Fan-out / fan-in parallel execution primitive',         wf: 'scaffold',        kind: 'execute', status: 'running', time: '52s' },
    { id: 'a75f037a', title: 'TaskRun lifecycle and recursive traceability',          wf: 'verification',    kind: 'eval',    status: 'running', time: '1m 30s' },
    { id: 'be21c0a4', title: 'Ship composite-FK authorization PR',                    wf: 'ship',            kind: 'execute', status: 'running', time: '3m 18s' },
    { id: '40628099', title: 'Emit chat runner activity events; replace runner lifecycle', wf: 'waitForChildren', kind: 'wait', status: 'waiting', time: '7h 36m' },
    { id: '3ef56524', title: 'Block CLI control plane from advancing orchestrated tasks',  wf: 'humanReview', kind: 'human', status: 'waiting', time: '2h 04m' },
    { id: 'ca564fec', title: 'Design platform layer for human_input approval',        wf: 'humanReview',     kind: 'human',   status: 'waiting', time: '38m' },
    { id: '2743d4d0', title: 'Add permission request mutations for GUI chat',         wf: 'decomposition',   kind: 'route',   status: 'queued',  time: '—' },
    { id: 'b6e66dc8', title: 'Research: “prior output” semantics for step context',   wf: 'decomposition',   kind: 'route',   status: 'queued',  time: '—' },
    { id: '8818251a', title: 'Composite FK authorization & referential integrity',    wf: 'backlog',         kind: 'route',   status: 'queued',  time: '—' },
    { id: 'f0546c38', title: 'Plumb OpenRouter provider routing through chat',        wf: 'backlog',         kind: 'route',   status: 'queued',  time: '—' },
    { id: 'e4e4c5c5', title: 'Apply work-breakdown authoring drafts into tasks',      wf: 'backlog',         kind: 'eval',    status: 'queued',  time: '—' },
    { id: '9e78bea2', title: 'Drive authoring intents via OpenRouter w/ verifier',    wf: 'done',            kind: 'final',   status: 'done',    time: '4d' },
    { id: '901268f8', title: 'Expose internal tracker operation tools to chat',       wf: 'done',            kind: 'final',   status: 'done',    time: '3d' },
  ];

  const STATUS_RANK = { running: 0, waiting: 1, queued: 2, done: 3 };

  // ── Column geometry helper ─────────────────────────────────────────
  function cols(n) {
    const inner = W - PAD * 2, gap = KGAP, cw = (inner - (n - 1) * gap) / n;
    const xs = []; for (let i = 0; i < n; i++) xs.push(PAD + i * (cw + gap));
    return { cw, xs };
  }

  // ── Station rectangles (topology) ──────────────────────────────────
  const stationRects = (() => {
    const { cw, xs } = cols(5);
    const tokensByWf = {};
    RUNS.forEach(r => { (tokensByWf[r.wf] = tokensByWf[r.wf] || []).push(r); });
    Object.keys(tokensByWf).forEach(w => tokensByWf[w].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]));
    const rects = {};
    Object.entries(WF).forEach(([id, w]) => {
      const n = (tokensByWf[id] || []).length;
      const x = xs[w.col] + 8, width = cw - 16;
      const y = ST_TOP + w.row * ROWH;
      const height = ST_HEAD + (n ? n * (TOKH + TOKGAP) + 6 : 14);
      rects[id] = { x, y, w: width, h: height, n };
    });
    return { rects, tokensByWf, cw, xs };
  })();

  // bezier between two station rects, exiting right / entering left
  function edgePath(a, b) {
    const sameCol = Math.abs(a.x - b.x) < 6;
    if (sameCol) {
      const x = a.x + a.w, sy = a.y + a.h / 2, ty = b.y + b.h / 2, cx = x + 54;
      return `M${x},${sy} C${cx},${sy} ${cx},${ty} ${b.x + b.w},${ty}`;
    }
    const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2;
    const dx = Math.max(46, (tx - sx) * 0.45);
    return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  }

  const EDGES = [
    ['decomposition', 'backlog', 'children', 'flow'],
    ['backlog', 'scaffold', 'approve', 'flow'],
    ['backlog', 'implementation', 'task', 'flow'],
    ['scaffold', 'implementation', 'scaffolded', 'flow'],
    ['implementation', 'finalizer', 'verified', 'flow'],
    ['finalizer', 'waitForChildren', 'await', 'flow'],
    ['waitForChildren', 'verification', 'verify', 'flow'],
    ['verification', 'ship', 'approve', 'flow'],
    ['ship', 'done', 'complete', 'flow'],
    ['implementation', 'humanReview', 'needs-human', 'dash'],
    ['verification', 'humanReview', 'needs-human', 'dash'],
    ['humanReview', 'ship', 'resume', 'dash'],
    ['waitForChildren', 'done', 'complete', 'dash'],
  ];

  // ── Per-mode layout: returns { card:{id->rect}, token:bool } ────────
  function useLayout(mode) {
    return useMemo(() => {
      const card = {};
      if (mode === 'topology') {
        const { rects, tokensByWf } = stationRects;
        Object.entries(tokensByWf).forEach(([wf, list]) => {
          const st = rects[wf];
          list.forEach((r, i) => {
            card[r.id] = { x: st.x + TOKPAD, y: st.y + ST_HEAD + 2 + i * (TOKH + TOKGAP), w: st.w - TOKPAD * 2, h: TOKH };
          });
        });
        return { card, token: true };
      }
      // kanban (status | phase)
      const isPhase = mode === 'phase';
      const groups = isPhase ? PHASES : STATUSES.map(s => s.key);
      const n = groups.length;
      const { cw, xs } = cols(n);
      const idxByGroup = {};
      const ordered = RUNS.slice().sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
      ordered.forEach(r => {
        const g = isPhase ? WF[r.wf].phase : r.status;
        const gi = groups.indexOf(g);
        const k = idxByGroup[g] = (idxByGroup[g] == null ? 0 : idxByGroup[g] + 1);
        card[r.id] = { x: xs[gi], y: CARD_TOP + k * (CARDH + CARDGAP), w: cw, h: CARDH };
      });
      return { card, token: false, cw, xs, groups };
    }, [mode]);
  }

  // ── Components ─────────────────────────────────────────────────────
  function RunCard({ r, rect, token, parked, lit, faded, onEnter, onLeave }) {
    const cls = ['rc', 's-' + r.status, token ? 'token' : '', token && parked ? 'parked' : '', lit ? 'lit' : '', faded ? 'faded' : ''].join(' ');
    return (
      <div className={cls}
        style={{ '--kc': KC[r.kind], '--tx': rect.x + 'px', '--ty': rect.y + 'px',
          width: rect.w, height: rect.h, transform: `translate(${rect.x}px, ${rect.y}px)` }}
        onMouseEnter={onEnter} onMouseLeave={onLeave}>
        <span className="hue" />
        <div className="rc-top">
          <span className="rc-dot" />
          <span className="rc-title">{r.title}</span>
          <span className="rc-time">{r.time}</span>
        </div>
        <div className="rc-meta">
          <span className="rc-id">{r.id}</span>
          <span className="chip">{r.kind === 'final' ? 'done' : r.kind}</span>
          <span className="rc-wf">{WF[r.wf].name}</span>
        </div>
      </div>
    );
  }

  function App() {
    const [mode, setMode] = useState(() => { try { return localStorage.getItem('hearth-unified-mode') || 'status'; } catch (e) { return 'status'; } });
    useEffect(() => { try { localStorage.setItem('hearth-unified-mode', mode); } catch (e) {} }, [mode]);
    const [hover, setHover] = useState(null);       // run id
    const [hoverWf, setHoverWf] = useState(null);    // station id
    const layout = useLayout(mode);
    const stageRef = useRef(null);
    const wrapRef = useRef(null);

    // scale-to-fit
    useLayoutEffect(() => {
      function fit() {
        const wrap = wrapRef.current, st = stageRef.current; if (!wrap || !st) return;
        const s = Math.min(wrap.clientWidth / W, wrap.clientHeight / H);
        st.style.transform = `translate(-50%, -50%) scale(${s})`;
      }
      fit();
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }, []);

    const running = RUNS.filter(r => r.status === 'running').length;

    // hover relationships (topology)
    const litWf = hover ? RUNS.find(r => r.id === hover).wf : hoverWf;
    const connected = useMemo(() => {
      if (mode !== 'topology' || !litWf) return null;
      const s = new Set([litWf]);
      EDGES.forEach(([a, b]) => { if (a === litWf) s.add(b); if (b === litWf) s.add(a); });
      return s;
    }, [mode, litWf]);

    const explain = {
      status: ['Run-state', 'Columns are run-state — the board you have today. What is each run doing right now?'],
      phase: ['Value-stream', 'Same runs, re-binned by pipeline phase. The Atlas columns, with kanban discipline.'],
      topology: ['On the map', 'Runs ride as live tokens on the workflow they’re parked in — where work actually sits.'],
    }[mode];

    // kanban headers
    const kHeaders = () => {
      if (mode === 'topology') return null;
      const isPhase = mode === 'phase';
      const groups = layout.groups, xs = layout.xs, cw = layout.cw;
      return groups.map((g, i) => {
        if (isPhase) {
          const count = RUNS.filter(r => WF[r.wf].phase === g).length;
          return (
            <div key={g} className="col-head phase" style={{ left: xs[i], top: HEAD_Y, width: cw }}>
              <span className="name"><span className="idx">{String(i + 1).padStart(2, '0')}</span>{g}</span>
              <span className="count">{count}</span>
            </div>
          );
        }
        const s = STATUSES.find(x => x.key === g);
        const count = RUNS.filter(r => r.status === g).length;
        return (
          <div key={g} className={'col-head ' + g} style={{ left: xs[i], top: HEAD_Y, width: cw }}>
            <span className="lamp" /><span className="name">{s.name}</span><span className="count">{count}</span>
          </div>
        );
      });
    };

    const { rects } = stationRects;

    return (
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <span className="eyebrow"><span className="ember" />Vertebrae · Hearth</span>
            <h1>Unified <em>Canvas</em></h1>
          </div>
          <div className="spacer" />
          <div className="morph-seg" role="tablist">
            {[['status', 'Group by', 'Status'], ['phase', 'Group by', 'Phase'], ['topology', 'Lay out as', 'Topology']].map(([m, k, v]) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} role="tab" aria-selected={mode === m}>
                <span className="k">{k}</span><span className="v">{v}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <div className="live-count"><span className="pulse" /><b>{running}</b>&nbsp;running · {RUNS.length} runs</div>
        </div>

        <div className="explainer">
          <span className="lead">{explain[0]}</span>
          <span className="txt">{explain[1]}</span>
        </div>

        <div className="stage-wrap" ref={wrapRef}>
          <div className="stage" ref={stageRef} style={{ width: W, height: H }}>

            {/* kanban headers */}
            <div className="chrome" data-show={mode !== 'topology'}>{kHeaders()}</div>

            {/* topology edges */}
            <div className="edges" data-show={mode === 'topology'}>
              <svg viewBox={`0 0 ${W} ${H}`}>
                <defs>
                  <marker id="uc-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
                  </marker>
                </defs>
                {EDGES.map(([a, b, lbl, kind]) => {
                  const d = edgePath(rects[a], rects[b]);
                  const isLit = connected && (a === litWf || b === litWf);
                  const isFade = connected && !isLit;
                  const cls = 'gedge ' + kind + (isLit ? ' lit' : '') + (isFade ? ' fade' : '');
                  return <path key={a + b} className={cls} d={d} markerEnd="url(#uc-arrow)" />;
                })}
              </svg>
            </div>

            {/* topology stations */}
            <div className="chrome" data-show={mode === 'topology'}>
              {Object.entries(WF).map(([id, w]) => {
                const st = rects[id];
                const run = RUNS.filter(r => r.wf === id && r.status === 'running').length;
                const isLit = connected && connected.has(id);
                const isDim = connected && !isLit;
                const cls = 'station' + (st.n ? '' : ' empty') + (isLit ? ' lit' : '') + (isDim ? ' dim' : '');
                return (
                  <div key={id} className={cls} style={{ left: st.x, top: st.y, width: st.w, height: st.h }}
                    onMouseEnter={() => setHoverWf(id)} onMouseLeave={() => setHoverWf(null)}>
                    <div className="st-head">
                      <span className="st-name">{w.name}</span>
                      {run ? <span className="st-run"><span className="pulse" />{run}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* run cards — always present, morph between layouts */}
            <div className="cards">
              {RUNS.map(r => {
                const rect = layout.card[r.id];
                const parked = layout.token && (r.status === 'queued' || r.status === 'done');
                const lit = (hover === r.id) || (connected && connected.has(r.wf) && layout.token);
                const faded = connected && layout.token && !connected.has(r.wf);
                return (
                  <RunCard key={r.id} r={r} rect={rect} token={layout.token} parked={parked} lit={lit} faded={faded}
                    onEnter={() => setHover(r.id)} onLeave={() => setHover(null)} />
                );
              })}
            </div>

          </div>
        </div>

        <div className="legend">
          {[['execute', 'execute'], ['eval', 'eval'], ['route', 'route'], ['human', 'human'], ['wait', 'wait'], ['final', 'done']].map(([k, l]) => (
            <span key={k} className="lg"><span className="sw" style={{ '--c': KC[k] }} />{l}</span>
          ))}
          <span className="hint">
            {mode === 'topology' ? 'Hover a run or station to trace its handoffs · parked & done runs dimmed' : 'Hover a card to lift it · switch the layout above to re-project the same runs'}
          </span>
        </div>
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
