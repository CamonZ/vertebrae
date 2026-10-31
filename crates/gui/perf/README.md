# Markdown streaming native verification

This fixture renders the production `ChatMessages` and `runToThreads`/`Thread`
paths in a dedicated macOS WKWebView. It does not load the application router,
connect to Sacrum, or alter conversations. The native host uses the same webview
engine as Tauri on macOS; it is not a full packaged-Tauri integration test.

The workload extends `agentProseMarkdown.test.tsx`: two conversations, six
completed Markdown items each, 120 alternating deltas at 100 ms intervals,
Markdown/code/JSON/Mermaid syntax, and independent item completion. It then
updates B ten times after A completes. Completed items include lists, links and
highlighted code. The visual sample shows identical partial and completed text.

`build.mjs` instruments entry into `RenderedMarkdownContent` **only in this test
build**, counting the boundary before JSON preprocessing, Markdown parsing,
highlighting and diagram work. No instrumentation ships in the main app.

## Build and run on macOS

From `crates/gui` (with `npm ci` already completed):

```sh
PERF_OUT=/tmp/markdown-changed-build node perf/build.mjs
mkdir -p /tmp/MarkdownVerification.app/Contents/MacOS
swiftc perf/WebView.swift -o /tmp/MarkdownVerification.app/Contents/MacOS/MarkdownVerification
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string MarkdownVerification' -c 'Add :CFBundleIdentifier string com.vertebrae.markdown-verification' -c 'Add :CFBundleName string MarkdownVerification' /tmp/MarkdownVerification.app/Contents/Info.plist
python3 perf/serve.py /tmp/markdown-changed-build /tmp/markdown-changed-results.json
```

Open `/tmp/MarkdownVerification.app`. Click **Start benchmark** and type while
each phase runs. The textarea is focused automatically. Results appear on the
page and are saved by the loopback-only server. Use **Show visual sample** to
inspect whitespace, wrapping, selection, independent scrolling and completion
formatting. The app menu supports Reload fixture (Cmd-R) and Quit (Cmd-Q).
Quit the host and stop the server when done. The PlistBuddy creation commands
are for a new app directory; do not repeat the `Add` commands on an existing plist.

For the baseline, archive revision `30de1b668e8484381466d5d74c422cf1532fbafb`
into a temporary directory, copy the current `perf` directory into its
`crates/gui`, and symlink the same `node_modules`. Run `perf/build.mjs` there with
`PERF_OUT=/tmp/markdown-baseline-build`. Serve that output with the same Python
server and save to a separate result file. Stop the server before switching
builds, then reload the native host. The server disables caching to prevent
assets from one revision being mixed with another.

## Measurement interpretation

- `streamingWork`: all rich-render entries during the 120 deltas, excluding
  initial history mounting. `historyReparses` is the completed-history subset.
- `exactPartial`: both pending DOM text contents equal their supplied strings.
- `completionWork`: rich-render entries when A completes while B remains pending.
- `aReparses`: additional parses of A during B's ten subsequent deltas.
- `updateP50/P95`: synchronous React update duration, measured around `flushSync`.
- `frameP95`: animation-frame interval while streaming (includes layout/paint
  scheduling, OS load, and any computer-use inspection overhead).
- `inputP95`: input-handler-to-next-animation-frame delay. Synthetic input events
  provide regular probes; trusted native input events are reported separately.
  Samples include the brief completion/post-stream update interval.
  This is **not** hardware-keypress-to-paint latency or a benchmark of the full
  production chat composer. A zero trusted-input count means no native samples.

These are exploratory single-machine measurements, not a statistically powered
performance study. Compare rendering-work counts as deterministic evidence;
small timing differences should not be interpreted as speedups/regressions.
Captured results are temporary local outputs and should not be copied into the repository or committed.

# Long chat rendering

`long-chat.html` renders the production `ChatMessages` path with a
deterministic synthetic history: per turn a user prompt, a Read tool call and
result, and a completed Markdown answer with inline code, links and a file
reference. Variants hold total fenced-code characters equal:

- `plain`: no fenced code.
- `small`: three ~10-line Rust blocks per answer (Pierre highlights these on
  the main thread, below `mainThreadMaxCharacters`).
- `large`: one ~120-line block every fourth answer (worker-highlighted).

Query parameters: `sizes` (turn counts, default `25,100,200`), `variants`,
`label`, and `auto=1` to start immediately. For each variant and size it
records: mounting the whole history (`mount`: commit time, frames over 50 ms
and their blocked time, Markdown parses, `CodeSnippet` renders, DOM nodes
including shadow roots); scrolling from the top at 40 px per frame (`scroll`),
back up over the same range (`scrollBack`) and at 400 px per frame (`fling`);
idle typing probes (`typing`); streaming 60 keyed deltas through `messages`
(`stream`, including history reparses and snippet renders); and switching the
dark code theme (`theme`). Before the benchmarks it checks inline code, code
inside links and entity links, file references and plain links against probes
colored with the inline-code and link tokens in light and dark mode
(`styles`). Frame gaps stand in for long tasks, which WebKit does not report.

