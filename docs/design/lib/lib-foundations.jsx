/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Foundations, layout diagrams, shell extras
   TypeRamp · SurfaceRamp · InkRamp · AccentRamp · TokenTriplet · SpacingScale
   IndentGuide · LayoutDiagram · AppFrame · MotionRow
   ────────────────────────────────────────────────────────────────── */
(function () {
  // ── TypeRamp ────────────────────────────────────────────────
  const TYPE_ROWS = [
    { sample: <span className="t-display">A single vocabulary.</span>, meta: 'Display', detail: 'Newsreader italic · 38–48px · -0.02em' },
    { sample: <span className="t-h1">Emit chat runner <em>activity events</em></span>, meta: 'H1 / detail title', detail: 'Newsreader italic · 19–22px · -0.015em' },
    { sample: <span className="t-h2">Workflow Pipelines</span>, meta: 'H2 / surface title', detail: 'Geist · 15px · 500 weight' },
    { sample: <span className="t-body">Suspend execution until all fanned-out child runs reach a terminal state.</span>, meta: 'Body', detail: 'Geist · 13px · 1.55 line-height' },
    { sample: <span className="t-meta">2h 57m · 97 attempts · 67M tokens</span>, meta: 'Meta', detail: 'JetBrains Mono · 10–11px' },
    { sample: <span className="t-label">step kind</span>, meta: 'Label', detail: 'JetBrains Mono uppercase · 10px · 0.16em' },
  ];
  function TypeRamp() {
    return (
      <div style={{ borderTop: '1px solid var(--line)' }}>
        {TYPE_ROWS.map((r, i) => (
          <div className="type-row" key={i}>
            <div className="meta"><b>{r.meta}</b>{r.detail}</div>
            <div>{r.sample}</div>
          </div>
        ))}
      </div>
    );
  }

  // ── Surface / Ink ramps ─────────────────────────────────────
  function SurfaceRamp() {
    const bgs = [
      { v: 'bg', role: 'base' }, { v: 'bg-1', role: 'surface 1' }, { v: 'bg-2', role: 'surface 2' },
      { v: 'bg-3', role: 'surface 3' }, { v: 'bg-4', role: 'surface 4' },
    ];
    return (
      <div className="swatch-grid">
        {bgs.map(b => (
          <div className="swatch-cell" key={b.v} style={{ background: 'var(--' + b.v + ')' }}>
            <span style={{ color: 'var(--fg-faint)' }}>--{b.v}</span>
            <span style={{ color: 'var(--fg-mute)' }}>{b.role}</span>
          </div>
        ))}
      </div>
    );
  }
  function InkRamp() {
    const fgs = [
      { v: 'fg', role: 'primary' }, { v: 'fg-soft', role: 'soft' }, { v: 'fg-mute', role: 'mute' },
      { v: 'fg-faint', role: 'faint' }, { v: 'fg-ghost', role: 'ghost' },
    ];
    return (
      <div className="swatch-grid">
        {fgs.map(f => (
          <div className="swatch-cell" key={f.v} style={{ background: 'var(--bg-1)' }}>
            <span style={{ color: 'var(--' + f.v + ')', fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 'var(--text-16)' }}>Aa</span>
            <span style={{ color: 'var(--' + f.v + ')' }}>--{f.v}</span>
          </div>
        ))}
      </div>
    );
  }

  // ── AccentRamp ──────────────────────────────────────────────
  function AccentRamp() {
    const variants = [
      { v: 'accent', spec: 'oklch(0.74 0.18 40)', role: 'primary · "now"' },
      { v: 'accent-deep', spec: 'oklch(0.58 0.18 35)', role: 'hover · pressed' },
      { v: 'accent-mute', spec: 'oklch(0.52 0.12 38)', role: 'subdued accent' },
      { v: 'accent-wash', spec: 'oklch(0.22 0.05 38)', role: 'background tint' },
    ];
    return (
      <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'stretch', width: '100%' }}>
        {variants.map(v => (
          <div key={v.v} style={{ flex: 1, minWidth: 130, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ height: 84, background: 'var(--' + v.v + ')', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)' }} />
            <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-11)', color: 'var(--fg)' }}>--{v.v}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-9)', color: 'var(--fg-faint)' }}>{v.spec}</div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 'var(--text-11)', color: 'var(--fg-mute)' }}>{v.role}</div>
          </div>
        ))}
      </div>
    );
  }

  // ── TokenTriplet ────────────────────────────────────────────
  // Renders a color family as main / wash / fg(Aa). { base, fg, hue, note, anchored }
  function TokenTriplet({ base, fg, hue, note, anchored }) {
    return (
      <div className="card">
        <div className="card-head">
          <div className="card-name">--{base} <em style={{ color: 'var(--' + fg + ')', marginLeft: 0 }}>{note}</em></div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-9)', color: 'var(--fg-faint)', padding: '2px 6px', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-xs)', letterSpacing: '0.1em' }}>
            {anchored ? '⚓ anchored' : 'spread'}
          </span>
        </div>
        <div className="card-canvas" style={{ padding: 'var(--s-3)', gap: 8, alignItems: 'stretch' }}>
          <div className="triplet"><div className="bar" style={{ background: 'var(--' + base + ')' }} /><span className="lbl">main</span></div>
          <div className="triplet"><div className="bar" style={{ background: 'var(--' + base + '-wash)' }} /><span className="lbl">wash</span></div>
          <div className="triplet"><div className="bar" style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 'var(--text-22)', color: 'var(--' + fg + ')' }}>Aa</div><span className="lbl">fg</span></div>
        </div>
        <div className="card-foot">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-10)' }}>main · wash · fg</span>
          {hue != null ? <span style={{ float: 'right', fontFamily: 'var(--mono)', fontSize: 'var(--text-9)', color: 'var(--fg-faint)' }}>hue {hue}°</span> : null}
        </div>
      </div>
    );
  }

  // ── SpacingScale ────────────────────────────────────────────
  function SpacingScale() {
    const scale = [
      { t: 's-1', px: 4 }, { t: 's-2', px: 8 }, { t: 's-3', px: 12 }, { t: 's-4', px: 16 },
      { t: 's-5', px: 20 }, { t: 's-6', px: 24 }, { t: 's-7', px: 28 }, { t: 's-8', px: 32 },
      { t: 's-10', px: 40 }, { t: 's-12', px: 48 }, { t: 's-16', px: 64 },
    ];
    return (
      <div style={{ width: '100%' }}>
        {scale.map(s => (
          <div key={s.t} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 46px', gap: 12, alignItems: 'center', padding: '4px 0' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-11)', color: 'var(--fg-mute)' }}>--{s.t}</span>
            <div style={{ height: 14, width: s.px, background: 'var(--accent-wash)', borderLeft: '2px solid var(--accent)', borderRadius: '0 var(--r-xs) var(--r-xs) 0' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-10)', color: 'var(--fg-faint)', textAlign: 'right' }}>{s.px}px</span>
          </div>
        ))}
      </div>
    );
  }

  // ── IndentGuide ─────────────────────────────────────────────
  function IndentGuide() {
    const G = ({ left }) => <span style={{ position: 'absolute', left, top: 0, bottom: 0, borderRight: '1px dashed var(--line)' }} />;
    return (
      <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-11)', color: 'var(--fg-faint)', width: '100%' }}>
        <div style={{ position: 'relative', padding: '4px 0 4px 28px' }}><G left={8} /><span style={{ color: 'var(--fg-mute)' }}>◇ ticket</span></div>
        <div style={{ position: 'relative', padding: '4px 0 4px 50px' }}><G left={8} /><G left={30} /><span style={{ color: 'var(--fg-soft)' }}>· task</span></div>
        <div style={{ position: 'relative', padding: '4px 0 4px 50px' }}><G left={8} /><G left={30} /><span style={{ color: 'var(--fg-soft)' }}>· task</span></div>
      </div>
    );
  }

  // ── LayoutDiagram ───────────────────────────────────────────
  // variant ∈ tasks | board | design | traces ; uses .diagram classes
  function Region({ name, comps, accent, style, className }) {
    return (
      <div className={'region' + (accent ? ' accent' : '') + (className ? ' ' + className : '')} style={style}>
        <div className="reg-name">{name}</div>
        {comps ? <div className="reg-comps" dangerouslySetInnerHTML={{ __html: comps }} /> : null}
      </div>
    );
  }
  function LayoutDiagram({ variant, stub, regions, annot }) {
    return (
      <div className={'diagram diag-' + variant}>
        <div className="stub-top-2">{stub}</div>
        <div className="frame">
          {regions.map((r, i) => <Region key={i} {...r} />)}
        </div>
        <div className="annot" dangerouslySetInnerHTML={{ __html: annot }} />
      </div>
    );
  }

  // ── AppFrame (shell composer demo) ──────────────────────────
  function AppFrame() {
    const bar = { fontFamily: 'var(--mono)', fontSize: 'var(--text-8)', color: 'var(--fg-faint)', letterSpacing: '0.16em', textTransform: 'uppercase' };
    return (
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4, padding: 'var(--s-3)' }}>
        <div style={{ background: 'var(--bg-2)', height: 18, borderRadius: 2, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', padding: '0 8px', ...bar }}>TopBar</div>
        <div style={{ display: 'flex', gap: 4, height: 120 }}>
          <div style={{ width: 24, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 2, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 4, ...bar, writingMode: 'vertical-rl' }}>Rail</div>
          <div style={{ flex: 1, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 'var(--text-9)', color: 'var(--fg-mute)' }}>Center column</div>
          <div style={{ width: 80, background: 'color-mix(in oklch, var(--accent-wash) 30%, var(--bg-2))', border: '1px dashed color-mix(in oklch, var(--accent) 30%, var(--line))', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', ...bar, color: 'var(--accent)' }}>Inspector</div>
        </div>
      </div>
    );
  }

  // ── MotionRow ───────────────────────────────────────────────
  function FlowEdge({ width = 240 }) {
    return (
      <svg width={width} height="20" viewBox={'0 0 ' + width + ' 20'}>
        <path d={'M10,10 H' + (width - 10)} stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 4" fill="none" style={{ filter: 'drop-shadow(0 0 4px var(--accent-glow))' }}>
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.4s" repeatCount="indefinite" />
        </path>
      </svg>
    );
  }
  function WaitBar() {
    return (
      <div style={{ width: 240, padding: '8px 12px', background: 'color-mix(in oklch, var(--step-wait-wash) 25%, var(--bg-2))', border: '1px solid color-mix(in oklch, var(--step-wait) 30%, transparent)', borderLeft: '3px solid var(--step-wait)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--sans)', fontSize: 'var(--text-11)', color: 'var(--step-wait-fg)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>Waiting</span>
        <span style={{ flex: 1, height: 3, background: 'linear-gradient(to right, var(--step-wait) 40%, transparent)', backgroundSize: '200% 100%', animation: 'c-flow 2.4s ease-in-out infinite', borderRadius: 2 }} />
      </div>
    );
  }

  Object.assign(window, {
    TypeRamp, SurfaceRamp, InkRamp, AccentRamp, TokenTriplet, SpacingScale,
    IndentGuide, LayoutDiagram, AppFrame, FlowEdge, WaitBar,
  });
})();
