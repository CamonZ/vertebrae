/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — Live session logs, keyed by workflow id.
   A "session" is one task's run THROUGH a workflow: the same event log
   that the Traces page renders, but addressable from the Graph so it can
   dock as a glass panel and light the step it is currently on.

   Shape (window.WFSessions[wfId]):
     { taskId, taskTitle, runId, state, started, elapsed, live,
       currentStepId,                         // bare step id the run sits on
       groups: [ { step:{ stepId, to, kind, at, rel, runtime, live },
                   events: [ EventRow props … ] } ] }

   • step.stepId references a REAL step of that workflow (wf-graph-data.js)
     so the panel ↔ canvas wiring can resolve the node to light.
   • The LAST group is the live one; its events stream in on open and the
     final event stays pending (spinner / blinking cursor).
   • prose is a plain string (this file is loaded raw, not via Babel);
     the event log renders **bold** and `code` inline.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const sessions = {

    /* ── SHOWCASE · Implementation — mid-run, looped back to `implement` ── */
    implementation: {
      taskId: '80e1a7b6',
      taskTitle: 'Define client-safe chat runner activity event builders',
      runId: '43abee9d',
      state: 'running', stateLabel: 'Running', live: true,
      started: '01:13 AM', elapsed: '12m 41s',
      currentStepId: 'implement',
      groups: [
        {
          step: { stepId: 'setup_workspace', to: 'setup_workspace', kind: 'entry', at: '01:13:42.483', rel: '+0s', runtime: '18s' },
          events: [
            { evt: 'p0', type: 'user', role: 'prompt', at: '01:13:42.49', rel: '+0s',
              text: 'Set up a clean, building workspace for 80e1a7b6.',
              body: '<system>\n  You are Sacrum, preparing a task workspace. cd into the ticket worktree,\n  install dependencies, confirm a clean build off a current base branch.\n\n<context>\n  task      80e1a7b6 · "Define client-safe chat runner activity event builders"\n  worktree  .wt/80e1a7b6\n  base      main @ 3f9c1a2' },
            { evt: 'a0', type: 'agent', at: '01:13:54.03', rel: '+11.5s', id: 't0.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Worktree is current with `main`. Installing deps and confirming a clean baseline build before I touch anything.' },
            { evt: 't0a', type: 'tool', kind: 'shell', at: '01:13:55.10', rel: '+12.6s', cmd: 'cd', em: '.wt/80e1a7b6 && mix deps.get', dur: '3.1s' },
            { evt: 't0b', type: 'tool', kind: 'shell', at: '01:13:59.40', rel: '+16.9s', cmd: 'mix', em: 'compile --warnings-as-errors', summary: 'clean · 0 warnings', dur: '4.8s' },
          ],
        },
        {
          step: { stepId: 'write_tests', to: 'write_tests', kind: 'execute', at: '01:14:18.220', rel: '+35s', runtime: '1m 02s' },
          events: [
            { evt: 'a1', type: 'agent', at: '01:14:20.10', rel: '+37s', id: 't1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Writing failing tests first — they capture the **builder contract** before any implementation: every activity event must be client-safe (no internal struct leakage) and round-trip through `to_public/1`.' },
            { evt: 't1a', type: 'tool', kind: 'shell', at: '01:14:41.00', rel: '+58s', cmd: 'apply_patch', em: 'test/chat/activity_builders_test.exs', summary: '+74 −0', dur: '120ms' },
            { evt: 't1b', type: 'tool', kind: 'shell', error: true, at: '01:14:52.00', rel: '+1m 09s', cmd: 'mix test', em: 'test/chat/activity_builders_test.exs', summary: '6 failed (red, as intended)', dur: '2.2s' },
          ],
        },
        {
          step: { stepId: 'implement', to: 'implement', kind: 'execute', at: '01:15:30.000', rel: '+1m 47s', runtime: '3m 41s' },
          events: [
            { evt: 'a2', type: 'agent', at: '01:15:32.40', rel: '+1m 49s', id: 't2.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Implementing the builders against the failing tests. Keeping the public surface to three functions: `activity_started/2`, `activity_progress/2`, `activity_settled/2` — each returning a plain map, no `%Runner{}` internals.' },
            { evt: 't2a', type: 'tool', kind: 'shell', at: '01:16:10.00', rel: '+2m 27s', cmd: 'apply_patch', em: 'lib/sacrum/chat/activity_builders.ex', summary: '+118 −4', dur: '140ms' },
            { evt: 't2b', type: 'tool', kind: 'shell', at: '01:18:42.00', rel: '+4m 59s', cmd: 'mix test', em: 'test/chat/activity_builders_test.exs', summary: '6 passed', dur: '2.0s' },
          ],
        },
        {
          step: { stepId: 'local_verify', to: 'local_verify', kind: 'eval', at: '01:19:02.000', rel: '+5m 19s', runtime: '1m 12s' },
          events: [
            { evt: 'a3', type: 'agent', at: '01:19:04.00', rel: '+5m 21s', id: 't3.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Running the full local gate — suite, lint, typecheck — before routing on.' },
            { evt: 't3a', type: 'tool', kind: 'shell', at: '01:19:20.00', rel: '+5m 37s', cmd: 'mix test', summary: '208 passed', dur: '11.4s' },
            { evt: 'err1', type: 'error', at: '01:19:46.00', rel: '+6m 03s', id: 'err.4a82', title: 'credo failed · exit 1',
              sub: '1 issue — activity_builders.ex:42 a public fn is missing its @doc. local_verify routes back to implement.' },
            { evt: 't3b', type: 'tool', kind: 'shell', error: true, at: '01:19:46.20', rel: '+6m 03s', cmd: 'mix credo', em: '--strict lib/sacrum/chat/activity_builders.ex', summary: '1 issue', dur: '1.9s' },
          ],
        },
        {
          /* ── LIVE: looped back to implement via the `revise` self-edge ── */
          step: { stepId: 'implement', to: 'implement', kind: 'execute', at: '01:20:08.000', rel: '+6m 25s', runtime: 'running 2m 33s', live: true },
          events: [
            { evt: 'p2', type: 'user', role: 'prompt', at: '01:20:08.10', rel: '+6m 25s',
              text: 'revise · address the credo issue, keep the suite green',
              body: '<system>\n  Re-entering `implement` from local_verify (transition: revise).\n  Address the single credo issue without changing behavior; the full suite must stay green.\n\n<handoff>\n  issue   activity_builders.ex:42 — public fn `activity_settled/2` missing @doc\n  suite   208 passed · credo 1 issue' },
            { evt: 'a4', type: 'agent', at: '01:20:11.00', rel: '+6m 28s', id: 't4.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Quick fix — documenting `activity_settled/2` and tightening the two sibling `@doc` strings so the public surface reads consistently. Re-running credo + the suite after.' },
            { evt: 't4a', type: 'tool', kind: 'shell', at: '01:20:40.00', rel: '+6m 57s', cmd: 'apply_patch', em: 'lib/sacrum/chat/activity_builders.ex', summary: '+9 −1', dur: '110ms' },
            { evt: 't4b', type: 'tool', kind: 'shell', status: 'pending', at: '01:22:38.00', rel: '+8m 55s', cmd: 'mix test', em: '&& mix credo --strict', summary: 'running…' },
          ],
        },
      ],
    },

    /* ── WaitForChildren — a quiet, parked live session ── */
    waitForChildren: {
      taskId: '40628099',
      taskTitle: 'Emit chat runner activity events and replace single-shot live chat runner lifecycle',
      runId: 'c794b783',
      state: 'waiting', stateLabel: 'Waiting', live: true,
      started: '01:50 AM', elapsed: '7h 36m',
      currentStepId: 'wait',
      groups: [
        {
          step: { stepId: 'wait', to: 'wait', kind: 'wait', at: '01:50:14.847', rel: '+0s', runtime: 'waiting 7h 36m', live: true },
          events: [
            { evt: 'a0', type: 'agent', at: '01:50:15.01', rel: '+0s', id: 'w0.sacrum', speaker: 'sacrum',
              prose: 'Parent parked. Three of six children are still in flight — holding here until every child reaches `done`, then routing to Verification.' },
            { evt: 'w1', type: 'wait', at: '01:50:15.30', rel: '+0s', id: 'wait.c794', text: 'Waiting on 3 child tasks · running for 7h 36m', wid: 'c794b783 still running' },
          ],
        },
      ],
    },

    /* ── Scaffold — opening a draft PR right now ── */
    scaffold: {
      taskId: 'a904a91e',
      taskTitle: 'Route user turns through the session-owned chat runner',
      runId: '6b2f5482',
      state: 'running', stateLabel: 'Running', live: true,
      started: '02:31 AM', elapsed: '0m 44s',
      currentStepId: 'create_draft_pr',
      groups: [
        {
          step: { stepId: 'create_workspace', to: 'create_workspace', kind: 'entry', at: '02:31:02.000', rel: '+0s', runtime: '21s' },
          events: [
            { evt: 'a0', type: 'agent', at: '02:31:04.00', rel: '+2s', id: 's0.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Creating the shared worktree the ticket and its children will build in.' },
            { evt: 't0', type: 'tool', kind: 'shell', at: '02:31:06.00', rel: '+4s', cmd: 'git worktree add', em: '.wt/a904a91e -b feat/session-runner', dur: '180ms' },
          ],
        },
        {
          step: { stepId: 'create_draft_pr', to: 'create_draft_pr', kind: 'execute', at: '02:31:23.000', rel: '+21s', runtime: 'running 23s', live: true },
          events: [
            { evt: 'a1', type: 'agent', at: '02:31:25.00', rel: '+23s', id: 's1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Opening a draft PR off `feat/session-runner` so children can stack onto it.' },
            { evt: 't1', type: 'tool', kind: 'shell', status: 'pending', at: '02:31:26.00', rel: '+24s', cmd: 'gh pr create', em: '--draft --base main', summary: 'running…' },
          ],
        },
      ],
    },

    /* ── Ship — watching CI ── */
    ship: {
      taskId: '8156c4fb',
      taskTitle: 'Add end-to-end tests for activity, multi-turn ingress, and restart recovery',
      runId: 'a1f7c220',
      state: 'running', stateLabel: 'Shipping', live: true,
      started: '02:40 AM', elapsed: '3m 12s',
      currentStepId: 'wait_ci',
      groups: [
        {
          step: { stepId: 'mark_ready', to: 'mark_ready', kind: 'execute', at: '02:40:01.000', rel: '+0s', runtime: '14s' },
          events: [
            { evt: 'a0', type: 'agent', at: '02:40:03.00', rel: '+2s', id: 'sh0.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Flipping the draft PR to ready and pushing the final commit.' },
            { evt: 't0', type: 'tool', kind: 'shell', at: '02:40:08.00', rel: '+7s', cmd: 'gh pr ready', em: '4821', summary: 'ready', dur: '420ms' },
          ],
        },
        {
          step: { stepId: 'wait_ci', to: 'wait_ci', kind: 'execute', at: '02:40:15.000', rel: '+14s', runtime: 'running 2m 58s', live: true },
          events: [
            { evt: 'a1', type: 'agent', at: '02:40:16.00', rel: '+15s', id: 'sh1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'Watching CI on PR `#4821`. On green I merge with `--squash --delete-branch`; on red I route back for a fix.' },
            { evt: 't1', type: 'tool', kind: 'shell', status: 'pending', at: '02:40:17.00', rel: '+16s', cmd: 'gh pr checks', em: '4821 --watch', summary: '3 / 5 checks green…' },
          ],
        },
      ],
    },

    /* ── Backlog — triaging a fresh ticket ── */
    backlog: {
      taskId: 'fe0a3c08',
      taskTitle: 'Explore backend chat sessions and app-owned workflows',
      runId: 'd0b9e413',
      state: 'running', stateLabel: 'Default', live: true,
      started: '02:44 AM', elapsed: '0m 12s',
      currentStepId: 'eval',
      groups: [
        {
          step: { stepId: 'inbox', to: 'inbox', kind: 'entry', at: '02:44:00.000', rel: '+0s', runtime: '6s' },
          events: [
            { evt: 'a0', type: 'agent', at: '02:44:01.00', rel: '+1s', id: 'b0.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5',
              prose: 'New ticket in the inbox. Classifying as **epic vs ticket vs task** and setting priority + tags before routing.' },
          ],
        },
        {
          step: { stepId: 'eval', to: 'eval', kind: 'eval', at: '02:44:06.000', rel: '+6s', runtime: 'running 6s', live: true },
          events: [
            { evt: 'a1', type: 'agent', at: '02:44:07.00', rel: '+7s', id: 'b1.codex', speaker: 'Agent · Codex', model: 'claude-sonnet-4.5', streaming: true,
              prose: 'Looks like an **epic** — broad surface across sessions, runners, and ingress. Leaning toward routing to Decomposition rather than straight to' },
          ],
        },
      ],
    },
  };

  window.WFSessions = sessions;
})();
