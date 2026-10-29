use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tempfile::TempDir;
use vertebrae_harness_core::{
    CompletionStatus, EventCorrelation, EventId, EventSink, FileChangeEvent, HarnessEventPayloadV1,
    HarnessEventV1, StreamId, TextEvent, ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus,
    TurnOutcome, UpdateSemantics,
};

use super::git::Limits;
use super::*;
use crate::local_chat::annotations::MAX_ANNOTATION_LINE_BYTES;
use crate::local_chat::harnesses::shared::LocalChatHarnessEventSink;
use crate::local_chat::{
    CreateLocalChatSessionInput, HarnessCreateSessionInput, LocalChatAnnotation,
    LocalChatEventSink, LocalChatHarness, LocalChatHarnessInfo, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionError, LocalChatSessionManager,
};

const CHAT: &str = "chat-1";
const WAIT: Duration = Duration::from_secs(10);
/// Time for the recorder to take a baseline before the tool body runs, as a
/// provider's tool starts executing only after its start event.
const TOOL_STARTUP: Duration = Duration::from_millis(100);

async fn tool_starts() {
    tokio::time::sleep(TOOL_STARTUP).await;
}

fn git(dir: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args);
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(variable);
    }
    let output = command.output().expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn numbered(lines: usize) -> String {
    (1..=lines).map(|line| format!("line {line}\n")).collect()
}

/// A repository with a few committed files, canonicalized.
fn repo() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().canonicalize().unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    git(&path, &["config", "user.email", "test@example.com"]);
    git(&path, &["config", "user.name", "Test"]);
    git(&path, &["config", "commit.gpgsign", "false"]);
    write(&path, "edit.txt", numbered(10));
    write(&path, "remove.txt", "gone\n");
    write(&path, "move.txt", "moving content\nsecond line\n");
    write(&path, ".gitignore", "ignored/\n*.log\n");
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-q", "-m", "init"]);
    (dir, path)
}

fn write(root: &Path, path: &str, content: impl AsRef<[u8]>) {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(full, content).unwrap();
}

fn fast_config() -> RecorderConfig {
    RecorderConfig {
        settle_delay: Duration::from_millis(20),
        settle_interval: Duration::from_millis(20),
        settle_timeout: Duration::from_millis(500),
        idle_interval: Duration::from_millis(20),
        channel_capacity: 512,
        limits: Limits::default(),
    }
}

fn store() -> (TempDir, LocalChatAnnotationStore) {
    let dir = TempDir::new().unwrap();
    let store = LocalChatAnnotationStore::new(
        Ok(dir.path().to_path_buf()),
        LocalChatEventSink::inert_for_tests(),
    );
    (dir, store)
}

fn event(
    backend: &str,
    sequence: u64,
    child: bool,
    parent: Option<&str>,
    payload: HarnessEventPayloadV1,
) -> HarnessEventV1 {
    let stream = if child {
        format!("local-chat:{backend}:thread:child")
    } else {
        format!("local-chat:{backend}")
    };
    HarnessEventV1 {
        event_id: EventId::new(format!("event-{sequence}")),
        stream_id: StreamId::new(stream),
        sequence,
        correlation: EventCorrelation {
            parent_tool_call_id: parent.map(ToolCallId::new),
            ..EventCorrelation::default()
        },
        timestamp: chrono::Utc::now(),
        semantics: UpdateSemantics::Snapshot,
        provider_sequence: None,
        payload,
    }
}

fn tool_call(id: &str, name: &str) -> HarnessEventPayloadV1 {
    HarnessEventPayloadV1::ToolCall(ToolCallEvent {
        tool_call_id: ToolCallId::new(id),
        name: name.into(),
        input: json!({}),
        status: ToolStatus::Started,
    })
}

fn tool_output(id: &str) -> HarnessEventPayloadV1 {
    HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
        tool_call_id: ToolCallId::new(id),
        output: json!("ok"),
        status: ToolStatus::Completed,
        content_semantics: UpdateSemantics::Snapshot,
    })
}

fn file_change(id: &str, status: ToolStatus) -> HarnessEventPayloadV1 {
    HarnessEventPayloadV1::FileChange(FileChangeEvent {
        tool_call_id: Some(ToolCallId::new(id)),
        changes: Vec::new(),
        status,
    })
}

