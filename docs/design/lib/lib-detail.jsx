/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Detail surface
   DetailHeader · HeroStatus · Accordion · FieldRow
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState } = React;
  const { IdChip } = window;

  // ── DetailHeader ────────────────────────────────────────────
  // title may contain a `mark` substring rendered in accent.
  // { title, mark, id, crumbs: [{text, em}] }
  function DetailHeader({ title, mark, id, crumbs = [] }) {
    let titleNode = title;
    if (mark && title.includes(mark)) {
      const [pre, post] = title.split(mark);
      titleNode = <>{pre}<em>{mark}</em>{post}</>;
    }
    return (
      <div className="detail-header">
        <div className="dh-title">{titleNode}</div>
        <div className="dh-crumb">
          {id ? <IdChip id={id} /> : null}
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span>·</span>
              <span onClick={c.onClick} style={c.onClick ? { cursor: 'pointer' } : null}>
                {c.em ? <em>{c.text}</em> : c.text}
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  // ── HeroStatus ──────────────────────────────────────────────
  // { state: running|waiting|queued|completed|cancelled|stopped|none,
  //   edge: kind, label, runtime, step:{n,kind}, finished, children }
  const PlayIcon = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
  );
  const ClockIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
  const CheckIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
  );
  const QueuedIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="9" opacity="0.4" /></svg>
  );
  const CancelIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
  );
  const EmptyIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.7"><circle cx="12" cy="12" r="9" /></svg>
  );
  const HERO_STATE = {
    running:   { Icon: PlayIcon,   tone: 'accent' },
    waiting:   { Icon: ClockIcon,  tone: 'warn' },
    queued:    { Icon: QueuedIcon, tone: 'mute' },
    completed: { Icon: CheckIcon,  tone: 'ok' },
    cancelled: { Icon: CancelIcon, tone: 'faint' },
    stopped:   { Icon: CancelIcon, tone: 'faint' },
    none:      { Icon: EmptyIcon,  tone: 'faint' },
  };
  const TONE_COLOR = { accent: 'var(--accent)', warn: 'var(--warn)', ok: 'var(--ok)', mute: 'var(--fg-mute)', faint: 'var(--fg-faint)' };
  function HeroStatus({ state = 'waiting', edge = 'wait', label, runtime, step, finished, right, children }) {
    const cfg = HERO_STATE[state] || HERO_STATE.waiting;
    const Icon = cfg.Icon;
    const color = TONE_COLOR[cfg.tone];
    return (
      <div className={'hero-status edge-' + edge}>
        <div className="hero-line" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="icon" style={{ color, display: 'inline-flex' }}><Icon /></span>
          <span className="state" style={{ color }}>{label}</span>
          {runtime ? <><span className="sep">·</span><span className="runtime">{runtime}</span></> : null}
          {step ? <><span className="sep">·</span><span className="at">at step <em style={{ color: 'var(--step-' + step.kind + '-fg)' }}>{step.n != null ? step.n + ' · ' : ''}{step.kind}</em></span></> : null}
          {finished ? <><span className="sep">·</span><span style={{ color: 'var(--fg-mute)' }}>{finished}</span></> : null}
          {right ? <span className="hero-right" style={{ marginLeft: 'auto' }}>{right}</span> : null}
        </div>
        {children}
      </div>
    );
  }

  // ── Accordion ───────────────────────────────────────────────
  // { name, accent, count, defaultOpen, children }
  function Accordion({ name, accent, count, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
      <div className={'accordion' + (open ? ' open' : '')}>
        <div className="acc-hd" onClick={() => setOpen(o => !o)}>
          <span className="chev">▾</span>
          <span className={'name' + (accent ? ' accent' : '')}>{name}</span>
          {count != null ? <span className="count">{count}</span> : null}
        </div>
        {children ? <div className="acc-bd">{children}</div> : null}
      </div>
    );
  }

  // ── FieldRow ────────────────────────────────────────────────
  // { k, v, tone: serif|execute|eval|route|human|wait|err }
  function FieldRow({ k, v, tone }) {
    const cls = 'v' + (tone ? ' ' + tone : '');
    return (
      <div className="field-row">
        <span className="k">{k}</span>
        <span className={cls}>{v}</span>
      </div>
    );
  }

  Object.assign(window, { DetailHeader, HeroStatus, Accordion, FieldRow });
})();
