//! Rhai command steps: execute scripts run local commands (`vtb::cmd`) in the
//! task worktree through the daemon, which runs in this container, so the
//! scenario can observe the command's processes directly.
//!
//! Command scripts use shell `$` freely, so only `$WORKTREE` (the quoted
//! scratch worktree path) is substituted.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cucumber::gherkin::Step;
use cucumber::{given, then, when};

use super::host_reads::{add_task, docstring, install_rhai_step, vtb_ok};
use crate::DaemonWorld;

const PID_FILE_TIMEOUT: Duration = Duration::from_secs(30);
const SURVIVOR_TIMEOUT: Duration = Duration::from_secs(5);

fn worktree(world: &DaemonWorld) -> PathBuf {
    PathBuf::from(
        world
            .fixture_ids
            .get("WORKTREE")
            .expect("no scratch worktree created"),
    )
}

#[given("a task whose worktree is a scratch directory")]
async fn task_with_worktree(world: &mut DaemonWorld) {
    let project = world.project_id.clone().expect("scenario project");
    let dir = world
        .capture_dir
        .join(format!("worktree-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("scratch worktree");
    let dir = dir.display().to_string();
    let task_id = add_task(world, &project, "SELF", &["host-command-self"]).await;
    vtb_ok(
        world,
        "update --worktree",
        &["update", &task_id, "--worktree", &dir],
    )
    .await;
    world.fixture_ids.insert("WORKTREE".into(), dir);
}

#[given("a Rhai command step running:")]
async fn command_step(world: &mut DaemonWorld, step: &Step) {
    let quoted = format!("\"{}\"", worktree(world).display());
    let script = docstring(step).replace("$WORKTREE", &quoted);
    install_rhai_step(world, &script).await;
}

#[when(expr = "the command has written {string} and {string} in the worktree")]
async fn pid_files_written(world: &mut DaemonWorld, first: String, second: String) {
    let dir = worktree(world);
    for name in [first, second] {
        let pid = read_pid(&dir.join(&name)).await;
        world.fixture_ids.insert(name, pid);
    }
}

#[then(expr = "neither {string} nor {string} is still running")]
async fn no_survivors(world: &mut DaemonWorld, first: String, second: String) {
    for name in [first, second] {
        let pid = world
            .fixture_ids
            .get(&name)
            .unwrap_or_else(|| panic!("{name} was never read"))
            .clone();
        let deadline = Instant::now() + SURVIVOR_TIMEOUT;
        while running(&pid) {
            assert!(
                Instant::now() < deadline,
                "command process {name} (pid {pid}) survived cancellation"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn read_pid(path: &Path) -> String {
    let deadline = Instant::now() + PID_FILE_TIMEOUT;
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && text.ends_with('\n')
        {
            return text.trim().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the command never wrote {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Present and not a zombie awaiting its new parent's reap.
fn running(pid: &str) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let state = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().next());
    !matches!(state, Some("Z" | "X"))
}
