use super::*;
use crate::local_chat::LocalChatEventSink;
use std::{fs, path::Path};
use tempfile::TempDir;

fn repo(path: &Path) -> git2::Repository {
    fs::create_dir_all(path).unwrap();
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(path, &options).unwrap();
    fs::write(path.join("a.txt"), "base\n").unwrap();
    fs::write(path.join("untouched.txt"), "clean\n").unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    index.write().unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[])
        .unwrap();
    drop(tree);
    repo
}

fn store(path: &Path) -> LocalChatAnnotationStore {
    LocalChatAnnotationStore::new(Ok(path.to_owned()), LocalChatEventSink::inert_for_tests())
}

fn observe(path: &Path) -> git::Snapshot {
    git::snapshot(
        &path.canonicalize().unwrap(),
        &git::Limits::default(),
        "main",
    )
    .unwrap()
}

fn text(body: FileBody) -> String {
    let FileBody::Text { contents, .. } = body else {
        panic!("expected text, got {body:?}")
    };
    contents
}

#[test]
fn dirty_baseline_external_edits_and_independent_turns_survive_reload() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let annotations = dir.path().join("annotations");
    let store = store(&annotations);
    fs::write(path.join("a.txt"), "dirty before association\n").unwrap();
    fs::write(path.join("new.txt"), "initial untracked\n").unwrap();
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture("one", &store, Some(&observe(&path)));

    fs::write(path.join("a.txt"), "user edit between tools\n").unwrap();
    fs::remove_file(path.join("new.txt")).unwrap();
    // Simulate one missed turn: a later cumulative capture is independent.
    recorder.capture("missed", &store, None);
    recorder.capture("two", &store, Some(&observe(&path)));
    fs::remove_file(path.join("a.txt")).unwrap();
    drop(store);
    let reopened =
        LocalChatAnnotationStore::new(Ok(annotations), LocalChatEventSink::inert_for_tests());

    assert_eq!(
        text(read(&reopened, "chat", "one", "a.txt").unwrap()),
        "dirty before association\n"
    );
    assert_eq!(
        text(read(&reopened, "chat", "one", "new.txt").unwrap()),
        "initial untracked\n"
    );
    assert_eq!(
        text(read(&reopened, "chat", "two", "a.txt").unwrap()),
        "user edit between tools\n"
    );
    assert_eq!(
        read(&reopened, "chat", "two", "new.txt").unwrap(),
        FileBody::Missing
    );
    assert_eq!(
        text(read(&reopened, "chat", "two", "untouched.txt").unwrap()),
        "clean\n"
    );
    assert!(read(&reopened, "chat", "missed", "a.txt").is_err());
    assert!(read(&reopened, "chat", "one", "../escape").is_err());
    assert!(!path.join("a.txt").exists());
}

#[test]
fn renamed_deleted_and_recreated_paths_preserve_their_turn_identity() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture("before", &store, Some(&observe(&path)));
    fs::rename(path.join("a.txt"), path.join("renamed.txt")).unwrap();
    recorder.capture("renamed", &store, Some(&observe(&path)));
    fs::write(path.join("a.txt"), "different file\n").unwrap();
    recorder.capture("recreated", &store, Some(&observe(&path)));

    assert_eq!(
        text(read(&store, "chat", "before", "a.txt").unwrap()),
        "base\n"
    );
    assert_eq!(
        read(&store, "chat", "renamed", "a.txt").unwrap(),
        FileBody::Missing
    );
    assert_eq!(
        text(read(&store, "chat", "renamed", "renamed.txt").unwrap()),
        "base\n"
    );
    assert_eq!(
        text(read(&store, "chat", "recreated", "a.txt").unwrap()),
        "different file\n"
    );
}