fn turn_finished() -> HarnessEventPayloadV1 {
    HarnessEventPayloadV1::TurnFinished(TurnOutcome {
        status: CompletionStatus::Completed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: Default::default(),
        error: None,
    })
}

/// One runtime's projection feeding a recorder, the way a live Claude or
/// Codex session does.
struct Session {
    backend: String,
    sink: LocalChatHarnessEventSink,
    captured: Arc<std::sync::Mutex<Vec<crate::local_chat::LocalChatEvent>>>,
    sequence: AtomicU64,
    store: LocalChatAnnotationStore,
    chat: String,
}

impl Session {
    fn new(backend: &str, chat: &str, tap: RecordingTap, store: LocalChatAnnotationStore) -> Self {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        Self {
            backend: backend.into(),
            sink: LocalChatHarnessEventSink::new(
                backend.into(),
                LocalChatHarnessKind::Claude,
                event_sink,
                None,
                0,
                false,
            )
            .with_recording(tap),
            captured,
            sequence: AtomicU64::new(0),
            store,
            chat: chat.into(),
        }
    }

    fn recording(worktree: &Path, store: LocalChatAnnotationStore, config: RecorderConfig) -> Self {
        let tap = RecordingTap::default();
        tap.start(CHAT.into(), worktree.to_path_buf(), store.clone(), config);
        Self::new("backend-1", CHAT, tap, store)
    }

    async fn root(&self, payload: HarnessEventPayloadV1) {
        self.emit(false, None, payload).await;
    }

    async fn child(&self, parent: Option<&str>, payload: HarnessEventPayloadV1) {
        self.emit(true, parent, payload).await;
    }

    async fn emit(&self, child: bool, parent: Option<&str>, payload: HarnessEventPayloadV1) {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.sink
            .emit(event(&self.backend, sequence, child, parent, payload))
            .await
            .expect("chat events keep flowing");
    }

    /// A root tool call that runs `work` between its call and its output.
    async fn tool(&self, id: &str, work: impl FnOnce()) {
        self.root(tool_call(id, "Bash")).await;
        tool_starts().await;
        work();
        self.root(tool_output(id)).await;
    }

    /// A root tool call whose provider runs `work` the instant the call is
    /// announced, before the recorder can snapshot anything.
    async fn racing_tool(&self, id: &str, work: impl FnOnce()) {
        self.root(tool_call(id, "Edit")).await;
        work();
        tool_starts().await;
        self.root(tool_output(id)).await;
    }

    fn annotations(&self) -> BTreeMap<String, LocalChatAnnotation> {
        self.store
            .load(&self.chat)
            .unwrap()
            .into_iter()
            .map(|annotation| (annotation.tool_id.clone(), annotation))
            .collect()
    }

