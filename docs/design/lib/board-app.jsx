/* ──────────────────────────────────────────────────────────────────
   Hearth · Board v2 — App (React)
   Kanban over runState columns, built on the component library.
   Columns = runState; card top-edge hue = stepKind.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;
  const { BoardCard, SearchBar, ViewTabs, LevelSelect, Button, AppShell, LiveCount } = window;
  const D = window.HEARTH_DATA;
  const { TASKS, byId, isActiveRun } = D;

  const RUN_LABEL = { running: 'Running', waiting: 'Waiting', queued: 'Queued' };
  const COLUMNS = [
    { key: 'queued', name: 'Queued', empty: 'Nothing queued.', test: t => t.runState === 'queued' || t.runState == null },
    { key: 'running', name: 'Running', empty: 'No active runs.', test: t => t.runState === 'running' },
    { key: 'waiting', name: 'Waiting', empty: 'Nothing waiting.', test: t => t.runState === 'waiting' },
    { key: 'done', name: 'Done', empty: 'No completed tasks.', test: t => t.runState === 'completed' },
  ];

  function matchesQuery(t, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return t.title.toLowerCase().indexOf(q) !== -1 || t.id.indexOf(q) !== -1 ||
      (t.tags || []).some(x => x.toLowerCase().indexOf(q) !== -1);
  }
  function matchesLevel(t, lvl) { return lvl === 'all' || t.level === Number(lvl); }
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

  function taskToCard(t) {
    const active = isActiveRun(t.runState);
    return {
      kind: t.stepKind || 'none',
      title: t.title,
      level: t.level,
      priority: t.priority,
      stepLabel: t.stepKind || null,
      pipeline: t.pipeline,
      breakdown: t.children && t.children.length ? childBreakdown(t) : null,
      tags: t.tags,
      run: active ? { state: t.runState, label: RUN_LABEL[t.runState], runtime: t.runtime } : null,
      id: t.id,
      when: t.when,
      running: t.runState === 'running',
      done: t.runState === 'completed',
      onClick: () => { window.location.href = 'tasks-v2.html#' + t.id; },
    };
  }

  const LEVEL_MAP = { 'All levels': 'all', 'Epics only': '0', 'Tickets': '1', 'Tasks': '2' };

  function Column({ col, tasks }) {
    return (
      <section className={'col ' + col.key}>
        <header className="col-head">
          <span className="lamp" />
          <span className="name">{col.name}</span>
          <span className="count">{tasks.length}</span>
        </header>
        {tasks.length ? (
          <div className="col-body">
            {tasks.map(t => <BoardCard key={t.id} {...taskToCard(t)} />)}
            {col.key === 'queued' ? <div className="add-stub">＋ New task</div> : null}
          </div>
        ) : <div className="col-body empty">{col.empty}</div>}
      </section>
    );
  }

  function BoardApp() {
    const [query, setQuery] = useState('');
    const [level, setLevel] = useState('all');
    const searchRef = useRef(null);

    const running = useMemo(() => TASKS.filter(t => t.runState === 'running').length, []);
    const total = TASKS.length;
    const roots = useMemo(() => TASKS.filter(t => !t.parent).length, []);

    const columns = useMemo(() => COLUMNS.map(col => ({
      col, tasks: TASKS.filter(t => col.test(t) && matchesQuery(t, query) && matchesLevel(t, level)),
    })), [query, level]);

    useEffect(() => {
      function onKey(e) {
        const inSearch = document.activeElement === searchRef.current;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current && (searchRef.current.focus(), searchRef.current.select()); }
        else if (e.key === '/' && !inSearch) { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
        else if (e.key === 'Escape' && inSearch) { searchRef.current.blur(); if (query) setQuery(''); }
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [query]);

    return (
      <AppShell page="Board" active="board" activity={
        <>
          <LiveCount running={running} />
          <span className="total"><b>{total}</b> tasks <span style={{ color: 'var(--fg-ghost)' }}>·</span> {roots} roots</span>
        </>
      }>
        <main className="board">
          <div className="board-head">
            <ViewTabs value="board" onChange={id => { if (id === 'list') window.location.href = 'tasks-v2.html'; }}
              tabs={[{ id: 'list', label: 'List', icon: 'list' }, { id: 'board', label: 'Board', icon: 'board' }]} />
            <div className="board-search"><SearchBar inputRef={searchRef} value={query} onChange={setQuery} placeholder="Search tasks by title, id, or tag…" hint="/" /></div>
            <LevelSelect onChange={txt => setLevel(LEVEL_MAP[txt] || 'all')} />
            <Button variant="primary">＋ New</Button>
          </div>
          <div className="columns">
            {columns.map(({ col, tasks }) => <Column key={col.key} col={col} tasks={tasks} />)}
          </div>
        </main>
      </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<BoardApp />);
})();
