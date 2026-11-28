use super::*;
use git_context::{resolve_worktree_git_context, NotApplicable, WorktreeGitContext};
use std::path::Path;

fn summary(number: u64, head_ref: &str, head_repo: Option<&str>) -> PullRequestSummary {
    PullRequestSummary {
        number,
        title: format!("PR {number}"),
        state: PullRequestState::Open,
        head_ref: head_ref.into(),
        head_repo: head_repo.map(str::to_owned),
        base_ref: "main".into(),
        url: format!("https://github.com/example/demo-repo/pull/{number}"),
        author: Some("alice".into()),
        updated_at: None,
    }
}

/// A repository whose only branch is `branch` (checked out), so no `main` or
/// `master` default exists unless a test creates one.
fn init_repo(dir: &Path, branch: &str, remotes: &[(&str, &str)]) -> git2::Repository {
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head(branch);
    let repo = git2::Repository::init_opts(dir, &options).unwrap();
    {
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
            .unwrap();
    }
    for (name, url) in remotes {
        repo.remote(name, url).unwrap();
    }
    repo
}

const ORIGIN: (&str, &str) = ("origin", "https://github.com/example/demo-repo.git");

#[test]
fn rejects_unrepresentable_pr_number_instead_of_clamping() {
    let pr = summary(u64::from(u32::MAX) + 1, "b", None);
    assert!(GithubPullRequest::from_summary("example", "demo-repo", &pr).is_err());
}

fn not_applicable_reason(result: Result<WorktreeGitContext, NotApplicable>) -> String {
    match result {
        Err(NotApplicable { reason, .. }) => reason,
        Ok(ctx) => panic!("expected NotApplicable, got context for {}", ctx.branch),
    }
}

#[test]
fn missing_repository_invalid_branch_and_missing_remotes_are_not_applicable() {
    let reason = not_applicable_reason;

    let plain = tempfile::tempdir().unwrap();
    assert!(
        reason(resolve_worktree_git_context(plain.path(), "feature/x"))
            .contains("not a Git repository")
    );

    let invalid = tempfile::tempdir().unwrap();
    init_repo(invalid.path(), "feature/x", &[ORIGIN]);
    for name in ["", "two..dots", "trailing/"] {
        assert!(
            reason(resolve_worktree_git_context(invalid.path(), name))
                .contains("not a valid branch name"),
            "{name:?}"
        );
    }

    let no_remote = tempfile::tempdir().unwrap();
    init_repo(no_remote.path(), "feature/x", &[]);
    assert!(
        reason(resolve_worktree_git_context(no_remote.path(), "feature/x"))
            .contains("No GitHub remote")
    );

    let foreign = tempfile::tempdir().unwrap();
    init_repo(
        foreign.path(),
        "feature/x",
        &[("origin", "https://gitlab.com/example/demo-repo.git")],
    );
    assert!(
        reason(resolve_worktree_git_context(foreign.path(), "feature/x"))
            .contains("No GitHub remote")
    );
}

#[test]
fn pinned_branch_is_used_instead_of_head_even_when_detached_or_elsewhere() {
    let worktree = tempfile::tempdir().unwrap();
    let repo = init_repo(worktree.path(), "feature/pinned", &[ORIGIN]);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature/other", &head, false).unwrap();
    repo.set_head("refs/heads/feature/other").unwrap();
    let ctx = resolve_worktree_git_context(worktree.path(), "feature/pinned").unwrap();
    assert_eq!(ctx.branch, "feature/pinned");

    repo.set_head_detached(head.id()).unwrap();
    let ctx = resolve_worktree_git_context(worktree.path(), "feature/pinned").unwrap();
    assert_eq!(ctx.branch, "feature/pinned");

    // A pinned branch deleted locally (say, after merging) is still looked up.
    let ctx = resolve_worktree_git_context(worktree.path(), "feature/deleted").unwrap();
    assert_eq!(ctx.branch, "feature/deleted");
}

#[test]
fn default_branch_is_not_applicable_so_github_is_never_queried() {
    let worktree = tempfile::tempdir().unwrap();
    let repo = init_repo(worktree.path(), "feature/x", &[ORIGIN]);
    let head = repo.head().unwrap().peel_to_commit().unwrap();

    // No origin/HEAD: local `main` is the default, like the Changes base.
    repo.branch("main", &head, false).unwrap();
    match resolve_worktree_git_context(worktree.path(), "main") {
        Err(NotApplicable { branch, reason }) => {
            assert_eq!(branch.as_deref(), Some("main"));
            assert!(reason.contains("default branch"), "{reason}");
        }
        other => panic!("expected NotApplicable, got {other:?}"),
    }
    assert!(resolve_worktree_git_context(worktree.path(), "feature/x").is_ok());

    repo.reference("refs/remotes/origin/trunk", head.id(), false, "test")
        .unwrap();
    repo.reference_symbolic(
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk",
        false,
        "test",
    )
    .unwrap();
    assert!(
        not_applicable_reason(resolve_worktree_git_context(worktree.path(), "trunk"))
            .contains("default branch")
    );
    assert!(resolve_worktree_git_context(worktree.path(), "main").is_ok());
}