    async fn annotation(&self, tool_id: &str) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(annotation) = self.annotations().remove(tool_id) {
                assert_eq!(annotation.kind, "worktree_delta");
                assert_eq!(annotation.session_id, self.chat);
                return annotation.payload;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no annotation for {tool_id}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// A tool whose annotation proves every earlier event was processed.
    async fn sentinel(&self, worktree: &Path, name: &str) {
        self.tool(name, || write(worktree, &format!("{name}.sentinel"), name))
            .await;
        self.annotation(name).await;
    }

    fn assert_none(&self, tool_id: &str) {
        assert!(
            !self.annotations().contains_key(tool_id),
            "unexpected annotation for {tool_id}"
        );
    }
}

fn files(payload: &Value) -> Vec<Value> {
    payload["files"].as_array().unwrap().clone()
}

fn paths(payload: &Value) -> Vec<String> {
    files(payload)
        .iter()
        .map(|file| file["path"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn shell_tool_records_modify_add_delete_and_plain_mv_as_an_exact_patch() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    let head = git(&worktree, &["rev-parse", "HEAD"]);

    session
        .tool("toolu_1", || {
            write(
                &worktree,
                "edit.txt",
                numbered(10).replace("line 5\n", "line five\n"),
            );
            write(&worktree, "new.txt", "fresh\n");
            std::fs::remove_file(worktree.join("remove.txt")).unwrap();
            std::fs::rename(worktree.join("move.txt"), worktree.join("moved.txt")).unwrap();
        })
        .await;
    let payload = session.annotation("toolu_1").await;

    assert_eq!(
        payload["patch"].as_str().unwrap(),
        "diff --git a/edit.txt b/edit.txt\n\
         --- a/edit.txt\n\
         +++ b/edit.txt\n\
         @@ -2,7 +2,7 @@\n \
         line 2\n \
         line 3\n \
         line 4\n\
         -line 5\n\
         +line five\n \
         line 6\n \
         line 7\n \
         line 8\n\
         diff --git a/move.txt b/moved.txt\n\
         similarity index 100%\n\
         rename from move.txt\n\
         rename to moved.txt\n\
         diff --git a/new.txt b/new.txt\n\
         new file mode 100644\n\
         --- /dev/null\n\
         +++ b/new.txt\n\
         @@ -0,0 +1 @@\n\
         +fresh\n\
         diff --git a/remove.txt b/remove.txt\n\
         deleted file mode 100644\n\
         --- a/remove.txt\n\
         +++ /dev/null\n\
         @@ -1 +0,0 @@\n\
         -gone\n"
    );
    assert_eq!(
        payload["files"],
        json!([
            {"path": "edit.txt", "status": "modified"},
            {"path": "moved.txt", "old_path": "move.txt", "status": "renamed"},
            {"path": "new.txt", "status": "added"},
            {"path": "remove.txt", "status": "deleted"},
        ])
    );
    assert_eq!(payload["worktree"], json!(worktree.to_string_lossy()));
    assert_eq!(payload["base_head"], json!(head));
    assert_eq!(payload["head_changed"], json!(false));
    assert_eq!(payload["aggregate"], json!(false));
    assert_eq!(payload["overlapping"], json!(false));

    // The patch applies to the base commit and reproduces the worktree.
    let clone = TempDir::new().unwrap();
    git(
        clone.path(),
        &["clone", "-q", &worktree.to_string_lossy(), "."],
    );
    let patch_file = clone.path().join("delta.patch");
    std::fs::write(&patch_file, payload["patch"].as_str().unwrap()).unwrap();
    git(clone.path(), &["apply", "delta.patch"]);
    for path in ["edit.txt", "moved.txt", "new.txt"] {
        assert_eq!(
            std::fs::read(clone.path().join(path)).unwrap(),
            std::fs::read(worktree.join(path)).unwrap(),
            "{path}"
        );
    }
    assert!(!clone.path().join("remove.txt").exists());
    assert!(!clone.path().join("move.txt").exists());
}

#[tokio::test]
async fn later_tools_record_only_their_increment_reverts_and_no_ops() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    let first = numbered(10).replace("line 2\n", "line two\n");
    let second = first.replace("line 9\n", "line nine\n");

    session
        .tool("toolu_1", || write(&worktree, "edit.txt", &first))
        .await;
    session.annotation("toolu_1").await;
    session
        .tool("toolu_2", || write(&worktree, "edit.txt", &second))
        .await;
    let increment = session.annotation("toolu_2").await;
    session
        .tool("toolu_3", || write(&worktree, "edit.txt", numbered(10)))
        .await;
    let revert = session.annotation("toolu_3").await;
    session.tool("toolu_4", || {}).await;
    session.sentinel(&worktree, "sentinel").await;

    assert_eq!(
        increment["patch"].as_str().unwrap(),
        "diff --git a/edit.txt b/edit.txt\n--- a/edit.txt\n+++ b/edit.txt\n\
         @@ -6,5 +6,5 @@\n line 6\n line 7\n line 8\n-line 9\n+line nine\n line 10\n"
    );
    assert_eq!(
        revert["patch"].as_str().unwrap(),
        "diff --git a/edit.txt b/edit.txt\n--- a/edit.txt\n+++ b/edit.txt\n\
         @@ -1,10 +1,10 @@\n line 1\n-line two\n+line 2\n line 3\n line 4\n line 5\n \
         line 6\n line 7\n line 8\n-line nine\n+line 9\n line 10\n"
    );
    session.assert_none("toolu_4");
}

#[tokio::test]
async fn existing_changes_idle_edits_and_ignored_files_are_never_attributed() {
    let (_repo, worktree) = repo();
    write(&worktree, "edit.txt", "dirty before recording\n");
    write(&worktree, "untracked.txt", "already here\n");
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());

    session
        .tool("toolu_1", || {
            write(&worktree, "a.txt", "a\n");
            write(&worktree, "ignored/cache.bin", "x");
            write(&worktree, "debug.log", "noise\n");
        })
        .await;
    let first = session.annotation("toolu_1").await;
    // Between tool windows nothing is attributed.
    write(&worktree, "idle.txt", "idle edit\n");
    write(&worktree, "edit.txt", "edited while idle\n");
    tokio::time::sleep(Duration::from_millis(150)).await;
    session
        .tool("toolu_2", || write(&worktree, "b.txt", "b\n"))
        .await;
    let second = session.annotation("toolu_2").await;

    assert_eq!(paths(&first), ["a.txt"]);
    assert_eq!(paths(&second), ["b.txt"]);
}

#[tokio::test]
async fn a_committing_tool_still_records_its_files_with_head_changed() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    let base = git(&worktree, &["rev-parse", "HEAD"]);

