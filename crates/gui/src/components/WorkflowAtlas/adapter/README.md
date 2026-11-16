# Atlas machine-flow adapter

## Levels

The Atlas Graph has three levels, each one shared machine scene
(`ScopedMachineGraph` → `useAtlasLevelFlow` → `AtlasMachineScene`), built by
`buildAtlasLevel` (`atlasLevels.ts`) from the whole project's summary:

- **Between factories** (`buildFactoryLevel`): one `factory` station per
  factory, one rail per directed factory route (`factoryRoutes`, the routes
  `factoryLinkCounts` counts).
- **Inside a factory** (`buildWorkflowLevel`): one `workflow` station per
  workflow (lamps by `step_type`, never names) and one rail per ordered pair of
  workflows that hand work to each other, carrying every backend transition
  in `transitionIds`. An empty workflow is a labelled endpoint.
- **Inside a workflow** (`buildMachineFlow` with a `context`): only that
  workflow's steps.

No connection is dropped: a handoff either joins two parts of the level or
ends at a short labelled stub (`topology endpoint`) naming where it goes or
comes from — the other factory inside a factory, the other workflow inside a
workflow. Only a handoff to a workflow missing from the project is diagnosed
and omitted. Inbound stubs lead the spec and station parts are listed in flow
order, because the layout reads spec order as model order.

`destinations` maps stations and stubs to the level they open. A click on a
part with an inspector entity inspects it; double-click or Enter opens its
level (`DiagramInteraction.onOpenPart`); a part with nothing to inspect (a
factory station, a stub) opens on click too. `WorkflowAtlas` keeps the opened
workflow per factory scope and one camera per level, so the breadcrumb returns
up with the previous camera and level and camera survive Map and Board.
Opening a level from a station frames it fresh. Station levels have no
regions; the composite layout packs their unconnected pieces in rows
(`FlowLayoutOptions.pack`). Station parts use the neutral `topology` prop: no
status line, counts in the title gap.

`TaskRunMotion` draws TaskRun motion: a realtime `task_run_step_changed` move
sends one card along the rail that carries it at the current level
(`railForMove`). Frames run only while a card travels, travel is capped and
skipped off-screen, and reduced motion shows the card at its destination.

## Steps level

`buildMachineFlow(scopedSummary, routeConfigs, scopeKey, context?)` is a pure,
additive adapter. The caller scopes the summary; it supplies only already
loaded configs. `useAtlasLevelFlow` stabilizes its spec and uses the shipped
`useLaidOutFlow` compiler/worker/cache lifecycle. It is the only Graph renderer
(the legacy ELK Graph, its morph and its build-time rollback toggle were
removed). Map retains `layoutCondensed` phase columns, and the unscoped Map
is `FactoryOverview`; Board and Run Console retain their hosts. Searches and
Graph cameras are retained per project/factory/level; project generation
retires old scenes. Pending topology hides prior geometry; worker errors show
the shared row fallback with an explicit warning and Retry layout action. A
retry remounts the shared hook; the adapter does not introduce another worker
or layout client.

Each backend step maps to a registered neutral topology part, including separate
stop and finish forms. Each workflow is a region containing its steps and a
labelled neutral `topology endpoint`. Workflow-level transitions leave that
endpoint because their runtime source step is unknown. Empty workflows retain
both region and endpoint. The shared endpoint has a plain connector drawing and
no observed status, network boundary or hop semantics. `selections` maps
part/region IDs to the existing
`AtlasSelection` inspector contract; `transitions` maps individual rail IDs to
backend step, decision and workflow-transition identities.

Ordered adjacent steps retain the existing **inferred sequential** connection.
A declared transition marks that connection explicit. Configured decisions
replace the adjacency link to their destination and each keep a separate rail,
even when several share a target. Rule ports derive from rule IDs; the default
uses the shared default port. Remaining declared transitions, including loops,
are preserved; a route's summary-only and inferred connections receive explicitly
named synthetic ports using destination step names (collision suffixes keep
ports unique); rail IDs remain based on backend step IDs. Non-route session
labels reuse the same `transitionSessionLabels` derivation as
`buildAtlasModel`, including declared jumps beyond ordered adjacency.
A finish has no runtime output port: unusual outgoing ordering/declared links
use a separately labelled logical ordering endpoint mapped to that step, only
when at least one valid outgoing rail exists.

