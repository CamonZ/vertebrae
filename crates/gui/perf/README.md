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
