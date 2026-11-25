use super::*;
use crate::commands::chat_catalog::{PrSave, StoredPrRecord};
use crate::commands::github::resolve_worktree_git_context;
use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};
use vertebrae_github::{PullRequestState, PullRequestSummary, ReviewAuthor};

const PUBLISHED: &str = "fn retry() {\n    let budget = 3;\n    let delay = 10;\n    attempt(budget);\n    wait(delay);\n}\n";

fn commit_file(repo: &Repository, path: &str, contents: &str, message: &str) -> Oid {
    let root = repo.workdir().unwrap();
    std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
    std::fs::write(root.join(path), contents).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
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
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

fn init(dir: &Path, branch: &str) -> Repository {
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head(branch);
    let repo = Repository::init_opts(dir, &options).unwrap();
    repo.remote("origin", "https://github.com/example/demo-repo.git")
        .unwrap();
    repo
}

fn anchor(id: &str, line: Option<u32>) -> GithubThreadAnchor {
    GithubThreadAnchor {
        thread_id: id.into(),
        path: "src/retry.rs".into(),
        side: GithubDiffSide::Right,
        line,
        start_line: None,
        original_line: line,
        original_commit_oid: None,
        file_level: false,
        outdated: false,
    }
}

fn request(head: Oid, threads: Vec<GithubThreadAnchor>) -> GithubThreadMappingRequest {
    GithubThreadMappingRequest {
        head_oid: head.to_string(),
        base_oid: head.to_string(),
        shown_target: None,
        shown_base: None,
        threads,
    }
}

fn placements(
    repo: &Repository,
    request: &GithubThreadMappingRequest,
) -> Vec<GithubThreadPlacement> {
    map_threads(repo, request)
        .unwrap()
        .into_iter()
        .map(|position| position.placement)
        .collect()
}

#[test]
fn unchanged_lines_anchor_exactly_and_shift_with_local_edits_above() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/retry");
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED, "published");

    // Clean checkout: the published anchors are exact.
    assert_eq!(
        placements(&repo, &request(head, vec![anchor("T1", Some(4))])),
        vec![GithubThreadPlacement::Anchored {
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
        &request(head, vec![anchor("T1", Some(4)), anchor("T2", Some(2))]),
    );
    assert_eq!(
        placed[0],
        GithubThreadPlacement::Anchored {
            start_line: 6,
            line: 6,
            published_line: 4,
        }
    );
    match &placed[1] {
        GithubThreadPlacement::Edited { line, published } => {
            assert_eq!(*line, 2);
            let focus: Vec<_> = published.iter().filter(|line| line.focus).collect();
            assert_eq!(focus.len(), 1);
            assert_eq!(focus[0].number, 2);
            assert_eq!(focus[0].text, "    let budget = 3;");
            assert_eq!(published.first().map(|line| line.number), Some(1));
            assert_eq!(published.last().map(|line| line.number), Some(3));
        }
        other => panic!("expected Edited, got {other:?}"),
    }
}

#[test]
fn published_branch_comparison_reads_the_commit_not_the_working_tree() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/retry");
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED, "published");
    std::fs::write(
        dir.path().join("src/retry.rs"),
        format!("// new\n{PUBLISHED}"),
    )
    .unwrap();

    let mut shown = request(head, vec![anchor("T1", Some(4))]);
    shown.shown_target = Some(head.to_string());
    assert_eq!(
        placements(&repo, &shown),
        vec![GithubThreadPlacement::Anchored {
            start_line: 4,
            line: 4,
            published_line: 4,
        }]
    );
}

#[test]
fn outdated_file_level_missing_and_unfetched_threads_are_classified() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/retry");
    let original = commit_file(&repo, "src/retry.rs", PUBLISHED, "original");
    let head = commit_file(&repo, "src/other.rs", "fn other() {}\n", "head");

    let outdated = GithubThreadAnchor {
        outdated: true,
        line: None,
        original_line: Some(3),
        original_commit_oid: Some(original.to_string()),
        ..anchor("T1", None)
    };
    let file_level = GithubThreadAnchor {
        file_level: true,
        ..anchor("T2", None)
    };
    let deleted = GithubThreadAnchor {
        path: "src/other.rs".into(),
        ..anchor("T3", Some(1))
    };
    std::fs::remove_file(dir.path().join("src/other.rs")).unwrap();

    let placed = placements(&repo, &request(head, vec![outdated, file_level, deleted]));
    match &placed[0] {
        GithubThreadPlacement::Outdated {
            original_line,
            original,
        } => {
            assert_eq!(*original_line, Some(3));
            let focus = original.iter().find(|line| line.focus).unwrap();
            assert_eq!(focus.text, "    let delay = 10;");
        }
        other => panic!("expected Outdated, got {other:?}"),
    }
    assert_eq!(placed[1], GithubThreadPlacement::FileLevel);
    assert_eq!(placed[2], GithubThreadPlacement::NotShown);

    // A published head this clone has never fetched: shown where GitHub says.
    let unfetched = request(
        Oid::from_str("1111111111111111111111111111111111111111").unwrap(),
        vec![anchor("T4", Some(4))],
    );
    assert_eq!(
        placements(&repo, &unfetched),
        vec![GithubThreadPlacement::Unverified { line: 4 }]
    );
}