    session
        .tool("toolu_commit", || {
            write(
                &worktree,
                "edit.txt",
                numbered(10).replace("line 1\n", "line one\n"),
            );
            write(&worktree, "committed.txt", "new\n");
            git(&worktree, &["add", "-A"]);
            git(&worktree, &["commit", "-q", "-m", "tool commit"]);
        })
        .await;
    let payload = session.annotation("toolu_commit").await;

    assert_eq!(payload["head_changed"], json!(true));
    assert_eq!(payload["base_head"], json!(base));
    assert_eq!(paths(&payload), ["committed.txt", "edit.txt"]);
    assert!(payload["patch"]
        .as_str()
        .unwrap()
        .contains("-line 1\n+line one\n"));
}

#[tokio::test]
async fn binary_oversized_uncached_and_over_limit_files_become_markers() {
    let (_repo, worktree) = repo();
    write(&worktree, "cached.txt", "first dirty\n");
    write(&worktree, "uncached.txt", "second dirty\n");
    let (_annotations, store) = store();
    let mut config = fast_config();
    config.limits.cache_paths = 1;
    config.limits.patch_bytes = 300;
    let session = Session::recording(&worktree, store, config);

    session
        .tool("toolu_1", || {
            write(&worktree, "blob.bin", b"\x00\x01binary");
            write(&worktree, "huge.txt", "x".repeat(1024 * 1024 + 1));
            write(&worktree, "uncached.txt", "second dirty, changed\n");
            write(&worktree, "a-small.txt", "small\n");
            write(&worktree, "z-big.txt", "y\n".repeat(400));
        })
        .await;
    let payload = session.annotation("toolu_1").await;

    assert_eq!(
        payload["files"],
        json!([
            {"path": "a-small.txt", "status": "added"},
            {"path": "blob.bin", "status": "added", "marker": {"reason": "binary"}},
            {"path": "huge.txt", "status": "added", "marker": {"reason": "too_large"}},
            {"path": "uncached.txt", "status": "modified", "marker": {"reason": "baseline_unavailable"}},
            {"path": "z-big.txt", "status": "added", "marker": {"reason": "patch_limit"}},
        ])
    );
    let patch = payload["patch"].as_str().unwrap();
    assert!(patch.len() <= 300);
    assert!(patch.contains("+small\n"));
    let line = serde_json::to_vec(&session.annotations()["toolu_1"]).unwrap();
    assert!(line.len() < MAX_ANNOTATION_LINE_BYTES);
}

#[tokio::test]
async fn claude_message_with_two_tool_calls_attributes_each_change_with_overlap() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());

    session.root(tool_call("toolu_a", "Bash")).await;
    session.root(tool_call("toolu_b", "Edit")).await;
    tool_starts().await;
    write(&worktree, "a.txt", "a\n");
    session.root(tool_output("toolu_a")).await;
    session.annotation("toolu_a").await;
    write(&worktree, "b.txt", "b\n");
    session.root(tool_output("toolu_b")).await;

    let a = session.annotation("toolu_a").await;
    let b = session.annotation("toolu_b").await;
    assert_eq!(paths(&a), ["a.txt"]);
    assert_eq!(paths(&b), ["b.txt"]);
    assert_eq!(a["overlapping"], json!(true));
    assert_eq!(b["overlapping"], json!(true));
}

