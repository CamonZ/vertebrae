use super::*;
use crate::local_chat::worktree_delta::git::Limits;
use std::{path::Path, process::Command};

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn crlf_selection_comparison_accepts_rendered_text_and_rejects_edits() {
    assert!(selected_text_matches("a\r\nb\r\n", "a\nb"));
    assert!(selected_text_matches("a\r\nb\r\n", "a\r\nb\r"));
    assert!(!selected_text_matches("a\r\nb\r\n", "a\nc"));
}

use hegel::generators as gs;

/// A generated anchor source of each kind.
fn source_of(tc: &hegel::TestCase) -> ReviewAnchorSource {
    match tc.draw(gs::integers::<u8>().max_value(3)) {
        0 => ReviewAnchorSource::Worktree { commit: None },
        1 => ReviewAnchorSource::Worktree {
            commit: Some("b".repeat(40)),
        },
        2 => ReviewAnchorSource::FullFile { turn: None },
        _ => ReviewAnchorSource::ToolCall {
            chat_id: "chat".into(),
            tool_use_id: tc.draw(gs::text().min_size(1).max_size(8)),
        },
    }
}

/// A selection keeps the home its source implies, whatever the text; a
/// GitHub thread is a worktree thread whose origin names it, accepted
/// only on worktree content and with a node ID, and it never compares
/// text (GitHub's anchor, not a UI selection, says which lines).
#[hegel::test(test_cases = 200)]
fn subject_decides_the_catalog_origin(tc: hegel::TestCase) {
    let source = source_of(&tc);
    let snippet: String = tc.draw(gs::text().max_size(12));
    let selected: String = tc.draw(gs::text().max_size(12));
    let selection = ReviewAnchorSubject::Selection {
        selected_text: selected.clone(),
    };
    let expected = match &source {
        ReviewAnchorSource::ToolCall { tool_use_id, .. } => {
            (ReviewThreadHome::ToolCall, Some(tool_use_id.clone()), None)
        }
        ReviewAnchorSource::Worktree { .. } => (ReviewThreadHome::Worktree, None, None),
        ReviewAnchorSource::FullFile { .. } => (
            ReviewThreadHome::Worktree,
            None,
            Some("full-file:null".to_string()),
        ),
    };
    let (home, tool_use_id, origin_ref) = catalog_home(&source, &selection).unwrap();
    assert_eq!((home, tool_use_id, origin_ref), expected);
    assert_eq!(
        subject_matches(&snippet, &selection),
        selected_text_matches(&snippet, &selected)
    );

    let id: String = tc.draw(gs::text().max_size(20));
    let github = ReviewAnchorSubject::GithubThread {
        github_thread_id: id.clone(),
    };
    assert!(subject_matches(&snippet, &github));
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-=".contains(c));
    match (catalog_home(&source, &github), &source) {
        (Ok((home, tool_use_id, origin_ref)), ReviewAnchorSource::Worktree { .. }) => {
            assert!(valid, "{id:?}");
            assert_eq!(home, ReviewThreadHome::Worktree);
            assert_eq!(tool_use_id, None);
            assert_eq!(origin_ref, Some(format!("github-thread:{id}")));
        }
        (Ok(_), _) => panic!("GitHub threads anchor only on worktree content"),
        (Err(error), source) => {
            assert!(matches!(error, ReviewAnchorError::ContentUnavailable));
            assert!(!valid || !matches!(source, ReviewAnchorSource::Worktree { .. }));
        }
    }
}

#[test]
fn github_thread_ids_accept_node_ids_and_reject_other_text() {
    assert!(valid_github_thread_id("PRRT_kwDOAbc123-_="));
    assert!(!valid_github_thread_id(""));
    assert!(!valid_github_thread_id("PRRT 1"));
    assert!(!valid_github_thread_id("github-thread:PRRT_1"));
    assert!(!valid_github_thread_id(&"a".repeat(257)));
}

fn working_location(path: &str) -> ReviewAnchorLocation {
    ReviewAnchorLocation {
        path: path.into(),
        side: ReviewThreadSide::Right,
        source: ReviewAnchorSource::Worktree { commit: None },
    }
}

