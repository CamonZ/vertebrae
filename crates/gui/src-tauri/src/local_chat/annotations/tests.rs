use std::collections::HashSet;
use std::io::Write as _;

use serde_json::json;
use tempfile::{tempdir, TempDir};

use super::*;

fn store_in(dir: &TempDir) -> LocalChatAnnotationStore {
    LocalChatAnnotationStore::new(
        Ok(dir.path().join(ANNOTATIONS_DIR)),
        LocalChatEventSink::inert_for_tests(),
    )
}

fn session_file(dir: &TempDir, session_id: &str) -> PathBuf {
    dir.path()
        .join(ANNOTATIONS_DIR)
        .join(format!("{session_id}.{ANNOTATIONS_EXTENSION}"))
}

fn annotation(
    session_id: &str,
    tool_id: &str,
    kind: &str,
    payload: serde_json::Value,
) -> LocalChatAnnotation {
    LocalChatAnnotation::new(session_id, tool_id, kind, payload)
}

fn write_raw(dir: &TempDir, session_id: &str, raw: &[u8]) {
    fs::create_dir_all(dir.path().join(ANNOTATIONS_DIR)).unwrap();
    fs::write(session_file(dir, session_id), raw).unwrap();
}

fn line(entry: &LocalChatAnnotation) -> String {
    format!("{}\n", serde_json::to_string(entry).unwrap())
}

#[test]
fn appended_entries_load_back_in_order_after_the_store_is_recreated() {
    let dir = tempdir().unwrap();
    let first = annotation(
        "chat-1",
        "toolu_1",
        "worktree_delta",
        json!({ "patch": "a" }),
    );
    let second = annotation(
        "chat-1",
        "exec-2",
        "worktree_delta",
        json!({ "patch": "b" }),
    );
    let unknown_kind = annotation("chat-1", "toolu_1", "future_kind", json!([1, 2]));
    {
        let store = store_in(&dir);
        store.append(first.clone()).unwrap();
        store.append(second.clone()).unwrap();
        store.append(unknown_kind.clone()).unwrap();
    }

    let loaded = store_in(&dir).load("chat-1").unwrap();

    assert_eq!(loaded, vec![first, second, unknown_kind]);
    assert!(chrono::DateTime::parse_from_rfc3339(&loaded[0].recorded_at).is_ok());
}

#[test]
fn append_emits_the_annotation_event_for_its_session() {
    let dir = tempdir().unwrap();
    let (sink, captured) = LocalChatEventSink::capturing_for_tests();
    let store = LocalChatAnnotationStore::new(Ok(dir.path().join(ANNOTATIONS_DIR)), sink);
    let entry = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));

    store.append(entry.clone()).unwrap();

    let events = captured.lock().unwrap();
    assert_eq!(
        *events,
        vec![LocalChatEvent::Annotation(LocalChatAnnotationEvent {
            session_id: "chat-1".to_string(),
            annotation: entry,
        })]
    );
    assert_eq!(events[0].tauri_event_name(), "local-chat-annotation-event");
}

#[test]
fn a_repeated_tool_and_kind_resolves_to_the_last_entry() {
    let dir = tempdir().unwrap();
    let store = store_in(&dir);
    let stale = annotation("chat-1", "toolu_1", "worktree_delta", json!({ "v": 1 }));
    let other = annotation("chat-1", "toolu_2", "worktree_delta", json!({ "v": 2 }));
    let other_kind = annotation("chat-1", "toolu_1", "note", json!({ "v": 3 }));
    let latest = annotation("chat-1", "toolu_1", "worktree_delta", json!({ "v": 4 }));
    for entry in [&stale, &other, &other_kind, &latest] {
        store.append(entry.clone()).unwrap();
    }

    assert_eq!(
        store.load("chat-1").unwrap(),
        vec![other, other_kind, latest]
    );
}

#[test]
fn a_missing_file_loads_as_empty() {
    let dir = tempdir().unwrap();

    assert_eq!(store_in(&dir).load("chat-1").unwrap(), Vec::new());
}