#[tokio::test]
async fn spawn_tool_aggregates_subagent_changes_and_child_tools_get_nothing() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());

    session.root(tool_call("toolu_agent", "Agent")).await;
    session
        .child(Some("toolu_agent"), tool_call("toolu_child", "Write"))
        .await;
    tool_starts().await;
    write(&worktree, "from-subagent.txt", "child\n");
    session
        .child(Some("toolu_agent"), tool_output("toolu_child"))
        .await;
    session
        .child(
            Some("toolu_agent"),
            HarnessEventPayloadV1::Text(TextEvent {
                text: "done".into(),
                completion_status: None,
            }),
        )
        .await;
    session.root(tool_output("toolu_agent")).await;
    let agent = session.annotation("toolu_agent").await;
    session.sentinel(&worktree, "sentinel").await;

    assert_eq!(agent["aggregate"], json!(true));
    assert_eq!(paths(&agent), ["from-subagent.txt"]);
    session.assert_none("toolu_child");
    assert_eq!(session.annotations().len(), 2);
}

#[tokio::test]
async fn codex_command_and_file_change_items_record_under_their_item_ids() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    let command = "exec-6f1c1c84-0d3e-4e83-9c43-6df1f3a1d1a1";
    let edit = "exec-0b5c2a51-7a35-4c0e-8d0f-3f8e1f2a9b77";

    session
        .tool(command, || write(&worktree, "command.txt", "ran\n"))
        .await;
    session.root(file_change(edit, ToolStatus::Started)).await;
    tool_starts().await;
    write(&worktree, "patched.txt", "applied\n");
    session.root(file_change(edit, ToolStatus::Completed)).await;

    assert_eq!(paths(&session.annotation(command).await), ["command.txt"]);
    assert_eq!(paths(&session.annotation(edit).await), ["patched.txt"]);
}

#[tokio::test]
async fn windows_open_at_turn_end_are_dropped() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());

    session.root(tool_call("toolu_open", "Bash")).await;
    tool_starts().await;
    write(&worktree, "interrupted.txt", "partial\n");
    session.root(turn_finished()).await;
    session.root(tool_output("toolu_open")).await;
    session.sentinel(&worktree, "sentinel").await;

    session.assert_none("toolu_open");
}

fn tree_state(worktree: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, state: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                walk(root, &path, state);
            } else {
                let metadata = std::fs::metadata(&path).unwrap();
                let mut value = std::fs::read(&path).unwrap();
                if relative == ".git/index" {
                    value.extend_from_slice(
                        format!("{:?}", metadata.modified().unwrap()).as_bytes(),
                    );
                }
                state.insert(relative, value);
            }
        }
    }
    let mut state = BTreeMap::new();
    walk(worktree, worktree, &mut state);
    state
}

#[tokio::test]
async fn recording_never_writes_the_index_refs_objects_or_worktree() {
    let (_repo, worktree) = repo();
    // Make the index stat data stale so a refreshing status would rewrite it.
    std::thread::sleep(Duration::from_millis(1100));
    write(&worktree, "edit.txt", numbered(10));
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    let mut expected = tree_state(&worktree);

    session
        .tool("toolu_1", || {
            write(&worktree, "edit.txt", "rewritten\n");
            write(&worktree, "new/nested.txt", "nested\n");
            std::fs::remove_file(worktree.join("remove.txt")).unwrap();
        })
        .await;
    session.annotation("toolu_1").await;
    session
        .tool("toolu_2", || write(&worktree, "edit.txt", numbered(10)))
        .await;
    session.annotation("toolu_2").await;

    expected.insert("edit.txt".into(), numbered(10).into_bytes());
    expected.insert("new/nested.txt".into(), b"nested\n".to_vec());
    expected.remove("remove.txt");
    assert_eq!(tree_state(&worktree), expected);
}

