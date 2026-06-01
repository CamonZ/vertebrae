/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — Shared task data
   Consumed by tasks-v2.js (list view) and board-v2.js (kanban).

   Concepts:
     • stepKind  — workflow position: execute|eval|route|human|wait|null
                   Drives hue.
     • runState  — last task run state: running|waiting|queued|
                                       completed|cancelled|stopped|null
                   Drives the chip. Active = running|waiting|queued.
   ────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

    // ── Data ────────────────────────────────────────────────────────
    const TASKS = [

      // ─── Roots ───
      { id: 'bffddcf6', level: 0, title: 'Task Orchestration System',
        runState: null, when: 'Mar 14', priority: 'lo',
        tags: ['orchestration', 'architecture'], childCount: 3,
        description: 'Top-level container for orchestration system work — schedulers, queues, signals, durable evidence.' },

      { id: '2743d4d0', level: 0, title: 'Add permission request mutations for GUI chat permission handling',
        runState: 'queued', when: 'Mar 15', priority: 'md',
        tags: ['gui', 'permissions'],
        description: 'Surface permission requests from agents into the live chat UI so the user can grant or deny mid-run.' },

      { id: '8818251a', level: 0, title: 'Composite FK authorization and referential integrity refactor',
        runState: null, when: 'Mar 29', priority: 'md',
        tags: ['backend', 'schema', 'security'], childCount: 5,
        description: 'Refactor cross-table authorization so referential integrity is enforced via composite foreign keys, not application-level checks.' },

      { id: '081f5160', level: 0, title: 'Fan-out / Fan-in Parallel Execution',
        runState: null, when: 'Apr 2', priority: 'lo',
        tags: ['orchestrator'], childCount: 6,
        description: 'Workflow primitive for fanning a task out to N parallel children, gathering their outputs, and resuming the parent with a deterministic merge.' },

      { id: 'b6e66dc8', level: 0, title: 'Research: "prior output" semantics for step execution context',
        runState: 'queued', when: 'Apr 17', priority: 'lo',
        tags: ['discussion', 'research', 'orchestrator'],
        description: 'Spec out what "prior output" should mean when a step executes — last sibling output, last successful, last by tag, etc.' },

      { id: '3ef56524', level: 0, title: 'Block CLI control plane from advancing tasks actively orchestrated',
        runState: 'queued', when: 'Apr 18', priority: 'md',
        tags: ['bug', 'orchestrator', 'cli'],
        description: 'The CLI can advance tasks that are mid-orchestration in the live runner, causing split-brain. Lock these out at the control plane.' },

      // Active epic
      { id: '2b064abb', level: 0, title: 'Vertebrae Web App',
        runState: 'running', when: 'Apr 25', priority: 'md',
        tags: ['research'], childCount: 11,
        children: ['a75f037a', 'ca564fec', 'fe0a3c08', 'e4e4c5c5', '9e78bea2', '901268f8', '40628099', 'f0546c38', '0ac78100'],
        description: 'The web app surface area: tasks, board, traces, runtime panels. Active work driving the current ember.' },

      // ─── Tickets under Vertebrae Web App ───
      { id: 'a75f037a', level: 1, title: 'TaskRun lifecycle and recursive traceability',
        runState: null, when: '23d', priority: 'lo',
        tags: ['orchestrator', 'traceability', 'run-lifecycle'],
        parent: '2b064abb',
        description: 'Define and persist the full lifecycle of a TaskRun so that traces can be reconstructed recursively across parent/child boundaries.' },

      { id: 'ca564fec', level: 1, title: 'Design platform layer for human_input approval workflows',
        runState: null, when: '20d', priority: 'lo',
        tags: ['platform', 'human-review'],
        parent: '2b064abb',
        description: 'A reusable approval/review surface for any step that requires human input — not just bespoke per-flow UI.' },

      { id: 'fe0a3c08', level: 1, title: 'Explore backend chat sessions and app-owned workflows',
        runState: 'running', stepKind: 'execute',
        runtime: '12m', when: '18d', priority: 'md',
        tags: ['planning-runs', 'chat-sessions'], childCount: 12,
        children: ['2d297d56', '3119862e', '984cd381', '181a66ba'],
        parent: '2b064abb',
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'running' },
          { kind: 'eval',    state: 'queued' },
          { kind: 'human',   state: 'queued' },
          { kind: 'wait',    state: 'queued' },
        ],
        description: 'Drive a coherent backend model for chat sessions: who owns them, how planning runs attach, how the app reads them back.' },

      // tasks under fe0a3c08
      { id: '2d297d56', level: 2, title: 'Add ChatRun investigation wait/resume with findings artifacts',
        runState: 'queued', when: '18d', parent: 'fe0a3c08',
        tags: ['planning-runs', 'harness', 'session-first', 'chat-v5', 'artifacts', 'authoring'] },
      { id: '3119862e', level: 2, title: 'Emit GUI result commands for direct tools and artifacts',
        runState: 'queued', when: '18d', parent: 'fe0a3c08',
        tags: ['planning-runs', 'gui-contract', 'chat-sessions'] },
      { id: '984cd381', level: 2, title: 'Add generic artifact model with task and section attachments',
        runState: 'completed', when: '18d', parent: 'fe0a3c08',
        tags: ['planning-runs', 'chat-sessions', 'session-first', 'chat-v3', 'artifacts'] },
      { id: '181a66ba', level: 2, title: 'Decide ChatRun history, archive, and delete model',
        runState: 'queued', when: '18d', parent: 'fe0a3c08',
        tags: ['planning-runs', 'chat-sessions', 'chat-history'] },

      { id: 'e4e4c5c5', level: 1, title: 'Apply work breakdown authoring drafts into tasks',
        runState: 'queued', when: '12d', priority: 'md',
        tags: ['authoring', 'work-breakdown', 'artifacts'],
        parent: '2b064abb',
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'eval',    state: 'queued' },
          { kind: 'human',   state: 'queued' },
        ],
        description: 'Convert work-breakdown drafts into real tasks under the right parent, preserving provenance to the source draft.' },

      { id: '9e78bea2', level: 1, title: 'Drive authoring intents via OpenRouter tools with verifier gate',
        runState: 'completed', when: '4d', priority: 'lo',
        tags: ['openrouter', 'verifier', 'authoring', 'inference'],
        parent: '2b064abb',
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'eval',    state: 'completed' },
          { kind: 'human',   state: 'completed' },
          { kind: 'execute', state: 'completed' },
        ],
        description: 'Route authoring tool-calls through OpenRouter and gate every produced artifact through a verifier before applying.' },

      { id: '901268f8', level: 1, title: 'Expose internal tracker operation tools to live chat',
        runState: 'completed', when: '3d', priority: 'md',
        tags: ['tracker-tools', 'chat-sessions', 'authoring'],
        parent: '2b064abb',
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'eval',    state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
        ],
        description: 'Lift the internal tracker mutation tools into the chat tool surface so the agent can create, update, and link work units directly.' },

      // ★ Selected ticket
      { id: '40628099', level: 1, title: 'Emit chat runner activity events and replace single-shot live chat runner lifecycle',
        runState: 'waiting', stepKind: 'wait',
        runtime: '7h 36m', when: '11h', priority: 'hi',
        tags: ['live-chat', 'runner', 'gui-contract', 'rehydration', 'jido', 'durability'],
        parent: '2b064abb',
        children: ['80e1a7b6', 'a904a91e', '23df40d5', 'c794b783', 'c0a5b5e3', '8156c4fb', 'e2f1a7c9'],
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'running' },
          { kind: 'execute', state: 'completed' },
          { kind: 'wait',    state: 'queued' },
        ],
        goal: 'Make live chat visibly active and operationally durable by moving ordinary user turns, tool continuations, activity events, and restart recovery behind a session-owned Jido AgentServer. Persistence remains authoritative durable evidence, but it must be a side effect and rehydration source rather than the main live control path.',
        description: 'Refactor live chat so the session-owned Jido AgentServer is the primary runtime boundary: user turns enter the runner as signals, persistence is a durable side effect / recovery source rather than the ingress queue, runner activity is projected to clients, and crashed/restarted runners can rehydrate from persisted session/message/event state.',
        constraints: [
          'Public activity payloads must remain client-safe and must not expose raw prompts, tool arguments beyond safe names or durable ids, provider request bodies, API keys, stack traces, filesystem paths, or internal resolver state.',
          'The session-owned Jido AgentServer is the normal live control boundary. Postgres remains the durable record and recovery source, but new user turns must be delivered to the runner as signals rather than relying on the runner only to discover work by polling persisted chat_messages.',
          'Persist accepted user messages before invoking models or executing tools so crash recovery has a durable turn record, but perform that persistence inside runner turn handling as a side effect of accepting the turn.',
        ],
        desired: 'User turns are submitted to a session-owned AgentServer as the live command path. The runner accepts and sequences turns, persists accepted user/assistant messages and public/internal events as side effects, emits client-safe activity events for meaningful phases, and returns to an idle per-session state after each turn instead of stopping the process.',
        blockedBy: ['2d297d56'],
        runs: { this: { runs: 2, attempts: 17, cost: 0 }, subtree: { runs: 10, attempts: 104, cost: 0 } },
      },

      // children of 40628099
      { id: '80e1a7b6', level: 2, title: 'Define client-safe chat runner activity event builders',
        runState: 'completed', stepKind: 'execute', when: '7h', parent: '40628099' },
      { id: 'a904a91e', level: 2, title: 'Route user turns through the session-owned chat runner',
        runState: 'completed', stepKind: 'execute', when: '7h', parent: '40628099' },
      { id: '23df40d5', level: 2, title: 'Keep chat session runners alive between turns',
        runState: 'completed', stepKind: 'execute', when: '7h', parent: '40628099' },
      { id: 'c794b783', level: 2, title: 'Hydrate chat runner state and resume pending work',
        runState: 'running', stepKind: 'execute', runtime: '2m',
        when: '2m', priority: 'md', parent: '40628099',
        description: 'On AgentServer boot or rehydration, reconstruct active and pending user turns from persisted chat_sessions / chat_messages / chat_events and resume work deterministically.' },
      { id: 'c0a5b5e3', level: 2, title: 'Project runner activity through chat public event surfaces',
        runState: 'completed', stepKind: 'execute', when: '7h', parent: '40628099' },
      { id: '8156c4fb', level: 2, title: 'Add end-to-end tests for activity, multi-turn ingress, and restart recovery',
        runState: 'queued', stepKind: 'execute', when: '7h', parent: '40628099' },
      { id: 'e2f1a7c9', level: 2, title: 'Spike: poll persisted chat_messages as ingress fallback',
        runState: 'cancelled', stepKind: 'execute', when: '5d', parent: '40628099' },

      { id: 'f0546c38', level: 1, title: 'Plumb OpenRouter provider routing through chat inference',
        runState: null, when: '17d', priority: 'lo',
        tags: ['chat', 'inference', 'openrouter'],
        parent: '2b064abb',
        description: 'Route every chat inference call through OpenRouter with explicit provider selection, so we can A/B providers without app changes.' },

      { id: '0ac78100', level: 1, title: 'Stream live chat responses from OpenRouter',
        runState: 'queued', when: '13d', priority: 'md',
        tags: ['chat', 'openrouter', 'streaming'],
        parent: '2b064abb',
        pipeline: [
          { kind: 'execute', state: 'completed' },
          { kind: 'execute', state: 'running' },
          { kind: 'eval',    state: 'queued' },
          { kind: 'human',   state: 'queued' },
          { kind: 'execute', state: 'queued' },
        ],
        description: 'Stream assistant responses incrementally to the GUI as OpenRouter chunks them, instead of buffering until completion.' },
    ];

  const byId = Object.create(null);
  TASKS.forEach(function (t) { byId[t.id] = t; });
  TASKS.forEach(function (t) {
    if (t.parent && byId[t.parent]) {
      var p = byId[t.parent];
      if (!p.children) p.children = [];
      if (p.children.indexOf(t.id) === -1) p.children.push(t.id);
    }
  });

  function isActiveRun(rs) { return rs === 'running' || rs === 'waiting' || rs === 'queued'; }
  function isTerminalRun(rs) { return rs === 'completed' || rs === 'cancelled' || rs === 'stopped'; }
  function ancestorIds(t) {
    var out = [], cur = t;
    while (cur && cur.parent) { out.push(cur.parent); cur = byId[cur.parent]; }
    return out;
  }

  window.HEARTH_DATA = { TASKS: TASKS, byId: byId, isActiveRun: isActiveRun, isTerminalRun: isTerminalRun, ancestorIds: ancestorIds };
})();