#[test]
fn association_changes_and_duplicate_terminals_do_not_rewrite_earlier_turns() {
    let dir = TempDir::new().unwrap();
    let first = dir.path().join("one");
    let second = dir.path().join("two");
    let _one = repo(&first);
    let _two = repo(&second);
    let store = store(&dir.path().join("annotations"));
    let first_recorder = HistoryRecorder::start(
        "chat",
        &first,
        &store,
        Some(&observe(&first)),
        &git::Limits::default(),
    );
    first_recorder.capture("old", &store, Some(&observe(&first)));
    fs::write(first.join("a.txt"), "later\n").unwrap();
    first_recorder.capture("old", &store, Some(&observe(&first)));
    let second_recorder = HistoryRecorder::start(
        "chat",
        &second,
        &store,
        Some(&observe(&second)),
        &git::Limits::default(),
    );
    fs::write(second.join("a.txt"), "new checkout\n").unwrap();
    second_recorder.capture("new", &store, Some(&observe(&second)));
    second_recorder.capture("old", &store, Some(&observe(&second)));

    assert_eq!(
        text(read(&store, "chat", "old", "a.txt").unwrap()),
        "base\n"
    );
    assert_eq!(
        text(read(&store, "chat", "new", "a.txt").unwrap()),
        "new checkout\n"
    );
    assert_ne!(first_recorder.capture.epoch, second_recorder.capture.epoch);
}

#[test]
fn linked_worktree_removal_does_not_remove_history_and_session_deletion_releases_refs() {
    let dir = TempDir::new().unwrap();
    let main = dir.path().join("main");
    let repo = repo(&main);
    let linked = dir.path().join("linked");
    repo.worktree("linked", &linked, None).unwrap();
    // The linked checkout has a branch named linked.
    let observe_linked = || {
        git::snapshot(
            &linked.canonicalize().unwrap(),
            &git::Limits::default(),
            "linked",
        )
        .unwrap()
    };
    let store = store(&dir.path().join("annotations"));
    fs::write(linked.join("a.txt"), "historical linked contents\n").unwrap();
    let recorder = HistoryRecorder::start(
        "chat",
        &linked,
        &store,
        Some(&observe_linked()),
        &git::Limits::default(),
    );
    recorder.capture("one", &store, Some(&observe_linked()));
    let reference = format!("refs/vertebrae/chat-history/{}", recorder.capture.epoch);
    assert!(repo.find_reference(&reference).is_ok());
    fs::remove_dir_all(&linked).unwrap();
    let mut options = git2::WorktreePruneOptions::new();
    options.valid(true).working_tree(true);
    repo.find_worktree("linked")
        .unwrap()
        .prune(Some(&mut options))
        .unwrap();

    assert_eq!(
        text(read(&store, "chat", "one", "a.txt").unwrap()),
        "historical linked contents\n"
    );
    store.delete("chat").unwrap();
    assert!(repo.find_reference(&reference).is_err());
    assert!(read(&store, "chat", "one", "a.txt").is_err());
}

#[test]
fn unsupported_contents_and_unknown_turns_fail_explicitly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let limits = git::Limits {
        side_bytes: 8,
        ..git::Limits::default()
    };
    let recorder = HistoryRecorder::start("chat", &path, &store, Some(&observe(&path)), &limits);
    fs::write(path.join("a.txt"), "long enough to exceed capture budget\n").unwrap();
    let end = git::snapshot(&path.canonicalize().unwrap(), &limits, "main").unwrap();
    recorder.capture("large", &store, Some(&end));

    assert!(read(&store, "chat", "large", "a.txt")
        .unwrap_err()
        .contains("size limit"));
    assert!(read(&store, "chat", "unknown", "a.txt")
        .unwrap_err()
        .contains("No historical capture"));
}

#[hegel::test(test_cases = 40)]
fn completed_turns_match_the_filesystem_model_even_after_later_edits(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    let mut expected = Vec::new();
    for turn in 0..tc.draw(gs::integers::<usize>().min_value(1).max_value(8)) {
        let contents = if tc.draw(gs::booleans()) {
            Some(format!("turn {turn}: {}\n", tc.draw(gs::integers::<u32>())))
        } else {
            None
        };
        match &contents {
            Some(text) => fs::write(path.join("a.txt"), text).unwrap(),
            None => {
                let _ = fs::remove_file(path.join("a.txt"));
            }
        }
        recorder.capture(&turn.to_string(), &store, Some(&observe(&path)));
        expected.push(contents);
    }
    fs::write(path.join("a.txt"), "unrelated latest contents\n").unwrap();
    for (turn, expected) in expected.into_iter().enumerate() {
        let actual = read(&store, "chat", &turn.to_string(), "a.txt").unwrap();
        match expected {
            Some(expected) => assert_eq!(text(actual), expected),
            None => assert_eq!(actual, FileBody::Missing),
        }
    }
}