#[test]
fn damaged_lines_are_skipped_while_every_valid_entry_loads() {
    let dir = tempdir().unwrap();
    let first = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));
    let second = annotation("chat-1", "toolu_2", "worktree_delta", json!({}));
    let foreign = annotation("chat-2", "toolu_3", "worktree_delta", json!({}));
    let raw = [
        line(&first),
        "not json\n".to_string(),
        r#"{"session_id":"chat-1","tool_id":"toolu_9"}"#.to_string() + "\n",
        "\n".to_string(),
        line(&foreign),
        line(&second),
        r#"{"session_id":"chat-1","tool_id":"#.to_string(),
    ]
    .concat();
    write_raw(&dir, "chat-1", raw.as_bytes());

    assert_eq!(store_in(&dir).load("chat-1").unwrap(), vec![first, second]);
}

#[test]
fn an_over_limit_line_is_skipped_without_losing_its_neighbours() {
    let dir = tempdir().unwrap();
    let first = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));
    let last = annotation("chat-1", "toolu_2", "worktree_delta", json!({}));
    let oversized = annotation(
        "chat-1",
        "toolu_big",
        "worktree_delta",
        json!({ "patch": "x".repeat(MAX_ANNOTATION_LINE_BYTES) }),
    );
    let mut raw = line(&first).into_bytes();
    raw.extend(line(&oversized).into_bytes());
    raw.extend(line(&last).into_bytes());
    write_raw(&dir, "chat-1", &raw);

    assert_eq!(store_in(&dir).load("chat-1").unwrap(), vec![first, last]);
}

#[test]
fn append_rejects_an_entry_over_the_line_cap() {
    let dir = tempdir().unwrap();
    let store = store_in(&dir);
    let oversized = annotation(
        "chat-1",
        "toolu_big",
        "worktree_delta",
        json!({ "patch": "x".repeat(MAX_ANNOTATION_LINE_BYTES) }),
    );

    let error = store.append(oversized).unwrap_err();

    assert!(matches!(error, AnnotationStoreError::TooLarge { .. }));
    assert!(!session_file(&dir, "chat-1").exists());
}

#[test]
fn append_after_a_truncated_line_keeps_the_new_entry_intact() {
    let dir = tempdir().unwrap();
    let first = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));
    let after = annotation("chat-1", "toolu_2", "worktree_delta", json!({}));
    write_raw(
        &dir,
        "chat-1",
        format!("{}{{\"session_id\":\"chat-1\",\"tool", line(&first)).as_bytes(),
    );
    let store = store_in(&dir);

    store.append(after.clone()).unwrap();

    assert_eq!(store.load("chat-1").unwrap(), vec![first, after]);
}

