//! The review-thread cache: bounded, expiring, and sharing concurrent reads.

use super::super::cache::{Clock, Entries, ThreadsKey, CAPACITY, TTL};
use super::*;
use hegel::generators as gs;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use vertebrae_github::RepoRef;

fn read(version: u32) -> GithubPrReviewThreads {
    GithubPrReviewThreads {
        repo: "example/demo-repo".into(),
        pr_number: version,
        pull_request_id: format!("PR_{version}"),
        viewer_login: None,
        head_oid: String::new(),
        base_oid: String::new(),
        threads: Vec::new(),
        truncated: false,
    }
}

fn key(host: u8, number: u64) -> ThreadsKey {
    let host = if host == 0 {
        "github.com"
    } else {
        "github.example.test"
    };
    ThreadsKey::new(&RepoRef::new(host, "example", "demo-repo"), number)
}

/// Oldest first: each key with when it was read and what was read.
#[derive(Default)]
struct Model(Vec<(ThreadsKey, Instant, u32)>);

impl Model {
    fn expire(&mut self, now: Instant) {
        self.0.retain(|(_, at, _)| now.duration_since(*at) < TTL);
    }

    fn get(&mut self, key: &ThreadsKey, now: Instant) -> Option<u32> {
        self.expire(now);
        self.0
            .iter()
            .find(|(other, _, _)| other == key)
            .map(|(_, _, version)| *version)
    }

    fn insert(&mut self, key: ThreadsKey, version: u32, now: Instant) {
        self.expire(now);
        self.0.retain(|(other, _, _)| *other != key);
        self.0.push((key, now, version));
        while self.0.len() > CAPACITY {
            self.0.remove(0);
        }
    }
}

/// Under a controlled clock, reads answer exactly as an age-ordered,
/// capped model: younger than the TTL, the oldest evicted first, a re-read
/// moving its PR to the back, an invalidated PR forgotten; the host is
/// part of the key.
#[hegel::test(test_cases = 100)]
fn cache_matches_an_expiring_capped_model(tc: hegel::TestCase) {
    let start = Instant::now();
    let mut now = start;
    let mut entries = Entries::default();
    let mut model = Model::default();
    let steps = tc.draw(gs::integers::<usize>().max_value(200));
    for version in 0..steps as u32 {
        let key = key(
            tc.draw(gs::integers::<u8>().max_value(1)),
            tc.draw(gs::integers::<u64>().max_value(CAPACITY as u64 + 8)),
        );
        match tc.draw(gs::integers::<u8>().max_value(4)) {
            0 => now += Duration::from_secs(tc.draw(gs::integers::<u64>().max_value(25))),
            4 => {
                entries.remove(&key);
                model.0.retain(|(other, _, _)| *other != key);
            }
            1 => assert_eq!(
                entries.get(&key, now).map(|read| read.pr_number),
                model.get(&key, now)
            ),
            _ => {
                entries.insert(key.clone(), read(version), now);
                model.insert(key, version, now);
            }
        }
        let keys: Vec<_> = model.0.iter().map(|(key, _, _)| key.clone()).collect();
        assert_eq!(entries.keys(), keys);
    }
}

struct ManualClock(Mutex<Instant>);

impl ManualClock {
    fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        *self.0.lock().unwrap()
    }
}

#[tokio::test]
async fn reads_expire_by_the_injected_clock_and_refresh_bypasses_them() {
    let clock = Arc::new(ManualClock(Mutex::new(Instant::now())));
    let cache = ReviewThreadsCache::with_clock(clock.clone());
    let calls = AtomicUsize::new(0);
    let fetch = || async {
        let call = calls.fetch_add(1, Ordering::SeqCst) as u32;
        Ok(read(call))
    };
    let version = |result: Result<GithubPrReviewThreads, GithubFailure>| result.unwrap().pr_number;

    assert_eq!(version(cache.read(key(0, 7), false, fetch).await), 0);
    clock.advance(TTL - Duration::from_millis(1));
    assert_eq!(version(cache.read(key(0, 7), false, fetch).await), 0);
    assert_eq!(version(cache.read(key(0, 7), true, fetch).await), 1);
    clock.advance(TTL);
    assert_eq!(version(cache.read(key(0, 7), false, fetch).await), 2);

    // A failure reaches the caller but is not remembered.
    let failed = cache
        .read(key(0, 8), false, || async {
            Err(GithubFailure::other("GitHub unavailable"))
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(version(cache.read(key(0, 8), false, fetch).await), 3);
}

#[tokio::test]
async fn concurrent_reads_of_one_pr_share_one_request() {
    let cache = ReviewThreadsCache::default();
    let calls = AtomicUsize::new(0);
    let release = tokio::sync::Notify::new();
    let fetch = || async {
        calls.fetch_add(1, Ordering::SeqCst);
        release.notified().await;
        Ok(read(1))
    };
    let (first, second, other, _) = tokio::join!(
        cache.read(key(0, 7), false, fetch),
        cache.read(key(0, 7), true, fetch),
        cache.read(key(1, 7), false, || async { Ok(read(2)) }),
        async {
            tokio::task::yield_now().await;
            release.notify_one();
        },
    );
    assert_eq!(first.unwrap(), read(1));
    assert_eq!(second.unwrap(), read(1));
    assert_eq!(other.unwrap(), read(2));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// A write between a read's request and its answer: the read still answers
/// its caller, but the next read asks GitHub instead of showing it.
#[tokio::test]
async fn a_read_out_during_a_write_is_not_remembered() {
    let cache = ReviewThreadsCache::default();
    let release = tokio::sync::Notify::new();
    let (before, _) = tokio::join!(
        cache.read(key(0, 7), false, || async {
            release.notified().await;
            Ok(read(1))
        }),
        async {
            tokio::task::yield_now().await;
            cache.invalidate(&key(0, 7));
            release.notify_one();
        },
    );
    assert_eq!(before.unwrap(), read(1));
    let after = cache.read(key(0, 7), false, || async { Ok(read(2)) }).await;
    assert_eq!(after.unwrap(), read(2));
}
