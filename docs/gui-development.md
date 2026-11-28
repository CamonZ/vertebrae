# GUI Development

The GUI is a Tauri 2 + React 19 desktop application located in `crates/gui/`.

## Quick Start

```bash
cd crates/gui

# Install dependencies (first time only)
npm install

# Start development mode (hot reload enabled)
npm run tauri:dev
```

## Run the native macOS GUI from a worktree

From the checkout, run `DOCKER_CONTEXT=colima scripts/gui-macos.sh start`.
The launcher seeds a private Sacrum and Postgres stack and builds the native
Tauri app in the foreground. The app opens in a macOS window. Use a separate
terminal to run `scripts/gui-macos.sh status` or `scripts/gui-macos.sh logs`,
with the same Docker context. `scripts/gui-macos.sh shell` opens a host shell
in the checkout with the same app home and backend connection.

Quit the app or interrupt the foreground command, then run
`scripts/gui-macos.sh stop` with the same context to remove the backend
containers and keep the database. The launcher stores the app home under
`test-output/macos-gui-home` in that checkout, and Codex's home under
`/tmp/vtb-codex-<key>`, so Claude and Codex sign-ins and history stay apart
from yours. Run provider sign-in commands through the launcher's shell to use
that environment. To reuse your own Claude and Codex logins instead, start with
`scripts/gui-macos.sh start --use-host-logins`. This links your login
Keychain, `~/.claude`, `~/.claude.json` and `~/.local/bin` into the app home
and uses `~/.codex`, so the app's Claude and Codex chats also land in your own
history. The next start without the flag removes those links. The host
development port 1420 must be available.

