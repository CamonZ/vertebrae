//! PR associations persist independently of the Sacrum connection.
//!
//! Writes are ordered without a generation counter that readers could observe
//! before it commits:
//! - discovery saves compare-and-set against the entry it loaded, so any
//!   commit in between (a user link, another discovery) wins;
//! - user link/unlink take a ticket when clicked and commit unless a later
//!   click already committed, so a slow link cannot overwrite a newer unlink
//!   and a link whose GitHub fetch fails leaves earlier clicks unaffected.

use super::{durable_write, lock_file, root};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex as StdMutex, OnceLock,
    },
};
use tokio::sync::Mutex;
use vertebrae_github::PullRequestSummary;

const FILE_NAME: &str = "worktree-pr-associations.json";
const LOCK_NAME: &str = ".worktree-pr-associations.lock";
/// Version 2 keys entries by worktree, then branch. Older files are moved
/// aside and treated as empty (no migration).
const VERSION: u64 = 2;

static PR_ASSOC_SERIAL: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrStoreError(String);

impl fmt::Display for PrStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Local PR association store unavailable: {}", self.0)
    }
}

impl std::error::Error for PrStoreError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct PrKey {
    pub worktree: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredPrRecord {
    /// Repository the pull request belongs to (its base repository).
    pub owner: String,
    pub repo: String,
    /// Unix timestamp (seconds) when PR metadata was last fetched from GitHub;
    /// 0 when the clock could not be read, which always counts as stale.
    pub fetched_at: i64,
    #[serde(flatten)]
    pub pr: PullRequestSummary,
}

impl StoredPrRecord {
    pub(crate) fn new(
        owner: impl Into<String>,
        repo: impl Into<String>,
        fetched_at: Option<i64>,
        pr: PullRequestSummary,
    ) -> Self {
        Self {
            owner: owner.into(),
            repo: repo.into(),
            fetched_at: fetched_at.unwrap_or(0),
            pr,
        }
    }