#[tokio::test]
async fn missing_non_git_or_removed_worktrees_yield_nothing_and_chat_continues() {
    let (_annotations, store) = store();
    let plain = TempDir::new().unwrap();
    let session = Session::recording(plain.path(), store.clone(), fast_config());
    session
        .tool("toolu_plain", || write(plain.path(), "a.txt", "a\n"))
        .await;

    let (repo_dir, worktree) = repo();
    let removed = Session::recording(&worktree, store.clone(), fast_config());
    removed.root(tool_call("toolu_removed", "Bash")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(repo_dir);
    removed.root(tool_output("toolu_removed")).await;

    let (_other, live) = repo();
    let healthy = Session::recording(&live, store, fast_config());
    healthy.sentinel(&live, "sentinel").await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    session.assert_none("toolu_plain");
    removed.assert_none("toolu_removed");
    assert!(!session.captured.lock().unwrap().is_empty());
    assert!(!removed.captured.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_files_are_marked_and_later_tools_record_normally() {
    use std::os::unix::fs::PermissionsExt;
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());

    session
        .tool("toolu_1", || {
            write(&worktree, "secret.txt", "hidden\n");
            std::fs::set_permissions(
                worktree.join("secret.txt"),
                std::fs::Permissions::from_mode(0o000),
            )
            .unwrap();
        })
        .await;
    let payload = session.annotation("toolu_1").await;
    std::fs::set_permissions(
        worktree.join("secret.txt"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    session
        .tool("toolu_2", || write(&worktree, "later.txt", "ok\n"))
        .await;

    assert_eq!(
        payload["files"],
        json!([{"path": "secret.txt", "status": "added", "marker": {"reason": "unreadable"}}])
    );
    assert_eq!(paths(&session.annotation("toolu_2").await), ["later.txt"]);
}

#[tokio::test]
async fn a_full_channel_drops_the_backlog_and_later_tools_record() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let mut config = fast_config();
    config.channel_capacity = 1;
    config.settle_delay = Duration::from_millis(200);
    let session = Session::recording(&worktree, store, config);

    session.root(tool_call("toolu_1", "Bash")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    write(&worktree, "one.txt", "1\n");
    session.root(tool_output("toolu_1")).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The recorder is settling toolu_1, so these overflow the channel.
    session
        .tool("toolu_2", || write(&worktree, "two.txt", "2\n"))
        .await;
    session.root(tool_call("toolu_3", "Bash")).await;
    session.annotation("toolu_1").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    session
        .tool("toolu_4", || write(&worktree, "four.txt", "4\n"))
        .await;

    assert_eq!(paths(&session.annotation("toolu_4").await), ["four.txt"]);
    session.assert_none("toolu_2");
    session.assert_none("toolu_3");
}

#[tokio::test]
async fn append_failures_are_logged_and_recording_continues() {
    let (_repo, worktree) = repo();
    let annotations = TempDir::new().unwrap();
    let blocked = annotations.path().join("store");
    std::fs::write(&blocked, "not a directory").unwrap();
    let store =
        LocalChatAnnotationStore::new(Ok(blocked.clone()), LocalChatEventSink::inert_for_tests());
    let session = Session::recording(&worktree, store, fast_config());

    session
        .tool("toolu_1", || write(&worktree, "one.txt", "1\n"))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::remove_file(&blocked).unwrap();
    session
        .tool("toolu_2", || write(&worktree, "two.txt", "2\n"))
        .await;

    assert_eq!(paths(&session.annotation("toolu_2").await), ["two.txt"]);
    session.assert_none("toolu_1");
}

#[tokio::test]
async fn stopping_discards_open_windows_and_late_results() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let mut config = fast_config();
    config.settle_delay = Duration::from_millis(200);
    let tap = RecordingTap::default();
    tap.start(CHAT.into(), worktree.clone(), store.clone(), config);
    let session = Session::new("backend-1", CHAT, tap.clone(), store);

    session
        .tool("toolu_late", || write(&worktree, "late.txt", "late\n"))
        .await;
    tap.stop();
    session
        .tool("toolu_after", || write(&worktree, "after.txt", "after\n"))
        .await;
    tokio::time::sleep(Duration::from_millis(600)).await;

    assert!(session.annotations().is_empty());
    assert_eq!(tap.worktree(), None);
}

struct IdleHarness;

#[async_trait]
impl LocalChatHarness for IdleHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        LocalChatHarnessKind::Claude
    }

    async fn info(&self) -> LocalChatHarnessInfo {
        LocalChatHarnessInfo {
            harness: LocalChatHarnessKind::Claude,
            label: "Claude".into(),
            available: true,
            unavailable_reason: None,
            default_model_id: None,
            models: Vec::new(),
            default_reasoning_effort: None,
            reasoning_efforts: Vec::new(),
            speed_tiers: Vec::new(),
            permission_modes: None,
            personality_options: None,
            supports_resume: true,
        }
    }

    async fn create_session(
        &self,
        _input: HarnessCreateSessionInput,
        _runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        Ok(())
    }

    async fn send_message(&self, _: &str, _: &str) -> Result<(), LocalChatSessionError> {
        Ok(())
    }

    async fn close_session(&self, _: &str) -> Result<(), LocalChatSessionError> {
        Ok(())
    }

    async fn has_session(&self, _: &str) -> bool {
        true
    }
}

fn manager(store: &LocalChatAnnotationStore) -> LocalChatSessionManager {
    LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(IdleHarness)])
        .with_annotation_store(store.clone())
        .with_recorder_config_for_tests(fast_config())
}

