//! Code intelligence for a worktree's working copy or one of its commits,
//! through the provider-neutral contract in `vertebrae_syntax`. Only the
//! embedded (tree-sitter) provider exists so far; it is shared by every
//! worktree, as its cache is keyed by content.
//!
//! Files are read on demand per request: the working copy's tracked and
//! untracked (not ignored) files through the Files sidebar's path policy,
//! or a commit's tree. Listing a working copy costs a full `git status`, so
//! listings are cached: a commit's for as long as it stays among the most
//! recent, a working copy's for [`LISTING_TTL`] (a file created within
//! that time may be missed until it expires; reads are always live).

use super::worktree_delta::git::{self, GitError};
use super::worktree_files::{self, FilesError};
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use vertebrae_syntax::intelligence::{
    Answer, Budget, Call, CodeIntelligence, CodeSymbol, EmbeddedProvider, IncomingCall,
    IntelligenceError, Reference, Snapshot, SnapshotError, SymbolKey,
};

/// The files a request reads.
#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IntelligenceSnapshot {
    WorkingTree,
    /// A commit (or anything naming one) of the worktree's repository.
    Commit {
        commit: String,
    },
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum IntelligenceRequest {
    Definitions { path: String },
    References { symbol: SymbolKey },
    OutgoingCalls { symbol: SymbolKey },
    IncomingCalls { symbol: SymbolKey, depth: u32 },
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum IntelligenceAnswer {
    Definitions(Answer<CodeSymbol>),
    References(Answer<Reference>),
    OutgoingCalls(Answer<Call>),
    IncomingCalls(Answer<IncomingCall>),
}

/// Why a request has no answer. `Provider` keeps the provider's reason,
/// so a caller can tell a stale symbol key (`unknown_symbol`: fetch the
/// file's definitions again) from an unsupported language.
#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodeIntelligenceError {
    Provider {
        error: IntelligenceError,
    },
    /// The worktree, path or commit was refused or could not be read.
    Files {
        message: String,
    },
    /// The request outlived its budget and the command's margin.
    TimedOut,
    /// The worker failed.
    Failed {
        message: String,
    },
}

impl CodeIntelligenceError {
    pub(super) fn files(error: impl std::fmt::Display) -> Self {
        Self::Files {
            message: error.to_string(),
        }
    }
}

static EMBEDDED: LazyLock<EmbeddedProvider> = LazyLock::new(EmbeddedProvider::new);

/// The budget of one request; the command's timeout adds a margin to it.
pub(crate) fn budget() -> Budget {
    Budget::default()
}

/// Answers one request. Blocks for about the budget's time at most.
pub(crate) fn answer(
    worktree: &Path,
    snapshot: &IntelligenceSnapshot,
    request: &IntelligenceRequest,
) -> Result<IntelligenceAnswer, CodeIntelligenceError> {
    answer_with(&*EMBEDDED, worktree, snapshot, request, &budget())
}

fn answer_with(
    provider: &dyn CodeIntelligence,
    worktree: &Path,
    snapshot: &IntelligenceSnapshot,
    request: &IntelligenceRequest,
    budget: &Budget,
) -> Result<IntelligenceAnswer, CodeIntelligenceError> {
    let files = open_snapshot(worktree, snapshot)?;
    let files = files.as_ref();
    let provided = match request {
        IntelligenceRequest::Definitions { path } => provider
            .definitions(files, path, budget)
            .map(IntelligenceAnswer::Definitions),
        IntelligenceRequest::References { symbol } => provider
            .references(files, symbol, budget)
            .map(IntelligenceAnswer::References),
        IntelligenceRequest::OutgoingCalls { symbol } => provider
            .outgoing_calls(files, symbol, budget)
            .map(IntelligenceAnswer::OutgoingCalls),
        IntelligenceRequest::IncomingCalls { symbol, depth } => provider
            .incoming_calls(files, symbol, *depth, budget)
            .map(IntelligenceAnswer::IncomingCalls),
    };
    provided.map_err(|error| CodeIntelligenceError::Provider { error })
}

