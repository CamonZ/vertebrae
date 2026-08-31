//! Provider-neutral OS process-tree teardown.
//!
//! Adapters launch provider children in their own process group on Unix. This
//! module is the single SIGTERM / wait / SIGKILL / wait implementation those
//! adapters share.

use std::{process::ExitStatus, time::Duration};

use tokio::process::Child;

/// How to start tearing down a provider child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReapMode {
    /// Wait for a natural exit, then SIGKILL leftovers. If the wait times out,
    /// SIGTERM, wait, then SIGKILL.
    WaitThenSignal,
    /// SIGTERM immediately (or SIGKILL leftovers if the leader already exited).
    SignalFirst,
}

/// Result of bounding a child wait and signaling its process group.
#[derive(Debug)]
pub struct ReapOutcome {
    pub status: Option<ExitStatus>,
    /// True when the helper had to signal instead of observing a natural exit
    /// within `timeout`.
    pub forced: bool,
}

/// Signal a Unix process group. `pid` is the leader; a negative kill targets
/// the group created with `process_group(0)`. No-op when `pid` is missing.
pub fn signal_process_group(pid: Option<u32>, force: bool) {
    signal_process_group_inner(pid, force);
}

/// Reap `child` and every descendant in its process group.
pub async fn reap_process_tree(
    child: &mut Child,
    timeout: Duration,
    mode: ReapMode,
) -> ReapOutcome {
    let pid = child.id();
    match mode {
        ReapMode::WaitThenSignal => {
            if let Ok(Ok(status)) = tokio::time::timeout(timeout, child.wait()).await {
                signal_process_group(pid, true);
                return ReapOutcome {
                    status: Some(status),
                    forced: false,
                };
            }
        }
        ReapMode::SignalFirst => {
            if let Ok(Some(status)) = child.try_wait() {
                signal_process_group(pid, true);
                return ReapOutcome {
                    status: Some(status),
                    forced: false,
                };
            }
        }
    }

    signal_process_group(pid, false);
    kill_leader_if_needed(child);
    let status = tokio::time::timeout(timeout, child.wait())
        .await
        .ok()
        .and_then(Result::ok);
    signal_process_group(pid, true);
    let status = if status.is_none() {
        kill_leader_if_needed(child);
        tokio::time::timeout(timeout, child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        status
    };
    ReapOutcome {
        status,
        forced: true,
    }
}

/// Drop the `Child` handle after reaping so callers cannot wait on it twice.
pub async fn reap_optional_process(
    process: &mut Option<Child>,
    timeout: Duration,
    mode: ReapMode,
) -> ReapOutcome {
    let Some(child) = process.as_mut() else {
        return ReapOutcome {
            status: None,
            forced: false,
        };
    };
    let outcome = reap_process_tree(child, timeout, mode).await;
    *process = None;
    outcome
}

#[cfg(not(unix))]
fn kill_leader_if_needed(child: &mut Child) {
    let _ = child.start_kill();
}

#[cfg(unix)]
fn kill_leader_if_needed(_child: &mut Child) {}

#[cfg(unix)]
fn signal_process_group_inner(pid: Option<u32>, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            log::warn!("failed to signal process group pid={pid} force={force}: {error}");
        }
    }
}

#[cfg(not(unix))]
fn signal_process_group_inner(_pid: Option<u32>, _force: bool) {}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::process::Command;

    use super::*;

    #[tokio::test]
    async fn reap_terminates_descendants_after_leader_exits() {
        let temp = TempDir::new().expect("temporary directory should be available");
        let marker = temp.path().join("descendant-survived");
        let script = format!(
            "trap '' TERM; (sleep 1; touch '{}') & exit 0",
            marker.display()
        );
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn().expect("fixture process should start");

        let outcome = reap_process_tree(
            &mut child,
            Duration::from_millis(250),
            ReapMode::WaitThenSignal,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(
            outcome.status.is_some(),
            "the provider child must be reaped"
        );
        assert!(
            !marker.exists(),
            "a helper process must not outlive its provider tree"
        );
    }
}
