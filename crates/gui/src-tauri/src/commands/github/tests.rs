use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

const NOW: Option<i64> = Some(1_700_000_000);

fn later(secs: i64) -> Option<i64> {
    NOW.map(|now| now + secs)
}

#[derive(Default)]
struct Gate {
    reached: Notify,
    release: Notify,
}

#[derive(Default)]
struct FakeLookup {
    branch_prs: BTreeMap<(String, String), Result<OpenPrSearchResult, GitHubError>>,
    open: BTreeMap<String, Result<OpenPrSearchResult, GitHubError>>,
    prs: BTreeMap<(String, u64), Result<PullRequestSummary, GitHubError>>,
    gates: BTreeMap<u64, Arc<Gate>>,
    calls: AtomicUsize,
}

impl FakeLookup {
    fn branch(mut self, repo: &str, branch: &str, prs: Vec<PullRequestSummary>) -> Self {
        self.branch_prs.insert(
            (repo.into(), branch.into()),
            Ok(OpenPrSearchResult {
                prs,
                has_more: false,
            }),
        );
        self
    }

    fn branch_result(
        mut self,
        repo: &str,
        branch: &str,
        result: Result<OpenPrSearchResult, GitHubError>,
    ) -> Self {
        self.branch_prs.insert((repo.into(), branch.into()), result);
        self
    }

    fn open(mut self, repo: &str, result: Result<OpenPrSearchResult, GitHubError>) -> Self {
        self.open.insert(repo.into(), result);
        self
    }

    fn pr(mut self, repo: &str, result: Result<PullRequestSummary, GitHubError>) -> Self {
        let number = match &result {
            Ok(pr) => pr.number,
            Err(_) => panic!("use pr_error for failures"),
        };
        self.prs.insert((repo.into(), number), result);
        self
    }

    fn pr_error(mut self, repo: &str, number: u64, err: GitHubError) -> Self {
        self.prs.insert((repo.into(), number), Err(err));
        self
    }

    fn gated(mut self, number: u64) -> (Self, Arc<Gate>) {
        let gate = Arc::new(Gate::default());
        self.gates.insert(number, gate.clone());
        (self, gate)
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl PrLookup for FakeLookup {
    async fn open_prs_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.branch_prs
            .get(&(repo.full_name(), branch.to_string()))
            .cloned()
            .unwrap_or(Ok(OpenPrSearchResult {
                prs: Vec::new(),
                has_more: false,
            }))
    }

    async fn open_prs(&self, repo: &RepoRef) -> Result<OpenPrSearchResult, GitHubError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.open
            .get(&repo.full_name())
            .cloned()
            .unwrap_or(Ok(OpenPrSearchResult {
                prs: Vec::new(),
                has_more: false,
            }))
    }

    async fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestSummary, GitHubError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.gates.get(&number) {
            gate.reached.notify_one();
            gate.release.notified().await;
        }
        self.prs
            .get(&(repo.full_name(), number))
            .cloned()
            .unwrap_or_else(|| {
                Err(GitHubError::NotFound {
                    message: format!("#{number}"),
                })
            })
    }
}

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

