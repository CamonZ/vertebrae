use super::{placement::map_threads, placement::MAX_MAPPED_THREADS, *};
use crate::commands::chat_catalog::ReviewThreadSide;
use git2::{Oid, Repository};
use std::path::Path;

mod cache;
mod oracle;

const PUBLISHED: &str = "fn retry() {\n    let budget = 3;\n    let delay = 10;\n    attempt(budget);\n    wait(delay);\n}\n";

/// Commit `files` on top of HEAD; `update_head` moves HEAD to it.
fn commit_files(repo: &Repository, files: &[(&str, &[u8])], update_head: bool) -> Oid {
    let root = repo.workdir().unwrap().to_owned();
    let mut index = repo.index().unwrap();
    for (path, contents) in files {
        std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        std::fs::write(root.join(path), contents).unwrap();
        index.add_path(Path::new(path)).unwrap();
    }
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    let parents = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .into_iter()
        .collect::<Vec<_>>();
    let parents = parents.iter().collect::<Vec<_>>();
    repo.commit(
        update_head.then_some("HEAD"),
        &sig,
        &sig,
        "fixture",
        &tree,
        &parents,
    )
    .unwrap()
}

fn commit_file(repo: &Repository, path: &str, contents: &str) -> Oid {
    commit_files(repo, &[(path, contents.as_bytes())], true)
}

fn init(dir: &Path) -> Repository {
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("feature/retry");
    let repo = Repository::init_opts(dir, &options).unwrap();
    repo.remote("origin", "https://github.com/example/demo-repo.git")
        .unwrap();
    repo
}

fn anchor(line: Option<u32>) -> GithubThreadAnchor {
    GithubThreadAnchor {
        path: "src/retry.rs".into(),
        side: ReviewThreadSide::Right,
        start_side: None,
        line,
        start_line: None,
        original_line: line,
        original_start_line: None,
        original_commit_oid: None,
        file_level: false,
        outdated: false,
    }
}

fn thread(id: &str, anchor: GithubThreadAnchor) -> GithubAnchoredThread {
    GithubAnchoredThread {
        thread_id: id.into(),
        anchor,
    }
}

fn request(head: Oid, anchors: Vec<GithubThreadAnchor>) -> GithubThreadMappingRequest {
    GithubThreadMappingRequest {
        head_oid: head.to_string(),
        base_oid: head.to_string(),
        shown_target: None,
        shown_base: head.to_string(),
        threads: anchors
            .into_iter()
            .enumerate()
            .map(|(index, anchor)| thread(&format!("T{index}"), anchor))
            .collect(),
    }
}

fn placements(
    repo: &Repository,
    request: &GithubThreadMappingRequest,
) -> Vec<GithubThreadPlacement> {
    let positions = map_threads(repo, request).unwrap();
    for (position, thread) in positions.iter().zip(&request.threads) {
        assert_eq!(position.thread_id, thread.thread_id);
    }
    positions
        .into_iter()
        .map(|position| position.placement)
        .collect()
}

fn focus(snippet: &[GithubSnippetLine]) -> Vec<(u32, &str)> {
    snippet
        .iter()
        .filter(|line| line.focus)
        .map(|line| (line.number, line.text.as_str()))
        .collect()
}

use GithubThreadPlacement::{Anchored, Edited, FileLevel, NotShown, Outdated, Unverified};

fn unplaceable(reason: GithubUnplaceableReason) -> GithubThreadPlacement {
    GithubThreadPlacement::Unplaceable { reason }
}

#[test]
fn unchanged_lines_anchor_exactly_and_shift_with_local_edits_above() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED);

    // Clean checkout: the published anchors are exact.
    assert_eq!(
        placements(&repo, &request(head, vec![anchor(Some(4))])),
        vec![Anchored {
            start_line: 4,
            line: 4,
            published_line: 4,
        }]
    );

    // Two lines added above line 4: it moves down; the edited line 2 stays
    // at its published anchor with the published text.
    std::fs::write(
        dir.path().join("src/retry.rs"),
        "// retry policy\n// bounded\nfn retry() {\n    let budget = 5;\n    let delay = 10;\n    attempt(budget);\n    wait(delay);\n}\n",
    )
    .unwrap();
    let placed = placements(
        &repo,
        &request(head, vec![anchor(Some(4)), anchor(Some(2))]),
    );
    assert_eq!(
        placed[0],
        Anchored {
            start_line: 6,
            line: 6,
            published_line: 4,
        }
    );
    match &placed[1] {
        Edited {
            start_line,
            line,
            published,
            edited_lines,
            published_commit,
        } => {
            assert_eq!((*start_line, *line), (2, 2));
            assert_eq!(edited_lines, &vec![2]);
            assert_eq!(published_commit, &head.to_string());
            assert_eq!(focus(published), vec![(2, "    let budget = 3;")]);
            assert_eq!(published.first().map(|line| line.number), Some(1));
            assert_eq!(published.last().map(|line| line.number), Some(3));
        }
        other => panic!("expected Edited, got {other:?}"),
    }
}