fn input(
    backend: &str,
    chat: &str,
    project: &Path,
    worktree: Option<&Path>,
) -> CreateLocalChatSessionInput {
    CreateLocalChatSessionInput {
        harness: LocalChatHarnessKind::Claude,
        backend_session_id: backend.into(),
        chat_session_id: chat.into(),
        recording_worktree: worktree.map(|path| path.to_string_lossy().into_owned()),
        working_dir: Some(project.to_string_lossy().into_owned()),
        initial_prompt: None,
        provider_resume_id: None,
        model_id: None,
        reasoning_effort: None,
        speed_tier: None,
        permission_mode: None,
        personality: None,
        provider_id: None,
        gate: None,
    }
}

/// Start a runtime through the manager and return its projection.
async fn start(
    manager: &LocalChatSessionManager,
    store: &LocalChatAnnotationStore,
    input: CreateLocalChatSessionInput,
) -> Session {
    let runtime = LocalChatRuntime::inert_for_tests();
    let tap = runtime.recording();
    let (backend, chat) = (
        input.backend_session_id.clone(),
        input.chat_session_id.clone(),
    );
    manager
        .create_session_with_runtime(input, runtime)
        .await
        .unwrap();
    Session::new(&backend, &chat, tap, store.clone())
}

#[tokio::test]
async fn concurrent_sessions_record_their_own_worktrees_under_their_chat_ids() {
    let (_repo, project) = repo();
    let linked_dir = TempDir::new().unwrap();
    let linked = linked_dir.path().canonicalize().unwrap().join("linked");
    git(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            &linked.to_string_lossy(),
        ],
    );
    let (_annotations, store) = store();
    let manager = manager(&store);

    let main = start(
        &manager,
        &store,
        input("local-chat-a-1", "chat-a", &project, Some(&project)),
    )
    .await;
    let side = start(
        &manager,
        &store,
        input("local-chat-b-1", "chat-b", &project, Some(&linked)),
    )
    .await;
    main.tool("toolu_main", || write(&project, "main.txt", "main\n"))
        .await;
    side.tool("toolu_side", || write(&linked, "side.txt", "side\n"))
        .await;
    let main_payload = main.annotation("toolu_main").await;
    let side_payload = side.annotation("toolu_side").await;

    // A restarted runtime of chat-b keeps recording under chat-b.
    manager.close_session("local-chat-b-1").await.unwrap();
    let restarted = start(
        &manager,
        &store,
        input("local-chat-b-2", "chat-b", &project, Some(&linked)),
    )
    .await;
    restarted
        .tool("toolu_again", || write(&linked, "again.txt", "again\n"))
        .await;
    let again = restarted.annotation("toolu_again").await;

    assert_eq!(paths(&main_payload), ["main.txt"]);
    assert_eq!(main_payload["worktree"], json!(project.to_string_lossy()));
    assert_eq!(paths(&side_payload), ["side.txt"]);
    assert_eq!(side_payload["worktree"], json!(linked.to_string_lossy()));
    assert_eq!(paths(&again), ["again.txt"]);
    assert_eq!(
        main.annotations().keys().collect::<Vec<_>>(),
        ["toolu_main"]
    );
    assert_eq!(
        restarted.annotations().keys().collect::<Vec<_>>(),
        ["toolu_again", "toolu_side"]
    );
}