fn stored_link(branch: &str, number: u64, fetched_at: Option<i64>) -> StoredPrAssociation {
    StoredPrAssociation::Linked(Box::new(StoredPrRecord::new(
        "example",
        "demo-repo",
        fetched_at,
        summary(number, branch, Some("example/demo-repo")),
    )))
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

struct Fixture {
    _worktree: tempfile::TempDir,
    _store_dir: tempfile::TempDir,
    ctx: WorktreeGitContext,
    store: PrAssociationStore,
}

fn fixture(branch: &str, remotes: &[(&str, &str)]) -> Fixture {
    let worktree = tempfile::tempdir().unwrap();
    init_repo(worktree.path(), branch, remotes);
    let ctx = resolve_worktree_git_context(worktree.path(), branch).unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let store = PrAssociationStore::at(store_dir.path());
    Fixture {
        _worktree: worktree,
        _store_dir: store_dir,
        ctx,
        store,
    }
}

async fn seed(fx: &Fixture, entry: StoredPrAssociation) {
    assert_eq!(
        fx.store
            .save_discovered(&fx.ctx.key(), None, entry)
            .await
            .unwrap(),
        PrSave::Saved
    );
}

fn linked_number(association: &WorktreePrAssociation) -> u32 {
    match association {
        WorktreePrAssociation::Linked { pr, .. } => pr.number,
        other => panic!("expected Linked, got {other:?}"),
    }
}

fn candidate_numbers(association: &WorktreePrAssociation) -> Vec<u32> {
    match association {
        WorktreePrAssociation::Ambiguous { candidates, .. } => {
            candidates.iter().map(|pr| pr.number).collect()
        }
        other => panic!("expected Ambiguous, got {other:?}"),
    }
}

#[test]
fn rejects_unrepresentable_pr_number_instead_of_clamping() {
    let pr = summary(u64::from(u32::MAX) + 1, "b", None);
    assert!(GithubPullRequest::from_summary("example", "demo-repo", &pr).is_err());
}

fn not_applicable_reason(result: Result<WorktreeGitContext, WorktreePrAssociation>) -> String {
    match result {
        Err(WorktreePrAssociation::NotApplicable { reason, .. }) => reason,
        Err(other) => panic!("expected NotApplicable, got {other:?}"),
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
        Err(WorktreePrAssociation::NotApplicable { branch, reason }) => {
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
    let fx = fixture(
        "feature/retry",
        &[
            ("origin", "git@github.com:alice/demo-repo.git"),
            ("upstream", "https://github.com/example/demo-repo.git"),
        ],
    );
    assert_eq!(fx.ctx.head_repo.full_name(), "alice/demo-repo");
    assert_eq!(fx.ctx.base_repo.full_name(), "example/demo-repo");
    assert_eq!(
        fx.ctx
            .github_remotes
            .iter()
            .map(RepoRef::full_name)
            .collect::<Vec<_>>(),
        ["alice/demo-repo", "example/demo-repo"]
    );
    match fx.ctx.no_pr() {
        WorktreePrAssociation::None {
            create_pr_url,
            repo,
            ..
        } => {
            assert_eq!(repo, "example/demo-repo");
            assert_eq!(
                create_pr_url,
                "https://github.com/example/demo-repo/compare/alice:feature/retry?expand=1"
            );
        }
        other => panic!("expected None, got {other:?}"),
    }
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

#[tokio::test]
async fn unique_open_pr_links_automatically_and_survives_restart_without_github() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/retry",
        vec![summary(482, "feature/retry", Some("example/demo-repo"))],
    );

    let first = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(linked_number(&first), 482);
    assert_eq!(lookup.calls(), 1);

    let reopened = PrAssociationStore::at(fx._store_dir.path());
    let offline = FakeLookup::default();
    let restored = association(&reopened, &fx.ctx, false, &offline, later(30))
        .await
        .unwrap();
    assert_eq!(restored, first);
    assert_eq!(offline.calls(), 0);
}

#[tokio::test]
async fn head_repo_matching_is_case_insensitive_and_requires_a_head_repo() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/retry",
        vec![summary(7, "feature/retry", Some("Example/Demo-Repo"))],
    );
    let linked = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(linked_number(&linked), 7);

    let fx = fixture("feature/deleted-fork", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/deleted-fork",
        vec![summary(8, "feature/deleted-fork", None)],
    );
    let result = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&result), [8]);
    assert_eq!(fx.store.load(&fx.ctx.key()).await.unwrap(), None);
}

#[tokio::test]
async fn outside_fork_pr_is_never_auto_linked_even_when_unique() {
    let fx = fixture("patch-1", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "patch-1",
        vec![summary(501, "patch-1", Some("bob/demo-repo"))],
    );
    let result = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&result), [501]);
    assert_eq!(fx.store.load(&fx.ctx.key()).await.unwrap(), None);
}

#[tokio::test]
async fn fork_branch_finds_its_pr_in_upstream_and_links_it_there() {
    let fx = fixture(
        "feature/retry",
        &[
            ("origin", "https://github.com/alice/demo-repo.git"),
            ("upstream", "https://github.com/example/demo-repo.git"),
        ],
    );
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/retry",
        vec![summary(31, "feature/retry", Some("alice/demo-repo"))],
    );
    let result = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    match &result {
        WorktreePrAssociation::Linked { repo, pr, .. } => {
            assert_eq!(repo, "example/demo-repo");
            assert_eq!((pr.owner.as_str(), pr.number), ("example", 31));
        }
        other => panic!("expected Linked, got {other:?}"),
    }
    assert_eq!(lookup.calls(), 2);

    let offline = FakeLookup::default();
    let again = association(&fx.store, &fx.ctx, false, &offline, later(5))
        .await
        .unwrap();
    assert_eq!(linked_number(&again), 31);
    assert_eq!(offline.calls(), 0);
}

