use std::process::Stdio;
use std::time::Duration;

use cucumber::{then, when};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use vertebrae_sacrum_client::TaskResponse;

use crate::DaemonWorld;

const IN_PROGRESS_TIMEOUT: Duration = Duration::from_secs(15);
const WORKTREE_UPDATE_TIMEOUT: Duration = Duration::from_secs(10);

#[when(
    expr = "a separate process sets the task worktree to {string} while the daemon is working on the step"
)]
pub async fn set_worktree_while_step_is_running(world: &mut DaemonWorld, path: String) {
    let execution_id = world.execution_id.as_ref().expect("execution_id").clone();
    world
        .poll_execution(&execution_id, &["in_progress"], IN_PROGRESS_TIMEOUT)
        .await
        .expect("execution never reached in_progress before worktree update");

    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let mut child = Command::new(&world.vtb_binary)
        .args(["update", &task_id, "--worktree", &path])
        .envs(&world.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn vtb worktree update");

    let mut stdout = child.stdout.take().expect("vtb stdout was not piped");
    let mut stderr = child.stderr.take().expect("vtb stderr was not piped");
    let stdout_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await.map(|_| output)
    });
    let stderr_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).await.map(|_| output)
    });

    let status = match tokio::time::timeout(WORKTREE_UPDATE_TIMEOUT, child.wait()).await {
        Ok(result) => result.expect("vtb worktree update process failed to wait"),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            panic!(
                "vtb worktree update did not finish within {WORKTREE_UPDATE_TIMEOUT:?} while the daemon was working"
            );
        }
    };
    let stdout = stdout_task
        .await
        .expect("vtb stdout reader panicked")
        .expect("failed to read vtb stdout");
    let stderr = stderr_task
        .await
        .expect("vtb stderr reader panicked")
        .expect("failed to read vtb stderr");
    assert!(
        status.success(),
        "vtb worktree update exited unsuccessfully: {status}; stdout={}; stderr={}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
}

#[then(expr = "the task worktree should be {string}")]
pub async fn task_worktree_should_be(world: &mut DaemonWorld, expected: String) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::tasks::GET_TASK,
        &[vertebrae_sacrum_client::queries::tasks::TASK_FIELDS],
    );
    let task: TaskResponse = client
        .execute(&query, serde_json::json!({ "id": task_id }), "task")
        .await
        .expect("task query failed");

    assert_eq!(
        task.worktree.as_deref(),
        Some(expected.as_str()),
        "task worktree did not persist while the daemon was working"
    );
}