#[test]
fn full_file_anchor_maps_lines_in_a_clean_file_without_diff_hunks() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    let path = dir.path().join("a");
    std::fs::write(&path, "first\nselected\nthird\n").unwrap();
    git(dir.path(), &["add", "a"]);
    git(
        dir.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "fixture",
        ],
    );
    let mut location = working_location("a");
    location.source = ReviewAnchorSource::FullFile { turn: None };
    let head = repo.blob(b"").unwrap();
    let bytes = worktree_content(&repo, head, &location).unwrap().unwrap();
    let range = ReviewLineRange {
        start_line: 2,
        line: 2,
    };
    let snippet = std::str::from_utf8(range.slice(&bytes).unwrap()).unwrap();
    assert!(selected_text_matches(snippet, "selected"));
    assert!(!selected_text_matches(snippet, "unsaved"));

    let thread_id = Uuid::new_v4();
    let blob = capture(&repo, thread_id, &bytes).unwrap();
    drop(repo);
    let repo = Repository::open(dir.path()).unwrap();
    let retained = repo
        .find_blob(repo.refname_to_id(&ref_name(thread_id)).unwrap())
        .unwrap();
    assert_eq!(range.slice(retained.content()).unwrap(), b"selected\n");

    std::fs::write(path, "inserted\nfirst\nselected\nthird\n").unwrap();
    let mapped = map_thread(
        &repo,
        head,
        ReviewMappingRequest {
            thread_id,
            original_blob_id: blob.to_string(),
            range,
            location,
        },
    );
    assert_eq!(mapped.status, ReviewMappingStatus::Open);
    assert_eq!((mapped.start_line, mapped.line), (Some(3), Some(3)));
}

/// A selection in the working tree maps onto a commit's copy of the file
/// by its unchanged lines; changed lines or a missing file are outdated.
#[test]
fn a_selection_maps_onto_a_commit_only_where_its_lines_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    Repository::init(path).unwrap();
    std::fs::write(path.join("a"), "first\nselected\nthird\n").unwrap();
    git(path, &["add", "a"]);
    git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "published",
        ],
    );
    let (repo, head) = open(path.to_str().unwrap()).unwrap();
    let published = |file: &str| ReviewAnchorLocation {
        path: file.into(),
        side: ReviewThreadSide::Right,
        source: ReviewAnchorSource::Worktree {
            commit: Some(head.to_string()),
        },
    };
    let at = |start_line, line| ReviewLineRange { start_line, line };
    let map = |range, onto: &ReviewAnchorLocation| {
        map_selection(&repo, head, &working_location("a"), range, onto)
    };

    std::fs::write(path.join("a"), "inserted\nfirst\nselected\nchanged\n").unwrap();
    assert_eq!(
        map(at(3, 3), &published("a")),
        MappedReviewRange {
            start_line: Some(2),
            line: Some(2),
            status: ReviewMappingStatus::Open,
        }
    );
    for (range, onto) in [(at(4, 4), published("a")), (at(3, 3), published("b"))] {
        assert_eq!(
            map(range, &onto),
            MappedReviewRange {
                start_line: None,
                line: None,
                status: ReviewMappingStatus::Outdated,
            }
        );
    }
    // A multi-line selection moves as one when all of it is unchanged.
    std::fs::write(path.join("a"), "inserted\nfirst\nselected\nthird\n").unwrap();
    assert_eq!(
        map(at(2, 3), &published("a")),
        MappedReviewRange {
            start_line: Some(1),
            line: Some(2),
            status: ReviewMappingStatus::Open,
        }
    );
    assert_eq!(
        map(at(9, 9), &published("a")).status,
        ReviewMappingStatus::Unavailable
    );
    // A removed line is shown from the base: it maps onto the base's side.
    let base = |file: &str| ReviewAnchorLocation {
        path: file.into(),
        side: ReviewThreadSide::Left,
        source: ReviewAnchorSource::Worktree {
            commit: Some(head.to_string()),
        },
    };
    assert_eq!(
        map_selection(&repo, head, &base("a"), at(3, 3), &base("a")),
        MappedReviewRange {
            start_line: Some(3),
            line: Some(3),
            status: ReviewMappingStatus::Open,
        }
    );
    // Chat tool-call content is not the worktree's: nothing to map.
    let tool_call = ReviewAnchorLocation {
        path: "a".into(),
        side: ReviewThreadSide::Right,
        source: ReviewAnchorSource::ToolCall {
            chat_id: "chat".into(),
            tool_use_id: "tool".into(),
        },
    };
    assert_eq!(
        map_selection(&repo, head, &tool_call, at(1, 1), &published("a")).status,
        ReviewMappingStatus::Unavailable
    );
}