pub(crate) fn embedded() -> &'static EmbeddedProvider {
    &EMBEDDED
}

pub(crate) fn open_snapshot(
    worktree: &Path,
    snapshot: &IntelligenceSnapshot,
) -> Result<Box<dyn Snapshot>, CodeIntelligenceError> {
    let root = worktree_files::worktree_root(worktree).map_err(CodeIntelligenceError::files)?;
    let files: Box<dyn Snapshot> = match snapshot {
        IntelligenceSnapshot::WorkingTree => Box::new(WorkingTree { root }),
        IntelligenceSnapshot::Commit { commit } => {
            Box::new(CommitTree::open(&root, commit).map_err(CodeIntelligenceError::files)?)
        }
    };
    Ok(files)
}

/// Runs `work` on a blocking worker under one of `permits`, waiting at
/// most `limit`. The worker holds its permit until it returns, so work
/// that outlives the wait still counts against the bound.
pub(crate) async fn bounded<T: Send + 'static>(
    permits: &'static tokio::sync::Semaphore,
    limit: Duration,
    work: impl FnOnce() -> Result<T, CodeIntelligenceError> + Send + 'static,
) -> Result<T, CodeIntelligenceError> {
    let failed = |message: String| CodeIntelligenceError::Failed { message };
    let permit = permits.acquire().await.map_err(|e| failed(e.to_string()))?;
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    match tokio::time::timeout(limit, worker).await {
        Ok(joined) => joined.map_err(|e| failed(e.to_string()))?,
        Err(_) => Err(CodeIntelligenceError::TimedOut),
    }
}

/// How long a working copy's listing is reused.
const LISTING_TTL: Duration = Duration::from_secs(3);
/// Listings kept, the oldest evicted first.
const LISTINGS: usize = 16;

#[derive(Clone, PartialEq, Eq)]
enum ListingKey {
    WorkingTree(PathBuf),
    Tree(git2::Oid),
}

/// A listing: its key, when it was listed, and its paths.
type Listing = (ListingKey, Instant, Arc<Vec<String>>);

/// Recent listings, oldest first. Concurrent misses list twice and store
/// the same paths; that costs time, never correctness.
static LISTING_CACHE: Mutex<VecDeque<Listing>> = Mutex::new(VecDeque::new());

fn cached_listing(
    key: ListingKey,
    ttl: Option<Duration>,
    list: impl FnOnce() -> Result<Vec<String>, SnapshotError>,
) -> Result<Vec<String>, SnapshotError> {
    let now = Instant::now();
    if let Ok(cache) = LISTING_CACHE.lock() {
        let fresh = cache.iter().find(|(cached, at, _)| {
            *cached == key && ttl.is_none_or(|ttl| now.duration_since(*at) < ttl)
        });
        if let Some((_, _, paths)) = fresh {
            return Ok(paths.as_ref().clone());
        }
    }
    let paths = Arc::new(list()?);
    if let Ok(mut cache) = LISTING_CACHE.lock() {
        cache.retain(|(cached, ..)| *cached != key);
        cache.push_back((key, now, paths.clone()));
        while cache.len() > LISTINGS {
            cache.pop_front();
        }
    }
    Ok(paths.as_ref().clone())
}

fn snapshot_error(error: impl std::fmt::Display) -> SnapshotError {
    SnapshotError(error.to_string())
}

/// UTF-8 text without NUL bytes, else `None`.
fn text(bytes: Vec<u8>) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// The working copy: tracked files and untracked ones Git does not ignore.
struct WorkingTree {
    /// Canonical worktree root.
    root: PathBuf,
}

impl Snapshot for WorkingTree {
    fn paths(&self) -> Result<Vec<String>, SnapshotError> {
        let key = ListingKey::WorkingTree(self.root.clone());
        cached_listing(key, Some(LISTING_TTL), || self.list())
    }

