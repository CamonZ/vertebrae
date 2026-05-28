/* ──────────────────────────────────────────────────────────────────
   Hearth · Traces v2 — App (React)
   Task/run rail + flight strip + event stream, on the component library.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;
  const { RunCard, IdChip, HeroStatus, FlightStrip, EventCard, ScopeChip, SearchBar, AutoScrollSwitch, IconButton, AppShell, LiveCount } = window;

  const TASKS = [
    { id: 'fe0a3c08', title: 'Explore backend chat sessions and app-owned workflows', level: 0 },
    { id: '40628099', title: 'Emit chat runner activity events and replace single-shot live chat runner lifecycle', level: 1 },
    { id: '80e1a7b6', title: 'Define client-safe chat runner activity event builders', level: 2 },
    { id: 'a904a91e', title: 'Route user turns through the session-owned chat runner', level: 2 },
    { id: '23df40d5', title: 'Keep chat session runners alive between turns', level: 2 },
    { id: 'c794b783', title: 'Hydrate chat runner state and resume pending work', level: 2 },
    { id: 'c0a5b5e3', title: 'Project runner activity through chat public event surfaces', level: 2 },
    { id: '8156c4fb', title: 'Add end-to-end tests for activity, multi-turn ingress, and restart recovery', level: 2 },
  ];
  const RUNS = [
    { id: '43abee9d', when: '01:13 AM', state: 'waiting', label: 'Waiting', runtime: '7h 36m' },
    { id: '6b2f5482', when: '01:05 AM', state: 'failed', label: 'Failed', reason: 'tool timeout' },
  ];

  const FILTERS = [
    { id: 'all', label: 'All', n: 52 }, { id: 'steps', label: 'Steps', n: 5 },
    { id: 'tools', label: 'Tools', n: 31 }, { id: 'turns', label: 'Turns', n: 14 },
    { id: 'waits', label: 'Waits', n: 1 }, { id: 'errors', label: 'Errors', n: 1, err: true },
    { sep: true }, { id: 'codex', label: 'codex', n: 12 }, { id: 'claude', label: 'claude', n: 2 },
  ];

  const FLIGHT = {
    steps: [
      { kind: 'execute', left: '2%', width: '8%' }, { kind: 'eval', left: '11%', width: '6%' },
      { kind: 'route', left: '18%', width: '4%' }, { kind: 'execute', left: '23%', width: '14%' },
      { kind: 'wait', left: '38%', width: '56%', live: true },
    ],
    tools: [{ left: '3.5%' }, { left: '5%' }, { left: '7%' }, { left: '9%' }, { left: '14%' }, { left: '24%' }, { left: '27%' }, { left: '30%' }, { left: '33%', error: true }, { left: '36%' }, { left: '41%' }],
    turns: ['3%', '6%', '11%', '16%', '23%', '28%', '32%', '37%'],
    viewport: { left: '5%', width: '8%' }, play: '94%',
    ticks: ['+0s', '+18m', '+36m', '+54m', '+1h 12m', '+1h 30m', '+1h 48m', '+2h 06m', '+2h 24m', '+2h 42m'],
  };

  const EVENTS = [
    { evt: 's1', type: 'step', kind: 'execute', at: '01:13:42.483', rel: '+0s', to: 'accept_user_turn' },
    { evt: 'a1', type: 'agent', at: '01:13:54.033', rel: '+11.5s', id: 't1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
      prose: <p>I'll ground this in the live tracker record and nearby Sacrum code paths first, then create only direct child tasks in dependency order. I'm also going to use the Vertebrae task skills because this is tracker-native decomposition work.</p> },
    { evt: 't1', type: 'tool', at: '01:14:01.110', rel: '+18.6s', cmd: 'rg', flag: '-n', em: '"chat runner activity|live chat runner|hydrate_session|Ji…"', dur: '142ms' },
    { evt: 't2', type: 'tool', at: '01:14:01.310', rel: '+18.8s', cmd: 'rg', flag: '-n', em: '"chat runner|ChatRunner|sendChatMessage|send_message_and_…"', dur: '98ms' },
    { evt: 't3', type: 'tool', at: '01:14:01.512', rel: '+19.0s', cmd: 'vtb show', em: '40628099-b155-45e8-8cee-f8621738138b', dur: '87ms' },
    { evt: 'a2', type: 'agent', at: '01:14:03.645', rel: '+21.2s', id: 't2.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
      prose: <>
        <p>The parent already has the intended checklist items, so I won't rewrite it. I'm narrowing child tasks around the actual runner modules, event/checkpoint layer, LiveChat ingress, GraphQL/channel projection, and hydration/recovery so the work stays exactly one level down.</p>
        <p style={{ marginTop: 8 }}>Reading the modules now to anchor each child to a real <code>vtb section</code> and code ref.</p>
      </> },
    { evt: 't4', type: 'tool', at: '01:14:08.220', rel: '+25.7s', cmd: 'sed', flag: '-n', em: "'1,180p' lib/sacrum/chat_session_runner.ex", dur: '42ms' },
    { evt: 't5', type: 'tool', at: '01:14:08.401', rel: '+25.9s', cmd: 'sed', flag: '-n', em: "'1,180p' lib/sacrum/accounts/live_chat.ex", dur: '38ms' },
    { evt: 's2', type: 'step', kind: 'eval', at: '01:18:11.022', rel: '+4m 28s', pre: 'accept_user_turn', to: 'classify_intent' },
    { evt: 'err1', type: 'error', at: '01:22:48.150', rel: '+9m 06s', id: 'err.4a82', title: 'tool · run_tests failed (exit 1)', sub: '2 of 41 tests failed in lib/sacrum/chat_session_runner_test.exs. Retrying with isolated runner.' },
    { evt: 't6', type: 'tool', error: true, at: '01:22:48.300', rel: '+9m 06s', cmd: 'mix test', em: 'lib/sacrum/chat_session_runner_test.exs --max-failures 1', dur: '2.4s' },
    { evt: 's3', type: 'step', kind: 'wait', at: '01:50:14.847', rel: '+36m 32s', pre: 'tool fan-out', to: 'wait_for_children' },
    { evt: 'w1', type: 'wait', at: '01:50:15.012', rel: '+36m 32s', id: 'wait.c794', text: 'Waiting on 3 child tasks · running for 7h 36m', wid: 'c794b783 still running' },
  ];

  function TracesApp() {
    const [selectedTask, setSelectedTask] = useState('40628099');
    const [selectedRun, setSelectedRun] = useState('43abee9d');
    const [scope, setScope] = useState('all');
    const [query, setQuery] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [selectedEvt, setSelectedEvt] = useState('w1');
    const searchRef = useRef(null);

    useEffect(() => {
      function onKey(e) {
        const inSearch = document.activeElement === searchRef.current;
        if (e.key === '/' && !inSearch) { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
        else if (e.key === 'Escape' && inSearch) { searchRef.current.blur(); if (query) setQuery(''); }
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [query]);

    return (
      <AppShell page="Traces" active="traces" kbd={false} activity={
        <>
          <span className="live"><span className="pulse" />1 waiting</span>
          <span className="total"><b>97</b> attempts <span style={{ color: 'var(--fg-ghost)' }}>·</span> 2h 57m</span>
        </>
      }>
        <main className="traces-main">
          {/* Rail */}
          <aside className="rail">
            <section className="rail-sec tasks-sec">
              <header className="rail-hd"><span className="name">Tasks</span><span className="meta">7</span></header>
              <div className="rail-body">
                {TASKS.map(t => (
                  <div key={t.id} className={'trace-task l' + t.level + (t.id === selectedTask ? ' sel' : '')} onClick={() => setSelectedTask(t.id)}>
                    <span className="glyph">{t.level === 2 ? '·' : '◇'}</span>
                    <span className="ttext">{t.title}</span>
                    <IdChip id={t.id} />
                  </div>
                ))}
              </div>
            </section>
            <section className="rail-sec runs-sec">
              <header className="rail-hd"><span className="name">Runs</span><span className="meta">2</span></header>
              <div className="rail-body" style={{ padding: '4px' }}>
                {RUNS.map(r => (
                  <div key={r.id} style={{ margin: '0 4px 4px' }}>
                    <RunCard run={{ state: r.state, label: r.label, runtime: r.runtime }} id={r.id}
                      when={'started ' + r.when} reason={r.reason}
                      selected={r.id === selectedRun} onClick={() => setSelectedRun(r.id)} />
                  </div>
                ))}
              </div>
            </section>
          </aside>

          {/* Center */}
          <section className="center">
            <header className="center-head">
              <div className="crumb-row"><span className="back">← Back</span><span style={{ color: 'var(--fg-ghost)' }}>·</span><span>ticket</span></div>
              <div className="title-row">
                <div className="title">Emit chat runner activity events and replace single-shot <em>live chat runner</em> lifecycle</div>
                <IdChip id="40628099" />
                <div className="actions">
                  <IconButton icon="detach" title="Detach" />
                  <IconButton icon="more" title="More" />
                </div>
              </div>
              <HeroStatus state="waiting" edge="wait" label="Waiting · for children" runtime="7h 36m running" step={{ n: 5, kind: 'wait' }}
                right={<span className="hero-stats"><span><b>6</b> runs</span><span className="d">·</span><span><b>97</b> attempts</span><span className="d">·</span><span><b>67M</b> tokens</span></span>} />
            </header>

            {/* Flight strip */}
            <section className="flight">
              <div className="flight-head">
                <div className="lbl">Flight strip <b>·</b> run <IdChip id="43abee9d" /></div>
                <AutoScrollSwitch defaultOn={autoScroll} onChange={setAutoScroll} />
              </div>
              <FlightStrip {...FLIGHT} />
            </section>

            {/* Filters */}
            <section className="filters">
              {FILTERS.map((f, i) => f.sep
                ? <span key={'sep' + i} className="filters-sep" />
                : <ScopeChip key={f.id} label={f.label} n={f.n} err={f.err} active={scope === f.id} onClick={() => setScope(f.id)} />)}
              <div className="filter-search"><SearchBar inputRef={searchRef} value={query} onChange={setQuery} placeholder="Search events…" hint="/" /></div>
            </section>

            {/* Stream */}
            <section className="stream">
              {EVENTS.map(e => (
                <EventCard key={e.evt} {...e} selected={selectedEvt === e.evt} onClick={() => setSelectedEvt(e.evt)} />
              ))}
            </section>
          </section>
        </main>
      </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<TracesApp />);
})();
