/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Surfaces
   TaskRow · BoardCard · RunCard · WorkflowRailItem · RecentItem
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { RunChip, IdChip, Glyph, Pipeline } = window;

  // ── TaskRow ─────────────────────────────────────────────────
  // task: { level, title, id, when, run: {state,label,runtime}, selected, completed }
  function TaskRow({ level = 0, title, id, when, run, selected, completed, guides, onClick }) {
    const cls = 'task-row l' + level +
      (selected ? ' selected' : '') + (completed ? ' completed' : '');
    return (
      <div className={cls} onClick={onClick}>
        {(guides || []).map((left, i) => (
          <span key={i} className="guide" style={{ left }} />
        ))}
        <Glyph level={level} accent={run && run.state === 'running' && level === 1 ? false : false} />
        <span className="ttl">{title}</span>
        <span className="right">
          {run ? <RunChip {...run} sm={level >= 1 && level !== 0 ? run.sm : run.sm} /> : null}
          {id ? <IdChip id={id} /> : null}
          {when ? <span className="when">{when}</span> : null}
        </span>
      </div>
    );
  }

  // ── BoardCard ───────────────────────────────────────────────
  // { kind, title, level, priority, stepLabel, pipeline:[{kind,state}],
  //   breakdown:{done,running,waiting,queued}, tags:[], run, id, when, running, done }
  const PRI_SYM = { hi: '↑', md: '→', lo: '↓' };
  function BoardCard({ kind, title, level = 1, priority, stepLabel, pipeline, breakdown, tags, run, id, when, running, done, onClick }) {
    const cls = 'board-card l' + level + ' kind-' + kind + (running ? ' running' : '') + (done ? ' done' : '');
    const bd = breakdown && (breakdown.done || breakdown.running || breakdown.waiting || breakdown.queued);
    return (
      <div className={cls} onClick={onClick}>
        <div className="bc-title">
          <window.Glyph level={level} accent={running} />
          <span className="ttl">{title}</span>
          {priority ? <span className={'bc-pri ' + priority} title={priority + ' priority'}>{PRI_SYM[priority]}</span> : null}
        </div>
        {stepLabel ? <span className={'step-tag kind-' + kind}>step · {stepLabel}</span> : null}
        {pipeline && pipeline.length ? <window.Pipeline width="100%" height={3} segments={pipeline.map(s => ({ kind: s.kind, state: s.state }))} /> : null}
        {bd ? <window.StateBreakdown {...breakdown} /> : null}
        {tags && tags.length ? (
          <div className="bc-tags">
            {tags.slice(0, 2).map((x, i) => <span key={i} className="tag">{x}</span>)}
            {tags.length > 2 ? <span style={{ color: 'var(--fg-ghost)' }}>+{tags.length - 2}</span> : null}
          </div>
        ) : null}
        <div className="bc-foot">
          {run ? <RunChip {...run} sm /> : null}
          {id ? <IdChip id={id} /> : null}
          {when ? <span className="when">{when}</span> : null}
        </div>
      </div>
    );
  }

  // ── RunCard ─────────────────────────────────────────────────
  // { run, id, when, reason, selected }
  function RunCard({ run, id, when, reason, selected, onClick }) {
    return (
      <div className={'run-card' + (selected ? ' selected' : '')} onClick={onClick}>
        <div className="head">
          {run ? <RunChip {...run} force /> : null}
          {id ? <IdChip id={id} /> : null}
        </div>
        <div className="when">
          {when}{reason ? <span className="err"> · {reason}</span> : null}
        </div>
      </div>
    );
  }

  // ── WorkflowRailItem ────────────────────────────────────────
  // { name, shape: [kind...], live, steps, daily, avg, selected }
  function WorkflowRailItem({ name, shape, live, steps, daily, avg, selected, onClick }) {
    const meta = [];
    if (live) meta.push(<span key="live" className="live"><span className="pulse" />{live} running</span>);
    if (steps) meta.push(<span key="steps">{steps} steps</span>);
    if (daily) meta.push(<span key="daily">{daily} / 24h</span>);
    if (avg) meta.push(<span key="avg">avg {avg}</span>);
    const withSeps = [];
    meta.forEach((m, i) => {
      if (i > 0) withSeps.push(<span key={'s' + i} className="sep">·</span>);
      withSeps.push(m);
    });
    return (
      <div className={'wf-rail-item' + (selected ? ' selected' : '')} onClick={onClick}>
        <div className="name">{name}</div>
        <div className="shape">
          {shape.map((k, i) => <span key={i} className={'seg kind-' + k} />)}
        </div>
        <div className="meta">{withSeps}</div>
      </div>
    );
  }

  // ── RecentItem ──────────────────────────────────────────────
  // { variant: done|running|waiting, title, when, muted }
  function RecentItem({ variant = 'done', title, when, muted }) {
    const accentWhen = variant === 'running';
    return (
      <div className={'recent-item' + (muted ? ' muted' : '')}>
        <span className={'dot ' + variant} />
        <span className="ri-title">{title}</span>
        <span className={'ri-when' + (accentWhen ? ' accent' : '')}>{when}</span>
      </div>
    );
  }

  Object.assign(window, { TaskRow, BoardCard, RunCard, WorkflowRailItem, RecentItem });
})();