#[tokio::test]
async fn two_matching_prs_are_ambiguous_and_incomplete_results_never_auto_link() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/retry",
        vec![
            summary(482, "feature/retry", Some("example/demo-repo")),
            summary(479, "feature/retry", Some("bob/demo-repo")),
        ],
    );
    let result = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&result), [482, 479]);

    let fx = fixture("feature/many", &[ORIGIN]);
    let lookup = FakeLookup::default().branch_result(
        "example/demo-repo",
        "feature/many",
        Ok(OpenPrSearchResult {
            prs: vec![summary(901, "feature/many", Some("example/demo-repo"))],
            has_more: true,
        }),
    );
    let result = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&result), [901]);
    assert_eq!(fx.store.load(&fx.ctx.key()).await.unwrap(), None);
}

#[tokio::test]
async fn gh_missing_and_auth_expired_return_distinct_recoverable_states() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let missing = FakeLookup::default().branch_result(
        "example/demo-repo",
        "feature/retry",
        Err(GitHubError::GhMissing),
    );
    assert!(matches!(
        association(&fx.store, &fx.ctx, true, &missing, NOW)
            .await
            .unwrap(),
        WorktreePrAssociation::GhMissing { .. }
    ));

    let expired = FakeLookup::default().branch_result(
        "example/demo-repo",
        "feature/retry",
        Err(GitHubError::AuthExpired {
            message: "Bad credentials".into(),
        }),
    );
    match association(&fx.store, &fx.ctx, true, &expired, NOW)
        .await
        .unwrap()
    {
        WorktreePrAssociation::AuthExpired { reason, .. } => assert_eq!(reason, "Bad credentials"),
        other => panic!("expected AuthExpired, got {other:?}"),
    }

    let limited = FakeLookup::default().branch_result(
        "example/demo-repo",
        "feature/retry",
        Err(GitHubError::RateLimited {
            retry_after_secs: Some(90),
            message: "slow down".into(),
        }),
    );
    match association(&fx.store, &fx.ctx, true, &limited, NOW)
        .await
        .unwrap()
    {
        WorktreePrAssociation::Unavailable { error, .. } => {
            assert_eq!(error.kind, GithubErrorKind::RateLimited);
            assert_eq!(error.retry_after_secs, Some(90));
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn plain_reloads_reuse_negative_results_until_ttl_or_refresh() {
    let fx = fixture("feature/none", &[ORIGIN]);
    let lookup = FakeLookup::default();

    for _ in 0..3 {
        assert!(matches!(
            association(&fx.store, &fx.ctx, false, &lookup, NOW)
                .await
                .unwrap(),
            WorktreePrAssociation::None { .. }
        ));
    }
    assert_eq!(lookup.calls(), 1, "reloads must not re-query GitHub");

    association(&fx.store, &fx.ctx, true, &lookup, NOW)
        .await
        .unwrap();
    association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(lookup.calls(), 2);

    expire_cached(&fx.ctx);
    association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(lookup.calls(), 3);
}

fn expire_cached(ctx: &WorktreeGitContext) {
    let past = Instant::now() - Duration::from_secs(1);
    if let Some(cached) = lock_display_cache().get_mut(&ctx.cache_key()) {
        cached.expires_at = Some(past);
    }
}

#[tokio::test]
async fn two_branches_of_one_worktree_keep_their_own_links() {
    let worktree = tempfile::tempdir().unwrap();
    init_repo(worktree.path(), "feature/branch-a", &[ORIGIN]);
    let store_dir = tempfile::tempdir().unwrap();
    let store = PrAssociationStore::at(store_dir.path());
    let ctx_a = resolve_worktree_git_context(worktree.path(), "feature/branch-a").unwrap();
    let ctx_b = resolve_worktree_git_context(worktree.path(), "feature/branch-b").unwrap();
    let lookup = FakeLookup::default()
        .branch(
            "example/demo-repo",
            "feature/branch-a",
            vec![summary(482, "feature/branch-a", Some("example/demo-repo"))],
        )
        .pr(
            "example/demo-repo",
            Ok(summary(479, "feature/branch-b", Some("example/demo-repo"))),
        );

    assert_eq!(
        linked_number(
            &association(&store, &ctx_a, false, &lookup, NOW)
                .await
                .unwrap()
        ),
        482
    );
    link(&store, &ctx_b, 479, None, &lookup, NOW).await.unwrap();
    assert_eq!(
        store.load(&ctx_a.key()).await.unwrap(),
        Some(stored_link("feature/branch-a", 482, NOW))
    );
    unlink(&store, &ctx_b).await.unwrap();

    let reopened = PrAssociationStore::at(store_dir.path());
    let offline = FakeLookup::default();
    assert_eq!(
        linked_number(
            &association(&reopened, &ctx_a, false, &offline, later(5))
                .await
                .unwrap()
        ),
        482
    );
    assert!(matches!(
        association(&reopened, &ctx_b, false, &offline, later(5)).await.unwrap(),
        WorktreePrAssociation::None { branch, .. } if branch == "feature/branch-b"
    ));
    assert_eq!(offline.calls(), 0);
}

#[tokio::test]
async fn switching_head_leaves_the_pinned_branch_pr_unchanged() {
    let worktree = tempfile::tempdir().unwrap();
    let repo = init_repo(worktree.path(), "feature/branch-a", &[ORIGIN]);
    let store_dir = tempfile::tempdir().unwrap();
    let store = PrAssociationStore::at(store_dir.path());
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/branch-a",
        vec![summary(482, "feature/branch-a", Some("example/demo-repo"))],
    );

    let ctx_a = resolve_worktree_git_context(worktree.path(), "feature/branch-a").unwrap();
    let on_a = association(&store, &ctx_a, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(linked_number(&on_a), 482);

    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature/branch-b", &head_commit, true).unwrap();
    repo.set_head("refs/heads/feature/branch-b").unwrap();

    let offline = FakeLookup::default();
    let pinned = resolve_worktree_git_context(worktree.path(), "feature/branch-a").unwrap();
    assert_eq!(
        association(&store, &pinned, false, &offline, later(5))
            .await
            .unwrap(),
        on_a
    );
    assert_eq!(offline.calls(), 0);
}

#[tokio::test]
async fn stale_linked_pr_refreshes_and_persists_when_ttl_expires() {
    let fx = fixture("feature/done", &[ORIGIN]);
    seed(
        &fx,
        stored_link("feature/done", 42, later(-LINKED_STALE_TTL_SECS - 10)),
    )
    .await;
    let mut merged = summary(42, "feature/done", Some("example/demo-repo"));
    merged.state = PullRequestState::Merged;
    let lookup = FakeLookup::default().pr("example/demo-repo", Ok(merged));

    match association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap()
    {
        WorktreePrAssociation::Linked {
            pr, stale_error, ..
        } => {
            assert_eq!(pr.state, GithubPrState::Merged);
            assert_eq!(stale_error, None);
        }
        other => panic!("expected refreshed Linked, got {other:?}"),
    }
    match fx.store.load(&fx.ctx.key()).await.unwrap() {
        Some(StoredPrAssociation::Linked(record)) => {
            assert_eq!(record.pr.state, PullRequestState::Merged);
            assert_eq!(Some(record.fetched_at), NOW);
        }
        other => panic!("expected stored link, got {other:?}"),
    }
}

#[tokio::test]
async fn failed_refresh_keeps_the_link_with_a_typed_reason_and_backs_off() {
    for (err, kind) in [
        (
            GitHubError::Network {
                message: "offline".into(),
            },
            GithubErrorKind::Other,
        ),
        (
            GitHubError::NotFound {
                message: "gone".into(),
            },
            GithubErrorKind::NotFound,
        ),
        (GitHubError::GhMissing, GithubErrorKind::GhMissing),
        (
            GitHubError::AuthExpired {
                message: "expired".into(),
            },
            GithubErrorKind::AuthExpired,
        ),
    ] {
        let fx = fixture("feature/done", &[ORIGIN]);
        let stale_at = later(-LINKED_STALE_TTL_SECS - 10);
        seed(&fx, stored_link("feature/done", 42, stale_at)).await;
        let lookup = FakeLookup::default().pr_error("example/demo-repo", 42, err);

        for _ in 0..3 {
            match association(&fx.store, &fx.ctx, false, &lookup, NOW)
                .await
                .unwrap()
            {
                WorktreePrAssociation::Linked {
                    pr, stale_error, ..
                } => {
                    assert_eq!(pr.number, 42);
                    assert_eq!(stale_error.map(|failure| failure.kind), Some(kind));
                }
                other => panic!("expected stale Linked for {kind:?}, got {other:?}"),
            }
        }
        assert_eq!(lookup.calls(), 1, "{kind:?}: failed refresh must back off");
        assert_eq!(
            fx.store.load(&fx.ctx.key()).await.unwrap(),
            Some(stored_link("feature/done", 42, stale_at))
        );
    }
}

#[tokio::test]
async fn check_again_after_unlink_shows_candidates_that_stick_until_unlinked_again() {
    let fx = fixture("local/custom-name", &[ORIGIN]);
    let unlinked = UserPrMutation::begin(&fx.ctx.key());
    fx.store
        .save_user(&unlinked, StoredPrAssociation::Unlinked)
        .await
        .unwrap();
    drop(unlinked);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "local/custom-name",
        vec![summary(888, "local/custom-name", Some("example/demo-repo"))],
    );

    assert!(matches!(
        association(&fx.store, &fx.ctx, false, &lookup, NOW)
            .await
            .unwrap(),
        WorktreePrAssociation::None { .. }
    ));
    assert_eq!(lookup.calls(), 0);

    let refreshed = association(&fx.store, &fx.ctx, true, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&refreshed), [888]);
    assert!(lock_display_cache()
        .get(&fx.ctx.cache_key())
        .is_some_and(|cached| cached.expires_at.is_none()));
    let reload = association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(candidate_numbers(&reload), [888]);
    assert_eq!(lookup.calls(), 1);

    unlink(&fx.store, &fx.ctx).await.unwrap();
    assert!(matches!(
        association(&fx.store, &fx.ctx, false, &lookup, NOW)
            .await
            .unwrap(),
        WorktreePrAssociation::None { .. }
    ));
    assert_eq!(lookup.calls(), 1);
}