#[test]
fn a_failed_baseline_write_releases_its_ref_and_preserves_existing_data() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let repo = repo(&path);
    let blocked = dir.path().join("annotations");
    fs::write(&blocked, "existing data").unwrap();
    let store = store(&blocked);
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );

    assert!(!recorder.baseline_ready);
    assert!(repo
        .find_reference(&format!(
            "refs/vertebrae/chat-history/{}",
            recorder.capture.epoch
        ))
        .is_err());
    assert_eq!(fs::read_to_string(blocked).unwrap(), "existing data");
}

#[test]
fn deleted_session_cannot_leak_a_new_baseline_ref() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    store.delete("chat").unwrap();
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    assert!(!recorder.baseline_ready);
    assert!(repo
        .find_reference(&format!(
            "refs/vertebrae/chat-history/{}",
            recorder.capture.epoch
        ))
        .is_err());
    assert!(store.load("chat").unwrap().is_empty());
}

#[test]
fn history_metadata_does_not_transport_patch_bodies() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    fs::write(path.join("a.txt"), "large changed contents\n".repeat(2000)).unwrap();
    recorder.capture("one", &store, Some(&observe(&path)));
    let entries = store.load("chat").unwrap();
    for entry in entries {
        assert!(
            entry.payload.get("patch").is_none(),
            "patch body escaped to the frontend"
        );
        assert!(
            serde_json::to_vec(&entry).unwrap().len() < 2048,
            "metadata grows with file contents"
        );
    }
    assert_eq!(
        text(read(&store, "chat", "one", "a.txt").unwrap()),
        "large changed contents\n".repeat(2000)
    );
}

#[test]
fn a_clean_transformed_file_never_returns_different_bytes_as_recorded_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let repo = repo(&path);
    fs::write(path.join(".gitattributes"), "a.txt text eol=crlf\n").unwrap();
    fs::write(path.join("a.txt"), b"hello\r\n").unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    index.write().unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "attributes", &tree, &[&parent])
        .unwrap();
    assert!(observe(&path).dirty.is_empty());
    let expected = fs::read(path.join("a.txt")).unwrap();
    let head = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .tree()
        .unwrap();
    let entry = head.get_path(Path::new("a.txt")).unwrap();
    assert_ne!(
        repo.find_blob(entry.id()).unwrap().content(),
        expected,
        "oracle fixture must distinguish normalized Git bytes from disk bytes"
    );
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture("one", &store, Some(&observe(&path)));
    // Unsupported transformations may abstain; successful reads must be exact.
    match read(&store, "chat", "one", "a.txt") {
        Ok(FileBody::Text { contents, .. }) => assert_eq!(contents.as_bytes(), expected),
        Ok(FileBody::Unreadable { message }) => assert!(message.contains("transformations")),
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[test]
fn deletion_between_ref_creation_and_publication_releases_the_ref() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start_with_hook(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
        None,
        || {
            assert_eq!(
                repo.references_glob("refs/vertebrae/chat-history/*")
                    .unwrap()
                    .count(),
                1
            );
            store.delete("chat").unwrap();
        },
    );
    assert!(!recorder.baseline_ready);
    assert_eq!(
        repo.references_glob("refs/vertebrae/chat-history/*")
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn expiration_after_computation_cannot_publish_ready_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.record_origin("expired", &store);
    let (receipt, waiting) = tokio::sync::oneshot::channel::<()>();
    recorder.capture_with_hook(
        "expired",
        &store,
        Some(&observe(&path)),
        || !receipt.is_closed(),
        || drop(waiting),
    );
    assert!(read(&store, "chat", "expired", "a.txt")
        .unwrap_err()
        .contains("expired"));
    recorder.capture("expired", &store, Some(&observe(&path)));
    assert!(read(&store, "chat", "expired", "a.txt").is_err());
}

#[test]
fn expiry_during_activation_rolls_back_ready_data_before_readers_can_see_it() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.record_origin("expired", &store);
    let checks = AtomicUsize::new(0);
    recorder.capture_checked("expired", &store, Some(&observe(&path)), || {
        checks.fetch_add(1, Ordering::AcqRel) == 0
    });
    assert!(checks.load(Ordering::Acquire) >= 2);
    assert!(read(&store, "chat", "expired", "a.txt")
        .unwrap_err()
        .contains("expired"));
    let metadata = store
        .load("chat")
        .unwrap()
        .into_iter()
        .find(|a| {
            a.subject == Some(AnnotationSubject::Turn("expired".into())) && a.kind == HISTORY_KIND
        })
        .unwrap();
    assert_eq!(metadata.payload["state"], "unavailable");
}