For Linux GUI acceptance, see
[GUI-managed Docker smoke tests](testing.md#gui-managed-docker-smoke-tests).

### Verify a GUI change on macOS

1. Start the launcher from the assigned worktree and keep its terminal open.
   In another terminal, run `scripts/gui-macos.sh status` with the same
   `DOCKER_CONTEXT`. Wait for Sacrum and Postgres to report healthy and for the
   foreground log to show the worktree's `target/debug/gui` running.
2. On first launch, select **Use an existing backend** in Project Setup and
   continue with the backend preconfigured by the launcher. Choose the worktree
   or a disposable fixture folder, create the project, and enter it. Confirm
   the active project in the sidebar before testing. A new project starts with
   an empty task list. Create any needed fixtures in this test backend.
3. Open the native window and reproduce the ticket's acceptance criteria.
   For a bug fix, exercise the original failure path and its expected result.
   Use computer use when it can target the worktree window. The unbundled
   `tauri dev` process may be missing from its app picker. If so, run the
   interaction manually or report the UI check as pending. Use the process and
   logs to verify startup and backend connectivity.
4. Record the checkout, macOS version, relevant fixture state, steps, expected
   and observed results, and any skipped checks. Keep screenshots or logs
   under `test-output/` when they help demonstrate the result. If a test
   requires a provider, sign in through the launcher's shell and verify a
   completed turn before reporting it as passed.

Run `scripts/validate.sh gui` for the GUI checks and use the existing Linux
acceptance lane for changes that affect its scenarios.
[See GUI testing and acceptance](testing.md#native-macos-gui-verification).

## Available Scripts

```bash
# Development
npm run dev              # Start Vite dev server only (port 1420)
npm run tauri:dev        # Start Tauri + Vite with hot reload

# Building
npm run build            # Build frontend (TypeScript + Vite)
npm run tauri:build      # Build production Tauri app
npm run package          # Build sidecars, stage them, then build the GUI bundle
npm run package:debug    # Same flow with debug sidecars and a debug GUI bundle

# Testing
npm run test             # Run tests once
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report

# Code Quality
npm run lint             # Run ESLint
npm run format           # Format with Prettier

# Utilities
npm run tauri            # Run any Tauri CLI command
npm run generate:types   # Generate TypeScript types from Rust
```

## Development Workflow

1. Run `npm run tauri:dev` to start the development environment
2. Edit React components in `src/` — changes hot reload automatically
3. Edit Rust backend in `src-tauri/src/` — Tauri rebuilds automatically
4. Run `npm run generate:types` after changing Rust command signatures

### Keyboard focus in composers

Text inputs the user writes into (the chat composer, diff comment and inline
discussion composers) carry `focusKeepProps` and use `useKeepFocus`. They keep
focus until a pointer press, Tab, Escape or a shortcut moves it. A loss to
nothing (including WebKit's silent loss when a diff re-renders the slot an
annotation is projected into) is restored with the selection. When a focused
input unmounts, focus goes to its pane's composer. The composer textarea is
never disabled: an unusable composer blocks submitting, not typing, and its
draft lives in `composerDraftStore` so remounts keep it.

Only user actions focus a composer. Store actions that open or show a chat
raise `composerFocusRevision`; the active pane's composer takes it once.

Dev builds install a focus tracer (`src/utils/focusTrace.ts`). A composer
losing focus without a user action logs a `[FOCUS_TRACE]` warning with the
preceding `focus()` stack and chat-store change, and shows a badge;
⌃⌥⇧F (or clicking the badge) copies the trace as JSON.

### Review galleries

Two review galleries are registered in every build. Their sidebar icons stay
hidden until you press ⌃⌥⌘⇧G, which toggles them for the session:

- **Machine parts gallery**: `/galleries/machine-parts`
  (`src/pages/MachinePartsGalleryPage.tsx`).
- **Thinking lines gallery**: `/galleries/thinking-lines`
  (`src/pages/ThinkingLinesGalleryPage.tsx`) shows the chat thinking-line
  shaders (Shimmer, Uplink, Assembler) with the renderer's frame rate.

The flow player (`/dev/flows`) stays dev-build only.

#### Machine parts gallery

The page shows every machine-diagram catalogue part. Each part gets one row
per change mark (unchanged, added, changed, removed). The columns are the
part's scenarios, shown at their still frame, followed by the five universal
states (idle, working, ok, failed, absent). The toolbar can:

- switch the app theme (dark, light or system);
- hide labels, which shows the silhouette view;
- filter by part or by change mark;
- switch between playing the scenario timelines (the default) and showing
  still frames. With reduced motion on, the page starts on still frames.

Use it to check a part by eye in both themes. The unit tests can't do this,
because jsdom doesn't apply the theme CSS.

A component ticket that adds a catalogue part should:

1. Add the part's drawing and scenarios as a `MachinePartDef` in
   `src/components/MachineDiagram/parts/<name>.tsx`, and list it in
   `MACHINE_PARTS` in `parts/index.tsx`. The gallery page picks up every part
   in `MACHINE_PARTS` without further changes.
2. Register the flow-spec kind with the same name in
   `src/components/MachineDiagram/flow/parts/`, and add it to `STARTER_PARTS`.
3. Add the part's frames to `__fixtures__/galleryParity.json`. Generate them
   from the gallery reference, not by hand. `galleryUniversalStates.json`
   already covers every catalogue part. `parts/parts.test.tsx` checks the part
   against these frames, and also checks palette-only colours, text size,
   the labels-off silhouette, and that the registry matches the drawing.

The flow registry contains validation and compilation specs only. Keep shared
geometry and protocol state in plain `.ts` modules (for example,
`partGeometry.ts`, `parts/distributedGeometry.ts` and `parts/*Spec.ts`), so the
CLI validator never imports a drawing. `flow/drawings.ts` joins part kinds to
GUI drawings through `FLOW_DRAWINGS`; `flow/attachmentRenderers.tsx` joins
evidence kinds to renderers through `attachmentRenderers`. Custom kinds register
their schemas with `FlowRegistryContext` and provide their GUI tables separately
with `FlowDrawingsContext` or `AttachmentRenderersContext`, including the built-in
table when extending it. Missing drawings use the frame fallback; missing
evidence renderers show a diagnostic.

After changing the spec language, run `npm run build:flow-validator` in
`crates/gui` and include the regenerated `crates/cli/assets/flow-validator.js`.
The bundle freshness test checks the complete dependency graph for presentation
imports. Drawing-only changes do not require rebuilding this committed asset;
Cargo continues to build the CLI without npm.

## Frontend Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | v19 | UI library |
| React Router | v7 | Routing |
| Zustand | v5 | State management |
| Tailwind CSS | v4 | Styling (custom neural-pathways theme) |
| XYFlow React | v12 | Graph visualization |
| Vite | v6 | Build tooling |
| Vitest | v4 | Test runner |
| Specta | v2 | Type-safe Rust-to-TypeScript bindings |

## Tauri Backend

The Rust backend in `src-tauri/src/` provides:

- **~34 Tauri commands** (`commands.rs`) — each acquires `RwLock<Option<VertebraeServices>>`, calls service method, converts to GUI type
- **WebSocket client** (`websocket_client.rs`) — Phoenix channel for real-time sync
- **Local chat harness manager** (`local_chat/`) — shared Claude/Codex runtime
  adapters and normalized live event delivery
- **Project config** (`project_config.rs`) — multi-project management

### Shared configuration forms

Settings includes Providers & Models, Connection and Observability forms for
this machine's `config.toml`, alongside existing Chat, Appearance and Updates.
Project creation remains in its dedicated UI. `daemon.toml` and daemon lifecycle
management are outside these forms.

File-backed forms keep drafts until Save or Discard, validate inputs, and protect
unsaved navigation. Reads return credential-presence flags and environment
variable names, never stored keys or environment values. Credential changes use
explicit keep/replace/clear operations. Provider API-key fields additionally
support moving an existing inline key to the OS credential store. New provider
API keys default to OS storage; `api_key_secret` references are persisted instead
of plaintext. Keychain/Secret Service reads and writes run on blocking workers,
and settings reads return the configured storage source without reading keys.
Locked/missing stores fail explicitly. Environment override indicators describe
the GUI process, not a remote daemon's environment. Endpoint URLs containing
credentials, query parameters or fragments are hidden rather than exposed.

Saved provider profiles, endpoints, models and API keys apply to new local
chat/title requests and daemon executions without restart. A confirmed GUI save
refreshes provider pickers for not-yet-started sessions; active sessions retain
their catalog and owned runtime configuration. Each new request reads a coherent
file snapshot and resolves its selected credential while holding a shared config
lock, so replacement cannot delete an old entry midway through request capture.
Malformed/unreadable config fails new requests and catalogs explicitly, while
existing sessions continue; fixing the file permits recovery on the next request.

Backend connection and telemetry settings still require a GUI restart. Binary,
skill and shell-environment discovery also stay startup-scoped. Saving never
restarts a process or replaces an active chat runtime. The daemon refreshes
custom-provider readiness advertisements on its existing 30-second heartbeat.

The shared configuration writer preserves unknown keys and existing comments
when patching known settings, atomically replaces the file with private Unix
permissions, and coordinates application writers through an advisory lock and
loaded-file revisions. Stale writes require reload and reconciliation. This
assumes the user configuration directory is trusted. External editors do not
participate in the lock: edits are checked before activation, but an editor can
still race the final filesystem replacement. Atomic visibility is provided;
power-loss durability of the directory entry is not guaranteed.

### Inline discussion model selection

Settings → Diffs & code editor → Inline discussions follows the main conversation by default.
The Diffs & code editor section groups code themes, diff presentation, file-link
editor selection and inline discussions; Appearance retains the application theme.
A dedicated configured provider/model can be saved independently of main chat
settings, along with the reasoning effort and speed tier supported by that
provider's harness and selected model. Selecting Custom model reveals provider,
model, effort and speed together on a second row below Answer using. Dedicated
personality/output-style preferences are discarded; follow mode continues to
inherit the main conversation's style. Options use the shared
catalog helpers. Model changes clear incompatible optional choices; stale saved
choices block requests. Follow mode inherits the main conversation's model options.
The permission policy stays read only and is not an editable model option.
Native Claude request options are normalized by the adapter: effort values use
its supported allowlist and output-style identifiers retain their case. Inline
style, speed and hook restrictions share one JSON settings argument. This
does not change the CLI workflow-step reasoning-effort policy. The comment
dialog and anchored thread omit routine provider/model labels;
an inherited unset model is resolved from the catalog default and sent explicitly.
User questions appear in right-aligned themed bubbles; assistant replies retain
left-aligned Markdown. Each pending turn shows the shared thinking indicator
using the Appearance preference, including asynchronous setup and follow-ups,
until response text arrives or the request terminates. Unavailable providers,
stale models and invalid saved choices
block discussion requests with recovery instructions rather than switching
providers. Provider catalogs refresh after a confirmed provider settings save.

Each question captures its provider/model before asynchronous runtime setup.
Changing settings leaves an outstanding reply on its captured runtime; the next
question, including a follow-up in the same thread, uses the new setting with
the original code snapshot and conversation history. Inline requests retain the
native read-only policy and the mounted session/worktree's lifetime.

### Workflow step harness selection

The Workflow Atlas authoring form (`WorkflowInspector.tsx`) sets a step's
optional `harness` when creating it. `StepInspector.tsx` edits the same field
and displays the stored choice, or `Sacrum default` when it is unset. The
selector values are the generated `StepHarness` contract: `claude`, `codex`,
and `typesafe`. Model and request settings remain separate step configuration.

### Session directives

`StepInspector.tsx` displays session directives without editing them
(`inspector/routeSessions.ts`). Route decisions carry theirs in the opaque
`route_config`; other steps' transitions carry theirs in the pipeline
summary's `transition_sessions`, keyed by destination step id. A route step
lists each rule and the default with its target and session mode
(`new (implicit)` when the decision has no directive). Every other step tags
each transition that carries a directive with its mode, plus the continued
step when it is not the destination. An `llm_inference` step shows a
Conversation section: the route decisions and transitions that enter it, and
those that resume or fork its conversation into another step, including an
`inter_workflow` decision (named by its destination workflow) and a
`wait_children` step whose children fork it (`fork → children`). A
`wait_children` step shows a Children Session section with its fork source. The
workflow's route and `wait_children` steps are loaded with `useSteps`, which
shares `useStep`'s per-step query cache so realtime step updates reach both.

The Atlas Graph has one renderer: the shared machine-flow path
(`adapter/buildMachineFlow.ts` → `useLaidOutFlow` worker/cache →
`AtlasMachineScene`), hosted by `ScopedMachineGraph.tsx` for a factory scope and
by the zoom-expanded `FactoryOverview.tsx` without one. The legacy ELK Graph
(`layoutFull`, `StepNodeGeo`, the Map⇄Graph morph) and its
`VITE_ATLAS_MACHINE_GRAPH` rollback toggle are gone; `WfBox` now draws only Map
cards and factory nodes. `adapter/README.md` documents the adapter, its
structural key and the presentation boundary.

`WorkflowAtlas.tsx` loads the scoped route steps with `useSteps` and passes
their `route_config`s to both the Graph adapter and `buildAtlasModel`. In the
Graph each route decision keeps its own port and rail, labelled with its
session directive; other steps' transitions carry `<mode>` or
`<mode> · <step>` labels. Directives are part of the adapter's structural key,
so a directive change re-lays out the Graph. On the Map, aggregated handoffs
carry condition chips, and route labels are part of `layoutKey`.

Sacrum's `step_transition_created`, `step_transition_updated` and
`step_transition_deleted` events carry the full edge, including its label and
session directive, so the summary reducer and the per-step `steps.byId` cache
apply them without a refetch. Step events carry no outgoing edges
(`StepChangedEvent.includes_transitions` is false for realtime payloads), so
they never replace the cached `transitions_to` / `transition_sessions`; edges
change only through transition events. The StepInspector sends
`transitions_to` only when the user edited it, because `update_step` replaces
the whole outgoing set.

`usePipelineSummarySync` (mounted in `GlobalListeners`) applies realtime
events to the cached summary even while no Atlas surface is mounted; the
summary is cached with an infinite stale time, so returning to the Atlas would
otherwise show it as it was when the Atlas was left. A summary fetch that
overlaps an event which changed the cache is retried, at most
`MAX_SUMMARY_FETCH_ATTEMPTS` times.

Hovering on the Atlas is a quiet trace. In the Graph (`useAtlasPresentation`)
hovering or focusing a workflow, step or rail lights it, its incident rails
and their other ends, and dims the rest; the Connections panel lists the
traced rails by direction. On the Map, hovering a workflow card lights its
handoffs in their in/out colour (white entering, accent leaving) and dims
unconnected cards; the board carries the mode as `trace-wf`. In both views
hovering an inspector transition row emphasises that single edge at full
contrast.

The Kanban board is the Atlas's third view (Map | Graph | Board), not a page of
its own. It is offered only while a factory scope is selected, because its
columns come from the scoped workflows' `kanban_column` values, the same values
the map uses as phases. `KanbanBoard` takes the scope from the Atlas factory
filter and replaces the pan/zoom canvas; clearing the factory returns to the
factory overview in Map view.

After changing the Rust Tauri types, regenerate bindings with
`npm run generate:types` and keep `src/bindings.ts` limited to the reviewed
contract changes.

### Run history in local chat history

The maximized chat sidebar lists the current project's TaskRuns from one
project-scoped, paginated query (`getTaskRunHistory`, Sacrum's
`projectRunHistory`), cached under `queryKeys.taskRunHistory` per project
generation, completed filter and debounced search. The initial load is one
request whatever the project's task count, and collapsing and expanding chat
reuses the cached pages (kept 30 minutes after the sidebar unmounts). **Load
older runs** fetches the next page from the cursor captured with the previous
page. `task_run_changed` events update, add or (under the completed filter)
drop cached entries; a run whose task no cache knows reloads that list, and a
websocket reconnect reloads loaded pages. The live task list overrides page task
titles, completion and archival between fetches. This cache is separate from
the per-task `taskRuns.byTask` entries, which task-list hydration seeds with
only the active run, so those partial snapshots never stand in for history.

The task list's current active-run projection also supplements the loaded
history pages. This keeps an open epic, ticket or task's active run available
even when more recently updated history pushes it past the first page, or the
history request fails. Matching run IDs are deduplicated by update time; newer
history snapshots win over stale active projections. Search, completion,
archival and project scoping apply to both sources. History loading and errors
are announced inline, with an explicit read-only retry on failure; existing
rows remain available during recovery.

### Completed conversations in local chat history

The maximized chat sidebar hides conversations associated with a ticket or task
whose canonical `completed_at` is set. General chats and conversations whose task
metadata has never been available remain visible. **Show completed** restores
these rows with a completion check icon beside their association icons; its preference lasts for the mounted sidebar.
Search and keyboard navigation operate on the visible rows, and empty ticket
groups disappear. A filtered-empty view offers Show completed.

Completion changes only history visibility: an open conversation remains mounted
and a running conversation continues. Explicitly revealing a conversation enables
Show completed and expands its ticket group. Current-project completion changes
follow the shared task cache's realtime updates. Existing project-scoped task
lists and details supply completion immediately; only missing associations need
individual task reads. While the current project is selected, the mounted sidebar
retains the newest observed metadata through source-query garbage collection and
refresh failures. Successful canonical updates, including reopening, replace older
metadata by `updated_at` (with fetch time breaking ties). Navigation to another
project or a project-generation reset retires this retained snapshot.
List summaries are not inserted into full-detail cache
entries. Other saved projects use
separate project/generation-scoped completion queries, refresh on revisit, and
poll every 30 seconds while selected. Pending or failed background refreshes keep
the last successful metadata; a first-ever failed read leaves the chat visible.
Foreign projects poll because their project channels are not
subscribed. These reads use task UUIDs without switching the backend project.
Unknown-project chats stay visible without fetching task metadata.

### Local Chat Harnesses (`src-tauri/src/local_chat/`)

Local chat owns session lifecycle and UI options; it owns no provider wire
protocol. The composer picker is provider → model: the built-in Anthropic and
OpenAI choices run on the `claude` and `codex` harnesses, and each
`[providers.<id>]` entry on those harnesses (read from config.toml for new sessions) is an extra choice whose model list is exactly its configured
`models`. `LocalChatHarnessCatalog.providers` carries these choices, the
session stores `providerId`, `create_local_chat_session` and title inference
receive `provider_id`, and saved chat defaults are keyed by provider. Both providers are built through the shared `HarnessRuntimeFactory`
from `vertebrae-harness` (see
[Architecture — Harness Crates](architecture.md#harness-crates)), so
`src-tauri` depends on `vertebrae-harness` and `vertebrae-harness-core` and
never on the adapter crates directly.

| Module | Responsibility |
|--------|----------------|
| `harness.rs` | `LocalChatHarness` trait, catalog, model/reasoning options |
| `harnesses/claude/` | Claude startup capabilities, model catalog, session creation |
| `harnesses/codex/` | Codex model catalog and session creation |
| `harnesses/shared.rs` | `LocalChatHarnessEventSink` — translates `HarnessEventV1` into local-chat events; `LocalChatControlSink` for approvals |
| `permissions.rs` | Permission-mode translation and the `vtb-gate` prompt bridge |
| `gate.rs` | `LocalChatGateBinding`, the hidden gate protocol instructions (draft or whole-artifact), and the bound `vtb gate` / `vtb artifact add` command check |
| `manager.rs` | Session registry and pane/session bookkeeping |

#### Conversation speed-tier restoration

An explicit fast/default `selectedSpeedTier` is authoritative. Missing and null
mean “current tier” (Rust's optional field normalizes missing to null). Without
an explicit tier, replay and live session-init
metadata recover the normalized requested tier, or the provider-reported active
tier when requested intent is absent. Recovery never overwrites a selection
made while replay is pending. Provider defaults apply only to empty new chats;
existing conversations do not inherit a changed global speed default.

For an unknown local tier, replay searches older pages for the latest known
root-conversation setting without adding those messages to the visible window.
This can require reading the full history for legacy conversations. The composer
waits for initial recovery before resuming with an unknown tier. Recovered
settings are persisted and used for the next resume and outgoing turn.

Codex maps app-server `serviceTier` and rollout `thread_settings_applied`
(`thread_settings.service_tier`) / `session_configured` metadata: `priority`
means fast, and `default` means default. These are requested configuration, not
confirmation of the tier serving a turn. Copied settings with a different
`thread_id` are ignored. Old `turn_context` records carry no service tier.
Claude recovers a reported `fast_mode_state`: on means fast, off/cooldown means
default; a separately known fast request survives temporary fallback. Missing
or unsupported metadata remains unknown. Neither adapter infers a confirmed
tier from model capability or request settings alone. Historical provider files
that never recorded a tier cannot reconstruct it.

#### Built-in local-chat model menus

`vertebrae_harness::curate_local_chat_models` owns picker selection policy:
Anthropic Fable, Opus, Sonnet, Haiku; OpenAI Astra, Sol, Terra, Luna. Each
family contributes its newest numeric version, with family rank taking priority
over version. Aliases and unranked families are absent from new choices.
Equal versions prefer an undated ID, then the newest dated snapshot; lexical
ID and serialized capability metadata break remaining ties deterministically.
Capabilities stay attached to the selected row and are never merged.

Claude IDs, labels and capabilities come from the shared adapter's
`DEFAULT_CLAUDE_MODELS` and `builtin_claude_model_capabilities`. Add confirmed
IDs there, update model-specific capability rules with provider evidence, then
run the harness and GUI catalog regressions. Do not add another GUI model list.
Fable 5.2's `claude-fable-5-2` ID, fast-mode capability and 1M context window
were verified against Claude Code 2.1.322 metadata on 2026-11-12; a live
first-party response confirmed that exact ID and window. Catalog presence
still depends on the existing CLI readiness check; account-specific rejection
is reported by the provider when a request runs.

Codex keeps the raw app-server discovery catalog (all pages, hidden models
excluded) or bundled fallback, then applies the same menu policy at the
local-chat projection. IDs and capabilities remain provider-supplied. Codex
0.167.2's live `model/list` and bundled catalogs both contain `gpt-6-astra`, `gpt-6.1-sol`,
`gpt-6.1-terra`, and `gpt-6-luna`. The `default` sentinel remains a no-override
choice; the composer displays it once through its default/current-model row.

Picker filtering never removes legacy execution support or changes active or
resumable conversation IDs/history. An obsolete saved default for a new chat
stays visibly unsupported and requires choosing an available model or resetting
to the default; it cannot silently switch families. Settings and dedicated
inline discussions likewise show stale choices and request recovery. Custom
providers bypass built-in curation and retain their configured model IDs/order.

#### Gate chats

The **Resolve** action on a waiting `human_input` gate opens a local chat
bound to the gate's run and step (`ChatSession.gate`, persisted in the chat
index), so Resolve reopens the same chat. A new gate chat passes
`CreateLocalChatSessionInput.gate`; `session_developer_instructions()` appends
the gate protocol, built from the waiting execution's rendered config, after
`chat_developer_instructions()`, and each harness maps the result into its
native additive instruction mechanism. The chat opens with a hidden turn so the
agent speaks first; turns wrapped as hidden never appear in the thread. The
manager binds the gate in the `PermissionBridge`, which approves exactly the
bound `vtb artifact add` submission without a prompt on both the Claude socket
and harness control paths; every other command still asks.

`useGateChatSync` (mounted in `GlobalListeners`) keeps open gate chats in step
with their runs. A TaskRun or StepExecution update for a bound run re-reads
its trace, and `deriveGateChatStatus()` sets the runtime `gateStatus` phase
shown above the thread: drafting, rejected (attempt n), under review, accepted
once a route after the submission moves the run to another step, and closed
when the run stops, fails or finishes. When the review loops back, the run
waits at the gate with a new execution; `refreshGateChat()` sends a live chat
`refresh_gate` as its own turn once the chat is idle. The canonical binding
carries the revision (attempt and the new execution's handoff as the verdict),
so the hidden turn opens with `[Vertebrae evaluation]` and the agent explains
the rejection. `refresh_gate` sends nothing when the chat is already bound to
that execution, which makes duplicate updates inject one turn. A chat with no
running session is rebound in place and gets the verdict in its developer
instructions when it resumes; a chat whose gate no longer waits resumes
unbound.

A draftable gate (Sacrum's `HumanInputStepConfig.draftable`) is resolved
through its durable draft. The canonical binding carries `draftable`, the
waiting execution's draft and the schema `fields`; the protocol records answers
with `vtb gate set|show|submit`, which the bridge approves for the bound
execution instead of `vtb artifact add`. `useHumanInputDraft()` reads the draft
keyed by the execution's realtime `draft_updated_at`, so every draft change
re-reads Sacrum's missing/invalid/complete report rather than deriving it.
`GateDraftProgress` shows each field under the status bar. `useGateSteering()`
counts the user's completed turns since the draft last changed, the gate was
re-entered, or the user chose Keep going; past the Settings thresholds (`uiStore`
`gateSteeringThresholds`, default 3/6/9) it sends one hidden `[Vertebrae
steering]` turn per stall, then `GateSteering` renders the remaining fields as
a `GateAnswerForm` (recorded with `setHumanInputDraft`, then reported in a
hidden `[Vertebrae form]` turn) and finally a Keep going / Stop this run card.
`HumanInputGate` offers the same form as Answer directly. Forms retain dirty
edits across draft refreshes; untouched fields follow the durable values. An
edited chat form stays open until recorded, Keep going is chosen, or its waiting execution changes.
Submission cards use the snapshot returned by `vtb --json gate submit`, rather
than reconstructing answers from chat commands; older results without that
snapshot remain ordinary tool output. When Resolve finds
the bound chat's session gone, `resolveGateInChat()` detaches that chat and
starts a new one whose protocol includes the current draft.

### Opt-in OpenTelemetry collection

The GUI reads telemetry settings from `[observability]` in the shared
`config.toml` file at startup. Exporters remain off by default. When the local
SigNoz OTLP HTTP NodePort (`30418`) is reachable from the host at `localhost`,
add:

```toml
[observability]
enabled = true
endpoint = "http://localhost:30418"
protocol = "http/protobuf"
signals = ["traces", "metrics", "logs"]
subsystems = ["local_chat", "claude_code"]
level = "info"
capture_message_content = true
```

`protocol` can also be `grpc` (the local cluster exposes it on NodePort
`30417`, or a standard collector listener uses port `4317`). HTTP/protobuf uses
the configured base endpoint and sends each signal to its OTLP path. `signals`
accepts `traces`, `metrics`, and `logs`;
`subsystems` accepts `local_chat` and `claude_code` for the current
instrumentation. Restart the GUI after changing this file. Message bodies are
off by default. Setting `capture_message_content = true` includes message text
in traces, capped at 32 KiB for each human input message and cumulatively across
each assistant turn; set it to `false` to retain message metadata without text.

Live Claude input events and human messages reconstructed from JSONL transcript
pages include session, thread, turn, source sequence, timestamp, and origin
attributes. The `local_chat.send_message` span records whether Claude accepted
the write and the terminal turn outcome. Each live Claude text delta is added
to that span as a `local_chat.inference_delta` event, correlated by `turn.id`.
Delta events carry the normalized event and stream IDs, event and provider
sequence numbers, timestamp, session/thread/turn/run IDs, message item ID,
tool-call and parent-tool-call IDs, and provider resume ID when available. With
content capture enabled, `message.delta` contains the delta text until the
32 KiB per-turn cap is reached; afterward the event retains its metadata and
marks content as truncated. A turn records at most 2,048 delta events;
`inference.delta_count` and `inference.delta_events_dropped` on the send span
make the count and any cap visible. Reasoning deltas are not captured as chat
text. The message event counter uses only fixed origin and outcome labels.

Adding a provider therefore means adding a `harnesses/<provider>/` module that
supplies the model catalog and session creation. Event translation stays in
`harnesses/shared.rs` because it works on the neutral `HarnessEventV1` stream.

The manager's session registry is authoritative live ownership and is
intentionally transient. `close_all_sessions()` is awaited before a project
switch and during Tauri exit; it interrupts active turns, fails pending
permission controls, closes provider transports, and delegates bounded
process-tree reaping to the provider harnesses. Registry entries are dropped
once close is initiated, including when a close times out or fails, so a later
create for the same conversation id is not blocked by a ghost owner. Project
switches do not delete chat history or provider resume IDs, so the next
project-scoped view can start a fresh provider session and resume durable
conversation state when supported.

Codex chat sessions run as threads on Codex's machine-wide managed App Server
daemon (`codex app-server daemon`), shared with the `vtb-daemon` and the
user's own Codex clients. Each live GUI session holds its own connection, so
the harness contract keeps one lossless notification receiver, one
root-thread identity, and one session-specific event/control sink per
connection; closing a session interrupts its active turn and sends
`thread/unsubscribe` rather than terminating a process. The GUI never stops
or restarts the daemon.

The GUI and daemon have separate lifecycles. GUI exit and project switching
close only the GUI's registered local-chat harnesses; they must not stop the
installed `vtb-daemon`. Daemon-owned Codex/Claude cleanup is performed by the
daemon when its own step, project, or process lifecycle ends.

### Chat event delivery and replay

Live chat and trace replay share one normalized stream:

- **Live** — the harness event sink emits `LocalChatEvent`s over Tauri; the
  frontend reduces them in `src/stores/chatStore.ts` and `src/hooks/useLocalChat.ts`
- **Replay** — `SessionLog` rows with `format=harness` are projected by
  `src/types/conversation.ts` (`parseSessionLogs`) through the canonical
  harness projection, producing the same events the live trace showed. Local-
  chat transcript replay is requested through the neutral Tauri command and is
  discovered/parsed by the provider harness crate; the frontend receives only
  serialized `HarnessEventV1` records.

### Realtime session-log pacing contract

Live session-log notifications are a UI delivery contract, not the durable
record. The websocket continues to deliver individual `SessionLog` records;
the frontend queues them in the session-log store and applies them in ordered,
bounded batches. Created records append, updated records upsert by `id` or
`logical_key`, and the record's existing ID, execution ID, content, format,
and timestamps are not rewritten. Reconnects may replay records, so idempotent
reconciliation is required. A complete historical result still comes from
`getExecutionLogs`/`getTaskRunTrace`; live state is merged with that durable
baseline.

The frontend delivery policy is:

| Measure | Budget / policy |
| --- | --- |
| Store flush cadence | One scheduled animation frame, with a 50 ms timer fallback when frames are unavailable or delayed |
| Records per store application | 256 maximum |
| Pending records | Records are retained and drained in successive bounded batches; there is no synchronous drain-all or automatic overflow refetch |
| Recovery | The durable baseline is refreshed only by the owning trace hook's explicit refetch path; project reset cancels and drops pending work, while reconnect does not synchronously drain it |

The session-log store owns the pending buffer and scheduling. A burst may
therefore take several frames to catch up, but each store application remains
bounded and unrelated execution buckets keep their existing references. There
is no production performance monitor or per-event correlation allocation in
this path.

### Codex local chat commands

In an idle Codex local chat, submit standalone `/compact` to compact the current
thread without clearing its transcript, or `/clear` to open a fresh conversation
in the same pane. The old conversation remains in history and can be resumed.
The fresh conversation keeps the project and selected provider/model settings.
Commands are unavailable while work or a question is pending; ordinary sends are
blocked during manual compaction. Compaction completion follows the provider's
compaction item and terminal turn, not just its RPC acknowledgement. A failed
compaction releases the live session; the next prompt can resume its saved thread.

Only exact commands (with optional surrounding whitespace) are recognized in
Codex chat. Arguments, autocomplete, custom prompts and commands in other
harnesses are outside this implementation; other input retains normal chat behavior.

### Background activity in local chat

Provider-native background commands are normalized by the adapters into
`background_work` updates and, where the provider has one, `background_roster`
snapshots (`vertebrae-harness-core` `background.rs` defines the contract; the
chat store's `stores/backgroundWork.ts` is the only projection). Subagents are not background work: they already appear
with their threads in the threads panel. While a session has background work,
the chat header shows a **Background tasks** toggle with the count of confirmed
running commands. It opens a side panel in the same slot as Changes and
Evidence, so opening one closes the others. The panel lists each command's
description, latest provider progress and elapsed time when the provider
reports a start. Terminal outcomes (completed, failed, cancelled, or ended
without a reported outcome) become timeline rows. Background work never keeps
the foreground reply streaming or blocks composition.

The state is runtime-only. Replay never claims work is running now, and a lost
or replaced backend connection marks earlier work *unconfirmed* rather than
finished. No percentage, ETA or heartbeat is synthesized.

Provider coverage: Claude reports `task_started`, `task_updated`,
`task_notification` and `background_tasks_changed` for `local_bash` and
`monitor` tasks; agent tasks are ignored. Codex App Server reports a
backgrounded command as a `commandExecution` item that is still open when the
turn completes; its `item/completed` carries the exit code and usually arrives
between turns, so a Codex session keeps reading notifications while idle.
Codex reports no progress for these commands.

### Claude compaction lifecycle

Claude context compaction is exposed as lifecycle state, not as transcript
content. A `status=compacting` record starts a session-scoped indeterminate
indicator labeled **“Compacting conversation…”**. The UI does not display a
percentage because Claude supplies status boundaries rather than reliable
progress measurements.

The `compact_boundary` event ends the indicator and retains its optional
metadata in the ephemeral session summary: the trigger (`manual` or `auto`)
and the pre-compaction token count. Local chat displays that summary as, for
example, “Conversation compacted (auto) · 4,096 tokens before compaction”.
The next provider usage event supplies the refreshed context-meter value.
Malformed or unrelated system records are ignored, and compact-summary user
records remain excluded from the transcript. Session end, cancellation, and
error paths clear both the active indicator and its completion summary.

## First-Run Installer

On first launch the GUI offers to install Vertebrae's command-line tools so
users can drive workflows from the terminal and run them in the background.
The flow is driven by Tauri commands in `src-tauri/src/install.rs`, which are
thin adapters over the shared [`vertebrae-installer`](../crates/installer)
crate. The GUI is the supported owner of daemon installation, so all installer
UI and lifecycle changes should be made through this flow.

### Welcome / consent screen

`src/pages/WelcomeInstallPage.tsx` renders the consent screen at `/welcome`.
It:

- Calls `installation_status` to pre-check the boxes and show each
  component's symlink target path.
- Offers three components — **vtb CLI**, **vtb-daemon** (background workflow
  runner), and **vtb-gate** (Claude permission bridge) — each as an opt-out
  checkbox. A component already installed at our symlink path and current with
  the bundled sidecar is shown as "already installed" and its checkbox is
  disabled; a managed component whose staged binary differs from the bundled
  sidecar stays checked and is tagged "update available"; a component found
  elsewhere on `$PATH` is tagged "found on PATH".
- **Install** calls
  `install_components(install_cli, install_daemon, install_gate)`, which stages
  the chosen sidecars and (if the daemon was selected) registers the daemon
  service. The user then proceeds to `/setup` (or `/` if a project was already
  selected).
- **Cancel** calls `quit_application`, which exits the app. Installation is
  required to continue — there is no "skip and install later".

### What gets installed

| Component | Purpose | Service registered? |
|-----------|---------|---------------------|
| `vtb` | CLI for managing tasks and workflows | No |
| `vtb-daemon` | Background workflow runner that executes agents | Yes — launchd (macOS) / systemd `--user` (Linux) |
| `vtb-gate` | Claude MCP permission prompt bridge for GUI chat sessions | No |

Each binary is copied into a per-OS data dir, set to `0o755`, and symlinked
into `~/.local/bin`. Installing the daemon additionally writes a service
definition and loads it so it starts at login. See
[Install Locations](#install-locations) below.

### Sidecar bundling

`vtb`, `vtb-daemon`, and `vtb-gate` ship inside the GUI bundle as Tauri
`externalBin` sidecars (declared in `src-tauri/tauri.conf.json`). The supported
packaging entry point is the root wrapper:

```bash
scripts/build-package.sh --release
scripts/build-package.sh --debug
```

From `crates/gui`, the equivalent npm affordances are:

```bash
npm run package
npm run package:debug
```

The wrapper builds and stages the sidecars first, then invokes the Tauri bundle
build. On macOS it defaults to `--bundles app` so the repeatable path produces a
runnable `.app` without requiring DMG tooling; set `TAURI_BUNDLES` or pass
`--bundles` to request another Tauri bundle format. For `--bundles dmg`, the
wrapper first uses Tauri's normal DMG path; if create-dmg fails during Finder
window customization, it retries with Finder customization skipped. Sidecar
staging itself is centralized in `scripts/prepare-sidecars.mjs`,
which remains wired into Tauri's `beforeDevCommand` and `beforeBuildCommand` so
direct `npm run tauri:dev` and `npm run tauri:build` commands continue to work:

```json
"beforeBuildCommand": "npm run tauri:prepare-sidecars && npm run build"
```

The wrapper's local bundle build uses `src-tauri/tauri.local.conf.json` to skip
updater artifact generation and, on macOS, passes Tauri's `--no-sign` option.
This keeps local packaging independent of release signing credentials. The
release workflow invokes Tauri directly with the production configuration and
continues to create signed updater artifacts.

`prepare-sidecars.mjs` (run via `npm run tauri:prepare-sidecars`):

1. Detects the build target triple (honoring `TAURI_ENV_TARGET_TRIPLE`, else
   parsing `rustc -vV`). Supported triples: `aarch64-apple-darwin`,
   `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`,
   `x86_64-unknown-linux-gnu`.
2. Removes staged sidecars for the other supported target triples so stale
   non-host binaries cannot be bundled accidentally.
3. Runs `cargo build --release -p vertebrae-cli -p vertebrae-daemon -p vtb-gate`
   by default, or a debug build when `SIDECAR_PROFILE=debug`, `--debug`, or
   `--profile debug` is used.
4. Copies the profile's binaries to
   `src-tauri/binaries/<bin>-<target-triple>` — the naming Tauri's
   `externalBin` expects.

It is idempotent per profile: if the staged profile marker matches the
requested profile and the staged copies are at least as new as the source
binaries in `target/<profile>/`, the rebuild and copy are skipped. Switching
between debug and release forces a restage so bundles do not accidentally reuse
sidecars from the other profile.

At bundle time `tauri-build` copies each staged sidecar next to the GUI
executable, stripping the `-<triple>` suffix. At runtime
`install_components` resolves them relative to the GUI executable using the
target triple baked in at build time, then hands them to
`vertebrae_installer::install_binary`.

Bare Rust builds and tests are intentionally separate from GUI bundling.
`cargo build` uses the workspace's default members, which exclude the Tauri GUI
crate. `cargo test --workspace --exclude acceptance --exclude gui-acceptance
--exclude daemon-acceptance` still compiles the GUI crate, but `build.rs`
removes `externalBin` from Tauri's build configuration unless
`VERTEBRAE_BUNDLE_SIDECARS=1` is set by the npm/Tauri packaging scripts.

### When the welcome screen is shown

`InstallationGuard` in `src/router.tsx` decides on mount. It calls
`installation_status` and redirects to `/welcome` when any required component
is missing:

```
!component.installed_at_symlink && !component.on_path
```

In words: a component is missing only when it is neither installed at the
symlink path we manage nor resolvable anywhere on `$PATH`. If the status probe
fails, the guard intentionally falls through to its children rather than
blocking an already-working install. `InstallationGuard` sits above
`ProjectGuard`, so the welcome screen comes before `/setup`.

### Fresh local backend setup

Fresh Docker and Podman installations resolve the latest published backend
from the `backend-master/latest.json` release manifest before provisioning.
The resolved image digest and release metadata are saved with the installation.
If the manifest cannot be fetched or validated, setup reports the error rather
than using a bundled older image. Reopening an existing installation uses its
saved image; backend updates remain available through Settings.

### GUI update availability

The GUI checks its signed Tauri updater manifest immediately after startup and
then every 15 minutes while the GUI is running. Checks are single-flight and
read-only; a transient failure leaves the last successful availability result
and Settings badge intact. A newer GUI version adds one application-panel
notification per channel/release identity. Cleanup stops the timer and ignores
callbacks from an in-flight request. The check does not download, install,
relaunch, or restart anything. Component installation remains the explicit
first-run sidecar flow described above; the CLI, daemon, and gate do not update
themselves.

### Install Locations

| Item | macOS | Linux |
|------|-------|-------|
| Data dir (shared root) | `~/Library/Application Support/Vertebrae` | `~/.local/share/vertebrae` |
| Staged binaries | `<data dir>/bin` | `<data dir>/bin` |
| Installed skills root | `~/Library/Application Support/Vertebrae/skills` | `~/.local/share/vertebrae/skills` |
| GUI app state | `<data dir>/app-state.json` | `<data dir>/app-state.json` |
| User symlinks | `~/.local/bin` | `~/.local/bin` |
| Daemon service file | `~/Library/LaunchAgents/com.vertebrae.daemon.plist` | `~/.config/systemd/user/vertebrae-daemon.service` |
| Service manager / id | launchd label `com.vertebrae.daemon` | systemd `--user` unit `vertebrae-daemon` |
| Daemon logs | `~/Library/Logs/vertebrae/{daemon.log,daemon.error.log}` | `~/.local/state/vertebrae/logs/{daemon.log,daemon.error.log}` |

`app-state.json` holds GUI-local view state (currently the last opened
project). The project registry itself lives in the shared
`~/.config/vertebrae/config.toml`. All client data dirs are derived from
`vertebrae_installer::data_dir()`.

Vertebrae-installed skills use the provider-neutral
`vertebrae_installer::installed_skills_dir()` contract. Each bundle is stored
as `<installed skills root>/<name>/SKILL.md`. The installer owns idempotent
creation of the root through `provision_installed_skills_dir()` and preserves
existing contents; the skills-assets layer owns files below it. The GUI stages
this bundle in its application setup hook before provider capability discovery,
independently of project registration. Provider integrations append this
absolute root to their normal discovery and must not create `.claude`,
`.agents`, or `.codex` directories or change the active project to expose it.
On Linux this is application data under `.local/share`, not configuration under
`.config`.

The Tauri setup hook resolves Claude's executable, PATH, and installed-skill
compatibility once and shares that immutable result with local-chat sessions.
Installing or updating Claude Code or managed skills while the GUI remains
open takes effect after restarting the application; the cached warning and
fallback guidance are still delivered to each affected session.

### Uninstalling

There is no GUI uninstall flow. Undo an install from the terminal:

1. **Remove the daemon service manually:**

   ```bash
   launchctl bootout gui/$UID ~/Library/LaunchAgents/com.vertebrae.daemon.plist
   rm -f ~/Library/LaunchAgents/com.vertebrae.daemon.plist
   ```

   On Linux, use `systemctl --user disable --now vertebrae-daemon` and remove
   `~/.config/systemd/user/vertebrae-daemon.service`. This does **not** remove
   the staged binaries or the `~/.local/bin` symlinks.

2. **Remove the symlinks and staged binaries manually:**

   ```bash
   # symlinks
   rm -f ~/.local/bin/vtb ~/.local/bin/vtb-daemon ~/.local/bin/vtb-gate

   # staged binaries (macOS)
   rm -rf "~/Library/Application Support/Vertebrae/bin"
   # staged binaries (Linux)
   rm -rf ~/.local/share/vertebrae/bin
   ```

   Removing the binaries and symlinks is enough to re-trigger the welcome
   screen on next launch, provided none of `vtb`, `vtb-daemon`, or `vtb-gate`
   is otherwise resolvable on `$PATH`.

## Real-Time Sync

The GUI maintains a WebSocket connection to Sacrum via Phoenix channels:

- Connects to `ws://host:port/socket/websocket?token=api_token`
- Joins the authenticated `accounts:me` channel for account-scoped daemon
  create/update/delete events and `project:{project_id}` for project events
- 30-second heartbeat, exponential backoff reconnection (100ms -> 30s)
- Receives broadcasts for task/workflow/execution changes from all clients and
  daemon CDC updates and ephemeral `daemon_metrics` telemetry from the account
  channel
- Emits Tauri events including `TaskChangedEvent`, `WorkflowChangedEvent`,
  `StepExecutionChangedEvent`, `NotificationChangedEvent`,
  `DaemonChangedEvent`, and `DaemonMetricsEvent`

Sacrum also mirrors project events onto `accounts:me`. The GUI consumes project
events only from its selected `project:{project_id}` subscription and ignores
those account copies. This gives additive pipeline reducers one delivery per
broadcast and keeps other projects' events out of selected-project stores.
The account subscription handles daemon lifecycle/metrics and Phoenix control
messages only.

The daemon fleet performs one account-scoped snapshot on initial load and after
reconnect recovery. Sacrum's GraphQL fleet/detail response is authoritative for
the durable identity and the current live snapshot. Between snapshots,
`DaemonChangedEvent` replaces durable projections and `DaemonMetricsEvent`
merges only live fields into already initialized fleet/detail projections; a
metrics event never creates a phantom daemon. Metrics are ephemeral, so a
missed event is recovered by the next fleet/detail query rather than a periodic
list poller.

### Activity notifications

The Activity panel (`NotificationsPanel`) shows two kinds of notification from
`notificationStore`:

- Ephemeral application notices: available GUI and local backend updates
  (`update.ts`) and a chat whose provider session may not have closed
  (`ChatWindowManager`). They live only in the session, survive project
  switches, and their read and dismiss state is local. Realtime change
  listeners update caches only; they don't add Activity entries.
- Durable project notifications that execute scripts publish through Sacrum
  (`vtb::notifications::send`). `useNotificationChangeListener` keeps them in
  the store: when the project scope starts it pages through every unread
  notification (`listProjectNotifications`, 200 per page); on each WebSocket
  `connected` it pages from the newest held notification rewound 5 seconds;
  and it applies `NotificationChangedEvent` creates, reads and deletes. Both
  paths merge by Sacrum ID. Results and events from an earlier project scope
  are dropped, and `resetProjectScopedStores` clears durable notifications.

Durable messages are Markdown rendered with `MarkdownContent`, so `vtb://task`,
`ticket`, `epic` and `artifact` links open their surfaces; an artifact link
opens the Artifacts page with `?artifactId=` and selects it once listed.
Unsupported `vtb://` types render as plain text. Read state lives in Sacrum:
"Mark read", "Mark all read" and following a link call
`markNotificationsRead` in batches of 200, and the item shows read once Sacrum
returns it or a `notification_updated` event arrives; a failed call leaves it
unread. Dismissing is local to the session and project: a dismissed durable
notification stays hidden when history repeats it. The store keeps the newest
50 of each kind, so a large unread backlog shows its newest 50.

### Live diagrams in Markdown

`MarkdownContent` registers both sandboxed SVG renderers and native React
component renderers. A completed `statechart` fence mounts `StatechartPreview`
with the same XState v5 JSON subset and controls as a statechart artifact.
Unfinished fences remain code, and invalid machines show an inline diagnostic.
Viewer interaction survives additional text streaming after the closed fence.

In conversations associated with a ticket, **Save as artifact** promotes a valid
fence to an artifact attached to that ticket with
rendered statechart metadata, preserves its original body, and replaces the
fence preview with the saved artifact link and embed. Save failures remain
visible with a retry action; pending saves cannot populate a later project's
cache. Conversations without a ticket association, including those associated
with a task or epic, show the preview without the save button. This action does
not edit the chat transcript or create a project attachment.

A completed `flow` fence plays its JSON or YAML flow spec with `FlowPlayer`, or
lists the compiler errors with their spec paths. `useFlowSpec` and
`FlowSpecView` (`components/shared/`) hold the shared parse, compile and
render-or-errors body, which forwards `onActivatePart` for drill-down.
`ChatDiagramBlock` carries the ticket-scoped **Save as artifact** rules above
for both fence kinds; a saved flow is a `flow`/`json` or `flow`/`yaml`
artifact (detected the same way as the parser: a body starting with `{` is
JSON) with rendered presentation. Flow artifacts play in the artifact preview
and inline wherever a chat message links them with `vtb://artifact`.

The flow player's left **Story** panel follows the current beat by default.
During playback, references use compact filename rows and the active part is
marked when a step association is available. Pausing restores evidence details.
**Browse story** exposes the full navigator without interrupting playback;
**Resume following** returns to the current beat. Opening a reference pauses
playback and switches to browsing, keeping the evidence stable for reading.
The full navigator groups whole-flow evidence, then each
beat's evidence and acting parts, rails and cards. Actor disclosures show their
evidence counts; a selected part or followed card appears in the inspector at
the panel foot. Playback expands and scrolls to the current beat until the
reader scrolls the list; **Jump to current** restores following. `S` toggles the
panel, `N` / `Shift+N` open the next/previous source reference and seek to its
beat, and Up/Down/Enter navigate the panel. Fitting reserves the panel's left
space beside the zoom gutter; collapsing returns that space to the diagram.

## Data Flow

```
CLI mutation -> Sacrum GraphQL API -> Sacrum broadcasts on WebSocket
            -> GUI WebSocket receives -> Tauri event -> React hooks -> Refetch & re-render

GUI mutation -> Tauri command -> VertebraeServices -> Sacrum GraphQL API
            -> Sacrum broadcasts on WebSocket -> React hooks -> Update state

Daemon mutation -> Sacrum GraphQL API -> `accounts:me` CDC broadcast
              -> GUI WebSocket -> `DaemonChangedEvent` -> daemon cache projections

Enrolled daemon -> `daemon:<id>` report/heartbeat -> Sacrum live registry
                -> `accounts:me` `daemon_metrics` -> `DaemonMetricsEvent`
                -> live fields merged into initialized daemon projections
```

### Decision model settings

Settings → Decision Model saves one optional machine-wide provider/model role
through the shared settings editor, including revision checks and discard/reload
behavior. It reuses provider profiles and discovered model catalogs; provider
selection determines the harness and credentials. The role is disabled by
default and independent of chat defaults. Stale enabled selections are reported
without preventing settings from loading; disabling retains the selection. See
`SACRUM_CONFIG.md` for resolution semantics and follow-up integration boundaries.

## Local chat associations

See [Local chat associations](chat-associations.md) for the inference flow,
header disclosure, persistence and prototype limits.

## Local chat attention states

Each chat has one attention state. It is derived in `utils/chatAttention.ts`
and drawn by `ChatAttentionDot` on the pane header, the history rows and the
launcher. In priority order:

| State | Signal | Dot |
|---|---|---|
| blocked | pending permission, plan or question in the current root turn; gate drafting/rejected while idle | accent + reason |
| error | lifecycle `error` | err, no glow |
| needs-you | turn-end check answered yes for an unviewed completed turn | accent + "Asked you something" |
| your-turn | the check answered no, is pending, or failed | muted |
| running | the agent is working | ok with the running glow (glow only means running) |
| closed | session closed | hollow |
| idle | none of the above | none |

The turn-end check (`classify_chat_turn_attention`) makes at most one
decision-model call per live completed root turn. It is never run for child
threads, discussions, cancelled or failed turns, turns with a deterministic
signal, or queued follow-ups. Each answer is stored as a chat catalog
classification keyed by turn identity and settings fingerprint. Replayed
history only looks the answer up and never asks the model. A failure or a
disabled model shows your-turn. Viewing the turn in the focused window clears
your-turn and needs-you; the user's reply clears them too. Viewed markers are
saved in localStorage. The launcher glows only while a chat is running and
shows a flat dot when chats are blocked, errored or need you ("N need
you"). `chatAttentionJumpOrder` puts blocked chats first, then the oldest.

## Changes view filesystem refresh

The Changes view opens with **Whole branch** selected: the current worktree
(including local edits and untracked files) compared with its branch merge-base.
**Uncommitted · working tree vs HEAD** remains selectable in the baseline
dropdown. Empty results render a **No changes** status and retain the selector;
baseline errors remain errors, with Uncommitted available for recovery.

The mounted Changes view owns a Rust `notify` watch of its worktree. Native
notifications are batched in fixed 150 ms windows and invalidate the Git change
list and loaded Files folders. `.git` internals and access-only events are
filtered before queueing; Git's `check-ignore` filters ignored paths, retaining
tracked files and ignore negations. Queue overflow, OS rescan requests and
filtering failures conservatively invalidate the lists. Watch startup failure
is visible in the view, where manual Refresh remains available.

The subscription is released on worktree changes, view unmount and native
window destruction. Each mounted view has its own subscription identity, so
notifications cannot refresh a different worktree. Git refreshes run serially
and coalesce further invalidations into a pending read. Open documents retain
their snapshot-at-read contents and drafts.

The worktree-delta recorder uses the same native filesystem subscription
implementation, owned by its runtime rather than the Changes view. A 25 ms
batch window coalesces file events before refreshing an idle checkpoint;
there is no periodic idle Git polling. Tool boundaries take priority over
filesystem signals, and an idle snapshot is discarded if a tool start was
queued while it was read. Tool completion still takes bounded settling
snapshots to capture late writes. Watch registration failure disables recording
with a warning instead of falling back to polling or using stale baselines.
The recorder releases its subscription on shutdown or worktree replacement.

Turn-based file history extends these observations with annotation-backed
baselines and cumulative turn captures. See [Chat file references](chat-file-references.md)
for historical/latest navigation, retention refs, capture limits and failure behavior.

## Diff review comments

The Changes icon in the conversation header toggles the chat's side column
(Changes · Discussions · Background tasks), a resizable panel beside the
mounted conversation. The main composer draft and conversation scroll survive
opening and closing it. The splitter can use the available window width without
a fixed pixel or percentage cap, keeping only a 180px usable minimum for each
surface. Closing the panel retains the existing unsaved-document
Save/Discard/Cancel gate.

The side column always sits beside the transcript; it never replaces it.
Showing any section while the chat panel is compact expands the panel to the
full (maximized) view, and switching sections keeps it expanded. Closing the
side column, or Escape outside a control that handles Escape itself, returns
to the compact chat. A chat the user expanded stays expanded when the column
closes, and collapsing the panel while a section is shown closes the column.
Below a 1100px chat width only source evidence (file references) replaces the
transcript as the chat's view, keeping the composer.
**⌘⇧B** toggles Changes for the active conversation only when its associated
worktree has changed files against the default Changes baseline. The shortcut
checks Git on demand, is inert without an associated worktree, and ignores a
pending check if the pane, session, or worktree changes. It does not poll Git.

Click, drag and shift-click select code passively in both inline tool-call diffs
and All Changes. Focus the Code diff selection region and use Up/Down (Shift to
extend) for keyboard selection. Press the gutter **+** to open a comment dialog
anchored beneath the selected lines. The selected
range remains highlighted while composing, including after focus moves into the
input; submitting either action clears it. Cancelling keeps the selection.
The dialog offers
**Discuss inline** and **Send to main chat**. Discuss inline submits the question
to a read-only thread rendered at that code anchor; questions, answers and
follow-ups stay together in the diff.

Each thread's conversation is a hidden chat-store session (`discussion: true`)
driven by the local chat lifecycle: the global event router streams its events,
and the thread renders the session with the main chat's `ChatTranscript`, so
prose, tool calls and results, and errors look as they do in the main
conversation. Discussion sessions are never persisted, summarized into history,
reused by chat openers, titled or used for chat association. Clicking the
discussion body or its file/range label highlights the
original source range; the close icon collapses the discussion to its marker.
The follow-up composer has a separated action row using the same compact button
styles as the initial comment dialog. Reopening a discussion restores its source
selection. Selection highlighting excludes the annotation and composer rows.

Send to main chat attaches the original snapshot and dialog text to the main
composer without sending. Selection and
opening the dialog send no model request. The next explicit main send includes
the attachment and the user's composer draft.

Mini conversations are in memory for the mounted session/worktree. They survive
panel close/reopen, but switching that identity or restarting the application
retires them and closes their sessions. Each thread owns one read-only harness
session: the first question starts it with the anchor (path, side, line range,
selected snapshot, outdated flag) as JSON context, and follow-ups are new turns
in that session carrying only the question, plus a one-time note once the
anchor becomes outdated. The read-only policy is the session's developer
instructions. Cancel marks the turn stopping and interrupts it without closing
the process; the turn settles when the provider reports it interrupted.
Only the active thread keeps an idle session; a collapsed thread's session
closes once its reply settles, and its next question resumes the provider
conversation by its resume id (or restarts it with the anchor when the
provider never reported one). Changing the discussion harness or provider
starts a fresh session from the anchor; transcripts are never replayed.

Discussion sessions can read the worktree but not change it. Claude launches
with only `Read`, `Grep` and `Glob` (`--tools`), an empty strict MCP
configuration, no plugin, skill or agent directories, hooks disabled and the
default permission mode, without the option to bypass permissions later; it has
no permission prompt tool, so reads outside the working directory are refused.
Codex runs its shell tool inside the native read-only sandbox with approvals
disabled and keeps apps, delegated agents, desktop/browser automation,
code-host execution and inherited MCP servers off. The permission bridge
approves exactly the adapters' read-only tool set for discussion sessions and
denies everything else with "Selection discussions are read only.".
Implementation requests can be attached to the main composer. One thread is
active at a time; collapsed diff markers reopen prior discussions. Changed
patches mark anchors outdated without replacing their original code snapshots.
Away from the diff, an opened anchored discussion in the Discussions section
shows its diff chunk (`spanChunk`: the span's hunk rows plus up to three rows
of context, as a one-hunk patch from `chunkPatch`). The chunk is drawn by a
lazily loaded Pierre `PatchDiff` with the Changes view's diff options and the
discussed lines selected. Listed rows stay one line each, and a detached
discussion shows its original selection instead.

Diff surfaces subscribe to stable discussion actions and anchor locations;
streamed message state updates only the thread UI. Screen readers receive a
terminal status announcement rather than every streamed chunk. Discussion errors
show readable recovery messages; diagnostics retain the request ID and error
category without logging selected code or provider payloads.

Users can still comment on lines of a worktree diff through **Comment on selection**
in the inline tool-call diffs and the Changes panel's All Changes view.
Comments are pending comments in `ChatWindow` (the `kind: "diff"` variant of
`PendingComment`), sent with the next message by `formatTextCommentsForReply`
and cleared on send. They are in-memory only; the DocumentEditor diff has none.

- `thread/toolChange/diffLineMapper.ts` is the pure line arithmetic: it parses
  patches into hunks and carries a line forward/backward through the ordered
  chain of recorded tool-call patches (renames included) and onto the All
  Changes patch. `diffComments.ts` turns that into per-surface placements and
  marks All Changes comments outdated when a reload changes their hunk.
- `DiffReviewContext` carries comments and placements from `ChatWindow` to the
  surfaces; `hooks/useDiffComments.tsx` builds each surface's Pierre
  annotations and gutter handler (separate from `usePierreDiffOptions`, which
  is appearance only). Annotations share one slot per side and line.
- All Changes is the canonical numbering. A comment is drawn on its home patch
  and on the other patch where the same line exists: a tool-call line maps to
  All Changes by shifting through later calls; an All Changes line maps to the
  single call that added or removed it. Inline diffs stay gated by
  `useNearViewport`, so their comments appear once the diff mounts.
- CodeView only republishes an item when its `version` changes, so
  `AllChangesView` bumps the version when annotations or the diff change.

### GitHub review threads in Changes

When the chat's pinned branch has a linked PR, Changes shows the PR's review
threads, and the viewer can reply, resolve and reopen them (see
[Posting to GitHub threads](#posting-to-github-threads)). GitHub reads and
local placement are kept apart:

- `get_github_pr_review_threads` reads the threads of the PR the caller
  names through `crates/github`, at most 10 pages of 50 threads and 30
  comments per thread, and reports truncation. The backend caches answers
  for 20 seconds (64 PRs, keyed by host, repository and PR) and shares a read
  already in flight; `refresh` bypasses the cache.
- `stores/prSync.ts` owns the threads, like the rest of a branch's PR state
  (`stores/prReviewThreadsSync.ts` does the reads): they live in the branch's `worktreePrStore` entry (`reviewThreads`) and
  reset whenever its link changes. A shown branch's threads are read with
  each fresh read of its PR, so they share the poller's cadence, its pause
  while the window is hidden, its backoff and GitHub's rate-limit hold-off.
  Refreshing the PR re-reads them past the cache. One read per branch is in
  flight at a time, an answer a later read replaced is dropped, and a failed
  read keeps the threads already shown. `useWorktreePr` exposes them and the
  open (unresolved) count.
- `stores/reviewThreadNotices.ts` records a PR's thread IDs on its first read;
  a later read that finds threads not seen before adds one `info`
  notification to the Activity panel.
- `map_worktree_pr_review_threads` places each published anchor on the shown
  comparison through `src-tauri/src/review_anchors/`, the one line mapper
  (Vertebrae discussions use it too). It reruns on every Changes load, so
  local edits move threads without another GitHub read. A thread is placed:
  - on its unchanged lines (a range for multi-line comments), possibly moved
    by local edits or by a different comparison base;
  - edited, which keeps the published line and published code. The card
    names the published lines the edit changed (`editedLines`, from the same
    line map) and marks them in the published snippet; an edit that only
    inserted lines inside a range is named as such;
  - outdated, with the original code;
  - unverified, when the PR head isn't fetched locally;
  - unplaceable, when the anchor is invalid or the file can't be read;
  - at file level, or not shown in this comparison.
- `workspace/githubReview/` holds the Changes side: `model.ts` (placement to
  markers, outdated groups and the rail's files), `useGithubPlacement.ts`,
  `useReviewController.ts`, `useWorktreeReview.ts`, `markers.ts`,
  `diffAnnotations.tsx` (the `AllChangesView` adapter), `GithubThreadCard.tsx`
  and `ReviewRail.tsx`.
- `markers.ts` draws one neutral avatar marker per side and line into
  Pierre's rows. A file with markers gives every drawn line a lane on the
  right (`markers.shadow.css`), so markers never cover code. The lane is
  pinned by its right edge (sticky), so it does not shift when Pierre starts
  measuring the code column (as it does once a card is open). Threads that
  share a line share one marker. The marker has no text nodes: its initials,
  count and drift glyph come from CSS. Activating it expands its threads in
  the line's annotation slot. Resolved threads fold to their first line
  until shown.
- Each file header has an **Outdated n** pill that lists that file's outdated
  threads in the first diff row's annotation slot, beside any line threads
  there.
- The Review rail lists every thread grouped by file in line order; the PR's
  checks stay in the review bar's drawer. It opens from the PR bar's thread
  count, the header PR chip, `r` anywhere in Changes outside text fields, or
  **Show review threads** in the Changes palette; on a narrow Changes pane it folds the file list or overlays the
  diff. Choosing an entry shows its thread in the diff (an overlaying rail
  closes so it does not cover the thread). A thread the diff can't show
  expands in the rail instead.
- Focus returns to what opened a card (a marker, an Outdated pill, a rail
  entry) and, when the rail closes, to the bar control that opened it.
  Targets are logical and resolved inside the Changes pane, so Pierre's
  recycled rows and a second pane never take the focus.
- ⌥↑/⌥↓ stop at marker lines. `o` on a line without a Vertebrae discussion
  toggles its GitHub threads.
- `[` and `]` (matched by physical key) step to the previous and next thread
  in the rail's order (`stepThread` in `model.ts`), from the focused card or
  rail entry, else from the line cursor, else from the last thread stepped
  to. The card stepped from closes; the next one opens where it can be read
  (the diff, else the rail, which opens) with focus in it. Stepping stops at
  either end. The palette offers **Next/Previous GitHub thread**.
- A focused card takes `c` (discuss inline, or show its discussion), ⌘⇧↵
  (Send to main chat) and Esc (close). Keys typed in the discussion's
  composer stay the composer's.
- **Open on GitHub** is a neutral icon (GitHub glyph and external arrow) in
  the card's header.
- Open threads and the rail survive comparison switches. A switch keeps the
  topmost visible line in place.

#### Private discussions of GitHub threads

A thread card's **Discuss inline** (never the GitHub glyph) starts a
read-only side discussion of that thread, using the same
`SelectionDiscussions` controller and discussion sessions as a selection.
The card's actions reuse the selection composer's action row
(`.diff-comment-editor-actions`): key hints, a neutral **Send to main chat**
and one accent primary, **Discuss inline** (or **Show private discussion**).

- `githubDiscussion.ts` picks the lines to capture. A thread on a line is
  captured from the shown side, exactly as a selection of those lines would
  be. An outdated thread is captured from the commit its snippet came from
  (`originalCommit` on the placement). File-level, not-shown and unplaceable
  threads have no lines, so there is no button.
- `capture_review_anchor` takes a typed `subject`: a selection (its text is
  checked against the captured lines) or a GitHub thread (the lines are read
  as is). A GitHub subject needs worktree content and a GitHub node ID, and
  it is stored as `origin_ref = github-thread:<id>`. Restore reads the ID
  back into `SelectionThread.githubThreadId`.
- The discussion is drawn only inside its GitHub thread's card, wherever the
  card shows: under its line, in the Outdated group or expanded in the Review
  rail. It therefore follows the GitHub thread ID through refreshes and
  comparison switches. It is never one of the diff's own anchors, and
  re-mapping never moves it. Discussions lists it under **On GitHub
  threads**, where `o` shows the thread in Changes.
- The first turn carries the thread (`githubThread`: resolution, outdated
  state, comments) from the PR state `useWorktreePr` holds.
- Esc, close, resolution and comparison switches only close the discussion
  view. The discussion and any unsent question (kept by the controller)
  stay.
- **Send to main chat** (on every card, private, so no GitHub glyph)
  attaches a `github_thread` pending comment: the code, the GitHub comments
  and, when the thread has a discussion, its questions and replies. Without
  one, it carries the lines the thread is drawn on and their code as the
  diff shows them (an outdated thread's original snippet), else GitHub's
  anchor lines without code (none for a file-level comment). It sends
  nothing, and a discussion's draft stays. There is one attachment per
  thread: sending again replaces it. The message is formatted like a diff
  comment (without a code block or line range when it has none), so the sent
  turn reads back into a code card. Its chip reveals the thread
  (`SelectionDiscussions.reveal` or `revealGithub`), in the diff or the
  Review rail, reopening its discussion when it has one.

#### Posting to GitHub threads

A card offers **Reply on GitHub**, **Resolve** and **Reopen** only where the
thread read says the viewer may (`viewerCanReply`, `viewerCanResolve`,
`viewerCanUnresolve`); without permission they are hidden. A private line
discussion offers **Comment on GitHub** once its lines are on the PR. So
does the selection box in Changes, beside **Send to main chat** and
**Discuss inline**, with no private discussion: `map_review_selection` maps
the shown lines onto the PR's published side (read only; nothing is
retained), and the button or ⌘⌥↵ posts the typed text at once as a new
thread. The button's tooltip and the box's hint row name the PR, lines and
audience. The text is read only while the post is out and after a timeout
until the check settles it, a failure keeps it with Retry (a timeout checks
GitHub first), and a posted comment closes the selection, unless another
selection has replaced it. Cancel or closing the selection forgets a failed
post. Every
public action is neutral with the GitHub glyph; the accent stays on private
actions.

- `crates/github` sends each write as one GraphQL mutation
  (`write_review_thread`, a `ReviewThreadWrite`), through the client's
  authentication and error mapping. A GraphQL `FORBIDDEN` or an HTTP 403 is
  `forbidden`, and a request timeout is `timeout`. A mutation GitHub took
  without errors but whose answer does not show the written node is
  `Unconfirmed`, which reaches the GUI as `timeout`: it may be on the PR, so
  it is checked before it is sent again. These reach the GUI as
  `GithubErrorKind`s. The thread read also returns `viewerLogin`.
- `write_github_pr_review_thread` sends the write once and then drops the
  PR's cached thread read. A read already in flight still answers its
  callers, but its answer is not cached. `prSync.writeWorktreeReviewThread`
  refuses a write when the branch now links a PR other than the one the user
  saw. After any outcome it re-reads the threads past the cache and drops
  reads that started before the write.
- `githubReview/threadWrites.ts` keeps the drafts per chat: one slot per
  GitHub thread (`thread:<id>`, its reply and resolve state) and per line
  discussion (`comment:<id>`), plus the selection box's post
  (`selection:<side>:<path>:<lines>`). They are separate from the unsent private
  questions of `SelectionDiscussions`, so closing a card, Esc and comparison
  switches keep both. `GithubWritesContext` (provided by `ChatWindow`)
  binds the store to the linked PR.
- The composer names the PR, the lines and the audience before posting. A
  click posts, and so does ⌘↵ (the hint, a live status, names the post it
  sends). **Discard** offers **Undo**, which takes the focus. **Draft reply** in a GitHub
  thread's private discussion seeds the reply from the latest answer. It
  never posts, and **Send to main chat** only attaches private context.
- A failed post keeps the draft. A 403 offers no Retry, only "<Action> on
  GitHub". Other failures keep Retry. A timeout's retry first re-reads the
  thread. The write counts as posted when a matching node (the viewer's
  comment with that body, the resolved state, a new thread by the viewer on
  those lines) appears beyond what matched before. When the threads cannot
  settle it (unknown viewer, truncated comments), the user is sent to GitHub
  instead. **Reply and resolve** posts the reply and then resolves. If the
  resolve fails, the reply is kept and only the resolve is offered again;
  when a timed-out reply is found posted, its resolve is sent then. A send
  that throws counts as a timeout.
- **Comment on GitHub** maps the discussion's retained lines onto the PR head
  (its base for removed lines) with `map_review_threads`. It is unavailable
  until they are there unchanged. A posted comment starts a thread,
  published at once as a one-comment review rather than left in the
  viewer's pending review (where only they see it and it cannot be
  resolved), and
  `put_review_thread` with `github_thread` moves the discussion under it
  (`origin_ref`). The discussion keeps its ID, transcript and draft. A failed
  post leaves it on its lines.

### Tool activity disclosure

The shared Thread renderer groups consecutive normalized tool calls with
syntax-derived activity summaries and lazy raw disclosure. See
[Tool activity summaries](tool-activity-summaries.md) for supported syntax,
evidence limits, local evaluation and the compiled benchmark fixture.

### Panel source viewers and editors

Artifact JSON and workflow source/configuration panels use the lazy shared
`PanelCode` surface. See [Panel code surfaces](panel-code-surfaces.md) for its
draft/reset contract, language policy, migrated inventory and ranked follow-up
candidates.

### Review thread catalog IPC

`putReviewThread` accepts a complete typed anchor and position. Use the same
thread UUID for updates. `tombstoneReviewThread` is idempotent for a known
tombstone and reports an error for an unknown thread. Updates to a known
tombstone fail locally. `listReviewThreads` reads the account-scoped cache for
a configured project. The standard chat history excludes discussion sessions.

Subscribe to `reviewThreadChanged` for durable changes to visible threads. The
event identifies the project and thread and carries the current thread or
`null` when it is removed. Local writes, remote writes, and the removal of
queued descendants use the same event. Use `reviewThreadCatalogRecovered` to
reload the complete project projection after startup or reconnect, including
an empty snapshot. A failed CDC merge emits `reviewThreadCatalogRecoveryNeeded`;
the global catalog listener requests recovery for the current account.

Git capture stages the anchor ref before acquiring the catalog lock so file
reads and hashing cannot delay catalog writes. If the process stops after
creating the ref but before saving its repository entry, the ref can remain
in Git without a catalog record. Catalog recovery releases only tracked
refs. An orphan in this window retains its blob until the ref is removed.