#[tokio::test]
async fn manual_link_with_different_head_branch_survives_restart() {
    let fx = fixture("local/custom-name", &[ORIGIN]);
    let lookup = FakeLookup::default().pr(
        "example/demo-repo",
        Ok(summary(777, "remote/other-name", Some("example/demo-repo"))),
    );
    let linked = link(&fx.store, &fx.ctx, 777, None, &lookup, NOW)
        .await
        .unwrap();
    assert_eq!(linked_number(&linked), 777);

    let reopened = PrAssociationStore::at(fx._store_dir.path());
    let offline = FakeLookup::default();
    let restored = association(&reopened, &fx.ctx, false, &offline, later(10))
        .await
        .unwrap();
    assert_eq!(restored, linked);
    assert_eq!(offline.calls(), 0);
}

#[tokio::test]
async fn link_targets_the_requested_remote_and_reports_typed_failures() {
    let fx = fixture(
        "feature/retry",
        &[
            ("origin", "https://github.com/alice/demo-repo.git"),
            ("upstream", "https://github.com/example/demo-repo.git"),
        ],
    );
    let lookup = FakeLookup::default()
        .pr(
            "alice/demo-repo",
            Ok(summary(3, "feature/retry", Some("alice/demo-repo"))),
        )
        .pr_error(
            "example/demo-repo",
            9,
            GitHubError::AuthExpired {
                message: "expired".into(),
            },
        );

    let linked = link(&fx.store, &fx.ctx, 3, Some("Alice/Demo-Repo"), &lookup, NOW)
        .await
        .unwrap();
    match &linked {
        WorktreePrAssociation::Linked { repo, .. } => assert_eq!(repo, "alice/demo-repo"),
        other => panic!("expected Linked, got {other:?}"),
    }

    let not_found = link(&fx.store, &fx.ctx, 5, None, &lookup, NOW)
        .await
        .unwrap_err();
    assert_eq!(not_found.kind, GithubErrorKind::NotFound);
    let expired = link(&fx.store, &fx.ctx, 9, None, &lookup, NOW)
        .await
        .unwrap_err();
    assert_eq!(expired.kind, GithubErrorKind::AuthExpired);
    let foreign = link(&fx.store, &fx.ctx, 3, Some("bob/demo-repo"), &lookup, NOW)
        .await
        .unwrap_err();
    assert_eq!(foreign.kind, GithubErrorKind::Other);
    let zero = link(&fx.store, &fx.ctx, 0, None, &lookup, NOW)
        .await
        .unwrap_err();
    assert_eq!(zero.kind, GithubErrorKind::Other);

    let offline = FakeLookup::default();
    assert_eq!(
        association(&fx.store, &fx.ctx, false, &offline, NOW)
            .await
            .unwrap(),
        linked
    );
}