#[test]
fn a_load_failure_after_restart_cannot_overwrite_an_existing_turn() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let annotations = dir.path().join("annotations");
    let store = store(&annotations);
    let first = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    first.capture("one", &store, Some(&observe(&path)));
    fs::create_dir(annotations.join("chat.jsonl")).unwrap();
    fs::write(path.join("a.txt"), "newer bytes\n").unwrap();
    let second = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    assert!(store.load("chat").is_err());
    second.capture("one", &store, Some(&observe(&path)));
    assert_eq!(
        text(read(&store, "chat", "one", "a.txt").unwrap()),
        "base\n"
    );
}

#[test]
fn direct_reads_do_not_parse_the_session_log() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let annotations = dir.path().join("annotations");
    let store = store(&annotations);
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture("one", &store, Some(&observe(&path)));
    // A transcript that cannot be read is an independent I/O oracle: keyed
    // history must remain readable without opening or parsing this path.
    fs::create_dir(annotations.join("chat.jsonl")).unwrap();
    assert_eq!(
        text(read(&store, "chat", "one", "untouched.txt").unwrap()),
        "clean\n"
    );
}

#[hegel::test(test_cases = 40)]
fn history_lifecycle_matches_first_publication_model(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let mut recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    let mut model = std::collections::BTreeMap::<u8, Option<Vec<u8>>>::new();
    let mut deleted = false;
    for step in 0..tc.draw(gs::integers::<usize>().min_value(4).max_value(20)) {
        let turn = tc.draw(gs::integers::<u8>().max_value(3));
        match tc.draw(gs::integers::<u8>().max_value(5)) {
            0 => {
                fs::write(path.join("a.txt"), format!("external edit {step}\n")).unwrap();
            }
            1 | 2 => {
                if !deleted {
                    model
                        .entry(turn)
                        .or_insert_with(|| Some(fs::read(path.join("a.txt")).unwrap()));
                }
                recorder.capture(&turn.to_string(), &store, Some(&observe(&path)));
            }
            3 => {
                if !deleted {
                    model.entry(turn).or_insert(None);
                }
                recorder
                    .capture_checked(&turn.to_string(), &store, Some(&observe(&path)), || false);
            }
            4 => {
                recorder = HistoryRecorder::start(
                    "chat",
                    &path,
                    &store,
                    Some(&observe(&path)),
                    &git::Limits::default(),
                );
            }
            _ => {
                store.delete("chat").unwrap();
                deleted = true;
            }
        }
        for id in 0..=3 {
            let actual = read(&store, "chat", &id.to_string(), "a.txt");
            match model.get(&id).filter(|_| !deleted) {
                Some(Some(bytes)) => assert_eq!(text(actual.unwrap()).as_bytes(), bytes),
                _ => assert!(actual.is_err()),
            }
        }
    }
}

#[test]
fn next_tool_queued_after_computation_retires_the_capture() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.record_origin("one", &store);
    let gate = RecorderGate::new();
    recorder.capture_with_hook(
        "one",
        &store,
        Some(&observe(&path)),
        || gate.can_publish_history(),
        || gate.start_queued(),
    );
    assert!(read(&store, "chat", "one", "a.txt")
        .unwrap_err()
        .contains("superseded"));
}

