/* ──────────────────────────────────────────────────────────────────
   Hearth · Tasks v2 — App (React)
   Full page rebuilt on the component library. Shell chrome uses the page's
   own layout classes; all content (rows, chips, scope, search, detail) is
   built from lib/*.jsx components.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef, useMemo, useCallback } = React;
  const { RunChip, IdChip, Pipeline, StateBreakdown, ScopeChip, SearchBar, TaskDetail, AppShell, LiveCount } = window;
  const D = window.HEARTH_DATA;
  const { TASKS, byId, isActiveRun, ancestorIds } = D;

  const GLYPHS = ['◈', '◇', '·'];
  const RUN_LABEL = { running: 'Running', waiting: 'Waiting', queued: 'Queued' };
  const COLLAPSE_THRESHOLD = 3;   // fold this many done leaves under a parent into one summary line

  const isTerminal = (s) => s === 'cancelled' || s === 'stopped';
  const isDoneLeaf = (t) => t.runState === 'completed' && !(t.children && t.children.length);

  const CheckMark = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
  );

  // Three-state completion marker. Active → RunChip; done → green ✓;
  // cancelled/stopped → muted ⊘; never-run → nothing.
  function CompletionMark({ t }) {
    if (isActiveRun(t.runState)) return <RunChip state={t.runState} label={RUN_LABEL[t.runState]} runtime={t.runtime} />;
    if (t.runState === 'completed') return <span className="done-mark icon" title="Completed"><CheckMark /></span>;
    if (isTerminal(t.runState))
      return <span className="cancel-mark" title={t.runState === 'stopped' ? 'Stopped' : 'Cancelled'}>⊘</span>;
    return null;
  }

  // ── Filtering helpers (ported) ──────────────────────────────
  function matchesScope(t, scope) {
    switch (scope) {
      case 'active':  return t.runState === 'running' || t.runState === 'waiting';
      case 'waiting': return t.runState === 'waiting';
      case 'blocked': return Array.isArray(t.blockedBy) && t.blockedBy.length > 0;
      case 'recent':  return /[hm]$/.test(t.when || '');
      case 'mine':    return (t.tags || []).some(x => /authoring|chat|live/.test(x));
      case 'queued':  return t.runState === 'queued';
      case 'done':    return t.runState === 'completed';
      default:        return true;
    }
  }
  function matchesQuery(t, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return t.title.toLowerCase().indexOf(q) !== -1 || t.id.indexOf(q) !== -1 ||
      (t.tags || []).some(x => x.toLowerCase().indexOf(q) !== -1);
  }
  function computeItems(scope, query, expanded, hideCompleted, summaryExpanded) {
    const filtering = scope !== 'all' || !!query;
    if (filtering) {
      const include = new Set();
      TASKS.forEach(t => {
        if (matchesScope(t, scope) && matchesQuery(t, query)) {
          include.add(t.id);
          ancestorIds(t).forEach(a => include.add(a));
        }
      });
      // Filtering bypasses collapse/hide — you asked to see matches.
      return TASKS.filter(t => include.has(t.id)).map(t => ({ type: 'row', id: t.id }));
    }
    const out = [];
    function visit(id) {
      const t = byId[id]; if (!t) return;
      out.push({ type: 'row', id });
      if (!expanded.has(id) || !t.children) return;
      const kids = t.children.map(c => byId[c]).filter(Boolean);
      const doneLeaves = kids.filter(isDoneLeaf);
      const collapse = !hideCompleted && doneLeaves.length >= COLLAPSE_THRESHOLD;
      kids.forEach(c => {
        const leaf = isDoneLeaf(c);
        if (hideCompleted && leaf) return;
        if (collapse && leaf) return;
        visit(c.id);
      });
      if (collapse) {
        const isOpen = summaryExpanded.has(id);
        out.push({ type: 'summary', parentId: id, count: doneLeaves.length, open: isOpen });
        if (isOpen) doneLeaves.forEach(c => visit(c.id));
      }
    }
    TASKS.filter(t => !t.parent).forEach(r => visit(r.id));
    return out;
  }
  function scopeCounts() {
    let running = 0, waiting = 0, blocked = 0, mine = 0, queued = 0, done = 0;
    TASKS.forEach(t => {
      if (t.runState === 'running') running++;
      if (t.runState === 'waiting') waiting++;
      if (Array.isArray(t.blockedBy) && t.blockedBy.length) blocked++;
      if ((t.tags || []).some(x => /authoring|chat|live/.test(x))) mine++;
      if (t.runState === 'queued') queued++;
      if (t.runState === 'completed') done++;
    });
    return { running, waiting, blocked, mine, queued, done, active: running + waiting };
  }
  function childBreakdown(t) {
    let done = 0, running = 0, waiting = 0, queued = 0;
    (t.children || []).forEach(cid => {
      const c = byId[cid]; if (!c) return;
      if (c.runState === 'completed') done++;
      else if (c.runState === 'running') running++;
      else if (c.runState === 'waiting') waiting++;
      else if (c.runState === 'queued') queued++;
    });
    return { done, running, waiting, queued };
  }

  // ── List row ────────────────────────────────────────────────
  function ListRow({ t, selected, expanded, onSelect, onToggle }) {
    const hasChildren = (t.children && t.children.length) || (t.childCount && t.childCount > 0);
    const chev = hasChildren ? (expanded ? '▾' : '▸') : '';
    const isCompleted = t.runState === 'completed';
    const accentGlyph = selected || t.runState === 'running';

    let metaExtra = null;
    if (t.level <= 1) {
      const ccount = (t.childCount || (t.children && t.children.length) || 0);
      const ccLabel = t.level === 0 ? (ccount === 1 ? '1 ticket' : ccount + ' tickets') : (ccount === 1 ? '1 task' : ccount + ' tasks');
      const tags = (t.tags || []).slice(0, 3);
      const bd = childBreakdown(t);
      const hasBd = bd.done || bd.running || bd.waiting || bd.queued;
      const hasExtra = ccount || tags.length || (t.pipeline && t.pipeline.length) || hasBd;
      metaExtra = hasExtra ? (
        <>
          {ccount ? <span>{ccLabel}</span> : null}
          {ccount && tags.length ? <span className="sep">·</span> : null}
          {tags.map((x, i) => <span key={i} className="tag">{x}</span>)}
          {t.pipeline && t.pipeline.length ? <><span className="sep">·</span><Pipeline width={120} segments={t.pipeline.map(s => ({ kind: s.kind, state: s.state }))} /></> : null}
          {hasBd ? <><span className="sep">·</span><StateBreakdown {...bd} /></> : null}
        </>
      ) : null;
    }
    // ID lives in the meta line (reference metadata), not on the title line.
    const meta = (
      <div className="t-meta">
        <IdChip id={t.id} />
        {metaExtra ? <><span className="sep">·</span>{metaExtra}</> : null}
      </div>
    );

    const pri = t.priority ? (t.priority === 'hi' ? '↑' : t.priority === 'md' ? '→' : '↓') : null;

    return (
      <div className={'t-row l' + t.level + (selected ? ' sel' : '') + (isCompleted ? ' completed' : '')}
        onClick={() => onSelect(t.id)}>
        <div className="t-indent">
          {t.level >= 1 ? <span className="g l1" /> : null}
          {t.level >= 2 ? <span className="g l2" /> : null}
        </div>
        <div className="t-body">
          <div className="t-top">
            <span className="t-chev" onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(t.id); }}>{chev}</span>
            <span className="t-glyph" style={accentGlyph ? { color: 'var(--accent)' } : null}>{GLYPHS[t.level]}</span>
            <span className={'t-title' + (isCompleted ? ' done' : '')}>{t.title}</span>
            {pri ? <span className={'t-pri ' + t.priority} title={t.priority + ' priority'}>{pri}</span> : null}
          </div>
          {meta}
        </div>
        <div className="t-right">
          <div className="chip-slot"><CompletionMark t={t} /></div>
          <div className="when">{t.when || ''}</div>
        </div>
      </div>
    );
  }

  // ── Collapsed-done summary row ───────────────────────────────
  function SummaryRow({ item, onToggle }) {
    return (
      <div className={'t-summary' + (item.open ? ' open' : '')} onClick={() => onToggle(item.parentId)}>
        <div className="t-indent"><span className="g l1" /><span className="g l2" /></div>
        <span className="sum-chev">{item.open ? '▾' : '▸'}</span>
        <span className="sum-mark"><CheckMark /></span>
        <span className="sum-label">{item.count} completed</span>
        <span className="sum-hint">{item.open ? 'hide' : 'show'}</span>
      </div>
    );
  }

  // ── Scope bar ───────────────────────────────────────────────
  function ScopeBar({ scope, setScope, counts }) {
    const items = [
      { key: 'active', label: 'Active', n: counts.active, pulse: true },
      { key: 'waiting', label: 'Waiting', n: counts.waiting },
      { key: 'blocked', label: 'Blocked', n: counts.blocked },
      { key: 'recent', label: 'Recent' },
      { key: 'mine', label: 'Mine', n: counts.mine },
      { sep: true },
      { key: 'queued', label: 'Queued', n: counts.queued },
      { key: 'done', label: 'Done', n: counts.done },
    ];
    return (
      <div style={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        {items.map((it, i) => it.sep
          ? <span key={'sep' + i} className="scope-sep" />
          : <ScopeChip key={it.key} label={it.label} n={it.n} pulse={it.pulse} active={scope === it.key}
              onClick={() => setScope(scope === it.key ? 'all' : it.key)} />)}
      </div>
    );
  }

  // ── App ─────────────────────────────────────────────────────
  function TasksApp() {
    const TWEAK_DEFAULTS = { uniformTitleSize: false, titleSize: 14, depShowResolved: true };
    const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
    const initialId = (location.hash && location.hash.length > 1 && byId[location.hash.slice(1)]) ? location.hash.slice(1) : '40628099';
    const [selectedId, setSelectedId] = useState(initialId);
    const [expanded, setExpanded] = useState(() => new Set(['2b064abb', '40628099']));
    const [scope, setScope] = useState('all');
    const [query, setQuery] = useState('');
    const [hideCompleted, setHideCompleted] = useState(false);
    const [summaryExpanded, setSummaryExpanded] = useState(() => new Set());
    const [rev, setRev] = useState(0);   // bumps when the tree mutates (new task added)
    const searchRef = useRef(null);
    const listRef = useRef(null);

    const counts = useMemo(scopeCounts, []);
    const total = useMemo(() => TASKS.length, [rev]);
    const roots = useMemo(() => TASKS.filter(t => !t.parent).length, [rev]);
    const items = useMemo(() => computeItems(scope, query, expanded, hideCompleted, summaryExpanded),
      [scope, query, expanded, hideCompleted, summaryExpanded, rev]);
    const rowIds = useMemo(() => items.filter(i => i.type === 'row').map(i => i.id), [items]);
    const toggleSummary = useCallback((pid) => {
      setSummaryExpanded(prev => { const n = new Set(prev); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
    }, []);

    const select = useCallback((id) => {
      if (!byId[id]) return;
      setExpanded(prev => {
        const next = new Set(prev);
        ancestorIds(byId[id]).forEach(a => next.add(a));
        return next;
      });
      setSelectedId(id);
    }, []);
    const toggle = useCallback((id) => {
      setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
    }, []);

    // Add a child task under `parentId`. Draft = quiet task you'll spec; delegate = queued for the agent.
    const addChild = useCallback((parentId, { title, level, priority, mode }) => {
      const p = byId[parentId];
      if (!p) return;
      const id = Math.random().toString(16).slice(2, 10);
      const node = {
        id, title, level, parent: parentId, children: [],
        priority: priority === 'none' ? null : priority,
        tags: [], when: 'now', stepKind: null,
        runState: mode === 'delegate' ? 'queued' : undefined,
      };
      TASKS.push(node);
      byId[id] = node;
      p.children = (p.children || []).concat(id);
      setExpanded(prev => { const n = new Set(prev); n.add(parentId); return n; });
      setRev(r => r + 1);
      // keep the parent in focus so the freshly-added child appears in its Children section
    }, []);

    // Delete a task. mode 'cascade' removes the whole subtree; 'promote' lifts direct
    // children up one level to the grandparent (or top level) and removes only this node.
    const deleteTask = useCallback((id, mode) => {
      const t = byId[id]; if (!t) return;
      const parentId = t.parent || null;
      const parent = parentId ? byId[parentId] : null;

      function removeNode(nid) {
        const n = byId[nid]; if (!n) return;
        (n.children || []).slice().forEach(removeNode);
        delete byId[nid];
        const idx = TASKS.indexOf(n); if (idx >= 0) TASKS.splice(idx, 1);
      }

      if (mode === 'promote' && t.children && t.children.length) {
        // Lift each child's whole subtree up one level (keeps depth === level invariant).
        function lift(nid) {
          const n = byId[nid]; if (!n) return;
          n.level = Math.max(0, n.level - 1);
          (n.children || []).forEach(lift);
        }
        t.children.slice().forEach(cid => {
          const c = byId[cid]; if (!c) return;
          c.parent = parentId || undefined;
          lift(cid);
          if (parent) parent.children = (parent.children || []).concat(cid);
        });
        if (parent && parent.childCount != null) parent.childCount = parent.children.length;
        t.children = [];   // detach so removeNode doesn't cascade into the promoted subtrees
      }

      if (parent && parent.children) parent.children = parent.children.filter(c => c !== id);
      if (parent && parent.childCount != null) parent.childCount = parent.children.length;
      removeNode(id);

      setSelectedId(parentId && byId[parentId] ? parentId : null);
      if (parentId && byId[parentId]) setExpanded(prev => { const n = new Set(prev); n.add(parentId); return n; });
      setRev(r => r + 1);
    }, []);

    // keep selected row in view (no scrollIntoView)
    useEffect(() => {
      const list = listRef.current; if (!list) return;
      const row = list.querySelector('.t-row.sel'); if (!row) return;
      const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
      if (r.bottom > l.bottom - 8) list.scrollTop += (r.bottom - (l.bottom - 8));
      else if (r.top < l.top + 8) list.scrollTop -= (l.top + 8 - r.top);
    }, [selectedId, items]);

    // keyboard
    useEffect(() => {
      function onKey(e) {
        const inSearch = document.activeElement === searchRef.current;
        if (e.key === 'Escape') {
          if (inSearch) { searchRef.current.blur(); if (query) setQuery(''); return; }
          setSelectedId(null);
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault(); if (searchRef.current) { searchRef.current.focus(); searchRef.current.select(); }
        } else if (e.key === '/' && !inSearch) {
          e.preventDefault(); searchRef.current && searchRef.current.focus();
        } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && selectedId && !inSearch) {
          e.preventDefault();
          let i = rowIds.indexOf(selectedId); if (i < 0) return;
          i = e.key === 'ArrowDown' ? Math.min(rowIds.length - 1, i + 1) : Math.max(0, i - 1);
          select(rowIds[i]);
        } else if (e.key === 'ArrowLeft' && selectedId && !inSearch) {
          const t = byId[selectedId];
          if (expanded.has(t.id) && t.children && t.children.length) toggle(t.id);
          else if (t.parent) select(t.parent);
        } else if (e.key === 'ArrowRight' && selectedId && !inSearch) {
          const t = byId[selectedId];
          if (t.children && t.children.length) { if (!expanded.has(t.id)) toggle(t.id); else select(t.children[0]); }
        }
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [selectedId, expanded, query, rowIds, select, toggle]);

    const selectedTask = byId[selectedId];

    // Apply the uniform-title-size tweak to the list via a root class + CSS var.
    useEffect(() => {
      const root = document.documentElement;
      root.classList.toggle('uniform-titles', !!tw.uniformTitleSize);
      root.style.setProperty('--uniform-title-size', tw.titleSize + 'px');
    }, [tw.uniformTitleSize, tw.titleSize]);

    return (
      <AppShell page="Tasks" active="tasks" activity={
        <>
          <LiveCount running={counts.running} />
          <span className="total"><b>{total}</b> tasks <span style={{ color: 'var(--fg-ghost)' }}>·</span> {roots} roots</span>
        </>
      }>
        <main className="list-col">
            <div className="list-head">
              <div className="scope-row">
                <ScopeBar scope={scope} setScope={setScope} counts={counts} />
                <div className="secondary">
                  <button className={'hide-done' + (hideCompleted ? ' on' : '')}
                    onClick={() => setHideCompleted(v => !v)}
                    title={hideCompleted ? 'Show completed tasks' : 'Hide completed tasks'}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {hideCompleted
                        ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>
                        : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
                    </svg>
                    {hideCompleted ? 'Done hidden' : 'Hide done'}
                  </button>
                  <select><option>All levels</option><option>Epics only</option><option>Tickets</option><option>Tasks</option></select>
                </div>
              </div>
              <SearchBar inputRef={searchRef} value={query} onChange={setQuery}
                placeholder="Search tasks by title, id, or tag…" hint="/" />
            </div>
            <div className="list" ref={listRef}>
              {items.length
                ? items.map(it => it.type === 'summary'
                    ? <SummaryRow key={'sum-' + it.parentId} item={it} onToggle={toggleSummary} />
                    : <ListRow key={it.id} t={byId[it.id]} selected={it.id === selectedId}
                        expanded={expanded.has(it.id)} onSelect={select} onToggle={toggle} />)
                : <div style={{ padding: 'var(--s-8) var(--s-5)', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--fg-faint)' }}>No tasks match that filter.</div>}
            </div>
          </main>
          {selectedTask ? (
            <aside className="detail">
              <TaskDetail task={selectedTask} onSelect={select} onClose={() => setSelectedId(null)} onTraces={() => { location.href = 'traces-v2.html'; }} onAddChild={addChild} onDelete={deleteTask} graphShowResolved={tw.depShowResolved} />
            </aside>
          ) : null}
          <TweaksPanel>
            <TweakSection label="Task list type" />
            <TweakToggle label="Uniform title size" value={tw.uniformTitleSize}
              onChange={(v) => setTweak('uniformTitleSize', v)} />
            {tw.uniformTitleSize ? (
              <TweakSlider label="Title size" value={tw.titleSize} min={12} max={18} step={1} unit="px"
                onChange={(v) => setTweak('titleSize', v)} />
            ) : null}
            <TweakSection label="Dependency graph" />
            <TweakToggle label="Show resolved blockers" value={tw.depShowResolved}
              onChange={(v) => setTweak('depShowResolved', v)} />
          </TweaksPanel>
        </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<TasksApp />);
})();