    fn read(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError> {
        self.read_file(path, max_bytes)
    }
}

impl WorkingTree {
    fn list(&self) -> Result<Vec<String>, SnapshotError> {
        let repo = git::repository(&self.root).map_err(snapshot_error)?;
        let mut paths = std::collections::BTreeSet::new();
        let index = repo.index().map_err(snapshot_error)?;
        for entry in index.iter() {
            if let Ok(path) = git::utf8_path(&entry.path) {
                paths.insert(path);
            }
        }
        let mut options = git2::StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false);
        let statuses = repo.statuses(Some(&mut options)).map_err(snapshot_error)?;
        for status in statuses.iter() {
            if status.status().contains(git2::Status::WT_NEW) {
                if let Ok(path) = status.path() {
                    paths.insert(path.to_owned());
                }
            }
        }
        Ok(paths.into_iter().collect())
    }

    fn read_file(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError> {
        let target = match worktree_files::existing_file(&self.root, path) {
            Ok(Some(target)) => target,
            // Missing, deleted, or refused by the path policy.
            Ok(None) | Err(FilesError::Outside(_) | FilesError::Invalid(_)) => return Ok(None),
            Err(error) => return Err(snapshot_error(error)),
        };
        let limit = u64::try_from(max_bytes)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let mut bytes = Vec::new();
        std::fs::File::open(&target)
            .and_then(|file| file.take(limit).read_to_end(&mut bytes))
            .map_err(snapshot_error)?;
        if bytes.len() > max_bytes {
            return Ok(None);
        }
        Ok(text(bytes))
    }
}

/// One commit's tree.
struct CommitTree {
    repo: git2::Repository,
    tree: git2::Oid,
}

impl CommitTree {
    fn open(root: &Path, reference: &str) -> Result<Self, GitError> {
        let repo = git::repository(root)?;
        let tree = repo.revparse_single(reference)?.peel_to_tree()?.id();
        Ok(Self { repo, tree })
    }

    fn with_tree<T>(
        &self,
        work: impl FnOnce(&git2::Repository, &git2::Tree) -> Result<T, git2::Error>,
    ) -> Result<T, SnapshotError> {
        let tree = self.repo.find_tree(self.tree).map_err(snapshot_error)?;
        work(&self.repo, &tree).map_err(snapshot_error)
    }
}

impl Snapshot for CommitTree {
    fn paths(&self) -> Result<Vec<String>, SnapshotError> {
        // A tree never changes.
        cached_listing(ListingKey::Tree(self.tree), None, || self.list())
    }

    fn read(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError> {
        self.read_blob(path, max_bytes)
    }
}

impl CommitTree {
    fn list(&self) -> Result<Vec<String>, SnapshotError> {
        self.with_tree(|_, tree| {
            let mut paths = Vec::new();
            tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
                if entry.kind() == Some(git2::ObjectType::Blob) {
                    if let Ok(name) = entry.name() {
                        paths.push(format!("{dir}{name}"));
                    }
                }
                git2::TreeWalkResult::Ok
            })?;
            paths.sort();
            Ok(paths)
        })
    }

