/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Primitives
   Atoms reuse the canonical c-* classes from components-v2.css.
   RunChip · IdChip · KindChip · Pipeline · StepDot · StateBreakdown · Glyph
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState } = React;

  // ── Small inline icons ──────────────────────────────────────
  const ClockIcon = (p) => (
    <svg width={p.size || 9} height={p.size || 9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );

  // ── RunChip ─────────────────────────────────────────────────
  // Terminal (completed/cancelled/stopped) and null states render nothing
  // UNLESS `force` is passed (catalog needs to show every variant).
  const TERMINAL = { completed: 1, cancelled: 1, stopped: 1 };
  function RunChip({ state, label, runtime, sm, force }) {
    if (!state) return null;
    if (TERMINAL[state] && !force) return null;
    const cls = 'c-run-chip ' + state + (sm ? ' sm' : '');
    return (
      <span className={cls}>
        {state === 'running' && <span className="spinner" />}
        {state === 'waiting' && !sm && <ClockIcon />}
        {label}
        {runtime ? <span className="runtime"> · {runtime}</span> : null}
      </span>
    );
  }

  // ── IdChip ──────────────────────────────────────────────────
  function IdChip({ id }) {
    const [copied, setCopied] = useState(false);
    function copy(e) {
      e.stopPropagation();
      const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1100); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(done).catch(() => {
          try {
            const ta = document.createElement('textarea');
            ta.value = id; ta.style.cssText = 'position:fixed;left:-9999px;opacity:0;';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta); done();
          } catch (err) {}
        });
      } else { done(); }
    }
    return (
      <span className={'c-id-chip' + (copied ? ' copied' : '')} title="click to copy" onClick={copy}>
        <span className="id-text">{id}</span>
        <svg className="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="1" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg className="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }

  // ── KindChip ────────────────────────────────────────────────
  const KIND_LABELS = { execute: 'execute', eval: 'eval', route: 'route', human: 'human review', wait: 'wait' };
  function KindChip({ kind, label }) {
    return (
      <span className={'c-kind-chip kind-' + kind}>
        <span className="swatch" />{label || KIND_LABELS[kind] || kind}
      </span>
    );
  }

  // ── Pipeline ────────────────────────────────────────────────
  // segments: [{ kind, state }] — state ∈ completed|running|waiting|queued
  function Pipeline({ segments, width = 140, height = 4 }) {
    return (
      <span className="c-pipeline" style={{ width, height }}>
        {segments.map((s, i) => (
          <span key={i} className={'seg kind-' + s.kind + (s.state ? ' s-' + s.state : '')} />
        ))}
      </span>
    );
  }

  // ── StepDot ─────────────────────────────────────────────────
  // variant ∈ done|running|waiting|queued
  function StepDot({ variant = 'queued' }) {
    return <span className={'c-dot ' + variant} />;
  }

  // ── StateBreakdown ──────────────────────────────────────────
  // counts: { done, running, waiting, queued } — only > 0 render
  function StateBreakdown({ done = 0, running = 0, waiting = 0, queued = 0 }) {
    const parts = [];
    if (done) parts.push(<span key="d" className="b-done">✓ {done}</span>);
    if (running) parts.push(<span key="r" className="b-run">▶ {running}</span>);
    if (waiting) parts.push(<span key="w" className="b-wait">⏸ {waiting}</span>);
    if (queued) parts.push(<span key="q" className="b-q">○ {queued}</span>);
    const withSeps = [];
    parts.forEach((p, i) => {
      if (i > 0) withSeps.push(<span key={'s' + i} className="sep">·</span>);
      withSeps.push(p);
    });
    return <span className="c-breakdown">{withSeps}</span>;
  }

  // ── Glyph ───────────────────────────────────────────────────
  // level ∈ 0 (epic ◈) | 1 (ticket ◇) | 2 (task ·)
  const GLYPHS = ['◈', '◇', '·'];
  function Glyph({ level = 0, accent }) {
    return (
      <span className={'c-glyph l' + level} style={accent ? { color: 'var(--accent)' } : null}>
        {GLYPHS[level]}
      </span>
    );
  }

  Object.assign(window, {
    RunChip, IdChip, KindChip, Pipeline, StepDot, StateBreakdown, Glyph, ClockIcon,
  });
})();
