/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Workflow graph
   StepNode · GraphEdge · RunPellet · Minimap · ZoomWidget
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

  // ── GraphEdge ───────────────────────────────────────────────
  // Standalone SVG path. Use inside an <svg>. variant: live adds animation.
  function GraphEdge({ d, live, markerEnd }) {
    if (live) {
      return (
        <path d={d} stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 4" fill="none"
          style={{ filter: 'drop-shadow(0 0 4px var(--accent-glow))' }} markerEnd={markerEnd}>
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.4s" repeatCount="indefinite" />
        </path>
      );
    }
    return <path d={d} stroke="var(--line-strong)" strokeWidth="1.5" fill="none" markerEnd={markerEnd} />;
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
  function ZoomWidget({ onZoomIn, onZoomOut, onFit }) {
    return (
      <div className="zoom-widget">
        <button title="Zoom in" onClick={onZoomIn}>＋</button>
        <button title="Zoom out" onClick={onZoomOut}>−</button>
        <button title="Fit to content" onClick={onFit}>⊡</button>
      </div>
    );
  }

  Object.assign(window, { StepNode, GraphEdge, RunPellet, Minimap, ZoomWidget });
})();
