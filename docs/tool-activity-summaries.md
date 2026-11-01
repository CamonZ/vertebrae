# Tool activity summaries

The shared Thread renderer groups consecutive normalized tool calls within one
turn, segment and agent thread. Any intervening message ends the group. Counts
refer to outer calls; nested operations contribute deduplicated activities with
a four-label limit and overflow. Calls retain their order and identity.

The first expansion is one clickable activity row per call: Build, Validation,
Read files, Git inspection, etc. The next expansion shows requested relationships,
literal targets, parser caveats and exact recorded arguments/results in bounded
panels. Expensive raw content mounts only when opened. Native buttons expose
keyboard activation and expanded state. Inline recorded and payload diffs remain
outside the group, using the existing viewport-gated viewer and review comments.

## Classification

`classification.ts` owns literal command classification and option consumption.
`categories.json` is the shared source for display labels, accepted inferred
activities and backend yes/no questions. The parser owns syntax and invocation
boundaries, rather than searching arbitrary source for command-name substrings.

- Structured Read/Edit/Write/Grep/Glob/apply_patch, coordination and web tools
  have deterministic handlers. Visual tools and UI controls use separate labels;
  Claude and Codex coordination aliases share one category. Known Tidewave log and
  runtime-metadata readers are runtime inspection; arbitrary evaluation and SQL
  remain input-dependent. Unknown MCP calls can request inference with their tool
  name and projected arguments, including code/query, under the same source caps.
- JavaScript wrappers recognize direct tools.<name> calls with literal object
  arguments. Data objects, comments and quoted command-like strings are not calls.
  Dynamic arguments retain uncertainty; Promise.all/allSettled retain parallel
  request relationships.
- Bash syntax separates lists, conditionals, pipelines, background requests,
  substitutions, arguments, redirects and heredocs. Literal sh/bash/zsh -c
  wrappers can be unwrapped. Dynamic/positional wrappers and function bodies
  remain unresolved. Pipeline filters are not independent file searches.
- Literal argv rules cover Git/GitHub inspection and changes, synchronization,
  worktrees, common build/validation tasks, source reads/searches and web requests.
  Unsupported aliases and option shapes remain unresolved.
- Embedded Python has a narrow AST projection for open/read_text/read_bytes and
  write_text/write_bytes. Reads implementing an edit do not add a separate read
  activity. Partly or fully unresolved Python invocations retain their own script context
  for optional inference, without absorbing sibling shell commands.

Malformed syntax, unsupported languages and indirect operations keep uncertainty
and raw access. The 25 constructed prototype controls and property tests cover
invocation ownership, composition, quoting, lifecycle and disclosure boundaries.

## Evidence boundaries

Activities describe requested work, never execution or success. A final process
result does not establish which child commands ran or whether tests passed.
Worktree snapshots never enter classification. The existing diff viewer labels
them as recorded around a call, with causation unestablished; a tail command stays
a read even when an unrelated file changed nearby. No annotation or transcript
is written by presentation enrichment.

The GUI cannot recover outer wrappers omitted by provider normalization. Counts
and raw inspection apply to received normalized calls, not invented provider
records. Raw input strings are retained verbatim; object inputs use lossless JSON
presentation formatting.

## Optional inference and resource ownership

Expanded chat groups may ask the configured decision role about up to 16 unique
unresolved syntax-separated sources. There are 18 independent activity questions,
including explicit tests/validation and script-file-edit questions. Requests contain
only those sources: no transcript, results, generated targets or worktree snapshots.
Known labels with yes probability >=0.9 are marked inferred; parser diagnostics remain.
Each parsed command owns one record with multiple labels and literal targets;
inference adds labels to that record without duplicating it.
This provisional threshold has not been calibrated on a live-model corpus.

Four sources fit one request, with two concurrent batches and two backend requests
globally. Sources are capped at 4096 UTF-8 bytes. Outcome deadlines are 20 seconds
with bounded cancellation waits. Disabled, busy or unavailable models fail open;
traces without a chat scope do not initiate inference. The backend owns batching,
concurrency, admission (32 pending group requests), and a cache of at most 128
completed judgments for one minute, keyed by source and decision settings. Queue
waits are bounded to 20 seconds. Disabled/failed requests are not cached. Closing
or changing the group ignores stale answers.

One shared parser worker serves mounted groups. Grammar linking is sequential to
avoid unresolved external-scanner exports in WebKit. Pure syntax caching is bounded
to 256 inputs, 1024 pending requests, 128 KiB per input and 4 MiB queued input.
A ten-second watchdog and one fresh-worker retry bound failures. Completed labels
remain visible while other calls finish; failed analyses are not cached. Loading,
unavailable analysis and genuine unknowns are distinct, with explicit retry after
persistent failure. Typed worker responses carry error phase and retryability;
recovery never matches diagnostic text. The last mounted owner terminates the worker and clears cache.

## Validation and guidance

Run `scripts/validate.sh gui` from the repository root, focused activity tests from
`crates/gui`, and `cargo test -p gui --lib commands::tool_activity` for the inference
gateway. Production latency, independent corpus review and live-model calibration
remain review obligations. Removed benchmark tooling is not an ongoing validation
or performance guarantee.

Selected project bb747fd8-5395-486f-bc8b-24ccd1615e18 guidance:

| Logical name | Artifact ID | SHA-256 |
| --- | --- | --- |
| typescript-best-practices/react-composition | f237c79a-7286-4410-958c-9ec70b65a3ff | e11c487c944ba2617d1ab9a6a63004a31255c6a1c3cad9f1ad356e5bc2abff27 |
| typescript-best-practices/performance-and-batching | 17e79ef2-19a6-48d0-a96f-52a759d42943 | 9fc095a370e5049e5c9dfafb018223e95e0d8380c8309ef117c7a8838867fa49 |
| rust-best-practices/async-and-concurrency | 21de8462-71c6-4af4-a869-d3ce28811c2e | d61d035ab1e26333b3cd4fb9c8bedb903569c00f7f90d773b905dff5c66131af |

Applicable rules: RCOMP-001/003/004/006, TSPERF-001/003/004/005/006 and
ASYNC-001/002/003/004/005/006/008. No required-rule exceptions. Passing tests and
linters do not establish complete guideline compliance or a native latency budget.