#[tokio::test]
async fn unlink_persists_and_overrides_auto_link() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let lookup = FakeLookup::default().branch(
        "example/demo-repo",
        "feature/retry",
        vec![summary(482, "feature/retry", Some("example/demo-repo"))],
    );
    association(&fx.store, &fx.ctx, false, &lookup, NOW)
        .await
        .unwrap();

    assert!(matches!(
        unlink(&fx.store, &fx.ctx).await.unwrap(),
        WorktreePrAssociation::None { .. }
    ));
    assert_eq!(
        fx.store.load(&fx.ctx.key()).await.unwrap(),
        Some(StoredPrAssociation::Unlinked)
    );
    assert!(matches!(
        association(&fx.store, &fx.ctx, false, &lookup, later(1))
            .await
            .unwrap(),
        WorktreePrAssociation::None { .. }
    ));
    assert_eq!(lookup.calls(), 1);
}

#[tokio::test]
async fn list_open_prs_uses_the_base_repo_and_types_failures() {
    let fx = fixture(
        "feature/retry",
        &[
            ("origin", "https://github.com/alice/demo-repo.git"),
            ("upstream", "https://github.com/example/demo-repo.git"),
        ],
    );
    let lookup = FakeLookup::default().open(
        "example/demo-repo",
        Ok(OpenPrSearchResult {
            prs: vec![summary(1, "a", Some("example/demo-repo"))],
            has_more: false,
        }),
    );
    let prs = open_prs(&fx.ctx, &lookup).await.unwrap();
    assert_eq!(prs.len(), 1);
    assert_eq!((prs[0].owner.as_str(), prs[0].number), ("example", 1));

    let missing = FakeLookup::default().open("example/demo-repo", Err(GitHubError::GhMissing));
    assert_eq!(
        open_prs(&fx.ctx, &missing).await.unwrap_err().kind,
        GithubErrorKind::GhMissing
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_started_while_link_awaits_github_cannot_overwrite_the_new_link() {
    let fx = Arc::new(fixture("feature/retry", &[ORIGIN]));
    seed(
        &fx,
        stored_link("feature/retry", 1, later(-LINKED_STALE_TTL_SECS - 10)),
    )
    .await;
    let (lookup, link_gate) = FakeLookup::default()
        .pr(
            "example/demo-repo",
            Ok(summary(1, "feature/retry", Some("example/demo-repo"))),
        )
        .pr(
            "example/demo-repo",
            Ok(summary(2, "feature/retry", Some("example/demo-repo"))),
        )
        .gated(2);
    let (lookup, refresh_gate) = lookup.gated(1);
    let lookup = Arc::new(lookup);

    let linking = tokio::spawn({
        let (fx, lookup) = (fx.clone(), lookup.clone());
        async move { link(&fx.store, &fx.ctx, 2, None, lookup.as_ref(), NOW).await }
    });
    link_gate.reached.notified().await;

    let refreshing = tokio::spawn({
        let (fx, lookup) = (fx.clone(), lookup.clone());
        async move { association(&fx.store, &fx.ctx, true, lookup.as_ref(), NOW).await }
    });
    refresh_gate.reached.notified().await;

    link_gate.release.notify_one();
    assert_eq!(linked_number(&linking.await.unwrap().unwrap()), 2);

    refresh_gate.release.notify_one();
    assert_eq!(linked_number(&refreshing.await.unwrap().unwrap()), 2);

    match fx.store.load(&fx.ctx.key()).await.unwrap() {
        Some(StoredPrAssociation::Linked(record)) => assert_eq!(record.pr.number, 2),
        other => panic!("expected the manual link to survive, got {other:?}"),
    }
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
        GithubErrorKind::Other
    );
    let limited = GithubFailure::from(GitHubError::RateLimited {
        retry_after_secs: Some(u64::MAX),
        message: String::new(),
    });
    assert_eq!(limited.kind, GithubErrorKind::RateLimited);
    assert_eq!(limited.retry_after_secs, Some(u32::MAX));
}
