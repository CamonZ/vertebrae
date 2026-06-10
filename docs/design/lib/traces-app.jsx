/* ──────────────────────────────────────────────────────────────────
   Hearth · Traces v2 — App (React)
   The trace as a RECURSIVE THREAD TREE:
     Task › Run › Thread › Turn › Message{ user · system · agent · tool }
   A tool call of kind "spawn" opens a child Thread (orchestrator step or
   subagent). The center stream is the run's root threads, each rendered by
   the shared, recursive <Thread> (lib-thread). The rail is the run's thread
   tree. readOnly for now — focus-drill is the read mechanic; the same
   component backs the interactive chat.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef } = React;
  const { RunCard, IdChip, HeroStatus, FlightStrip, ScopeChip, SearchBar, AutoScrollSwitch, IconButton, AppShell, Thread, flattenThreads } = window;

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

  const FILTERS = [
    { id: 'all', label: 'All', n: 52 }, { id: 'threads', label: 'Threads', n: 6 },
    { id: 'turns', label: 'Turns', n: 9 }, { id: 'tools', label: 'Tools', n: 31 },
    { id: 'system', label: 'System', n: 4 }, { id: 'errors', label: 'Errors', n: 1, err: true },
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

  // ── The recursive trace ────────────────────────────────────────────
  // A run is an ordered list of root threads (its orchestrator steps).
  // A thread has turns; a turn is an ordered series of messages; a tool
  // call of type "spawn" carries a child thread (subagent / sub-step).

  // depth-2 subagent: a tiny helper search spawned mid-subagent
  const SUB_SEARCH = {
    id: 'th.9aa0', label: 'grep_test_helpers', spawnLabel: 'subagent', kind: 'eval',
    summary: { turns: 1, tools: 2, dur: '3.1s', status: 'ok' },
    turns: [
      { id: 'ss1', messages: [
        { evt: 'ssys', type: 'system', at: '01:23:12.004', rel: '+9m 29s', label: 'System · subagent',
          text: 'Locate existing chat-runner test helpers before writing new fixtures.',
          body: '<system>\n  You are a retrieval subagent. Find existing test helpers and factories\n  for the chat session runner so the parent subagent reuses them instead of\n  re-deriving fixtures. Return file paths + the helper names. Do not edit.' },
        { evt: 'ssa1', type: 'agent', at: '01:23:13.120', rel: '+9m 30s', speaker: 'Subagent · Codex', model: 'claude-haiku-4',
          prose: <p>Scanning the test support tree for runner factories and shared setup.</p> },
        { evt: 'sst1', type: 'tool', kind: 'shell', at: '01:23:13.330', rel: '+9m 30s', cmd: 'rg', flag: '-l', em: '"def build_runner|setup_chat_session|RunnerCase"', dur: '54ms' },
        { evt: 'sst2', type: 'tool', kind: 'shell', at: '01:23:13.610', rel: '+9m 31s', cmd: 'sed', flag: '-n', em: "'1,60p' test/support/runner_case.ex", dur: '31ms',
          body: 'defmodule Sacrum.RunnerCase do\n  use ExUnit.CaseTemplate\n  using do\n    quote do\n      import Sacrum.RunnerFactory\n      setup :start_isolated_runner\n    end\n  end\nend' },
      ] },
    ],
  };

  // depth-1 subagent: writes the failing test, then verifies green
  const SUB_WRITETESTS = {
    id: 'th.f4d2', label: 'write_failing_test', spawnLabel: 'subagent', kind: 'execute',
    summary: { turns: 3, tools: 5, dur: '48s', status: 'ok' },
    turns: [
      { id: 'st1', messages: [
        { evt: 'sys1', type: 'system', at: '01:23:05.220', rel: '+9m 23s', label: 'System · subagent',
          text: 'You are a focused test-writing subagent for the chat session runner.',
          body: '<system>\n  You are a test-writing subagent. Reproduce the two failing cases in\n  chat_session_runner_test.exs as isolated, deterministic tests, then make\n  them pass with the smallest change. Reuse existing helpers. Hand back a\n  one-line summary + the touched files.\n\n<scope>\n  files   lib/sacrum/chat_session_runner.ex · test/.../chat_session_runner_test.exs\n  budget  one level of helper retrieval; no schema edits' },
        { evt: 'sa1', type: 'agent', at: '01:23:08.440', rel: '+9m 26s', speaker: 'Subagent · Codex', model: 'claude-sonnet-4.5',
          prose: <p>I'll reproduce both failures as isolated cases first. Before writing fixtures I want to reuse whatever runner helpers already exist, so I'm dispatching a quick retrieval pass.</p> },
        { evt: 'st_t1', type: 'tool', kind: 'shell', at: '01:23:09.010', rel: '+9m 26s', cmd: 'mix test', em: 'chat_session_runner_test.exs --only failing --trace', dur: '2.2s' },
        { evt: 'st_t2', type: 'tool', kind: 'shell', at: '01:23:11.500', rel: '+9m 28s', cmd: 'sed', flag: '-n', em: "'120,210p' lib/sacrum/chat_session_runner.ex", dur: '40ms' },
      ] },
      { id: 'st2', messages: [
        { evt: 'sa2', type: 'agent', at: '01:23:12.000', rel: '+9m 29s', speaker: 'Subagent · Codex', model: 'claude-sonnet-4.5',
          prose: <p>Retrieval first — then I'll write the two cases against the existing <code>RunnerCase</code> template.</p> },
        { evt: 'spawn-search', type: 'spawn', thread: SUB_SEARCH },
        { evt: 'st_t3', type: 'tool', kind: 'shell', at: '01:23:40.220', rel: '+9m 57s', cmd: 'apply_patch', em: 'test/sacrum/chat_session_runner_test.exs', dur: '120ms' },
        { evt: 'st_t4', type: 'tool', kind: 'shell', at: '01:23:44.010', rel: '+10m 01s', cmd: 'apply_patch', em: 'lib/sacrum/chat_session_runner.ex', dur: '96ms' },
      ] },
      { id: 'st3', messages: [
        { evt: 'sa3', type: 'agent', at: '01:23:51.330', rel: '+10m 08s', speaker: 'Subagent · Codex', model: 'claude-sonnet-4.5',
          prose: <p>Both regressions are now covered by deterministic cases and the suite is green. Handing back <code>chat_session_runner.ex</code> + the test file.</p> },
      ] },
    ],
  };

  const RUN1_THREADS = [
    {
      id: 'th.a1f3',
      step: { to: 'accept_user_turn', kind: 'execute', at: '01:13:42', rel: '+0s' },
      summary: { turns: 1, tools: 5, status: 'ok' },
      turns: [
        { id: 'tn1', messages: [
          { evt: 'u1', type: 'user', role: 'human', at: '01:13:42', rel: '+0s', id: 'turn.1',
            text: 'Decompose the chat-runner work into direct child tasks, in dependency order — stay exactly one level down.' },
          { evt: 'a1', type: 'agent', at: '01:13:54', rel: '+11.5s', id: 't1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
            prose: <p>I'll ground this in the live tracker record and nearby Sacrum code paths first, then create only direct child tasks in dependency order. I'm also going to use the Vertebrae task skills because this is tracker-native decomposition work.</p> },
          { evt: 't1', type: 'tool', kind: 'shell', at: '01:14:01', rel: '+18.6s', cmd: 'rg', flag: '-n', em: '"chat runner activity|live chat runner|hydrate_session"', dur: '142ms' },
          { evt: 't2', type: 'tool', kind: 'shell', at: '01:14:01', rel: '+18.8s', cmd: 'rg', flag: '-n', em: '"chat runner|ChatRunner|sendChatMessage"', dur: '98ms' },
          { evt: 't3', type: 'tool', kind: 'shell', at: '01:14:01', rel: '+19.0s', cmd: 'vtb show', em: '40628099-b155-45e8-8cee-f8621738138b', dur: '87ms' },
          { evt: 'a2', type: 'agent', at: '01:14:03', rel: '+21.2s', id: 't2.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
            prose: <>
              <p>The parent already has the intended checklist items, so I won't rewrite it. I'm narrowing child tasks around the actual runner modules, event/checkpoint layer, LiveChat ingress, GraphQL/channel projection, and hydration/recovery so the work stays exactly one level down.</p>
              <p style={{ marginTop: 8 }}>Reading the modules now to anchor each child to a real <code>vtb section</code> and code ref.</p>
            </> },
          { evt: 't4', type: 'tool', kind: 'shell', at: '01:14:08', rel: '+25.7s', cmd: 'sed', flag: '-n', em: "'1,180p' lib/sacrum/chat_session_runner.ex", dur: '42ms' },
          { evt: 't5', type: 'tool', kind: 'shell', at: '01:14:08', rel: '+25.9s', cmd: 'sed', flag: '-n', em: "'1,180p' lib/sacrum/accounts/live_chat.ex", dur: '38ms' },
        ] },
      ],
    },
    {
      id: 'th.7b22',
      step: { to: 'classify_intent', kind: 'eval', at: '01:18:11', rel: '+4m 28s' },
      summary: { turns: 1, tools: 0, status: 'ok' },
      turns: [
        { id: 'tn1', messages: [
          { evt: 'p1', type: 'system', at: '01:18:11', rel: '+4m 28s', id: 'sys.cls', label: 'System · interpolated',
            text: 'Split further, or finalize the proposed child set? Decision + one line why.',
            body: '<system>\n  You are Sacrum, decomposing a tracker task. Create only DIRECT children,\n  one level down. Prefer fewer, well-bounded tasks with an honest dependency order.\n\n<context>\n  parent      40628099  · "Emit chat runner activity events…"\n  modules     chat_session_runner.ex, accounts/live_chat.ex\n  candidates  6 child tasks (runner / events / ingress / projection / hydration / tests)\n\n<question>\n  Given the parent checklist and the modules just read, should the agent split\n  further, or finalize the proposed child set? Answer with a decision + one line why.' },
          { evt: 'a3', type: 'agent', at: '01:18:19', rel: '+4m 36s', id: 't3.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
            prose: <p>The six proposed children map one-to-one onto real modules and already have a clean dependency order. <strong>Finalizing</strong> — no further split.</p> },
        ] },
      ],
    },
    {
      id: 'th.c901',
      step: { to: 'verify_changes', kind: 'execute', at: '01:22:40', rel: '+8m 58s' },
      summary: { turns: 1, tools: 2, status: 'ok' },
      turns: [
        { id: 'tn1', messages: [
          { evt: 'a4', type: 'agent', at: '01:22:44', rel: '+9m 02s', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
            prose: <p>Running the runner suite before handing the children off. If anything is red I'll spin up a focused subagent to repair it rather than fixing inline.</p> },
          { evt: 'err1', type: 'error', at: '01:22:48', rel: '+9m 06s', id: 'err.4a82', title: 'run_tests failed · exit 1', sub: '2 of 41 failed in chat_session_runner_test.exs — dispatching an isolated test subagent.' },
          { evt: 't6', type: 'tool', kind: 'shell', error: true, at: '01:22:48', rel: '+9m 06s', cmd: 'mix test', em: 'chat_session_runner_test.exs --max-failures 1', dur: '2.4s' },
          { evt: 'spawn-writetests', type: 'spawn', thread: SUB_WRITETESTS },
          { evt: 't7', type: 'tool', kind: 'shell', at: '01:24:02', rel: '+10m 19s', cmd: 'mix test', em: 'chat_session_runner_test.exs', dur: '2.1s',
            body: '....................................\nFinished in 2.1 seconds (0.4s async, 1.7s sync)\n41 tests, 0 failures' },
        ] },
      ],
    },
    {
      id: 'th.dd31',
      step: { to: 'wait_for_children', kind: 'wait', at: '01:50:14', rel: '+36m 32s', runtime: 'waiting 7h 36m' },
      summary: { turns: 1, tools: 0, status: 'waiting' },
      turns: [
        { id: 'wt1', messages: [
          { evt: 'w1', type: 'wait', at: '01:50:15', rel: '+36m 32s', id: 'wait.c794', text: 'Waiting on 3 child tasks · running for 7h 36m', wid: 'c794b783 still running' },
        ] },
      ],
    },
  ];

  const RUN2_THREADS = [
    {
      id: 'th.2b01',
      step: { to: 'accept_user_turn', kind: 'execute', at: '01:05:02', rel: '+0s' },
      summary: { turns: 1, tools: 2, status: 'ok' },
      turns: [
        { id: 'r2t1', messages: [
          { evt: 'r2u1', type: 'user', role: 'human', at: '01:05:02', rel: '+0s', id: 'turn.1', text: 'Decompose the chat-runner work into direct child tasks.' },
          { evt: 'r2a1', type: 'agent', at: '01:05:09', rel: '+7s', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5', prose: <p>Grounding in the tracker record and runner modules first.</p> },
          { evt: 'r2t1a', type: 'tool', kind: 'shell', at: '01:05:11', rel: '+9s', cmd: 'rg', flag: '-n', em: '"ChatRunner"', dur: '110ms' },
          { evt: 'r2t1b', type: 'tool', kind: 'shell', at: '01:05:12', rel: '+10s', cmd: 'vtb show', em: '40628099', dur: '88ms' },
        ] },
      ],
    },
    {
      id: 'th.2c02',
      step: { to: 'verify_changes', kind: 'execute', at: '01:05:31', rel: '+29s' },
      summary: { turns: 1, tools: 1, status: 'err' },
      turns: [
        { id: 'r2t2', messages: [
          { evt: 'r2a2', type: 'agent', at: '01:05:33', rel: '+31s', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5', prose: <p>Running the suite to verify before handoff.</p> },
          { evt: 'r2t2a', type: 'tool', kind: 'shell', error: true, at: '01:05:36', rel: '+34s', cmd: 'mix test', em: 'chat_session_runner_test.exs', dur: '120s' },
          { evt: 'r2err', type: 'error', at: '01:07:36', rel: '+2m 34s', id: 'err.7c10', title: 'tool timeout · 120s', sub: 'mix test exceeded the per-tool budget — run failed.' },
        ] },
      ],
    },
  ];

  // ── lightweight thread sets for older, resolved runs ───────────────
  function quickThread(id, to, kind, status, prose) {
    return {
      id: id, step: { to: to, kind: kind, at: '—', rel: '' }, summary: { turns: 1, tools: 1, status: status },
      turns: [{ id: id + '.t', messages: [
        { evt: id + '.a', type: 'agent', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5', prose: <p>{prose}</p> },
        { evt: id + '.x', type: 'tool', kind: 'shell', cmd: 'mix test', em: 'chat_session_runner_test.exs', dur: '2.0s' },
      ] }],
    };
  }
  const RUN_DONE_A = [
    quickThread('th.da1', 'accept_user_turn', 'execute', 'ok', 'Grounded in the tracker record and drafted the child set.'),
    quickThread('th.da2', 'verify_changes', 'execute', 'ok', 'Suite green — handing the children off.'),
  ];
  const RUN_DONE_B = [
    quickThread('th.db1', 'accept_user_turn', 'execute', 'ok', 'Re-derived the decomposition from the updated parent spec.'),
    quickThread('th.db2', 'classify_intent', 'eval', 'ok', 'Finalized — six children, clean dependency order.'),
    quickThread('th.db3', 'verify_changes', 'execute', 'ok', 'All green.'),
  ];

  // ── Runs, newest first. A task accrues many; this list is the history. ──
  const RUNS = [
    { id: '43abee9d', n: 6, group: 'Today', state: 'waiting', label: 'Waiting', stamp: '01:13:42', date: 'Jun 8', duration: '7h 36m', attempts: 97, threads: RUN1_THREADS },
    { id: '6b2f5482', n: 5, group: 'Today', state: 'failed', label: 'Failed', stamp: '01:05:02', date: 'Jun 8', duration: '2m 34s', attempts: 12, reason: 'tool timeout', threads: RUN2_THREADS },
    { id: 'a3f1c2d4', n: 4, group: 'Yesterday', state: 'completed', label: 'Completed', stamp: '23:41:09', date: 'Jun 7', duration: '4m 12s', attempts: 23, threads: RUN_DONE_A },
    { id: '7e2b9a01', n: 3, group: 'Yesterday', state: 'completed', label: 'Completed', stamp: '22:10:55', date: 'Jun 7', duration: '3m 48s', attempts: 19, threads: RUN_DONE_B },
    { id: '2c8d5f33', n: 2, group: 'Yesterday', state: 'failed', label: 'Failed', stamp: '18:02:31', date: 'Jun 7', duration: '1m 02s', attempts: 4, reason: 'eval rejected', threads: RUN_DONE_B },
    { id: '9b0e7a12', n: 1, group: 'Earlier', state: 'completed', label: 'Completed', stamp: '14:20:08', date: 'Jun 5', duration: '5m 20s', attempts: 31, threads: RUN_DONE_A },
  ];
  const RUNS_DATA = {};
  RUNS.forEach((r) => { RUNS_DATA[r.id] = { id: r.id, threads: r.threads }; });

  /* ── RunNode — a run row that expands into its thread tree ── */
  function RunNode({ run, active, selectedEvt, onSelectRun, onJump }) {
    const nodes = active ? flattenThreads(run.threads, 0, []) : null;
    return (
      <div className={'run-node' + (active ? ' active' : '')}>
        <div className="rn-head" onClick={() => onSelectRun(run.id)} title={'Run ' + run.n + ' · ' + run.date + ' ' + run.stamp + ' · ' + run.id}>
          <span className={'rn-mark ' + run.state}>{run.n}</span>
          <div className="rn-body">
            <div className="rn-row1">
              <span className="rn-runlbl">Run {run.n}</span>
              <span className={'rn-state ' + run.state}>{run.label}</span>
              <span className="rn-dur">{run.duration}</span>
            </div>
            <div className="rn-row2">
              <span className="rn-ts">{run.date} · {run.stamp}</span>
              {run.attempts ? <React.Fragment><span className="rn-sep">·</span><span className="rn-att">{run.attempts} exec</span></React.Fragment> : null}
              {run.reason ? <React.Fragment><span className="rn-sep">·</span><span className="rn-reason">{run.reason}</span></React.Fragment> : null}
            </div>
          </div>
          <span className="rn-chev">▾</span>
        </div>
        {active ? (
          <div className="run-threads">
            {nodes.map((node) => (
              <div key={node.id} className={'trace-thread l' + Math.min(node.depth, 2) + (selectedEvt === node.id ? ' sel' : '')} onClick={() => onJump(node.id)}>
                <span className={'tk k-' + node.kind} />
                <span className="ttext">{node.label}</span>
                <span className="tmeta">{node.summary.turns != null ? node.summary.turns + 't' : ''}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function TracesApp() {
    const [selectedTask, setSelectedTask] = useState('40628099');
    const [selectedRun, setSelectedRun] = useState('43abee9d');
    const [scope, setScope] = useState('all');
    const [query, setQuery] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [selectedEvt, setSelectedEvt] = useState('th.dd31');
    const [focused, setFocused] = useState(null); // a Thread, when drilled in
    const searchRef = useRef(null);
    const streamRef = useRef(null);
    const threadRefs = useRef({});

    const run = RUNS_DATA[selectedRun];

    const registerRef = (id, el) => { if (el) threadRefs.current[id] = el; };

    function jumpTo(id) {
      setSelectedEvt(id);
      setFocused(null);
      setTimeout(() => {
        const el = threadRefs.current[id];
        const s = streamRef.current;
        if (el && s) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 16;
      }, 40);
    }

    useEffect(() => {
      function onKey(e) {
        const inSearch = document.activeElement === searchRef.current;
        if (e.key === '/' && !inSearch) { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
        else if (e.key === 'Escape') {
          if (focused) { setFocused(null); return; }
          if (inSearch) { searchRef.current.blur(); if (query) setQuery(''); }
        }
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [query, focused]);

    return (
      <AppShell page="Traces" active="traces" kbd={false} activity={
        <>
          <span className="live"><span className="pulse" />1 waiting</span>
          <span className="total"><b>6</b> threads <span style={{ color: 'var(--fg-ghost)' }}>·</span> 2h 57m</span>
        </>
      }>
        <main className="traces-main">
          {/* Rail — Task › Run › Thread tree */}
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
            <section className="rail-sec threads-sec">
              <header className="rail-hd"><span className="name">Runs</span><span className="meta">{RUNS.length}</span></header>
              <div className="rail-body">
                {RUNS.map((r, i) => (
                  <React.Fragment key={r.id}>
                    {(i === 0 || RUNS[i - 1].group !== r.group) ? <div className="run-group">{r.group}</div> : null}
                    <RunNode run={r} active={r.id === selectedRun} selectedEvt={selectedEvt}
                      onSelectRun={(id) => { setSelectedRun(id); setFocused(null); }} onJump={jumpTo} />
                  </React.Fragment>
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
                right={<span className="hero-stats"><span><b>6</b> runs</span><span className="d">·</span><span><b>97</b> executions</span><span className="d">·</span><span><b>67M</b> tokens</span></span>} />
            </header>

            {/* Flight strip */}
            <section className="flight">
              <div className="flight-head">
                <div className="lbl">Flight strip <b>·</b> run <IdChip id={selectedRun} /></div>
                <AutoScrollSwitch defaultOn={autoScroll} onChange={setAutoScroll} />
              </div>
              <FlightStrip {...FLIGHT} />
            </section>

            {/* Filters */}
            <section className="filters">
              {FILTERS.map((f, i) => f.sep
                ? <span key={'sep' + i} className="filters-sep" />
                : <ScopeChip key={f.id} label={f.label} n={f.n} err={f.err} active={scope === f.id} onClick={() => setScope(f.id)} />)}
              <div className="filter-search"><SearchBar inputRef={searchRef} value={query} onChange={setQuery} placeholder="Search the thread…" hint="/" /></div>
            </section>

            {/* Focus bar — shown when drilled into a subthread */}
            {focused ? (
              <div className="focus-bar">
                <span className="fb-crumb" onClick={() => setFocused(null)}>← run {selectedRun}</span>
                <span className="fb-sep">/</span>
                <span className="fb-here"><span className={'tk k-' + (focused.kind || 'execute')} /> focused on <b>{focused.label}</b></span>
                <span className="fb-tag">read-only</span>
              </div>
            ) : null}

            {/* Stream — the run's thread tree (timed, deep reveal, read-only) */}
            <section className="stream evlog evlog--timed" ref={streamRef}>
              {focused ? (
                <Thread thread={focused} depth={0} mode="timed" reveal="deep"
                  selectedEvt={selectedEvt} onSelect={setSelectedEvt} registerRef={registerRef} onFocus={setFocused} />
              ) : (
                run.threads.map(th => (
                  <Thread key={th.id} thread={th} depth={0} mode="timed" reveal="deep"
                    selectedEvt={selectedEvt} onSelect={setSelectedEvt} registerRef={registerRef} onFocus={setFocused} />
                ))
              )}
            </section>
          </section>
        </main>
      </AppShell>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<TracesApp />);
})();