#[test]
fn fork_checkout_pushes_to_origin_and_targets_upstream() {
    let worktree = tempfile::tempdir().unwrap();
    init_repo(
        worktree.path(),
        "feature/retry",
        &[
            ("origin", "git@github.com:alice/demo-repo.git"),
            ("upstream", "https://github.com/example/demo-repo.git"),
        ],
    );
    let ctx = resolve_worktree_git_context(worktree.path(), "feature/retry").unwrap();
    assert_eq!(
        ctx.github(),
        WorktreeGithub::Github {
            branch: "feature/retry".into(),
            host: "github.com".into(),
            head_repo: "alice/demo-repo".into(),
            base_repo: "example/demo-repo".into(),
            search_repos: vec!["alice/demo-repo".into(), "example/demo-repo".into()],
            create_pr_url:
                "https://github.com/example/demo-repo/compare/alice:feature/retry?expand=1".into(),
        }
    );
    assert_eq!(ctx.remote(None).unwrap().full_name(), "example/demo-repo");
    assert_eq!(
        ctx.remote(Some("ALICE/demo-repo")).unwrap().full_name(),
        "alice/demo-repo"
    );
    assert!(ctx
        .remote(Some("mallory/demo-repo"))
        .unwrap_err()
        .message
        .contains("not a GitHub remote"));
}

#[test]
fn branch_tracking_and_push_configuration_choose_the_head_repo() {
    let worktree = tempfile::tempdir().unwrap();
    let repo = init_repo(
        worktree.path(),
        "feature/retry",
        &[
            ("origin", "https://github.com/example/demo-repo.git"),
            ("bob", "https://github.com/bob/demo-repo.git"),
            ("alice", "https://github.com/alice/demo-repo.git"),
        ],
    );
    let head = |path: &Path| {
        resolve_worktree_git_context(path, "feature/retry")
            .unwrap()
            .head_repo
            .full_name()
    };
    assert_eq!(head(worktree.path()), "example/demo-repo");

    let mut config = repo.config().unwrap();
    config
        .set_str("branch.feature/retry.remote", "bob")
        .unwrap();
    assert_eq!(head(worktree.path()), "bob/demo-repo");

    config.set_str("remote.pushDefault", "alice").unwrap();
    assert_eq!(head(worktree.path()), "alice/demo-repo");

    config
        .set_str("branch.feature/retry.pushRemote", "origin")
        .unwrap();
    assert_eq!(head(worktree.path()), "example/demo-repo");
}

#[test]
fn github_errors_map_to_typed_failure_kinds() {
    let kind = |err: GitHubError| GithubFailure::from(err).kind;
    assert_eq!(kind(GitHubError::GhMissing), GithubErrorKind::GhMissing);
    assert_eq!(
        kind(GitHubError::AuthExpired {
            message: String::new()
        }),
        GithubErrorKind::AuthExpired
    );
    assert_eq!(
        kind(GitHubError::NotFound {
            message: String::new()
        }),
        GithubErrorKind::NotFound
    );
    assert_eq!(
        kind(GitHubError::Forbidden {
            message: String::new()
        }),
        GithubErrorKind::Forbidden
    );
    assert_eq!(
        kind(GitHubError::Timeout {
            message: String::new()
        }),
        GithubErrorKind::Ambiguous
    );
    // Sent but not confirmed: checked before resending, like a timeout.
    for sent in [
        GitHubError::Unconfirmed {
            message: String::new(),
        },
        GitHubError::Interrupted {
            message: String::new(),
        },
    ] {
        assert_eq!(kind(sent), GithubErrorKind::Ambiguous);
    }
    // Refused before sending: resending it unchanged cannot help.
    assert_eq!(
        kind(GitHubError::InvalidInput {
            message: String::new()
        }),
        GithubErrorKind::Rejected
    );
    // Not a refusal of the request itself: a write turns those of these
    // that follow a send into Unconfirmed before they get here.
    for other in [
        GitHubError::Network {
            message: String::new(),
        },
        GitHubError::Http {
            status: 502,
            message: String::new(),
        },
        GitHubError::GraphQl {
            message: String::new(),
        },
        GitHubError::Decode {
            message: String::new(),
        },
    ] {
        assert_eq!(kind(other), GithubErrorKind::Other);
    }
    let limited = GithubFailure::from(GitHubError::RateLimited {
        retry_after_secs: Some(u64::MAX),
        message: String::new(),
    });
    assert_eq!(limited.kind, GithubErrorKind::RateLimited);
    assert_eq!(limited.retry_after_secs, Some(u32::MAX));
}

mod checks;
