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
    chevLeft: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="15 18 9 12 15 6" /></svg>,
    trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>,
  };

  // ── Subtree stats ── recursive descendant counts by level (tickets vs tasks)
  function subtreeStats(t) {
    let tickets = 0, tasks = 0, total = 0;
    (function walk(node) {
      (node.children || []).forEach(cid => {
        const c = D.byId[cid]; if (!c) return;
        total++;
        if (c.level <= 1) tickets++; else tasks++;
        walk(c);
      });
    })(t);
    return { tickets, tasks, total };
  }

  // ── DeleteConfirm ── inline confirmation that slides up in the panel footer.
  // Adapts to standalone vs has-children (subtree decision).
  function DeleteConfirm({ task, onConfirm, onCancel }) {
    const hasChildren = !!(task.children && task.children.length);
    const [mode, setMode] = useState('promote');   // safe default
    useEffect(() => {
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      }
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [onCancel]);

    const levelName = LEVEL_NAMES[task.level].toLowerCase();
    const parent = task.parent ? D.byId[task.parent] : null;
    const stats = hasChildren ? subtreeStats(task) : null;
    const directCount = hasChildren ? task.children.length : 0;
    const directType = task.level === 0
      ? (directCount === 1 ? 'ticket' : 'tickets')
      : (directCount === 1 ? 'task' : 'tasks');
    const target = parent ? <em>{parent.title}</em> : 'the top level';

    function summaryText() {
      const parts = [];
      if (stats.tickets) parts.push(stats.tickets + (stats.tickets === 1 ? ' ticket' : ' tickets'));
      if (stats.tasks) parts.push(stats.tasks + (stats.tasks === 1 ? ' task' : ' tasks'));
      return parts.join(' and ');
    }

    const confirmLabel = !hasChildren ? 'Delete task'
      : mode === 'promote' ? 'Delete \u0026 promote'
      : 'Delete ' + (stats.total + 1) + ' items';

    return (
      <div className="t-delconfirm">
        <div className="dl-head">
          <span className="dl-title">Delete {levelName} <em>{task.title}</em>?</span>
        </div>
        {hasChildren ? (
          <>
            <p className="dl-sub">Contains <b>{summaryText()}</b> — choose what happens to them.</p>
            <div className="del-choices">
              <label className={'del-choice' + (mode === 'promote' ? ' on' : '')}>
                <input type="radio" name="del-mode" checked={mode === 'promote'} onChange={() => setMode('promote')} />
                <span className="dc-radio" />
                <span className="dc-text">
                  <span className="dc-title">Promote children</span>
                  <span className="dc-desc">Delete only this {levelName}. Its {directCount} {directType} move up to {target}.</span>
                </span>
              </label>
              <label className={'del-choice danger' + (mode === 'cascade' ? ' on' : '')}>
                <input type="radio" name="del-mode" checked={mode === 'cascade'} onChange={() => setMode('cascade')} />
                <span className="dc-radio" />
                <span className="dc-text">
                  <span className="dc-title">Delete everything</span>
                  <span className="dc-desc">Remove this {levelName} and all {stats.total} descendants, with their runs and trace history. Cannot be undone.</span>
                </span>
              </label>
            </div>
          </>
        ) : (
          <p className="dl-sub">This cannot be undone. The task, its runs, and trace history will be removed.</p>
        )}
        <div className="dl-actions">
          <span className="sp" />
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <button className="btn danger sm" onClick={() => onConfirm(hasChildren ? mode : 'cascade')}>{confirmLabel}</button>
        </div>
      </div>
    );
  }

  // run-state → hero label / edge
  const RUN_LABEL = { running: 'Running', waiting: 'Waiting', queued: 'Queued', completed: 'Completed', cancelled: 'Cancelled', stopped: 'Stopped' };

  // ── Hero ── does ONE thing: the task's run status. Composition (children)
  // and the route (run path) live in their own accordions below; the exact
  // ordered step log lives in Traces. The hero never redraws them.
  function Hero({ t }) {
    const kind = t.stepKind || null;
    const edge = kind || 'none';
    const state = t.runState || 'none';
    const label = RUN_LABEL[t.runState] || 'No active run';
    const runtime = t.runtime && (t.runState === 'running' || t.runState === 'waiting') ? t.runtime : null;
    const finished = t.runState === 'completed' && t.when ? 'completed ' + t.when + ' ago' : null;
    const hasChildren = !!(t.children && t.children.length);
    const right = (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-10)', color: 'var(--fg-faint)' }}>
        {hasChildren ? t.children.length + ' children' : 'leaf · no children'}
      </span>
    );
    return (
      <div style={{ marginTop: 'var(--s-4)' }}>
        <HeroStatus state={state} edge={edge} label={label} runtime={runtime}
          step={kind ? { kind } : null} finished={finished} right={right} />
      </div>
    );
  }

  // ── RunMap ── "you are here" on the real workflow graph. Same kind-colour
  // vocabulary as the canvas. Visited nodes solid, current pulsing, traversed
  // edges lit (animated), branches not taken dimmed. Honest about what's
  // reachable without inventing a percentage of an unknowable whole.
  function RunMap({ graph }) {
    if (!graph || !graph.nodes || !graph.nodes.length) return null;
    const W = 96, H = 44, PADX = 6, PADY = 12, COLGAP = 132, ROWGAP = 70;
    const pos = {};
    graph.nodes.forEach(n => {
      const x = PADX + n.col * COLGAP, y = PADY + n.row * ROWGAP;
      pos[n.id] = { x, y, cx: x + W / 2, l: x, r: x + W, t: y, b: y + H, my: y + H / 2 };
    });
    const cols = Math.max(...graph.nodes.map(n => n.col)) + 1;
    const rows = Math.max(...graph.nodes.map(n => n.row)) + 1;
    const vbW = PADX * 2 + (cols - 1) * COLGAP + W;
    const vbH = PADY + (rows - 1) * ROWGAP + H + PADY;

    function path(e) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return '';
      const an = graph.nodes.find(n => n.id === e.from), bn = graph.nodes.find(n => n.id === e.to);
      const dCol = bn.col - an.col;
      if (e.loop || dCol < 0) {            // back-edge: bow up & over
        return `M${a.cx},${a.t} C${a.cx},${a.t - 34} ${b.cx},${b.b + 34} ${b.cx},${b.b}`;
      }
      if (dCol === 0) {                    // same column, vertical
        if (bn.row > an.row) return `M${a.cx},${a.b} C${a.cx},${a.b + 24} ${b.cx},${b.t - 24} ${b.cx},${b.t}`;
        return `M${a.cx},${a.t} C${a.cx},${a.t - 24} ${b.cx},${b.b + 24} ${b.cx},${b.b}`;
      }
      const mx = (a.r + b.l) / 2;          // forward: right → left S-curve
      return `M${a.r},${a.my} C${mx},${a.my} ${mx},${b.my} ${b.l},${b.my}`;
    }

    return (
      <div className="runmap" style={{ width: vbW, height: vbH }}>
        <svg className="rm-edges" viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none">
          <defs>
            <marker id="rm-a" markerWidth="6" markerHeight="6" refX="4.8" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 z" fill="var(--line-strong)" /></marker>
            <marker id="rm-al" markerWidth="6" markerHeight="6" refX="4.8" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 z" fill="var(--accent)" /></marker>
            <marker id="rm-as" markerWidth="6" markerHeight="6" refX="4.8" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 z" fill="var(--fg-faint)" /></marker>
          </defs>
          {graph.edges.map((e, i) => {
            const cls = e.live ? 'live' : e.skip ? 'skip' : 'future';
            const mk = e.live ? 'rm-al' : e.skip ? 'rm-as' : 'rm-a';
            return <path key={i} className={'rm-edge ' + cls} d={path(e)} markerEnd={`url(#${mk})`} />;
          })}
        </svg>
        {graph.nodes.map(n => {
          const state = n.current ? 'current' : n.skip ? 'skip' : n.future ? 'future' : 'visited';
          const badge = n.current ? null : n.visits > 1 ? '✓ ×' + n.visits : n.visits ? '✓' : null;
          return (
            <div key={n.id} className={'rm-node kind-' + n.kind + ' ' + state}
              style={{ left: pos[n.id].x, top: pos[n.id].y, width: W }}>
              {badge ? <span className="rm-v">{badge}</span> : null}
              <span className="rm-k">{n.kind}</span>
              <span className="rm-t">{n.title}</span>
            </div>
          );
        })}
      </div>
    );
  }
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

  function Deps({ t, onSelect, onOpenGraph }) {
    const parent = t.parent ? D.byId[t.parent] : null;
    const blocked = (t.blockedBy || []).map(b => D.byId[b]).filter(Boolean);
    if (!parent && !blocked.length) return <div className="t-empty">No dependencies.</div>;
    return (
      <>
        {onOpenGraph ? (
          <button className="t-traces" style={{ marginBottom: 'var(--s-3)' }} onClick={onOpenGraph}>
            <span>View blocking order as a <em>graph</em></span>
            <span className="arr">⤳</span>
          </button>
        ) : null}
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

  // ── Dependency graph ────────────────────────────────────────
  // A sibling blockedBy DAG — NOT containment. Tasks that block each other,
  // drawn left→right by dependency depth. Same kind-hue node vocabulary as the
  // RunMap. The edge that's still LIVE (an unsatisfied blocker) is the literal
  // answer to "why can't this run yet". Opened as a focus overlay.
  const RESOLVED = (rs) => rs === 'completed' || rs === 'cancelled' || rs === 'stopped';
  const PIP = { running: 'var(--accent)', waiting: 'var(--warn)', queued: 'var(--fg-mute)', completed: 'var(--ok)', cancelled: 'var(--fg-faint)', stopped: 'var(--fg-faint)' };
  const childWordFor = (parent) => !parent ? 'epics' : parent.level === 0 ? 'tickets' : 'tasks';

  // Build the sibling cohort model: nodes that block or are blocked, + edges.
  function buildDepModel(rootTask) {
    const { byId, TASKS } = D;
    const parentId = rootTask.parent || null;
    const cohort = parentId ? (byId[parentId].children || []) : TASKS.filter(t => !t.parent).map(t => t.id);
    const inCohort = new Set(cohort);
    const nodeIds = new Set([rootTask.id]);
    const edges = [];
    cohort.forEach(id => {
      const t = byId[id]; if (!t) return;
      (t.blockedBy || []).forEach(bid => {
        if (!byId[bid]) return;
        nodeIds.add(id); nodeIds.add(bid);
        edges.push({ from: bid, to: id, external: !inCohort.has(bid) });
      });
    });
    return { nodeIds: [...nodeIds], edges, parent: parentId ? byId[parentId] : null, cohortSize: cohort.length };
  }

  // Longest-path layering + a few barycenter sweeps to reduce crossings.
  function layoutDep(nodeIds, edges) {
    const idSet = new Set(nodeIds);
    const blockersOf = {}; nodeIds.forEach(id => blockersOf[id] = []);
    edges.forEach(e => { if (idSet.has(e.from) && idSet.has(e.to)) blockersOf[e.to].push(e.from); });
    const col = {}, seen = new Set();
    function depth(id) {
      if (col[id] != null) return col[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      let d = 0; blockersOf[id].forEach(b => { d = Math.max(d, depth(b) + 1); });
      return col[id] = d;
    }
    nodeIds.forEach(depth);
    const maxCol = Math.max(0, ...nodeIds.map(id => col[id]));
    const byCol = {}; for (let c = 0; c <= maxCol; c++) byCol[c] = [];
    nodeIds.forEach(id => byCol[col[id]].push(id));
    const row = {}; for (let c = 0; c <= maxCol; c++) byCol[c].forEach((id, i) => row[id] = i);
    const bary = (id) => { const bs = blockersOf[id]; return bs.length ? bs.reduce((s, b) => s + row[b], 0) / bs.length : row[id]; };
    for (let pass = 0; pass < 5; pass++) {
      for (let c = 1; c <= maxCol; c++) {
        byCol[c].sort((a, b) => bary(a) - bary(b));
        byCol[c].forEach((id, i) => row[id] = i);
      }
    }
    const rowsCount = Math.max(1, ...Object.values(byCol).map(a => a.length));
    return { col, row, maxCol, rowsCount };
  }

  function chainOf(id, edges) {
    const inc = {}, out = {};
    edges.forEach(e => { (out[e.from] = out[e.from] || []).push(e.to); (inc[e.to] = inc[e.to] || []).push(e.from); });
    const set = new Set([id]);
    (function up(x) { (inc[x] || []).forEach(p => { if (!set.has(p)) { set.add(p); up(p); } }); })(id);
    (function dn(x) { (out[x] || []).forEach(c => { if (!set.has(c)) { set.add(c); dn(c); } }); })(id);
    return set;
  }

  function DepGraph({ rootTask, onSelect, onClose, showResolved }) {
    const { byId } = D;
    const [hover, setHover] = useState(null);
    useEffect(() => {
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    const model = buildDepModel(rootTask);
    let nodeIds = model.nodeIds, edges = model.edges;
    // Optionally hide resolved (completed/cancelled) nodes to isolate the live critical path.
    if (!showResolved) {
      const keep = new Set(nodeIds.filter(id => id === rootTask.id || !RESOLVED(byId[id].runState)));
      edges = edges.filter(e => keep.has(e.from) && keep.has(e.to));
      const part = new Set([rootTask.id]); edges.forEach(e => { part.add(e.from); part.add(e.to); });
      nodeIds = nodeIds.filter(id => part.has(id) && keep.has(id));
    }

    const childWord = childWordFor(model.parent);
    const hasGraph = edges.length > 0;
    const externalCount = nodeIds.filter(id => e_isExternal(byId[id], rootTask)).length;
    const cohortShown = nodeIds.length - externalCount;

    const W = 176, H = 84, COLGAP = 220, ROWGAP = 112, PADX = 10, PADY = 10;
    const { col, row, maxCol, rowsCount } = layoutDep(nodeIds, edges);
    const pos = {};
    nodeIds.forEach(id => {
      const x = PADX + col[id] * COLGAP, y = PADY + row[id] * ROWGAP;
      pos[id] = { x, y, l: x, r: x + W, cy: y + H / 2 };
    });
    const vbW = PADX * 2 + maxCol * COLGAP + W;
    const vbH = PADY * 2 + (rowsCount - 1) * ROWGAP + H;
    const lit = hover ? chainOf(hover, edges) : null;

    function edgePath(e) {
      const a = pos[e.from], b = pos[e.to]; if (!a || !b) return '';
      const mx = (a.r + b.l) / 2;
      return `M${a.r},${a.cy} C${mx},${a.cy} ${mx},${b.cy} ${b.l},${b.cy}`;
    }

    return ReactDOM.createPortal((
      <>
        <div className="dg-scrim" onClick={onClose} />
        <aside className="dg-sheet" role="dialog" aria-label="Dependency graph">
        <div className="dg-head">
          <div>
            <button className="dg-back" onClick={onClose}>{I.chevLeft || '‹'} Back to detail</button>
            <div className="dg-tt">{model.parent ? <>Blocking order under <em>{model.parent.title}</em></> : 'Blocking order across epics'}</div>
            <div className="dg-sub">
              {hasGraph
                ? <><b>{cohortShown}</b> of {model.cohortSize} {childWord} in the chain{externalCount ? <> · <b>{externalCount}</b> external blocker{externalCount > 1 ? 's' : ''}</> : null} · blocker → blocked</>
                : <>No blocking relationships among these {childWord}.</>}
            </div>
          </div>
          <div className="dg-spacer" />
          {hasGraph ? (
            <div className="dg-legend">
              <span className="lg-row"><i className="sw block" /> still blocking</span>
              <span className="lg-row"><i className="sw sat" /> satisfied</span>
              <span className="lg-row"><span className="dot" style={{ background: 'var(--accent)' }} /> you are here</span>
            </div>
          ) : null}
          <IconButton icon={I.close} title="Close (esc)" onClick={onClose} />
        </div>

        <div className="dg-stage">
          {hasGraph ? (
            <div className="dg-canvas" style={{ width: vbW, height: vbH }}>
              <svg className="dg-edges" viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none">
                <defs>
                  <marker id="dg-sat" markerWidth="7" markerHeight="7" refX="5.4" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 z" fill="color-mix(in oklch, var(--ok) 70%, transparent)" /></marker>
                  <marker id="dg-block" markerWidth="7" markerHeight="7" refX="5.4" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 z" fill="var(--accent)" /></marker>
                </defs>
                {edges.map((e, i) => {
                  const satisfied = byId[e.from].runState === 'completed';
                  const cls = 'dg-edge ' + (satisfied ? 'sat' : 'block') + (e.external ? ' ext' : '') + (lit && !(lit.has(e.from) && lit.has(e.to)) ? ' faded' : '');
                  return <path key={i} className={cls} d={edgePath(e)} markerEnd={`url(#${satisfied ? 'dg-sat' : 'dg-block'})`} />;
                })}
              </svg>
              {nodeIds.map(id => {
                const t = byId[id]; if (!t) return null;
                const kind = t.stepKind;
                const isSel = id === rootTask.id;
                const resolved = RESOLVED(t.runState);
                const faded = lit && !lit.has(id);
                const blockers = (t.blockedBy || []).map(b => byId[b]).filter(Boolean);
                const liveBlockers = blockers.filter(b => b.runState !== 'completed').length;
                const isExternal = e_isExternal(t, rootTask);
                const cls = 'dg-node' + (kind ? ' kind-' + kind : '') + (isSel ? ' sel' : '')
                  + (isExternal ? ' external' : '') + (resolved && !isSel ? ' resolved' : '') + (faded ? ' faded' : '');
                const kindLabel = kind || (t.level === 0 ? 'epic' : t.level === 1 ? 'ticket' : 'task');
                return (
                  <div key={id} className={cls} title={t.title}
                    style={{ left: pos[id].x, top: pos[id].y, width: W }}
                    onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}
                    onClick={() => { onSelect(id); onClose(); }}>
                    <div className="dg-n-top">
                      <span className={'dg-pip' + (t.runState === 'running' ? ' running' : '')} style={{ background: PIP[t.runState] || 'var(--fg-ghost)' }} title={t.runState || 'no run'} />
                      <span className="dg-k">{kindLabel}</span>
                      {isExternal ? <span className="dg-ext">external</span> : null}
                    </div>
                    <div className="dg-n-title">{t.title}</div>
                    <div className="dg-n-foot">
                      <IdChip id={id} />
                      {liveBlockers && !resolved ? <span className="blocked-tag" title="blockers not yet satisfied">⏳ {liveBlockers} blocking</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="dg-empty">These {childWord} don't block one another. Add a <em>blocked by</em> relationship and it'll show up here as a graph.</div>
          )}
        </div>
        </aside>
      </>
    ), document.body);
  }
  // a node is "external" to the current cohort if its parent differs from the root's parent
  function e_isExternal(t, rootTask) {
    return (t.parent || null) !== (rootTask.parent || null);
  }

  // ── TaskDetail ──────────────────────────────────────────────
  function TaskDetail({ task, onSelect, onClose, onTraces, onAddChild, onDelete, graphShowResolved = true }) {
    const [composing, setComposing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [graphOpen, setGraphOpen] = useState(false);
    useEffect(() => { setComposing(false); setConfirming(false); setGraphOpen(false); }, [task && task.id]);
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
    const siblingDeps = buildDepModel(t).edges.length > 0;

    return (
      <>
        <div className="t-detail-head">
          <div className="t-detail-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              <DetailHeader title={t.title} mark={m} id={t.id} crumbs={crumbs} />
            </div>
            <div className="t-actions">
              <IconButton icon={isLive ? I.stop : I.run} title={isLive ? 'Stop' : 'Run'} />
              <IconButton icon={I.trash} title="Delete…" onClick={() => { setComposing(false); setConfirming(true); }} />
              <span className="t-actions-sep" />
              <IconButton icon={I.open} title="Open in new tab" />
              <IconButton icon={I.close} title="Close" onClick={onClose} />
            </div>
          </div>
          <Hero t={t} />
        </div>

        <div className="t-detail-body">
          {childCount ? <Accordion name="Children" accent count={childCount} defaultOpen><Children t={t} onSelect={onSelect} /></Accordion> : null}
          {t.graph ? <Accordion name="Run path" defaultOpen={!childCount}><RunMap graph={t.graph} /><div className="rm-legend"><span><i className="sw live" />traversed</span><span><i className="sw next" />reachable</span><span><i className="sw skip" />not taken</span></div></Accordion> : null}
          <Accordion name="Spec"><Spec t={t} /></Accordion>
          <Accordion name="Dependencies" count={depCount}><Deps t={t} onSelect={onSelect} onOpenGraph={siblingDeps ? () => setGraphOpen(true) : null} /></Accordion>
          <Accordion name="Code" count={0}><div className="t-empty">No code references yet.</div></Accordion>
          <Accordion name="Details"><Details t={t} /></Accordion>
          {t.runs ? (
            <div style={{ padding: 'var(--s-3) var(--s-5) var(--s-5)' }}>
              <button className="t-traces" onClick={onTraces}>
                <span>Explore <em>{t.runs.subtree.runs}</em> subtree runs · {t.runs.subtree.attempts} step executions</span>
                <span className="arr">→</span>
              </button>
            </div>
          ) : null}
        </div>

        {confirming ? (
          <DeleteConfirm task={t} onConfirm={(mode) => { onDelete && onDelete(t.id, mode); }} onCancel={() => setConfirming(false)} />
        ) : composing ? (
          <Composer t={t} onAddChild={onAddChild} onCancel={() => setComposing(false)} />
        ) : (
          <div className="t-detail-foot">
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-10)', color: 'var(--fg-faint)' }}>esc · close</span>
            <span style={{ marginLeft: 'auto' }} />
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>＋ Add task</Button>
          </div>
        )}
        {graphOpen ? <DepGraph rootTask={t} onSelect={onSelect} onClose={() => setGraphOpen(false)} showResolved={graphShowResolved} /> : null}
      </>
    );
  }

  window.TaskDetail = TaskDetail;
})();