#[test]
fn left_side_threads_map_from_the_merge_base_onto_the_shown_base() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/retry");
    let base = commit_file(&repo, "src/retry.rs", PUBLISHED, "base");
    let head = commit_file(&repo, "src/retry.rs", "fn retry() {}\n", "head");

    let mut left = request(
        head,
        vec![GithubThreadAnchor {
            side: GithubDiffSide::Left,
            ..anchor("T1", Some(3))
        }],
    );
    left.base_oid = base.to_string();
    left.shown_base = Some(base.to_string());
    assert_eq!(
        placements(&repo, &left),
        vec![GithubThreadPlacement::Anchored {
            start_line: 3,
            line: 3,
            published_line: 3,
        }]
    );
}

#[test]
fn invalid_commit_ids_and_oversized_requests_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/retry");
    let head = commit_file(&repo, "src/retry.rs", PUBLISHED, "published");
    let mut bad = request(head, Vec::new());
    bad.head_oid = "not-a-commit".into();
    assert!(map_threads(&repo, &bad).is_err());
    let many = request(
        head,
        (0..=MAX_MAPPED_THREADS)
            .map(|index| anchor(&index.to_string(), Some(1)))
            .collect(),
    );
    assert!(map_threads(&repo, &many).is_err());
}

#[derive(Default)]
struct FakeThreads {
    calls: AtomicUsize,
}

impl ThreadLookup for FakeThreads {
    async fn review_threads(
        &self,
        _repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestReviewThreads, GitHubError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(PullRequestReviewThreads {
            head_oid: "1111111111111111111111111111111111111111".into(),
            base_oid: "2222222222222222222222222222222222222222".into(),
            threads: vec![ReviewThread {
                id: format!("T{number}"),
                path: "src/retry.rs".into(),
                side: DiffSide::Right,
                start_side: None,
                line: Some(4),
                start_line: None,
                original_line: Some(4),
                original_start_line: None,
                original_commit_oid: None,
                file_level: false,
                outdated: false,
                resolved: false,
                viewer_can_resolve: true,
                viewer_can_unresolve: false,
                viewer_can_reply: true,
                comments: vec![ReviewComment {
                    id: "C1".into(),
                    author: Some(ReviewAuthor {
                        login: "alice".into(),
                        avatar_url: None,
                    }),
                    body: "Bound the retries".into(),
                    created_at: None,
                    url: "https://github.com/example/demo-repo/pull/7#discussion_C1".into(),
                }],
                comments_truncated: false,
            }],
            truncated: false,
        })
    }
}

#[tokio::test]
async fn threads_are_read_only_for_a_linked_pr_and_cached_until_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path(), "feature/threads-cache");
    commit_file(&repo, "src/retry.rs", PUBLISHED, "published");
    let ctx = resolve_worktree_git_context(dir.path(), "feature/threads-cache").unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let store = PrAssociationStore::at(store_dir.path());
    let lookup = FakeThreads::default();

    assert_eq!(
        review_threads(&store, &ctx, false, &lookup).await.unwrap(),
        WorktreePrReviewThreads::NotLinked
    );
    assert_eq!(lookup.calls.load(Ordering::SeqCst), 0);

    let record = StoredPrRecord::new(
        "example",
        "demo-repo",
        Some(1_700_000_000),
        PullRequestSummary {
            number: 7,
            title: "Fix retry budget".into(),
            state: PullRequestState::Open,
            head_ref: "feature/threads-cache".into(),
            head_repo: Some("example/demo-repo".into()),
            base_ref: "main".into(),
            url: "https://github.com/example/demo-repo/pull/7".into(),
            author: Some("alice".into()),
            updated_at: None,
        },
    );
    assert_eq!(
        store
            .save_discovered(
                &ctx.key(),
                None,
                StoredPrAssociation::Linked(Box::new(record))
            )
            .await
            .unwrap(),
        PrSave::Saved
    );

    let loaded = review_threads(&store, &ctx, false, &lookup).await.unwrap();
    match &loaded {
        WorktreePrReviewThreads::Loaded {
            repo,
            pr_number,
            threads,
            ..
        } => {
            assert_eq!(repo, "example/demo-repo");
            assert_eq!(*pr_number, 7);
            assert_eq!(threads[0].id, "T7");
            assert_eq!(threads[0].comments[0].body, "Bound the retries");
        }
        other => panic!("expected Loaded, got {other:?}"),
    }
    assert_eq!(
        review_threads(&store, &ctx, false, &lookup).await.unwrap(),
        loaded
    );
    assert_eq!(lookup.calls.load(Ordering::SeqCst), 1);
    review_threads(&store, &ctx, true, &lookup).await.unwrap();
    assert_eq!(lookup.calls.load(Ordering::SeqCst), 2);
}
