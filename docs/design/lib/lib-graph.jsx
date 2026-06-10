/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Workflow graph
   StepNode · GraphEdge · RunPellet · Minimap · ZoomWidget
   Canvas vocabulary (shared by Atlas + Graph):
   SegControl · KnobToggle · KindLegend · StepStrip
   ────────────────────────────────────────────────────────────────── */
(function () {
  // ── RunPellet ───────────────────────────────────────────────
  function RunPellet({ id, onClick }) {
    return (
      <span className="run-pellet" onClick={onClick}>
        <span className="dot" />{id}
      </span>
    );
  }

  // ── StepNode ────────────────────────────────────────────────
  // { num, kind, title, desc, active, selected, runs, style, children }
  function StepNode({ num, kind, title, desc, active, selected, runs, style, children, onClick }) {
    const cls = 'step-node kind-' + kind + (active ? ' active' : '') + (selected ? ' sel' : '');
    return (
      <div className={cls} style={style} onClick={onClick}>
        <div className="row">
          <span className="num">{num}</span>
          <span className="kind">{kind === 'terminal' ? 'done' : kind}</span>
        </div>
        <div className="ttl">{title}</div>
        {desc ? <div className="sn-desc">{desc}</div> : null}
        {runs ? <div className="runs"><span className="pulse" />{runs}</div> : null}
        {children}
      </div>
    );
  }

  // ── GraphMarkers ────────────────────────────────────────────
  // Shared arrowhead defs. Drop ONE of these inside any canvas <svg>
  // that renders <GraphEdge>. #ge-arrow inherits the path's stroke
  // (context-stroke); #ge-loop is fixed to the route hue.
  function GraphMarkers() {
    return (
      <defs>
        <marker id="ge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
        <marker id="ge-loop" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--step-route)" />
        </marker>
      </defs>
    );
  }

  // ── GraphEdge ───────────────────────────────────────────────
  // One routed SVG <path>. Style comes from the .gedge token classes —
  // see components-lib.css. Use inside an <svg> alongside <GraphMarkers/>.
  //   kind:  'step' | 'handoff' | 'loop'
  //   state: '' | 'lit' | 'dim'
  //   solid: force a handoff to render without a dash (high-level map)
  //   live:  legacy animated-accent variant (design-v2)
  // markerEnd defaults by kind; pass a custom url() or null to override.
  function GraphEdge({ d, kind = 'step', state = '', solid, live, markerEnd }) {
    const marker = markerEnd !== undefined ? markerEnd : (kind === 'loop' ? 'url(#ge-loop)' : 'url(#ge-arrow)');
    if (live) {
      return (
        <path className="gedge live" d={d} markerEnd={marker}>
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.4s" repeatCount="indefinite" />
        </path>
      );
    }
    const cls = 'gedge k-' + kind + (solid ? ' solid' : '') + (state ? ' ' + state : '');
    return <path className={cls} d={d} markerEnd={marker} />;
  }

  // ── Minimap ─────────────────────────────────────────────────
  // Faithful reduction; nodes keep kind palette, active pulses, viewport box.
  function Minimap() {
    return (
      <div style={{ width: 240, height: 90, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: 8 }}>
        <svg viewBox="0 0 200 60" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <g stroke="var(--line-strong)" strokeWidth="1" fill="none">
            <path d="M14,30 H38" /><path d="M48,30 H62" /><path d="M72,30 H86" />
            <path d="M96,30 L110,18" /><path d="M96,30 L110,30" /><path d="M96,30 L110,42" />
            <path d="M120,18 L134,30" /><path d="M120,30 H134" /><path d="M120,42 L134,30" />
            <path d="M144,30 H158" /><path d="M168,30 H182" />
          </g>
          <rect x="4" y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7" />
          <rect x="38" y="26" width="10" height="8" rx="1" fill="var(--step-eval)" opacity="0.7" />
          <rect x="62" y="26" width="10" height="8" rx="1" fill="var(--step-route)" opacity="0.7" />
          <rect x="86" y="14" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.5" />
          <rect x="86" y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7" />
          <rect x="86" y="38" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.5" />
          <rect x="110" y="26" width="10" height="8" rx="1" fill="var(--accent)" stroke="var(--accent)" strokeWidth="0.5">
            <animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite" />
          </rect>
          <rect x="134" y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7" />
          <rect x="158" y="26" width="10" height="8" rx="1" fill="var(--ok)" opacity="0.7" />
          <rect x="2" y="6" width="80" height="48" fill="none" stroke="var(--accent)" strokeWidth="0.8" strokeDasharray="3 2" opacity="0.6" />
        </svg>
      </div>
    );
  }

  // ── ZoomWidget ──────────────────────────────────────────────
  // floating: pins to a canvas corner (.floating modifier). Always
  // carries data-no-pan so the pan handler ignores button drags.
  function ZoomWidget({ onZoomIn, onZoomOut, onFit, floating }) {
    return (
      <div className={'zoom-widget' + (floating ? ' floating' : '')} data-no-pan>
        <button title="Zoom in" onClick={onZoomIn}>＋</button>
        <button title="Zoom out" onClick={onZoomOut}>−</button>
        <button title="Fit to content" onClick={onFit}>⊡</button>
      </div>
    );
  }

  // ── SegControl ──────────────────────────────────────────────
  // Accent-on segmented control. items: [{ id, label, href?, on?, onClick? }].
  // An item with href renders a navigational <a>; otherwise a <button>.
  // Optional `label` renders a leading mono caption cap.
  function SegControl({ items, label, title }) {
    return (
      <div className="seg-control" title={title}>
        {label ? <span className="lab">{label}</span> : null}
        {items.map((it) => it.href != null
          ? <a key={it.id} className={it.on ? 'on' : ''} href={it.href}>{it.label}</a>
          : <button key={it.id} className={it.on ? 'on' : ''} onClick={it.onClick}>{it.label}</button>
        )}
      </div>
    );
  }

  // ── KnobToggle ──────────────────────────────────────────────
  // Inline pill switch with a trailing text label.
  function KnobToggle({ on, onToggle, label, title }) {
    return (
      <div className={'knob-toggle' + (on ? ' on' : '')} onClick={onToggle} title={title}>
        <span className="knob" />{label}
      </div>
    );
  }

  // ── KindLegend ──────────────────────────────────────────────
  // Footer swatch→label strip. items: [[kind, label], …]; hint: helper text.
  function KindLegend({ items, hint }) {
    return (
      <footer className="kind-legend">
        {items.map(([k, lbl]) => <span key={k} className={'lg-item k-' + k}><span className="sw" />{lbl}</span>)}
        <span className="lg-sep" />
        {hint ? <span className="hint">{hint}</span> : null}
      </footer>
    );
  }

  // ── StepStrip ───────────────────────────────────────────────
  // Reduces a workflow's ordered step kinds four ways. shape: string[].
  // mode: 'ribbon' | 'pipeline' | 'grouped' | 'tally'.
  const stepKindLabel = (k) => (k === 'final' ? 'done' : k);
  function groupRuns(shape) {
    const out = [];
    shape.forEach((k) => { const l = out[out.length - 1]; if (l && l.kind === k) l.count++; else out.push({ kind: k, count: 1 }); });
    return out;
  }
  function tallyKinds(shape) {
    const m = {}, order = [];
    shape.forEach((k) => { if (!(k in m)) { m[k] = 0; order.push(k); } m[k]++; });
    return order.map((k) => ({ kind: k, count: m[k] }));
  }
  function StepStrip({ shape, mode }) {
    if (mode === 'ribbon') return <div className="strip-ribbon">{shape.map((k, i) => <span key={i} className={'seg k-' + k} />)}</div>;
    if (mode === 'pipeline') return (
      <div className="strip-pipe">
        {shape.map((k, i) => (
          <React.Fragment key={i}>{i > 0 ? <span className="link" /> : null}<span className={'dot k-' + k} title={stepKindLabel(k)} /></React.Fragment>
        ))}
      </div>
    );
    if (mode === 'grouped') {
      const g = groupRuns(shape);
      return (
        <div className="strip-chips">
          {g.map((s, i) => (
            <React.Fragment key={i}>{i > 0 ? <span className="arrow">›</span> : null}
              <span className={'chip k-' + s.kind}>{stepKindLabel(s.kind)}{s.count > 1 ? <b>×{s.count}</b> : null}</span>
            </React.Fragment>
          ))}
        </div>
      );
    }
    const t = tallyKinds(shape);
    return <div className="strip-chips">{t.map((s, i) => <span key={i} className={'chip k-' + s.kind}>{stepKindLabel(s.kind)}<b>{s.count}</b></span>)}</div>;
  }

  Object.assign(window, { StepNode, GraphEdge, GraphMarkers, RunPellet, Minimap, ZoomWidget, SegControl, KnobToggle, KindLegend, StepStrip });
})();