#[test]
fn concurrent_appends_to_one_session_produce_intact_lines() {
    let dir = tempdir().unwrap();
    let store = store_in(&dir);
    let payload = "y".repeat(64 * 1024);
    let threads: Vec<_> = (0..8)
        .map(|thread| {
            let store = store.clone();
            let payload = payload.clone();
            std::thread::spawn(move || {
                for call in 0..16 {
                    store
                        .append(annotation(
                            "chat-1",
                            &format!("tool-{thread}-{call}"),
                            "worktree_delta",
                            json!({ "patch": payload }),
                        ))
                        .unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }

    let raw = fs::read_to_string(session_file(&dir, "chat-1")).unwrap();
    assert_eq!(raw.lines().count(), 128);
    for raw_line in raw.lines() {
        serde_json::from_str::<LocalChatAnnotation>(raw_line).expect("intact line");
    }
    let tool_ids: HashSet<_> = store
        .load("chat-1")
        .unwrap()
        .into_iter()
        .map(|entry| entry.tool_id)
        .collect();
    assert_eq!(tool_ids.len(), 128);
}

#[test]
fn events_and_files_stay_with_their_own_session() {
    let dir = tempdir().unwrap();
    let (sink, captured) = LocalChatEventSink::capturing_for_tests();
    let store = LocalChatAnnotationStore::new(Ok(dir.path().join(ANNOTATIONS_DIR)), sink);
    let one = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));
    let two = annotation("chat-2", "toolu_1", "worktree_delta", json!({}));
    store.append(one.clone()).unwrap();
    store.append(two.clone()).unwrap();

    store.delete("chat-1").unwrap();

    assert_eq!(store.load("chat-1").unwrap(), Vec::new());
    assert_eq!(store.load("chat-2").unwrap(), vec![two]);
    let sessions: Vec<_> = captured
        .lock()
        .unwrap()
        .iter()
        .map(|event| match event {
            LocalChatEvent::Annotation(event) => (
                event.session_id.clone(),
                event.annotation.session_id.clone(),
            ),
            other => panic!("unexpected event {other:?}"),
        })
        .collect();
    assert_eq!(
        sessions,
        vec![
            ("chat-1".to_string(), "chat-1".to_string()),
            ("chat-2".to_string(), "chat-2".to_string())
        ]
    );
}

#[test]
fn deleting_an_absent_file_succeeds() {
    let dir = tempdir().unwrap();

    store_in(&dir).delete("chat-never").unwrap();
}

#[test]
fn unsafe_session_ids_are_rejected_by_append_load_and_delete() {
    let dir = tempdir().unwrap();
    let outside = dir.path().join("outside.jsonl");
    fs::write(&outside, "keep").unwrap();
    let store = store_in(&dir);

    for session_id in [
        "",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        "chat.1",
        "chat 1",
        "chat\u{e9}",
        "/tmp/abs",
        &"x".repeat(MAX_SESSION_ID_LEN + 1),
    ] {
        let invalid = |error: AnnotationStoreError| {
            assert!(
                matches!(error, AnnotationStoreError::InvalidSessionId(_)),
                "{session_id:?}: {error}"
            )
        };
        invalid(
            store
                .append(annotation(
                    session_id,
                    "toolu_1",
                    "worktree_delta",
                    json!({}),
                ))
                .unwrap_err(),
        );
        invalid(store.load(session_id).unwrap_err());
        invalid(store.delete(session_id).unwrap_err());
    }
    assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
    assert!(!dir.path().join(ANNOTATIONS_DIR).exists());
}

#[test]
fn an_unavailable_directory_fails_append_without_panicking() {
    let dir = tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    fs::File::create(&blocker)
        .unwrap()
        .write_all(b"file, not a directory")
        .unwrap();
    let store = LocalChatAnnotationStore::new(
        Ok(blocker.join(ANNOTATIONS_DIR)),
        LocalChatEventSink::inert_for_tests(),
    );
    let unavailable = LocalChatAnnotationStore::new(
        Err("no data dir".to_string()),
        LocalChatEventSink::inert_for_tests(),
    );
    let entry = annotation("chat-1", "toolu_1", "worktree_delta", json!({}));

    assert!(matches!(
        store.append(entry.clone()).unwrap_err(),
        AnnotationStoreError::Io(_)
    ));
    assert!(matches!(
        unavailable.append(entry).unwrap_err(),
        AnnotationStoreError::Unavailable(_)
    ));
}

#[test]
fn the_sweep_removes_only_unknown_sessions_without_a_live_runtime() {
    let dir = tempdir().unwrap();
    let store = store_in(&dir);
    for session_id in ["known", "orphan", "live"] {
        store
            .append(annotation(
                session_id,
                "toolu_1",
                "worktree_delta",
                json!({}),
            ))
            .unwrap();
    }
    fs::write(dir.path().join(ANNOTATIONS_DIR).join("notes.txt"), "keep").unwrap();

    let removed = store
        .sweep_orphans(
            &HashSet::from(["known".to_string()]),
            &HashSet::from(["live".to_string()]),
        )
        .unwrap();

    assert_eq!(removed, vec!["orphan".to_string()]);
    assert!(session_file(&dir, "known").exists());
    assert!(session_file(&dir, "live").exists());
    assert!(!session_file(&dir, "orphan").exists());
    assert!(dir.path().join(ANNOTATIONS_DIR).join("notes.txt").exists());
}

#[test]
fn the_sweep_of_a_missing_directory_removes_nothing() {
    let dir = tempdir().unwrap();

    assert_eq!(
        store_in(&dir)
            .sweep_orphans(&HashSet::new(), &HashSet::new())
            .unwrap(),
        Vec::<String>::new()
    );
}