Missing configs stay neutral and show only summary transitions and inferred
order. Unknown step types use the existing neutral process fallback. Missing
intra-workflow targets are diagnosed and omitted as rails (their source
parts/decision ports remain); workflows outside the scope end at stubs when a
`context` is given and are diagnosed and omitted otherwise. Workflow handoff targets fall
back from a missing explicit step to a valid initial step, then first ordered
step, then the empty workflow endpoint; missing references are diagnosed.
Malformed duplicate rule IDs retain distinct ports/rails using positional
suffixes with diagnostics. Unlike valid rule IDs, those malformed identities
cannot promise stability under reorder.

`counts` is a separate live projection. The structural key contains scope and
the entire generated spec (names, geometry props, port order, labels and
topology). Hover and selection are not adapter inputs. Count-only and unrelated
backend-field changes preserve the hook's spec identity and issue no new layout
requests. Pass a new registry identity when registry geometry changes, as
required by `useLaidOutFlow`; do not mutate a registry in place. The adapter adds
no geometric cache or router. Final recompilation uses shared `layoutFrom`,
including label positions, jumps and corner radii, rather than copying points.

The independent inventory fixture tests the full compiler/layout/recompile and
shared drawing boundaries. Hook tests observe the real shared client and verify
request stability/invalidation; metamorphic tests protect decision identity and
adversarial backend-ID encoding. jsdom exercises the client's documented
non-browser fallback; it does not claim native webview/worker smoke coverage.

`AtlasMachineScene` adds the optional live presentation boundary to `FlowScene`.
Pass the current adapter result and its compiled arrangement; the host continues
to own the shared layout hook and viewport. `useAtlasPresentation` is also
available for hosts that need to pass `interaction` and `presentation` directly
to `FlowDiagram`. Neither bridge starts a layout or owns a camera. The scoped Graph host owns camera fitting and resets it only on geometry
changes or explicit fit/retry. Counts, selection, inspector hover, focus and
workflow search decorate the existing scene without compile/layout requests.
Search dims nonmatching workflow members and rails; an active trace takes
precedence, preserving inspector and keyboard interaction.

The global entity panel store owns inspector selection and inspector edge hover.
Scene hover and keyboard focus are local, with the most recently entered channel
taking precedence. A mouse click may focus a part; later pointer entries still
replace that trace. Leaving a pointer target restores focus/selection tracing; removed
IDs are retired on the next render and do not resurrect on reintroduction.
Out-of-scope selections remain owned by the global inspector but decorate no
entities in this scene. Region selection includes its members; part traces
include incident rails and immediate neighbours only. Inspector edge emphasis
supersedes the trace and accepts individual machine rail IDs, backend handoff IDs
and the shipped inspector's `X_`, `B_` and `L_` edge IDs. Legacy inspector rows
that aggregate several decisions emphasize that set; individual machine IDs
still address one parallel rail.

Atlas adapter parts are neutral, unchanged, have no change notes and compile at
scale 1 in every arrangement. The title-gap count slot is restricted to neutral
full-scale parts without change notes; other flows keep their note/name slot
and still expose counts in the accessible name. Tests enforce this Atlas
invariant. Region `liveHeader: true` reserves both label lines structurally in
`regionLabels`; its name/count anchors are shared with the renderer and the
layout cache keys include the option. Omitted options retain embedded geometry.

Workflow totals appear in headers and step totals below the part title, using
only the adapter's observed parked/active values. There is no execution-state
projection onto the neutral mechanisms. Headers have their own click/Enter/Space
activation and visible focus target. Counts and emphasis are static under both
motion preferences. Dashed conditional rails and arrow direction are opt-in
presentation; original embedded wires keep their defaults. Emphasis changes only
CSS on the existing wire path, retaining route points, jumps, corner radii,
labels and endpoint identity. No second rail or catalogue lead is drawn.

## Layout

Every level lays out through the composite entry
(`MachineDiagram/flow/composite.ts`): region flows compose per-region layouts,
flat station levels pack their pieces. Layouts are memoized and persisted in
IndexedDB (`layoutStore.ts`). `useAtlasLayoutWarmup` precomputes every level
(`atlasWarmupLevels`) at background priority after the pipeline summary and
route configs load; the visible Graph always jumps the queue.
Persisted layouts are keyed by build, so a new build recomputes them once.