    /// Stale when `ttl_secs` have passed, the clock is unreadable (`None`), or
    /// the clock moved backwards past the fetch time.
    pub(crate) fn is_stale(&self, now_secs: Option<i64>, ttl_secs: i64) -> bool {
        match now_secs {
            Some(now) => {
                let age = now.saturating_sub(self.fetched_at);
                !(0..ttl_secs).contains(&age)
            }
            None => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum StoredPrAssociation {
    Linked(Box<StoredPrRecord>),
    /// The user explicitly unlinked this branch locally; do not auto-link it
    /// again until they manually link a PR.
    Unlinked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrSave {
    Saved,
    /// A newer commit won; carries the entry now on disk.
    Superseded(Option<StoredPrAssociation>),
}

#[derive(Default, Serialize, Deserialize)]
struct PrAssociationStoreFile {
    version: u64,
    worktrees: BTreeMap<String, BTreeMap<String, StoredPrAssociation>>,
}

impl PrAssociationStoreFile {
    fn get(&self, key: &PrKey) -> Option<&StoredPrAssociation> {
        self.worktrees.get(&key.worktree)?.get(&key.branch)
    }

    fn insert(&mut self, key: PrKey, entry: StoredPrAssociation) {
        self.worktrees
            .entry(key.worktree)
            .or_default()
            .insert(key.branch, entry);
    }
}

/// Only the version, read before the body so an old shape is reported as such.
#[derive(Deserialize)]
struct StoreVersion {
    version: u64,
}

#[derive(Default)]
struct UserMutations {
    in_flight: usize,
    last_committed: u64,
}

static NEXT_USER_TICKET: AtomicU64 = AtomicU64::new(1);

/// Per-key bookkeeping, present only while a user mutation is in flight.
fn user_mutations() -> &'static StdMutex<BTreeMap<PrKey, UserMutations>> {
    static MUTATIONS: OnceLock<StdMutex<BTreeMap<PrKey, UserMutations>>> = OnceLock::new();
    MUTATIONS.get_or_init(|| StdMutex::new(BTreeMap::new()))
}

fn lock_user_mutations() -> std::sync::MutexGuard<'static, BTreeMap<PrKey, UserMutations>> {
    user_mutations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A user link/unlink click, ordered by when it was clicked.
#[derive(Debug)]
pub(crate) struct UserPrMutation {
    key: PrKey,
    ticket: u64,
}

impl UserPrMutation {
    pub(crate) fn begin(key: &PrKey) -> Self {
        let mut map = lock_user_mutations();
        map.entry(key.clone()).or_default().in_flight += 1;
        let ticket = NEXT_USER_TICKET.fetch_add(1, Ordering::Relaxed);
        Self {
            key: key.clone(),
            ticket,
        }
    }
}

/// Whether no later click has committed. Checked and recorded under the store
/// locks so the check, the write and the record are one step.
fn user_commit_allowed(key: &PrKey, ticket: u64) -> bool {
    lock_user_mutations()
        .get(key)
        .is_none_or(|entry| ticket > entry.last_committed)
}

fn record_user_commit(key: &PrKey, ticket: u64) {
    if let Some(entry) = lock_user_mutations().get_mut(key) {
        entry.last_committed = entry.last_committed.max(ticket);
    }
}

impl Drop for UserPrMutation {
    fn drop(&mut self) {
        let mut map = lock_user_mutations();
        if let Some(entry) = map.get_mut(&self.key) {
            entry.in_flight = entry.in_flight.saturating_sub(1);
            // Tickets are global and monotonic, so once nothing is in flight
            // every future ticket outranks the forgotten `last_committed`.
            if entry.in_flight == 0 {
                map.remove(&self.key);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PrAssociationStore {
    dir: PathBuf,
}

impl PrAssociationStore {
    pub(crate) async fn app() -> Result<Self, PrStoreError> {
        let dir = blocking(|| root().map_err(|err| PrStoreError(err.message))).await?;
        Ok(Self { dir })
    }

    #[cfg(test)]
    pub(crate) fn at(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    /// Runs `op` on a blocking thread holding the process and disk locks.
    async fn locked<R: Send + 'static>(
        &self,
        op: impl FnOnce(&Path) -> Result<R, PrStoreError> + Send + 'static,
    ) -> Result<R, PrStoreError> {
        let _serial = PR_ASSOC_SERIAL.lock().await;
        let _disk = lock_file(&self.dir, LOCK_NAME)
            .await
            .map_err(|err| PrStoreError(err.message))?;
        let path = self.dir.join(FILE_NAME);
        blocking(move || op(&path)).await
    }

    pub(crate) async fn load(
        &self,
        key: &PrKey,
    ) -> Result<Option<StoredPrAssociation>, PrStoreError> {
        let key = key.clone();
        self.locked(move |path| Ok(load_store(path)?.get(&key).cloned()))
            .await
    }

    /// Saves a discovery result only if the entry is still `expected`.
    pub(crate) async fn save_discovered(
        &self,
        key: &PrKey,
        expected: Option<StoredPrAssociation>,
        entry: StoredPrAssociation,
    ) -> Result<PrSave, PrStoreError> {
        let key = key.clone();
        self.locked(move |path| {
            let mut store = load_store(path)?;
            let current = store.get(&key);
            if current != expected.as_ref() {
                return Ok(PrSave::Superseded(current.cloned()));
            }
            store.insert(key, entry);
            save_store(path, &store)?;
            Ok(PrSave::Saved)
        })
        .await
    }

    /// Saves a user link/unlink unless a later click already committed.
    pub(crate) async fn save_user(
        &self,
        mutation: &UserPrMutation,
        entry: StoredPrAssociation,
    ) -> Result<PrSave, PrStoreError> {
        let key = mutation.key.clone();
        let ticket = mutation.ticket;
        self.locked(move |path| {
            let mut store = load_store(path)?;
            if !user_commit_allowed(&key, ticket) {
                return Ok(PrSave::Superseded(store.get(&key).cloned()));
            }
            store.insert(key.clone(), entry);
            save_store(path, &store)?;
            record_user_commit(&key, ticket);
            Ok(PrSave::Saved)
        })
        .await
    }
}

async fn blocking<R: Send + 'static>(
    op: impl FnOnce() -> Result<R, PrStoreError> + Send + 'static,
) -> Result<R, PrStoreError> {
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|err| PrStoreError(format!("store task failed: {err}")))?
}

/// Loads the store; an unparseable or wrong-version file (including every
/// older format) is moved aside and treated as empty so one bad file cannot
/// disable every PR command.
fn load_store(path: &Path) -> Result<PrAssociationStoreFile, PrStoreError> {
    let empty = || PrAssociationStoreFile {
        version: VERSION,
        worktrees: BTreeMap::new(),
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(err) => return Err(PrStoreError(format!("could not read {FILE_NAME}: {err}"))),
    };
    let parsed = serde_json::from_slice::<StoreVersion>(&bytes).and_then(|probe| {
        if probe.version == VERSION {
            serde_json::from_slice::<PrAssociationStoreFile>(&bytes).map(Ok)
        } else {
            Ok(Err(probe.version))
        }
    });
    match parsed {
        Ok(Ok(store)) => Ok(store),
        Ok(Err(version)) => {
            quarantine(path, &format!("unsupported version {version}"));
            Ok(empty())
        }
        Err(err) => {
            quarantine(path, &err.to_string());
            Ok(empty())
        }
    }
}

fn quarantine(path: &Path, reason: &str) {
    let aside = path.with_file_name(format!("{FILE_NAME}.corrupt-{}", uuid::Uuid::new_v4()));
    match fs::rename(path, &aside) {
        Ok(()) => tracing::warn!(
            reason,
            moved_to = %aside.display(),
            "Ignoring unreadable worktree PR association store"
        ),
        Err(err) => tracing::warn!(
            reason,
            error = %err,
            "Ignoring unreadable worktree PR association store; could not move it aside"
        ),
    }
}

fn save_store(path: &Path, store: &PrAssociationStoreFile) -> Result<(), PrStoreError> {
    let bytes = serde_json::to_vec(store)
        .map_err(|err| PrStoreError(format!("could not encode {FILE_NAME}: {err}")))?;
    durable_write(path, &bytes).map_err(|_| PrStoreError(format!("could not write {FILE_NAME}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_github::PullRequestState;

    fn record(number: u64, title: &str) -> StoredPrRecord {
        StoredPrRecord::new(
            "example",
            "demo-repo",
            Some(1_700_000_000),
            PullRequestSummary {
                number,
                title: title.into(),
                state: PullRequestState::Open,
                head_ref: "feature/retry".into(),
                head_repo: Some("example/demo-repo".into()),
                base_ref: "main".into(),
                url: format!("https://github.com/example/demo-repo/pull/{number}"),
                author: Some("alice".into()),
                updated_at: Some("2026-11-24T12:00:00Z".into()),
            },
        )
    }

    fn linked(number: u64, title: &str) -> StoredPrAssociation {
        StoredPrAssociation::Linked(Box::new(record(number, title)))
    }

    fn unique_key(dir: &tempfile::TempDir, name: &str) -> PrKey {
        branch_key(dir, name, "feature/retry")
    }

    fn branch_key(dir: &tempfile::TempDir, name: &str, branch: &str) -> PrKey {
        PrKey {
            worktree: format!("{}/{name}", dir.path().display()),
            branch: branch.into(),
        }
    }

    #[tokio::test]
    async fn pr_associations_persist_per_worktree_in_sacrum_independent_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let (a, b) = (unique_key(&dir, "a"), unique_key(&dir, "b"));

        let first = UserPrMutation::begin(&a);
        assert_eq!(
            store.save_user(&first, linked(482, "Reset")).await.unwrap(),
            PrSave::Saved
        );
        let second = UserPrMutation::begin(&b);
        assert_eq!(
            store
                .save_user(&second, StoredPrAssociation::Unlinked)
                .await
                .unwrap(),
            PrSave::Saved
        );

        let reopened = PrAssociationStore::at(dir.path());
        assert_eq!(reopened.load(&a).await.unwrap(), Some(linked(482, "Reset")));
        assert_eq!(
            reopened.load(&b).await.unwrap(),
            Some(StoredPrAssociation::Unlinked)
        );
        assert_eq!(reopened.load(&unique_key(&dir, "c")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn pr_associations_for_two_branches_of_one_worktree_never_overwrite_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let a = branch_key(&dir, "wt", "feature/a");
        let b = branch_key(&dir, "wt", "feature/b");

        let link_a = UserPrMutation::begin(&a);
        store.save_user(&link_a, linked(1, "A")).await.unwrap();
        let link_b = UserPrMutation::begin(&b);
        store.save_user(&link_b, linked(2, "B")).await.unwrap();
        assert_eq!(
            store
                .save_discovered(&b, Some(linked(2, "B")), StoredPrAssociation::Unlinked)
                .await
                .unwrap(),
            PrSave::Saved
        );

        let reopened = PrAssociationStore::at(dir.path());
        assert_eq!(reopened.load(&a).await.unwrap(), Some(linked(1, "A")));
        assert_eq!(
            reopened.load(&b).await.unwrap(),
            Some(StoredPrAssociation::Unlinked)
        );
        assert_eq!(
            reopened
                .load(&branch_key(&dir, "wt", "feature/c"))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn stale_delayed_link_cannot_overwrite_newer_unlink() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let key = unique_key(&dir, "race");

        let link = UserPrMutation::begin(&key);
        let unlink = UserPrMutation::begin(&key);
        assert_eq!(
            store
                .save_user(&unlink, StoredPrAssociation::Unlinked)
                .await
                .unwrap(),
            PrSave::Saved
        );
        assert_eq!(
            store
                .save_user(&link, linked(482, "Delayed"))
                .await
                .unwrap(),
            PrSave::Superseded(Some(StoredPrAssociation::Unlinked))
        );
        assert_eq!(
            store.load(&key).await.unwrap(),
            Some(StoredPrAssociation::Unlinked)
        );
    }

    #[tokio::test]
    async fn user_clicks_on_another_branch_do_not_supersede_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let a = branch_key(&dir, "wt", "feature/a");
        let b = branch_key(&dir, "wt", "feature/b");

        let on_a = UserPrMutation::begin(&a);
        let on_b = UserPrMutation::begin(&b);
        store
            .save_user(&on_b, StoredPrAssociation::Unlinked)
            .await
            .unwrap();
        assert_eq!(
            store.save_user(&on_a, linked(7, "A")).await.unwrap(),
            PrSave::Saved
        );
    }

    #[tokio::test]
    async fn failed_later_link_does_not_block_earlier_unlink() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let key = unique_key(&dir, "failed-link");

        let unlink = UserPrMutation::begin(&key);
        // Clicked after the unlink, then its GitHub fetch failed: no commit.
        drop(UserPrMutation::begin(&key));
        assert_eq!(
            store
                .save_user(&unlink, StoredPrAssociation::Unlinked)
                .await
                .unwrap(),
            PrSave::Saved
        );
    }

    #[tokio::test]
    async fn discovery_started_during_link_cannot_overwrite_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let key = unique_key(&dir, "discovery-race");
        let seed = UserPrMutation::begin(&key);
        store.save_user(&seed, linked(1, "Old")).await.unwrap();
        drop(seed);

        // Link #2 starts and awaits GitHub; discovery loads the old entry.
        let link = UserPrMutation::begin(&key);
        let loaded = store.load(&key).await.unwrap();
        assert_eq!(
            store.save_user(&link, linked(2, "New")).await.unwrap(),
            PrSave::Saved
        );
        assert_eq!(
            store
                .save_discovered(&key, loaded, linked(1, "Old refreshed"))
                .await
                .unwrap(),
            PrSave::Superseded(Some(linked(2, "New")))
        );
        assert_eq!(store.load(&key).await.unwrap(), Some(linked(2, "New")));
    }

    #[tokio::test]
    async fn user_link_overwrites_a_discovery_committed_while_it_was_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let store = PrAssociationStore::at(dir.path());
        let key = unique_key(&dir, "link-wins");

        let link = UserPrMutation::begin(&key);
        assert_eq!(
            store
                .save_discovered(&key, None, linked(1, "Auto"))
                .await
                .unwrap(),
            PrSave::Saved
        );
        assert_eq!(
            store.save_user(&link, linked(2, "Manual")).await.unwrap(),
            PrSave::Saved
        );
        assert_eq!(store.load(&key).await.unwrap(), Some(linked(2, "Manual")));
    }

    #[test]
    fn mutation_bookkeeping_is_pruned_when_nothing_is_in_flight() {
        let key = PrKey {
            worktree: format!("/wt/prune-{}", uuid::Uuid::new_v4()),
            branch: "feature/retry".into(),
        };
        let first = UserPrMutation::begin(&key);
        let second = UserPrMutation::begin(&key);
        assert!(lock_user_mutations().contains_key(&key));
        drop(first);
        assert!(lock_user_mutations().contains_key(&key));
        drop(second);
        assert!(!lock_user_mutations().contains_key(&key));
    }

    #[tokio::test]
    async fn corrupt_old_or_wrong_version_store_is_moved_aside_and_treated_as_empty() {
        // The version-1 shape kept one entry per worktree, without a branch key.
        let version_one =
            br#"{"version":1,"worktrees":{"/wt":{"status":"unlinked","branch":"feature/retry"}}}"#;
        for contents in [
            &b"{not json"[..],
            &version_one[..],
            br#"{"version":99,"worktrees":{}}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(FILE_NAME);
            fs::write(&path, contents).unwrap();
            let store = PrAssociationStore::at(dir.path());
            let key = unique_key(&dir, "wt");

            assert_eq!(store.load(&key).await.unwrap(), None);
            let quarantined = fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&format!("{FILE_NAME}.corrupt-"))
                })
                .count();
            assert_eq!(quarantined, 1);

            let mutation = UserPrMutation::begin(&key);
            store
                .save_user(&mutation, StoredPrAssociation::Unlinked)
                .await
                .unwrap();
            assert_eq!(
                store.load(&key).await.unwrap(),
                Some(StoredPrAssociation::Unlinked)
            );
            let written: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(written["version"], VERSION);
        }
    }

    #[test]
    fn staleness_treats_negative_age_and_missing_clock_as_stale() {
        let record = record(1, "Clock");
        let fetched = record.fetched_at;
        assert!(!record.is_stale(Some(fetched + 10), 300));
        assert!(record.is_stale(Some(fetched + 300), 300));
        assert!(record.is_stale(Some(fetched - 1), 300));
        assert!(record.is_stale(None, 300));
        let unknown_fetch = StoredPrRecord::new("example", "demo-repo", None, record.pr);
        assert!(unknown_fetch.is_stale(Some(fetched), 300));
    }
}