    fn read_blob(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError> {
        self.with_tree(|repo, tree| {
            let entry = match tree.get_path(Path::new(path)) {
                Ok(entry) => entry,
                Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return Ok(None);
            }
            let (size, _) = repo.odb()?.read_header(entry.id())?;
            if size > max_bytes {
                return Ok(None);
            }
            let blob = repo.find_blob(entry.id())?;
            Ok(text(blob.content().to_vec()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use vertebrae_syntax::intelligence::Resolution;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "mod a;\n\npub fn run() {\n    a::step();\n}\n",
        )
        .unwrap();
        fs::write(root.join("src/a.rs"), "pub fn step() {}\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn run_key() -> SymbolKey {
        SymbolKey {
            path: "src/lib.rs".into(),
            name: "run".into(),
            line: 3,
        }
    }

    fn outgoing(answer: IntelligenceAnswer) -> Vec<Call> {
        match answer {
            IntelligenceAnswer::OutgoingCalls(answer) => answer.items,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn working_tree_and_commit_snapshots_answer_from_their_own_files() {
        let dir = repo();
        let root = dir.path();
        // Uncommitted: `run` now calls a function in an untracked file.
        fs::write(
            root.join("src/lib.rs"),
            "mod a;\nmod b;\n\npub fn run() {\n    a::step();\n    b::more();\n}\n",
        )
        .unwrap();
        fs::write(root.join("src/b.rs"), "pub fn more() {}\n").unwrap();
        fs::write(root.join("ignored.rs"), "pub fn more() {}\n").unwrap();
        let provider = EmbeddedProvider::new();
        let request = |key: SymbolKey| IntelligenceRequest::OutgoingCalls { symbol: key };
        let working = outgoing(
            answer_with(
                &provider,
                root,
                &IntelligenceSnapshot::WorkingTree,
                &request(SymbolKey {
                    line: 4,
                    ..run_key()
                }),
                &budget(),
            )
            .unwrap(),
        );
        let targets: Vec<String> = working
            .iter()
            .map(|call| match &call.resolution {
                Resolution::Exact { target } => target.path.clone(),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(targets, ["src/a.rs", "src/b.rs"]);
        let committed = outgoing(
            answer_with(
                &provider,
                root,
                &IntelligenceSnapshot::Commit {
                    commit: "HEAD".into(),
                },
                &request(run_key()),
                &budget(),
            )
            .unwrap(),
        );
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].resolution.targets()[0].path, "src/a.rs");
    }

    #[test]
    fn ignored_files_are_not_listed_and_paths_cannot_escape() {
        let dir = repo();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("ignored.rs"), "pub fn x() {}\n").unwrap();
        let tree = WorkingTree { root };
        let paths = tree.paths().unwrap();
        assert!(paths.contains(&"src/a.rs".to_owned()));
        assert!(!paths.contains(&"ignored.rs".to_owned()));
        assert_eq!(tree.read("../outside.rs", 1024).unwrap(), None);
        assert_eq!(
            tree.read("src/a.rs", 4).unwrap(),
            None,
            "over the size limit"
        );
    }

    #[tokio::test]
    async fn a_timed_out_request_keeps_its_permit_until_its_worker_ends() {
        static PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let slow = bounded(&PERMITS, Duration::from_millis(20), move || {
            wait.recv().ok();
            Ok(())
        });
        assert!(matches!(slow.await, Err(CodeIntelligenceError::TimedOut)));
        assert_eq!(PERMITS.available_permits(), 0, "the worker still runs");
        release.send(()).unwrap();
        let next = bounded(&PERMITS, Duration::from_secs(5), || Ok(7)).await;
        assert!(matches!(next, Ok(7)));
        assert_eq!(PERMITS.available_permits(), 1);
    }

    #[test]
    fn an_unknown_symbol_or_commit_is_an_error() {
        let dir = repo();
        let missing = answer_with(
            &EmbeddedProvider::new(),
            dir.path(),
            &IntelligenceSnapshot::WorkingTree,
            &IntelligenceRequest::OutgoingCalls {
                symbol: SymbolKey {
                    line: 99,
                    ..run_key()
                },
            },
            &budget(),
        );
        assert!(matches!(
            missing,
            Err(CodeIntelligenceError::Provider {
                error: IntelligenceError::UnknownSymbol { .. }
            })
        ));
        let commit = answer_with(
            &EmbeddedProvider::new(),
            dir.path(),
            &IntelligenceSnapshot::Commit {
                commit: "no-such-ref".into(),
            },
            &IntelligenceRequest::Definitions {
                path: "src/lib.rs".into(),
            },
            &budget(),
        );
        assert!(matches!(commit, Err(CodeIntelligenceError::Files { .. })));
    }
}
