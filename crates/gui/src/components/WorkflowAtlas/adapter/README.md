# Atlas machine-flow adapter

`buildMachineFlow(scopedSummary, routeConfigs, scopeKey)` is a pure, additive
adapter. The caller scopes the summary using the existing Atlas scope logic and
supplies only already loaded configs. `useAtlasMachineFlow` stabilizes its spec
and uses the shipped `useLaidOutFlow` compiler/worker/cache lifecycle. The current
Atlas renderer is unchanged; subsequent scene integration can consume this API.

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
intra-workflow targets and workflows outside scope are diagnosed and omitted as
rails (their source parts/decision ports remain). Workflow handoff targets fall
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
