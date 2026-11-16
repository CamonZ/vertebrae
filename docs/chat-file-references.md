# File references in chat

File references belong to the conversation turn in which they appear. Opening
an earlier reference must not silently substitute today's file or a file in
another worktree.

## Viewing a file

A file link opens the read-only Pierre source panel. **At this turn** shows the
recorded contents at the completion of that turn. **Latest file** explicitly
reads the same path in its associated worktree. A deleted or unavailable file
is explained in the panel; there is no automatic fallback to main.

The latest-file view can open the corresponding local file in the configured
external editor. Historical contents never enter the editable document store.
Line anchors describe the referenced version; later edits can move those lines.

Use complete repository-relative Markdown destinations for the conversation's
worktree, preserving line/column anchors where useful. An absolute destination
can explicitly identify the project checkout, but a turn capture does not
provide historical contents for an unrelated checkout. Method names such as
`.map` and `.unwrap()` remain code.

## What is recorded

When a runtime starts recording an associated worktree, it saves an association
baseline: a Git commit identity plus its existing working-directory changes.
Each completed, correlated turn saves a cumulative patch against that baseline
commit, including supported nonignored untracked files and externally made edits visible
at the boundary. An unchanged turn still gets a capture. Changing the association
or restarting the recorder starts another baseline; earlier turn records remain
bound to their original context.

These records belong to the existing per-conversation annotation store, with
explicit association and turn subjects. The store keeps immutable keyed capture
bodies on disk and sends only bounded metadata to the webview. Reading one
historical file loads its selected capture directly, without parsing the session
log. Existing inline history records migrate when the session metadata is loaded.
Tool-change annotations retain their separate JSONL contract. No
reference destination or click timing is persisted in browser localStorage.
The retired file-reference cache is removed when the association drivers mount.

The baseline commit is retained by an app-owned `refs/vertebrae/chat-history/`
reference. A small ownership record is published before ref creation, and creation
shares the deletion lock. An interrupted baseline initialization therefore leaves
a discoverable owner that conversation cleanup can use. Deleting the conversation or sweeping its orphaned annotations also
releases its retained references. The normal worktree files, index and branches
are not changed by capture. Per-file reconstruction applies only the selected
file's patch in a private in-memory Git object database. It can work after a
linked worktree is removed, provided the common repository remains available.

## Boundaries and unavailable history

Turn origin is recorded independently when the correlated turn starts. A delayed
or failed capture does not authorize using today's assignment. A link with unknown
origin cannot open an inferred latest checkout. An open panel follows the original
origin when its metadata arrives.

The captured context is the completed turn's observed state, not every read or
intermediate edit within the turn. Tool events remain non-blocking. A correlated turn terminal waits at most five
seconds for its capture before reaching the UI, so queued next turns cannot
normally race the capture. If that wait expires, the recorder must not publish
a late observation as that turn's state. Annotation events make captures available
to open windows; a source panel opened earlier refreshes when its capture arrives.

Capture uses the recorder's existing bounds: 1 MiB per file side, 64 MiB cached
contents, 2,000 cached dirty paths, 5,000 status entries and a 1 MiB patch budget.
Binary, oversized, unreadable or uncached contents are explicitly unavailable.
Clean paths affected by Git text/encoding/filter transformations are also marked
unavailable unless their actual contents were captured; a normalized Git blob is
not claimed to be the observed filesystem bytes. Capture retains its own side-size
limit for later reads.
Ignored files are not captured; absence from a captured state does not establish
that such a file never existed on disk.
A failed capture or a following tool already queued during capture is not
represented as a successful historical state. Later cumulative captures do not
depend on earlier captures succeeding. Duplicate terminal events do not rewrite
an already-recorded turn.

Older conversations without captures cannot promise historical reconstruction.
Their references explain the missing context. Latest-file viewing requires a
known original checkout or an explicitly named checkout; it cannot use a later
conversation assignment. Moving or deleting the common repository can also make history unavailable.

History follows the annotation store's existing restart/reload contract; it does
not add an fsync-based power-loss guarantee or a crash-atomic transaction across
Git refs and annotation records. The small header is the commit point for a keyed
capture. Readers and deletion share the publication lock. Expired publication is
retired as unavailable before readers are admitted, and duplicate terminals are
filtered before queueing so they cannot incur a second five-second wait. Incomplete records are skipped, and reported baseline-write
failures release their newly created retention ref.
