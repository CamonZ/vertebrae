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
  function computeVisible(scope, query, expanded) {
    const filtering = scope !== 'all' || !!query;
    if (filtering) {
      const include = new Set();
      TASKS.forEach(t => {
        if (matchesScope(t, scope) && matchesQuery(t, query)) {
          include.add(t.id);
          ancestorIds(t).forEach(a => include.add(a));
        }
      });
      return TASKS.filter(t => include.has(t.id)).map(t => t.id);
    }
    const out = [];
    (function () {
      function visit(id) {
        const t = byId[id]; if (!t) return;
        out.push(id);
        if (expanded.has(id) && t.children) t.children.forEach(visit);
      }
      TASKS.filter(t => !t.parent).forEach(r => visit(r.id));
    })();
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

    let meta = null;
    if (t.level <= 1) {
      const ccount = (t.childCount || (t.children && t.children.length) || 0);
      const ccLabel = t.level === 0 ? (ccount === 1 ? '1 ticket' : ccount + ' tickets') : (ccount === 1 ? '1 task' : ccount + ' tasks');
      const tags = (t.tags || []).slice(0, 3);
      const bd = childBreakdown(t);
      const hasBd = bd.done || bd.running || bd.waiting || bd.queued;
      meta = (
        <div className="t-meta">
          {ccount ? <span>{ccLabel}</span> : null}
          {ccount && tags.length ? <span className="sep">·</span> : null}
          {tags.map((x, i) => <span key={i} className="tag">{x}</span>)}
          {t.pipeline && t.pipeline.length ? <><span className="sep">·</span><Pipeline width={120} segments={t.pipeline.map(s => ({ kind: s.kind, state: s.state }))} /></> : null}
          {hasBd ? <><span className="sep">·</span><StateBreakdown {...bd} /></> : null}
        </div>
      );
    }

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
          <div className="chip-slot">{isActiveRun(t.runState) ? <RunChip state={t.runState} label={RUN_LABEL[t.runState]} runtime={t.runtime} /> : null}</div>
          <IdChip id={t.id} />
          <div className="when">{t.when || ''}</div>
        </div>
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
    const initialId = (location.hash && location.hash.length > 1 && byId[location.hash.slice(1)]) ? location.hash.slice(1) : '40628099';
    const [selectedId, setSelectedId] = useState(initialId);
    const [expanded, setExpanded] = useState(() => new Set(['2b064abb', '40628099']));
    const [scope, setScope] = useState('all');
    const [query, setQuery] = useState('');
    const searchRef = useRef(null);
    const listRef = useRef(null);

    const counts = useMemo(scopeCounts, []);
    const total = TASKS.length;
    const roots = useMemo(() => TASKS.filter(t => !t.parent).length, []);
    const visible = useMemo(() => computeVisible(scope, query, expanded), [scope, query, expanded]);

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

    // keep selected row in view (no scrollIntoView)
    useEffect(() => {
      const list = listRef.current; if (!list) return;
      const row = list.querySelector('.t-row.sel'); if (!row) return;
      const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
      if (r.top < l.top + 8) list.scrollTop -= (l.top + 8 - r.top);
      else if (r.bottom > l.bottom - 8) list.scrollTop += (r.bottom - (l.bottom - 8));
    }, [selectedId, visible]);

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
          let i = visible.indexOf(selectedId); if (i < 0) return;
          i = e.key === 'ArrowDown' ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1);
          select(visible[i]);
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
    }, [selectedId, expanded, query, visible, select, toggle]);

    const selectedTask = byId[selectedId];

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
                  <select><option>All levels</option><option>Epics only</option><option>Tickets</option><option>Tasks</option></select>
                </div>
              </div>
              <SearchBar inputRef={searchRef} value={query} onChange={setQuery}
                placeholder="Search tasks by title, id, or tag…" hint="/" />
            </div>
            <div className="list" ref={listRef}>
              {visible.length
                ? visible.map(id => (
                    <ListRow key={id} t={byId[id]} selected={id === selectedId}
                      expanded={expanded.has(id)} onSelect={select} onToggle={toggle} />
                  ))
                : <div style={{ padding: 'var(--s-8) var(--s-5)', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--fg-faint)' }}>No tasks match that filter.</div>}
            </div>
            <div className="caption-strip">
              <span className="plate">⊹ tasks · v2</span>
              <em>built on the component library · ember on the live</em>
            </div>
          </main>
          <aside className="detail">
            <TaskDetail task={selectedTask} onSelect={select} onClose={() => setSelectedId(null)} onTraces={() => { location.href = 'traces-v2.html'; }} />
          </aside>
        </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<TasksApp />);
})();
