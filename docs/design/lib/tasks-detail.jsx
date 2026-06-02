/* ──────────────────────────────────────────────────────────────────
   Hearth · Tasks v2 — Detail panel (React)
   Composed entirely from the component library: DetailHeader, HeroStatus,
   Accordion, FieldRow, RunChip, IdChip, StepDot, StateBreakdown, Button, IconButton.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { DetailHeader, HeroStatus, Accordion, FieldRow, RunChip, IdChip, StepDot, StateBreakdown, Button, IconButton } = window;
  const { useState, useRef, useEffect } = React;
  const D = window.HEARTH_DATA;

  const LEVEL_NAMES = ['Epic', 'Ticket', 'Task'];
  const MARK_RE = /(live chat runner|JWT service|chat runner|OpenRouter|work breakdown|tracker operation tools|chat sessions)/i;

  // action icons
  const I = {
    run: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
    stop: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>,
    chat: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
    open: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>,
    close: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
  };

  // run-state → hero label / edge
  const RUN_LABEL = { running: 'Running', waiting: 'Waiting', queued: 'Queued', completed: 'Completed', cancelled: 'Cancelled', stopped: 'Stopped' };

  function childCounts(t) {
    let done = 0, running = 0, waiting = 0, queued = 0;
    (t.children || []).forEach(cid => {
      const c = D.byId[cid]; if (!c) return;
      if (c.runState === 'completed') done++;
      else if (c.runState === 'running') running++;
      else if (c.runState === 'waiting') waiting++;
      else if (c.runState === 'queued') queued++;
    });
    return { done, running, waiting, queued };
  }

  function HeroDots({ t }) {
    if (!t.children || !t.children.length) return null;
    const map = { completed: 'done', running: 'running', waiting: 'waiting', queued: 'queued', cancelled: 'queued', stopped: 'queued' };
    return (
      <div style={{ marginTop: 'var(--s-3)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {t.children.map(cid => {
          const c = D.byId[cid]; if (!c) return null;
          return <span key={cid} title={c.title + (c.runState ? ' — ' + c.runState : '')}><StepDot variant={map[c.runState] || 'queued'} /></span>;
        })}
        {t.runs ? <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 'var(--text-10)', color: 'var(--fg-faint)' }}>{t.runs.this.runs} runs · {t.runs.this.attempts} attempts</span> : null}
      </div>
    );
  }

  function Hero({ t }) {
    const kind = t.stepKind || null;
    const edge = kind || 'none';
    const state = t.runState || 'none';
    const label = RUN_LABEL[t.runState] || 'No active run';
    const runtime = t.runtime && (t.runState === 'running' || t.runState === 'waiting') ? t.runtime : null;
    const finished = t.runState === 'completed' && t.when ? 'completed ' + t.when + ' ago' : null;
    const cc = childCounts(t);
    const hasBreak = cc.done || cc.running || cc.waiting || cc.queued;
    return (
      <div style={{ marginTop: 'var(--s-4)' }}>
        <HeroStatus state={state} edge={edge} label={label} runtime={runtime}
          step={kind ? { kind } : null} finished={finished}>
          {hasBreak ? (
            <div style={{ marginTop: 'var(--s-2)', fontFamily: 'var(--mono)', fontSize: 'var(--text-11)' }}>
              <StateBreakdown done={cc.done} running={cc.running} waiting={cc.waiting} queued={cc.queued} />
            </div>
          ) : null}
          <HeroDots t={t} />
        </HeroStatus>
      </div>
    );
  }

  // ── Section bodies ──────────────────────────────────────────
  function ChildRow({ c, onSelect }) {
    const running = c.runState === 'running';
    const completed = c.runState === 'completed';
    return (
      <div className="t-child" onClick={() => onSelect(c.id)}>
        <span className="cdot" style={c.stepKind ? { background: 'var(--step-' + c.stepKind + ')' } : null} />
        <span className="cname" style={{ color: running ? 'var(--fg)' : completed ? 'var(--fg-mute)' : 'var(--fg-soft)' }}>{c.title}</span>
        <span className="cright">
          {D.isActiveRun(c.runState) ? <RunChip state={c.runState} label={RUN_LABEL[c.runState]} runtime={c.runtime} sm /> : null}
          <IdChip id={c.id} />
        </span>
      </div>
    );
  }

  function Children({ t, onSelect }) {
    if (!t.children || !t.children.length) return <div className="t-empty">No children yet.</div>;
    return <>{t.children.map(cid => { const c = D.byId[cid]; return c ? <ChildRow key={cid} c={c} onSelect={onSelect} /> : null; })}</>;
  }

  function Spec({ t }) {
    const blocks = [];
    if (t.goal) blocks.push(<React.Fragment key="g"><div className="t-sublbl">Goal</div><div className="t-prose"><p>{t.goal}</p></div></React.Fragment>);
    if (t.description) blocks.push(<React.Fragment key="d"><div className="t-sublbl">Description</div><div className="t-prose"><p>{t.description}</p></div></React.Fragment>);
    if (t.constraints && t.constraints.length) blocks.push(
      <React.Fragment key="c"><div className="t-sublbl">Constraints</div><div className="t-prose"><ul>{t.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul></div></React.Fragment>
    );
    if (t.desired) blocks.push(<React.Fragment key="x"><div className="t-sublbl">Desired behavior</div><div className="t-prose"><p>{t.desired}</p></div></React.Fragment>);
    return blocks.length ? <>{blocks}</> : <div className="t-empty">No spec authored yet.</div>;
  }

  function Deps({ t, onSelect }) {
    const parent = t.parent ? D.byId[t.parent] : null;
    const blocked = (t.blockedBy || []).map(b => D.byId[b]).filter(Boolean);
    if (!parent && !blocked.length) return <div className="t-empty">No dependencies.</div>;
    return (
      <>
        {parent ? <>
          <div className="t-sublbl">Parent</div>
          <div className="t-dep" onClick={() => onSelect(parent.id)}><IdChip id={parent.id} /><span className="dep-title">{parent.title}</span></div>
        </> : null}
        {blocked.length ? <>
          <div className="t-sublbl">Blocked by</div>
          {blocked.map(b => <div key={b.id} className="t-dep" onClick={() => onSelect(b.id)}><IdChip id={b.id} /><span className="dep-title">{b.title}</span></div>)}
        </> : null}
      </>
    );
  }

  function Details({ t }) {
    const pri = t.priority === 'hi' ? { v: 'High ↑', tone: 'err' } : t.priority === 'md' ? { v: 'Medium →', tone: 'wait' } : t.priority === 'lo' ? { v: 'Low ↓', tone: '' } : { v: 'None', tone: '' };
    return (
      <>
        <FieldRow k="Level" v={LEVEL_NAMES[t.level]} />
        <FieldRow k="Step kind" v={t.stepKind || 'none'} tone={t.stepKind ? 'serif ' + t.stepKind : ''} />
        <FieldRow k="Priority" v={pri.v} tone={pri.tone} />
        <FieldRow k="Updated" v={t.when || '—'} />
        <FieldRow k="Tags" v={(t.tags || []).join(' · ') || 'none'} />
      </>
    );
  }

  // ── Quick-add composer ──────────────────────────────────────
  // Two paths to the same tree: Draft (you author it) or Delegate (hand a
  // one-line intent to the agent in chat). Inline, keyboard-driven — no modal.
  function Composer({ t, onAddChild, onCancel }) {
    const [mode, setMode] = useState('draft');
    const [title, setTitle] = useState('');
    const [level, setLevel] = useState(Math.min(t.level + 1, 2));
    const [priority, setPriority] = useState('none');
    const inputRef = useRef(null);
    useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

    const levelOpts = [];
    for (let i = Math.min(t.level + 1, 2); i <= 2; i++) levelOpts.push(i);
    if (!levelOpts.length) levelOpts.push(2);

    const canCreate = title.trim().length > 0;
    function submit() {
      if (!canCreate) return;
      onAddChild(t.id, { title: title.trim(), level, priority, mode });
      onCancel();
    }
    function onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      e.stopPropagation();   // keep the list's arrow/esc handlers from firing while typing
    }

    return (
      <div className="t-composer">
        <div className="tc-top">
          <div className="tc-pre">New task <em>· child of {LEVEL_NAMES[t.level].toLowerCase()}</em></div>
          <div className="tc-seg">
            <button className={mode === 'draft' ? 'on' : ''} onClick={() => setMode('draft')}>Draft</button>
            <button className={mode === 'delegate' ? 'on' : ''} onClick={() => setMode('delegate')}>Delegate</button>
          </div>
        </div>
        <textarea ref={inputRef} className="tc-input" rows={2}
          placeholder={mode === 'draft' ? 'Title — what needs doing?' : 'Describe the outcome; the agent will break it down…'}
          value={title} onChange={e => setTitle(e.target.value)} onKeyDown={onKey} />
        {mode === 'draft' ? (
          <div className="tc-meta">
            <label className="tc-field"><span>Level</span>
              <select value={level} onChange={e => setLevel(+e.target.value)}>
                {levelOpts.map(i => <option key={i} value={i}>{LEVEL_NAMES[i]}</option>)}
              </select>
            </label>
            <label className="tc-field"><span>Priority</span>
              <select value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="none">None</option><option value="lo">Low</option><option value="md">Medium</option><option value="hi">High</option>
              </select>
            </label>
          </div>
        ) : (
          <div className="tc-delegate-note">Opens a <b>chat</b> seeded with this task. The agent proposes a breakdown into subtasks before any run starts.</div>
        )}
        <div className="tc-actions">
          <span className="tc-hint"><kbd>⏎</kbd> create · <kbd>esc</kbd> cancel</span>
          <span className="sp" />
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>{mode === 'draft' ? '＋ Create task' : '→ Hand to agent'}</Button>
        </div>
      </div>
    );
  }

  // ── TaskDetail ──────────────────────────────────────────────
  function TaskDetail({ task, onSelect, onClose, onTraces, onAddChild }) {
    const [composing, setComposing] = useState(false);
    useEffect(() => { setComposing(false); }, [task && task.id]);
    if (!task) {
      return <div style={{ padding: 'var(--s-8)', color: 'var(--fg-faint)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>No task selected.</div>;
    }
    const t = task;
    const parent = t.parent ? D.byId[t.parent] : null;
    const isLive = t.runState === 'running' || t.runState === 'waiting';
    const m = (t.title.match(MARK_RE) || [])[0];
    const childCount = (t.children && t.children.length) || 0;
    const depCount = (parent ? 1 : 0) + ((t.blockedBy || []).length);
    const crumbs = [{ text: LEVEL_NAMES[t.level].toLowerCase() }];
    if (parent) crumbs.push({ text: <>under <em>{parent.title}</em></>, onClick: () => onSelect(parent.id) });

    return (
      <>
        <div className="t-detail-head">
          <div className="t-detail-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              <DetailHeader title={t.title} mark={m} id={t.id} crumbs={crumbs} />
            </div>
            <div className="t-actions">
              <IconButton icon={isLive ? I.stop : I.run} title={isLive ? 'Stop' : 'Run'} />
              <IconButton icon={I.chat} title="Chat" />
              <IconButton icon={I.open} title="Open in new tab" />
              <IconButton icon={I.close} title="Close" onClick={onClose} />
            </div>
          </div>
          <Hero t={t} />
        </div>

        <div className="t-detail-body">
          {childCount ? <Accordion name="Children" accent count={childCount} defaultOpen><Children t={t} onSelect={onSelect} /></Accordion> : null}
          <Accordion name="Spec"><Spec t={t} /></Accordion>
          <Accordion name="Dependencies" count={depCount}><Deps t={t} onSelect={onSelect} /></Accordion>
          <Accordion name="Code" count={0}><div className="t-empty">No code references yet.</div></Accordion>
          <Accordion name="Details"><Details t={t} /></Accordion>
          {t.runs ? (
            <div style={{ padding: 'var(--s-3) var(--s-5) var(--s-5)' }}>
              <button className="t-traces" onClick={onTraces}>
                <span>Explore <em>{t.runs.subtree.runs}</em> subtree runs · {t.runs.subtree.attempts} attempts</span>
                <span className="arr">→</span>
              </button>
            </div>
          ) : null}
        </div>

        {composing ? (
          <Composer t={t} onAddChild={onAddChild} onCancel={() => setComposing(false)} />
        ) : (
          <div className="t-detail-foot">
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-10)', color: 'var(--fg-faint)' }}>esc · close</span>
            <span style={{ marginLeft: 'auto' }} />
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>＋ Add task</Button>
            <Button size="sm" onClick={onTraces}>⊙ Inspect</Button>
          </div>
        )}
      </>
    );
  }

  window.TaskDetail = TaskDetail;
})();