#[test]
fn multi_line_and_cross_side_ranges_are_placed_whole_or_on_their_last_line() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED);
    std::fs::write(
        dir.path().join("src/retry.rs"),
        format!(
            "// new\n{}",
            PUBLISHED.replace("wait(delay)", "sleep(delay)")
        ),
    )
    .unwrap();
    let range = |start_line, line| GithubThreadAnchor {
        start_line: Some(start_line),
        ..anchor(Some(line))
    };
    let cross_side = GithubThreadAnchor {
        start_side: Some(ReviewThreadSide::Left),
        ..range(1, 3)
    };
    let placed = placements(
        &repo,
        &request(head, vec![range(2, 4), range(4, 5), cross_side]),
    );
    assert_eq!(
        placed[0],
        Anchored {
            start_line: 3,
            line: 5,
            published_line: 4,
        }
    );
    match &placed[1] {
        Edited {
            start_line: 4,
            line: 5,
            published,
            edited_lines,
            published_commit,
        } => {
            assert_eq!(published_commit, &head.to_string());
            assert_eq!(
                focus(published),
                vec![(4, "    attempt(budget);"), (5, "    wait(delay);")]
            );
            // Only the call that changed, not the whole range.
            assert_eq!(edited_lines, &vec![5]);
        }
        other => panic!("expected Edited 4..=5, got {other:?}"),
    }
    assert_eq!(
        placed[2],
        Anchored {
            start_line: 4,
            line: 4,
            published_line: 3,
        }
    );
}

#[test]
fn published_branch_comparison_reads_the_commit_not_the_working_tree() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED);
    std::fs::write(
        dir.path().join("src/retry.rs"),
        format!("// new\n{PUBLISHED}"),
    )
    .unwrap();

    let mut shown = request(head, vec![anchor(Some(4))]);
    shown.shown_target = Some(head.to_string());
    assert_eq!(
        placements(&repo, &shown),
        vec![Anchored {
            start_line: 4,
            line: 4,
            published_line: 4,
        }]
    );
}

#[test]
fn outdated_file_level_missing_and_unfetched_threads_are_classified() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let original = commit_file(&repo, "src/retry.rs", PUBLISHED);
    let head = commit_file(&repo, "src/other.rs", "fn other() {}\n");

    let outdated = GithubThreadAnchor {
        outdated: true,
        line: None,
        original_start_line: Some(2),
        original_line: Some(3),
        original_commit_oid: Some(original.to_string()),
        ..anchor(None)
    };
    let file_level = GithubThreadAnchor {
        file_level: true,
        ..anchor(None)
    };
    let deleted = GithubThreadAnchor {
        path: "src/other.rs".into(),
        ..anchor(Some(1))
    };
    std::fs::remove_file(dir.path().join("src/other.rs")).unwrap();

    let original_oid = original.to_string();
    let placed = placements(&repo, &request(head, vec![outdated, file_level, deleted]));
    match &placed[0] {
        Outdated {
            original_start_line,
            original_line,
            original,
            original_commit,
        } => {
            assert_eq!((*original_start_line, *original_line), (Some(2), Some(3)));
            // The snippet's commit, so a discussion can capture those lines.
            assert_eq!(original_commit.as_deref(), Some(&*original_oid));
            assert_eq!(
                focus(original),
                vec![(2, "    let budget = 3;"), (3, "    let delay = 10;")]
            );
        }
        other => panic!("expected Outdated, got {other:?}"),
    }
    assert_eq!(placed[1], FileLevel);
    assert_eq!(placed[2], NotShown);

    // A published head this clone has never fetched: shown where GitHub says.
    let unfetched = request(
        Oid::from_str("1111111111111111111111111111111111111111").unwrap(),
        vec![GithubThreadAnchor {
            start_line: Some(3),
            ..anchor(Some(4))
        }],
    );
    assert_eq!(
        placements(&repo, &unfetched),
        vec![Unverified {
            start_line: 3,
            line: 4
        }]
    );
}