#[test]
fn invalid_threads_do_not_prevent_a_valid_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    std::fs::write(dir.path().join("valid"), "shift\nselected\n").unwrap();
    std::fs::write(dir.path().join("binary"), b"selected\0\n").unwrap();
    std::fs::write(dir.path().join("non-utf8"), [0xff]).unwrap();
    std::fs::write(
        dir.path().join("large"),
        vec![b'a'; Limits::default().side_bytes as usize + 1],
    )
    .unwrap();
    let valid = Uuid::new_v4();
    let blob = capture(&repo, valid, b"selected\n").unwrap();
    let other_blob = repo.blob(b"different\n").unwrap();
    use ReviewMappingStatus::{Open, Outdated, Unavailable};
    let requests = [
        (Uuid::new_v4(), blob, "valid", 1, Unavailable, None),
        (valid, other_blob, "valid", 1, Unavailable, None),
        (valid, blob, "binary", 1, Outdated, None),
        (valid, blob, "non-utf8", 1, Outdated, None),
        (valid, blob, "large", 1, Unavailable, None),
        (valid, blob, "missing", 1, Outdated, None),
        (valid, blob, "valid", 2, Unavailable, None),
        (valid, blob, "valid", 1, Open, Some(2)),
    ];
    for (thread_id, original, path, line, status, position) in requests {
        let mapped = map_thread(
            &repo,
            blob,
            ReviewMappingRequest {
                thread_id,
                original_blob_id: original.to_string(),
                location: working_location(path),
                range: ReviewLineRange {
                    start_line: line,
                    line,
                },
            },
        );
        assert_eq!(mapped.status, status, "{path}, line {line}");
        assert_eq!((mapped.start_line, mapped.line), (position, position));
    }
}

#[test]
fn git_failure_is_unavailable_and_a_retry_maps_normally() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    std::fs::write(dir.path().join("a"), "selected\n").unwrap();
    let thread_id = Uuid::new_v4();
    let blob = capture(&repo, thread_id, b"selected\n").unwrap();
    let request = |location| ReviewMappingRequest {
        thread_id,
        original_blob_id: blob.to_string(),
        range: ReviewLineRange {
            start_line: 1,
            line: 1,
        },
        location,
    };
    // Ask Git for a commit which is temporarily unavailable locally.
    let mut location = working_location("a");
    location.source = ReviewAnchorSource::Worktree {
        commit: Some("a".repeat(40)),
    };
    let failed = map_thread(&repo, blob, request(location));
    assert_eq!(failed.status, ReviewMappingStatus::Unavailable);
    assert_eq!((failed.start_line, failed.line), (None, None));
    let retry = map_thread(&repo, blob, request(working_location("a")));
    assert_eq!(retry.status, ReviewMappingStatus::Open);
    assert_eq!((retry.start_line, retry.line), (Some(1), Some(1)));
}

