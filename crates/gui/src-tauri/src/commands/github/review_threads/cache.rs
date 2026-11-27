//! A bounded, short-lived cache of review-thread reads, held in Tauri
//! managed state. Concurrent reads of one PR share a single GitHub request.

use super::GithubPrReviewThreads;
use crate::commands::github::GithubFailure;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;
use vertebrae_github::RepoRef;

/// Below the PR poller's 30 s active cadence so each poll reaches GitHub.
pub(super) const TTL: Duration = Duration::from_secs(20);
/// PRs remembered at once; the oldest read goes first.
pub(super) const CAPACITY: usize = 64;

pub(super) trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// One PR: its host, `owner/name` and number.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct ThreadsKey {
    host: String,
    repo: String,
    number: u64,
}

impl ThreadsKey {
    pub(super) fn new(repo: &RepoRef, number: u64) -> Self {
        Self {
            host: repo.host.clone(),
            repo: repo.full_name(),
            number,
        }
    }
}

/// Reads oldest first. Re-reading a PR moves it to the back, so the order
/// is also by age and expired reads are always at the front.
#[derive(Debug, Default)]
pub(super) struct Entries {
    reads: HashMap<ThreadsKey, (Instant, GithubPrReviewThreads)>,
    order: VecDeque<ThreadsKey>,
}

impl Entries {
    fn expire(&mut self, now: Instant) {
        while let Some(oldest) = self.order.front() {
            if now.duration_since(self.reads[oldest].0) < TTL {
                break;
            }
            self.reads.remove(oldest);
            self.order.pop_front();
        }
    }

    /// A read younger than [`TTL`] at `now`.
    pub(super) fn get(&mut self, key: &ThreadsKey, now: Instant) -> Option<GithubPrReviewThreads> {
        self.expire(now);
        self.reads.get(key).map(|(_, read)| read.clone())
    }

    /// Remember `read` as of `now`, evicting the oldest past [`CAPACITY`].
    pub(super) fn insert(&mut self, key: ThreadsKey, read: GithubPrReviewThreads, now: Instant) {
        self.expire(now);
        if self.reads.insert(key.clone(), (now, read)).is_some() {
            self.order.retain(|other| *other != key);
        }
        self.order.push_back(key);
        while self.order.len() > CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.reads.remove(&oldest);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn keys(&self) -> Vec<ThreadsKey> {
        assert_eq!(self.reads.len(), self.order.len());
        self.order.iter().cloned().collect()
    }
}

type Shared = Arc<OnceCell<Result<GithubPrReviewThreads, GithubFailure>>>;

pub struct ReviewThreadsCache {
    clock: Arc<dyn Clock>,
    entries: Mutex<Entries>,
    in_flight: Mutex<HashMap<ThreadsKey, Shared>>,
}

impl Default for ReviewThreadsCache {
    fn default() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ReviewThreadsCache {
    pub(super) fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: Mutex::default(),
            in_flight: Mutex::default(),
        }
    }

    /// The cached read of `key` unless `refresh`; otherwise `fetch`, shared
    /// with every read of `key` already waiting on GitHub. Failures are
    /// shared but not cached.
    pub(super) async fn read<F, Fut>(
        &self,
        key: ThreadsKey,
        refresh: bool,
        fetch: F,
    ) -> Result<GithubPrReviewThreads, GithubFailure>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<GithubPrReviewThreads, GithubFailure>>,
    {
        if !refresh {
            if let Some(read) = lock(&self.entries).get(&key, self.clock.now()) {
                return Ok(read);
            }
        }
        let shared = lock(&self.in_flight)
            .entry(key.clone())
            .or_default()
            .clone();
        let result = shared
            .get_or_init(|| async {
                let result = fetch().await;
                if let Ok(read) = &result {
                    lock(&self.entries).insert(key.clone(), read.clone(), self.clock.now());
                }
                result
            })
            .await
            .clone();
        let mut in_flight = lock(&self.in_flight);
        if in_flight
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &shared))
        {
            in_flight.remove(&key);
        }
        result
    }
}