#[test]
fn a_failed_write_cannot_recapture_later_bytes_on_a_duplicate_terminal_or_restart() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let annotations = dir.path().join("annotations");
    let store = store(&annotations);
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.record_origin("one", &store);
    let records = annotations.join("chat.records");
    let backup = annotations.join("saved.records");
    fs::rename(&records, &backup).unwrap();
    fs::write(&records, "blocked").unwrap();
    recorder.capture_checked("one", &store, Some(&observe(&path)), || true);
    fs::remove_file(&records).unwrap();
    fs::rename(&backup, &records).unwrap();
    fs::write(path.join("a.txt"), "bytes from a later turn\n").unwrap();
    recorder.capture("one", &store, Some(&observe(&path)));
    assert!(read(&store, "chat", "one", "a.txt").is_err());
    let resumed = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    resumed.capture("one", &store, Some(&observe(&path)));
    assert!(read(&store, "chat", "one", "a.txt").is_err());
}

#[test]
fn a_terminal_without_an_original_turn_identity_cannot_adopt_the_current_checkout() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture_checked("unknown", &store, Some(&observe(&path)), || true);
    assert!(read(&store, "chat", "unknown", "a.txt").is_err());
    let header = store
        .load("chat")
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.kind == HISTORY_KIND
                && entry.subject == Some(AnnotationSubject::Turn("unknown".into()))
        })
        .unwrap();
    assert_eq!(header.payload["worktree"], "");
}

#[test]
fn cumulative_patch_size_does_not_scale_webview_event_payloads() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let (sink, events) = LocalChatEventSink::capturing_for_tests();
    let store = LocalChatAnnotationStore::new(Ok(dir.path().join("annotations")), sink);
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    for turn in 0..20 {
        fs::write(
            path.join("a.txt"),
            format!("turn {turn}\n{}", "large history line\n".repeat(2000)),
        )
        .unwrap();
        recorder.capture(&turn.to_string(), &store, Some(&observe(&path)));
    }
    let events = events.lock().unwrap();
    let mut total = 0;
    for event in events.iter() {
        if let crate::local_chat::LocalChatEvent::Annotation(event) = event {
            assert!(event.annotation.payload.get("patch").is_none());
            assert!(event.annotation.payload.get("files").is_none());
            let bytes = serde_json::to_vec(&event.annotation).unwrap().len();
            assert!(bytes < 2048);
            total += bytes;
        }
    }
    assert!(total < 42 * 2048);
    assert_eq!(store.load("chat").unwrap().len(), 42);
}

#[test]
fn interrupted_baseline_initialization_leaves_a_discoverable_owner_for_its_ref() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        HistoryRecorder::start_with_hook(
            "chat",
            &path,
            &store,
            Some(&observe(&path)),
            &git::Limits::default(),
            None,
            || panic!("simulated process interruption after ref creation"),
        );
    }));
    assert!(interrupted.is_err());
    assert_eq!(
        repo.references_glob("refs/vertebrae/chat-history/*")
            .unwrap()
            .count(),
        1
    );
    assert!(store
        .load("chat")
        .unwrap()
        .iter()
        .any(|entry| entry.kind == "worktree_retention"));
    store
        .sweep_orphans(
            &std::collections::HashSet::new(),
            &std::collections::HashSet::new(),
        )
        .unwrap();
    assert_eq!(
        repo.references_glob("refs/vertebrae/chat-history/*")
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn the_store_itself_keeps_the_first_turn_even_without_a_recorder_cache() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("repo");
    let _repo = repo(&path);
    let store = store(&dir.path().join("annotations"));
    let recorder = HistoryRecorder::start(
        "chat",
        &path,
        &store,
        Some(&observe(&path)),
        &git::Limits::default(),
    );
    recorder.capture("one", &store, Some(&observe(&path)));
    let mut changed = store
        .read_record("chat", HISTORY_KIND, &AnnotationSubject::Turn("one".into()))
        .unwrap()
        .unwrap();
    changed["state"] = "unavailable".into();
    changed["message"] = "a duplicate attempted to replace the record".into();
    let mut entry = LocalChatAnnotation::new("chat", "", HISTORY_KIND, changed);
    entry.subject = Some(AnnotationSubject::Turn("one".into()));
    store.append(entry).unwrap();
    assert_eq!(
        text(read(&store, "chat", "one", "a.txt").unwrap()),
        "base\n"
    );
}