#[test]
fn left_side_reads_the_explicit_base_commit_and_rejects_trees() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    Repository::init(path).unwrap();
    std::fs::create_dir(path.join("folder")).unwrap();
    std::fs::write(path.join("folder/file"), "base\n").unwrap();
    git(path, &["add", "folder"]);
    git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "base",
        ],
    );
    let (repo, base) = open(path.to_str().unwrap()).unwrap();
    std::fs::write(path.join("folder/file"), "head\n").unwrap();
    git(path, &["add", "folder/file"]);
    git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "head",
        ],
    );
    let (_, head) = open(path.to_str().unwrap()).unwrap();
    let mut location = ReviewAnchorLocation {
        path: "folder/file".into(),
        side: ReviewThreadSide::Left,
        source: ReviewAnchorSource::Worktree {
            commit: Some(base.to_string()),
        },
    };
    assert_eq!(
        worktree_content(&repo, head, &location).unwrap().as_deref(),
        Some(&b"base\n"[..])
    );
    location.path = "folder".into();
    assert!(matches!(
        worktree_content(&repo, head, &location),
        Err(ReviewAnchorError::ContentUnavailable)
    ));
}

#[cfg(unix)]
#[test]
fn worktree_content_rejects_a_symlinked_parent() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    std::fs::write(outside.path().join("a"), "outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
    assert!(matches!(
        worktree_content(&repo, repo.blob(b"").unwrap(), &working_location("link/a")),
        Err(ReviewAnchorError::InvalidPath)
    ));
}

#[test]
fn tool_anchor_uses_the_post_image_and_rejects_the_left_side() {
    use crate::local_chat::{annotations::LocalChatAnnotation, events::LocalChatEventSink};
    use serde_json::json;

    let worktree = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let repo = Repository::init(worktree.path()).unwrap();
    std::fs::write(worktree.path().join("a"), "later edit\n").unwrap();
    let annotations = LocalChatAnnotationStore::new(
        Ok(directory.path().into()),
        LocalChatEventSink::inert_for_tests(),
    );
    let entry = LocalChatAnnotation::new(
        "chat",
        "tool",
        "worktree_delta",
        json!({
            "review_post_images": {"a": "post-image\n"},
        }),
    );
    assert!(entry
        .clone()
        .frontend()
        .payload
        .get("review_post_images")
        .is_none());
    annotations.append(entry).unwrap();

    let mut location = ReviewAnchorLocation {
        path: "a".into(),
        side: ReviewThreadSide::Right,
        source: ReviewAnchorSource::ToolCall {
            chat_id: "chat".into(),
            tool_use_id: "tool".into(),
        },
    };
    let head = repo.blob(b"").unwrap();
    assert_eq!(
        content(&repo, head, &location, &annotations)
            .unwrap()
            .as_deref(),
        Some(&b"post-image\n"[..])
    );
    location.side = ReviewThreadSide::Left;
    assert!(matches!(
        content(&repo, head, &location, &annotations),
        Err(ReviewAnchorError::ContentUnavailable)
    ));
}

#[test]
fn requires_a_repository_with_a_first_commit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let worktree = path.to_str().unwrap();
    assert!(matches!(
        open(worktree),
        Err(ReviewAnchorError::NotRepository)
    ));
    Repository::init(path).unwrap();
    assert!(matches!(open(worktree), Err(ReviewAnchorError::UnbornHead)));
}

#[test]
fn nested_folder_resolves_the_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    Repository::init(path).unwrap();
    git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "base",
        ],
    );
    let (repo, _) = open(path.to_str().unwrap()).unwrap();
    let nested = path.join("nested");
    std::fs::create_dir(&nested).unwrap();
    assert_eq!(
        open(nested.to_str().unwrap()).unwrap().0.path(),
        repo.path()
    );
}

#[test]
fn retained_blob_survives_gc_and_release_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let repo = Repository::init(path).unwrap();
    let thread = Uuid::new_v4();
    let original = b"uncommitted\n";
    let id = capture(&repo, thread, original).unwrap();
    assert!(capture(&repo, thread, original).is_err());
    assert!(capture(&repo, thread, b"other\n").is_err());
    git(path, &["gc", "--prune=now"]);
    assert_eq!(repo.find_blob(id).unwrap().content(), original);
    assert_eq!(repo.refname_to_id(&ref_name(thread)).unwrap(), id);
    assert!(repo.index().unwrap().is_empty());
    release(&repo, thread).unwrap();
    release(&repo, thread).unwrap();
    assert!(repo.find_reference(&ref_name(thread)).is_err());
}