#[test]
fn left_side_threads_map_from_the_merge_base_onto_the_shown_base() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let base = commit_file(&repo, "src/retry.rs", PUBLISHED);
    let head = commit_file(&repo, "src/retry.rs", "fn retry() {}\n");
    // The shown old side is not HEAD: a commit with a line added above.
    let shown_base = commit_files(
        &repo,
        &[("src/retry.rs", format!("// new\n{PUBLISHED}").as_bytes())],
        false,
    );

    let left = |line| GithubThreadAnchor {
        side: ReviewThreadSide::Left,
        ..anchor(Some(line))
    };
    let mut request = request(head, vec![left(3)]);
    request.base_oid = base.to_string();
    request.shown_base = shown_base.to_string();
    assert_eq!(
        placements(&repo, &request),
        vec![Anchored {
            start_line: 4,
            line: 4,
            published_line: 3,
        }]
    );

    // Outdated on the left: the base of the original diff, the merge base
    // of its commit with the PR's base.
    request.threads = vec![thread(
        "T0",
        GithubThreadAnchor {
            outdated: true,
            line: None,
            original_line: Some(2),
            original_commit_oid: Some(head.to_string()),
            ..left(1)
        },
    )];
    match &placements(&repo, &request)[0] {
        Outdated {
            original,
            original_commit,
            ..
        } => {
            assert_eq!(focus(original), vec![(2, "    let budget = 3;")]);
            assert_eq!(original_commit.as_deref(), Some(&*base.to_string()));
        }
        other => panic!("expected Outdated, got {other:?}"),
    }
    // Without the original commit there is no snippet.
    request.threads[0].anchor.original_commit_oid =
        Some("1111111111111111111111111111111111111111".into());
    match &placements(&repo, &request)[0] {
        Outdated {
            original,
            original_commit,
            ..
        } => assert!(original.is_empty() && original_commit.is_none()),
        other => panic!("expected Outdated, got {other:?}"),
    }
}

#[test]
fn invalid_anchors_and_unreadable_files_are_unplaceable() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let head = commit_files(
        &repo,
        &[
            ("src/retry.rs", PUBLISHED.as_bytes()),
            ("assets/logo.bin", b"\x89PNG\0\0"),
        ],
        true,
    );
    let placed = placements(
        &repo,
        &request(
            head,
            vec![
                anchor(Some(40)),
                GithubThreadAnchor {
                    start_line: Some(5),
                    ..anchor(Some(4))
                },
                anchor(Some(0)),
                GithubThreadAnchor {
                    path: "src/absent.rs".into(),
                    ..anchor(Some(1))
                },
                GithubThreadAnchor {
                    path: "../outside.rs".into(),
                    ..anchor(Some(1))
                },
                GithubThreadAnchor {
                    path: "assets/logo.bin".into(),
                    ..anchor(Some(1))
                },
            ],
        ),
    );
    use GithubUnplaceableReason::{InvalidAnchor, Unreadable};
    assert_eq!(
        placed,
        vec![
            unplaceable(InvalidAnchor),
            unplaceable(InvalidAnchor),
            unplaceable(InvalidAnchor),
            unplaceable(InvalidAnchor),
            unplaceable(InvalidAnchor),
            unplaceable(Unreadable),
        ]
    );
}

#[test]
fn an_unborn_head_without_a_target_shows_no_threads() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let published = commit_files(&repo, &[("src/retry.rs", PUBLISHED.as_bytes())], false);
    assert_eq!(
        placements(&repo, &request(published, vec![anchor(Some(2))])),
        vec![NotShown]
    );
    let mut target = request(published, vec![anchor(Some(2))]);
    target.shown_target = Some(published.to_string());
    assert_eq!(
        placements(&repo, &target),
        vec![Anchored {
            start_line: 2,
            line: 2,
            published_line: 2,
        }]
    );
}

#[test]
fn invalid_commit_ids_and_oversized_requests_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED);
    let mut bad = request(head, Vec::new());
    bad.head_oid = "not-a-commit".into();
    assert!(map_threads(&repo, &bad).is_err());
    let mut bad = request(head, Vec::new());
    bad.shown_base = "not-a-commit".into();
    assert!(map_threads(&repo, &bad).is_err());
    let many = request(
        head,
        (0..=MAX_MAPPED_THREADS).map(|_| anchor(Some(1))).collect(),
    );
    assert!(map_threads(&repo, &many).is_err());
}