#[tokio::test]
async fn recording_target_contract_validates_switches_and_clears() {
    let (_repo, project) = repo();
    let (_elsewhere, foreign) = repo();
    let (_annotations, store) = store();
    let manager = manager(&store);
    let session = start(&manager, &store, input("backend-1", CHAT, &project, None)).await;

    // No target: nothing is recorded.
    session
        .tool("toolu_off", || write(&project, "off.txt", "off\n"))
        .await;
    let foreign_error = manager
        .set_recording_worktree("backend-1", Some(foreign.to_string_lossy().into_owned()))
        .await
        .unwrap_err();
    let unknown_error = manager
        .set_recording_worktree("missing", Some(project.to_string_lossy().into_owned()))
        .await
        .unwrap_err();
    manager
        .set_recording_worktree("backend-1", Some(project.to_string_lossy().into_owned()))
        .await
        .unwrap();
    session
        .tool("toolu_on", || write(&project, "on.txt", "on\n"))
        .await;
    session.annotation("toolu_on").await;

    // Changing the target drops the open window.
    session.root(tool_call("toolu_switched", "Bash")).await;
    tool_starts().await;
    write(&project, "switched.txt", "switched\n");
    let linked_dir = TempDir::new().unwrap();
    let linked = linked_dir.path().canonicalize().unwrap().join("linked");
    git(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            &linked.to_string_lossy(),
        ],
    );
    manager
        .set_recording_worktree("backend-1", Some(linked.to_string_lossy().into_owned()))
        .await
        .unwrap();
    session.root(tool_output("toolu_switched")).await;
    session.sentinel(&linked, "sentinel").await;

    // Clearing stops recording.
    manager
        .set_recording_worktree("backend-1", None)
        .await
        .unwrap();
    session
        .tool("toolu_cleared", || write(&linked, "cleared.txt", "x\n"))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(matches!(
        foreign_error,
        LocalChatSessionError::InvalidRecordingWorktree(_)
    ));
    assert_eq!(
        unknown_error,
        LocalChatSessionError::SessionNotFound("missing".into())
    );
    assert_eq!(
        session.annotations().keys().collect::<Vec<_>>(),
        ["sentinel", "toolu_on"]
    );
}

#[tokio::test]
async fn close_project_switch_and_shutdown_stop_recording() {
    let (_repo, project) = repo();
    let (_annotations, store) = store();
    let manager = manager(&store);

    let closed = start(
        &manager,
        &store,
        input("b-closed", "chat-closed", &project, Some(&project)),
    )
    .await;
    manager.close_session("b-closed").await.unwrap();
    closed
        .tool("toolu_closed", || write(&project, "closed.txt", "x\n"))
        .await;

    let switched = start(
        &manager,
        &store,
        input("b-switch", "chat-switch", &project, Some(&project)),
    )
    .await;
    switched.root(tool_call("toolu_switch", "Bash")).await;
    tool_starts().await;
    drop(manager.begin_project_switch().await);
    write(&project, "switch.txt", "x\n");
    switched.root(tool_output("toolu_switch")).await;

    let shut = start(
        &manager,
        &store,
        input("b-shut", "chat-shut", &project, Some(&project)),
    )
    .await;
    manager.shutdown().await;
    shut.tool("toolu_shut", || write(&project, "shut.txt", "x\n"))
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    assert!(closed.annotations().is_empty());
    assert!(switched.annotations().is_empty());
    assert!(shut.annotations().is_empty());
}

#[tokio::test]
async fn an_invalid_create_target_leaves_recording_off_but_starts_the_chat() {
    let (_repo, project) = repo();
    let (_elsewhere, foreign) = repo();
    let (_annotations, store) = store();
    let manager = manager(&store);

    let session = start(
        &manager,
        &store,
        input("backend-1", CHAT, &project, Some(&foreign)),
    )
    .await;
    session
        .tool("toolu_1", || write(&foreign, "a.txt", "a\n"))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(manager.has_session("backend-1").await);
    assert!(session.annotations().is_empty());
}

#[tokio::test]
async fn a_tool_that_finishes_before_its_snapshot_is_still_attributed() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    tokio::time::sleep(Duration::from_millis(100)).await;

    session
        .racing_tool("toolu_1", || write(&worktree, "quick.txt", "quick\n"))
        .await;

    assert_eq!(paths(&session.annotation("toolu_1").await), ["quick.txt"]);
}

mod patch_roundtrip;
mod recorder_attribution;