## WKWebView (macOS)

```sh
PERF_OUT=/tmp/long-chat-build node perf/build.mjs
mkdir -p /tmp/VtbPerf.app/Contents/MacOS
swiftc perf/WebView.swift -o /tmp/VtbPerf.app/Contents/MacOS/VtbPerf
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string VtbPerf' -c 'Add :CFBundleIdentifier string com.vertebrae.perf-verification' -c 'Add :CFBundleName string VtbPerf' /tmp/VtbPerf.app/Contents/Info.plist
python3 perf/serve.py /tmp/long-chat-build /tmp/long-chat-results.json &
/tmp/VtbPerf.app/Contents/MacOS/VtbPerf "http://127.0.0.1:18420/perf/long-chat.html?auto=1&sizes=50,100,200&label=current"
```

The host takes the fixture URL as its first argument (the Markdown streaming
fixture remains the default). Results are posted to the results file when the
run completes; keep the window visible, since hidden windows throttle frames.

## Chrome trace (attribution aid)

`chrome-trace.mjs` drives the same page in headless Chrome over the DevTools
protocol and records a timeline with CPU samples. It summarizes each phase by
main-thread category (scripting, style, layout, paint, GC), other threads
(including the Pierre highlight workers) and hot functions (self and
inclusive). Build with `PERF_MINIFY=0` so function names survive:

```sh
PERF_MINIFY=0 PERF_OUT=/tmp/long-chat-named node perf/build.mjs
python3 perf/serve.py /tmp/long-chat-named /tmp/unused.json &
node perf/chrome-trace.mjs "http://127.0.0.1:18420/perf/long-chat.html?sizes=100&variants=small" /tmp/long-chat-chrome.json /tmp/long-chat-trace.json
```

The optional third argument writes the raw trace, which loads in Chrome
DevTools' Performance panel. Chrome isolates where time goes; WebKit timings
differ substantially, so confirm conclusions in WKWebView.

## Edit-heavy Pierre diffs

The same long-chat fixture accepts `diff-small`, `diff-large`, `payload-small`
and `payload-large`. Each turn edits a unique Rust file: small replaces 10
lines and large replaces 120 lines (20/240 added-plus-deleted lines per diff).
`diff-*` supplies an `Edit` call with a `worktree_delta` annotation in the chat
store; `payload-*` supplies an `apply_patch` call with a normalized `file_edit`
message. Both render through the production `ChatMessages` path. These are
separate workloads, not equal-character comparisons with the Markdown variants.

The mount report includes diff viewport, annotation block, Pierre container and
placeholder counts, plus loading/error counts, to confirm diffs actually
rendered. Inline diffs far from the visible area render as plain placeholders
(see `ResizableDiffViewport`), so only the few diffs near the viewport mount
Pierre; the run fails unless Pierre containers plus placeholders account for
every diff and at least one Pierre container rendered. The
`diffOptions` phase switches unified/word-alt to split/char, then restores the
defaults outside the measured interval. Existing theme, streaming and scrolling
phases are unchanged. The typing probe is synthetic, not native keypress latency.

```sh
PERF_OUT=/tmp/pierre-diff-build node perf/build.mjs
python3 perf/serve.py /tmp/pierre-diff-build /tmp/pierre-webkit.json
# In another terminal, with the native host compiled as above:
/tmp/VtbPerf.app/Contents/MacOS/VtbPerf 'http://127.0.0.1:18420/perf/long-chat.html?auto=1&sizes=50,100,200&variants=diff-small,diff-large,payload-small,payload-large&label=pierre-current'
```

Keep the native window visible and avoid running other CPU-heavy checks during
recorded runs. This measures the current checkout; for a before/after, build
each checkout into its own output directory. Raw results stay in temporary
local files.

Payload cases explicitly expand all tool rows before taking the mount result;
that expansion cost is included. Annotated edit diffs are already inline by
default. Diff cases fail if the expected viewport/Pierre/placeholder counts
do not match or if loading/error messages remain. Results are checkpointed after each
case with `complete: false`, and finalized with `complete: true`.

Interpret `settleMs` as elapsed time to the last observed frame gap above 50 ms,
including the synchronous commit; the quiet detection period itself is excluded.
It is not continuous frozen time. Report maximum frame gap and blocked time
separately. The trace's phase interval also includes the subsequent unmeasured
restore of theme/diff defaults, so its attribution totals are not identical to
the result's timed interval. Scrolling covers the first 9,600 px in each
direction and the first 36,000 px for the fling, not the entire transcript.
