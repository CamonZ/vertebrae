//! `vtb::cmd::run`: run a local command and capture its result.
//!
//! The command runs as the daemon user, unsandboxed, in its own process
//! group, with the daemon's environment and the user's login-shell PATH (as
//! provider steps get), plus any `env` overrides. It defaults to the step's
//! working directory (the task worktree, else the project root); `cwd` is not
//! confined to it. There is no timeout
//! or output cap. The group is owned by the call: leftovers are killed when
//! the leader exits, and cancellation terminates the group (SIGTERM, then
//! SIGKILL) and reaps the leader before the call raises `cancelled`, so the
//! worker slot is never released while the command is still running.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use rhai::{Dynamic, Map, Module};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use vertebrae_harness_core::{ReapMode, reap_process_tree, signal_process_group};

use super::{map_argument, set_host_fn3, string_argument};
use crate::script_worker::{CancelSignal, HostContext, HostError, HostErrorKind};

const NAMESPACE: &str = "vtb::cmd";

/// How long a cancelled group gets after SIGTERM before SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

pub(super) fn module(host: &HostContext) -> Module {
    let mut module = Module::new();
    set_host_fn3(&mut module, host, NAMESPACE, "run", run);
    module
}

/// A validated command, ready to spawn.
struct Spec {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    stdin: Option<String>,
}

/// What the finished leader left behind.
struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run(
    host: &HostContext,
    program: Dynamic,
    args: Dynamic,
    opts: Dynamic,
) -> Result<Dynamic, HostError> {
    let spec = Spec::parse(host.working_dir(), host.search_path(), program, args, opts)?;
    let finished = host.block_on_owned(|cancel| supervise(spec, cancel))?;
    let mut result = Map::new();
    result.insert(
        "exit_code".into(),
        finished
            .status
            .code()
            .map_or(Dynamic::UNIT, |code| rhai::INT::from(code).into()),
    );
    result.insert("stdout".into(), lossy(finished.stdout));
    result.insert("stderr".into(), lossy(finished.stderr));
    Ok(result.into())
}

impl Spec {
    fn parse(
        working_dir: &Path,
        search_path: &str,
        program: Dynamic,
        args: Dynamic,
        opts: Dynamic,
    ) -> Result<Self, HostError> {
        let program = process_text(string_argument(program, "Program")?, "Program")?;
        if program.trim().is_empty() {
            return Err(HostError::invalid("Program must not be blank"));
        }
        let args = array_argument(args, "Command arguments")?
            .into_iter()
            .map(|arg| {
                process_text(
                    string_argument(arg, "Command argument")?,
                    "Command argument",
                )
            })
            .collect::<Result<_, _>>()?;
        let mut spec = Self {
            program: PathBuf::from(program),
            args,
            cwd: working_dir.to_path_buf(),
            env: BTreeMap::from([("PATH".to_owned(), search_path.to_owned())]),
            stdin: None,
        };
        for (key, value) in map_argument(opts, "Command options")? {
            match key.as_str() {
                "cwd" => {
                    let cwd = process_text(string_argument(value, "cwd")?, "cwd")?;
                    if cwd.trim().is_empty() {
                        return Err(HostError::invalid("cwd must not be blank"));
                    }
                    spec.cwd = working_dir.join(cwd);
                }
                "env" => spec.env.extend(env_argument(value)?),
                "stdin" if value.is_unit() => spec.stdin = None,
                "stdin" => spec.stdin = Some(string_argument(value, "stdin")?),
                other => {
                    return Err(HostError::invalid(format!(
                        "Unknown command option {other:?}; accepted keys are cwd, env and stdin"
                    )));
                }
            }
        }
        // A relative path with a separator names a file under the command's
        // working directory, not the daemon's.
        if spec.program.is_relative() && spec.program.components().count() > 1 {
            spec.program = spec.cwd.join(&spec.program);
        }
        Ok(spec)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .current_dir(&self.cwd)
            .envs(&self.env)
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        command
    }
}

/// Run the command to completion or cancellation. On cancel the group is
/// terminated and the leader reaped before `cancelled` is returned.
async fn supervise(spec: Spec, mut cancel: CancelSignal) -> Result<Finished, HostError> {
    // A cancel that lands after the engine's last progress check must not
    // still launch the command.
    if cancel.is_cancelled() {
        return Err(HostError::cancelled());
    }
    if !spec.cwd.is_dir() {
        return Err(HostError::new(
            HostErrorKind::NotFound,
            format!("Working directory {} does not exist", spec.cwd.display()),
        ));
    }
    let mut child = spec.command().spawn().map_err(|error| match error.kind() {
        ErrorKind::NotFound => HostError::new(
            HostErrorKind::NotFound,
            format!("Program {} not found", spec.program.display()),
        ),
        _ => transport(
            format!("Could not start {}", spec.program.display()),
            &error,
        ),
    })?;
    // Tokio forgets the pid once the leader is reaped; the group outlives it.
    let group = child.id();
    let stdin = feed(&mut child, spec.stdin);
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let aborts = [
        stdin.abort_handle(),
        stdout.abort_handle(),
        stderr.abort_handle(),
    ];
    let abort_streams = || aborts.iter().for_each(tokio::task::AbortHandle::abort);

    let status = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        status = child.wait() => Some(status),
    };
    let Some(status) = status else {
        terminate(&mut child).await;
        abort_streams();
        return Err(HostError::cancelled());
    };
    // The leader is gone; nothing else in its group outlives the call.
    signal_process_group(group, true);
    let status =
        status.map_err(|error| transport("Could not wait for the command".into(), &error))?;

    // Killing the group closes its pipes, but a descendant that left the
    // group can hold them open, so the drain still yields to cancellation.
    let (stdin, stdout, stderr) = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            abort_streams();
            return Err(HostError::cancelled());
        }
        streams = async { tokio::join!(stdin, stdout, stderr) } => streams,
    };
    joined(stdin)?;
    Ok(Finished {
        status,
        stdout: joined(stdout)?,
        stderr: joined(stderr)?,
    })
}

/// SIGTERM the group, SIGKILL it after the grace period, and do not return
/// until the leader is reaped.
async fn terminate(child: &mut Child) {
    let outcome = reap_process_tree(child, TERMINATE_GRACE, ReapMode::SignalFirst).await;
    if outcome.status.is_none() {
        let _ = child.wait().await;
    }
}

/// Write `input` and close stdin. A command that exits without reading its
/// input is not an error.
fn feed(child: &mut Child, input: Option<String>) -> JoinHandle<std::io::Result<Vec<u8>>> {
    let pipe = child.stdin.take();
    tokio::spawn(async move {
        if let (Some(mut pipe), Some(input)) = (pipe, input) {
            match pipe.write_all(input.as_bytes()).await {
                Err(error) if error.kind() != ErrorKind::BrokenPipe => return Err(error),
                _ => {}
            }
        }
        Ok(Vec::new())
    })
}

fn drain(
    pipe: Option<impl AsyncRead + Unpin + Send + 'static>,
) -> JoinHandle<std::io::Result<Vec<u8>>> {
    tokio::spawn(async move {
        let mut output = Vec::new();
        if let Some(mut pipe) = pipe {
            pipe.read_to_end(&mut output).await?;
        }
        Ok(output)
    })
}

fn joined(
    stream: Result<std::io::Result<Vec<u8>>, tokio::task::JoinError>,
) -> Result<Vec<u8>, HostError> {
    match stream {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(error)) => Err(transport("Command I/O failed".into(), &error)),
        Err(error) => Err(HostError::new(
            HostErrorKind::Transport,
            format!("Command I/O failed: {error}"),
        )),
    }
}

fn transport(context: String, error: &std::io::Error) -> HostError {
    HostError::new(HostErrorKind::Transport, format!("{context}: {error}"))
}

fn lossy(bytes: Vec<u8>) -> Dynamic {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
        .into()
}

/// Process arguments, paths and environment entries cannot carry NUL.
fn process_text(text: String, what: &str) -> Result<String, HostError> {
    if text.contains('\0') {
        return Err(HostError::invalid(format!("{what} must not contain NUL")));
    }
    Ok(text)
}

fn array_argument(value: Dynamic, what: &str) -> Result<rhai::Array, HostError> {
    let type_name = value.type_name();
    value
        .try_cast::<rhai::Array>()
        .ok_or_else(|| HostError::invalid(format!("{what} must be an array, got {type_name}")))
}

fn env_argument(value: Dynamic) -> Result<BTreeMap<String, String>, HostError> {
    map_argument(value, "env")?
        .into_iter()
        .map(|(name, value)| {
            let name = process_text(name.to_string(), "Environment name")?;
            if name.is_empty() || name.contains('=') {
                return Err(HostError::invalid(format!(
                    "Environment name {name:?} must be non-empty and contain no '='"
                )));
            }
            let what = format!("Environment value for {name}");
            let value = process_text(string_argument(value, &what)?, &what)?;
            Ok((name, value))
        })
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use std::future::Future;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tempfile::TempDir;
    use vertebrae_core::models::ExecuteConfig;

    use crate::actors::step_executor::StepResult;
    use crate::config::ScriptSlots;
    use crate::script_host::test_support::completed;
    use crate::script_worker::test_support::scope;
    use crate::script_worker::{CancelSignal, ScriptAttempt, ScriptWorker};

    fn admit(
        worker: &ScriptWorker,
        dir: &Path,
        script: &str,
        settled: impl FnOnce(StepResult) + Send + 'static,
    ) -> ScriptAttempt {
        let mut scope = scope();
        scope.working_dir = dir.to_path_buf();
        admit_in(worker, scope, script, settled)
    }

    fn admit_in(
        worker: &ScriptWorker,
        scope: crate::script_worker::ScriptScope,
        script: &str,
        settled: impl FnOnce(StepResult) + Send + 'static,
    ) -> ScriptAttempt {
        let config = ExecuteConfig {
            version: 1,
            script: script.into(),
            context: Some(json!({
                "task": {}, "execution": {}, "inputs": {},
                "steps": {}, "workflow": {}, "artifacts": {}
            })),
            output_schema: json!({}),
        };
        worker.admit(config, scope, settled).unwrap()
    }

    async fn run_in(dir: &Path, script: &str) -> Value {
        let result = bounded(admit(&ScriptWorker::default(), dir, script, |_| {}).settle()).await;
        completed(result, script)
    }

    /// The error a script caught from `call`, as `#{ kind, message, function }`.
    async fn caught(dir: &Path, call: &str) -> Value {
        let script = format!(
            "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
        );
        run_in(dir, &script).await
    }

    fn failure(result: StepResult) -> String {
        match result {
            StepResult::Failed { error, .. } => error,
            other => panic!("expected failure, got {other:?}"),
        }
    }

    /// Gone or a zombie awaiting its new parent's reap.
    fn alive(pid: &str) -> bool {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid.trim()])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&output.stdout);
        output.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
    }

    /// Fail rather than hang the suite when cancellation regresses.
    async fn bounded<F: Future>(work: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(10), work)
            .await
            .expect("the attempt settles")
    }

    /// SIGKILLs the recorded processes and their groups when a test ends, so
    /// a failed assertion does not leave its commands running.
    #[derive(Default)]
    struct Survivors(Vec<u32>);

    impl Survivors {
        fn own(&mut self, pid: &str) -> String {
            let pid = pid.trim();
            self.0.push(pid.parse().expect("a pid"));
            pid.to_owned()
        }
    }

    impl Drop for Survivors {
        fn drop(&mut self) {
            for &pid in &self.0 {
                super::signal_process_group(Some(pid), true);
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }

    async fn assert_gone(pid: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive(pid) {
            assert!(Instant::now() < deadline, "process {pid} survived");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn read_when_written(path: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && text.ends_with('\n')
            {
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "{} never written",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn captures_output_and_returns_a_nonzero_exit_as_data() {
        let dir = TempDir::new().unwrap();
        let result = run_in(
            dir.path(),
            r#"vtb::cmd::run("sh", ["-c", "printf out; printf err >&2; exit 3"], #{})"#,
        )
        .await;
        assert_eq!(
            result,
            json!({"exit_code": 3, "stdout": "out", "stderr": "err"})
        );
    }

    #[tokio::test]
    async fn runs_in_the_working_directory_and_applies_cwd_env_and_stdin() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let pwd = |opts: &str| format!(r#"vtb::cmd::run("pwd", ["-P"], {opts}).stdout"#);
        let script = format!(
            r#"[{}, {}, {},
                vtb::cmd::run("sh", ["-c", "printf %s \"$GREETING\""], #{{ env: #{{ GREETING: "hi" }} }}).stdout,
                vtb::cmd::run("cat", [], #{{ stdin: "fed\n✓" }}).stdout,
                vtb::cmd::run("cat", [], #{{ stdin: () }}).stdout]"#,
            pwd("#{}"),
            pwd(r#"#{ cwd: "sub" }"#),
            pwd(&format!(r#"#{{ cwd: "{}" }}"#, root.join("sub").display())),
        );
        assert_eq!(
            run_in(dir.path(), &script).await,
            json!([
                format!("{}\n", root.display()),
                format!("{}\n", root.join("sub").display()),
                format!("{}\n", root.join("sub").display()),
                "hi",
                "fed\n✓",
                ""
            ])
        );
    }

    #[tokio::test]
    async fn commands_resolve_on_the_login_shell_path_unless_env_overrides_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let tool = bin.join("vtb-test-tool");
        std::fs::write(&tool, "#!/bin/sh\nprintf %s \"$PATH\"\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut scope = scope();
        scope.working_dir = dir.path().to_path_buf();
        scope.search_path = format!("{}:/usr/bin:/bin", bin.display());
        let script = r#"[vtb::cmd::run("vtb-test-tool", [], #{}).stdout,
            vtb::cmd::run("/bin/sh", ["-c", "printf %s \"$PATH\""], #{ env: #{ PATH: "/custom" } }).stdout]"#;
        let result = admit_in(&ScriptWorker::default(), scope, script, |_| {})
            .settle()
            .await;
        assert_eq!(
            completed(result, script),
            json!([format!("{}:/usr/bin:/bin", bin.display()), "/custom"])
        );
    }

    #[tokio::test]
    async fn signal_termination_has_no_exit_code_and_output_is_decoded_lossily() {
        let dir = TempDir::new().unwrap();
        let result = run_in(
            dir.path(),
            r#"[vtb::cmd::run("sh", ["-c", "kill -9 $$"], #{}).exit_code,
                vtb::cmd::run("printf", ["a\\377b"], #{}).stdout]"#,
        )
        .await;
        assert_eq!(result, json!([null, "a\u{fffd}b"]));
    }

    #[tokio::test]
    async fn a_missing_program_or_directory_is_not_found_not_an_exit() {
        let dir = TempDir::new().unwrap();
        for call in [
            r#"vtb::cmd::run("vtb-no-such-program", [], #{})"#,
            r#"vtb::cmd::run("./missing.sh", [], #{})"#,
            r#"vtb::cmd::run("true", [], #{ cwd: "missing" })"#,
        ] {
            let error = caught(dir.path(), call).await;
            assert_eq!(error["kind"], "not_found", "{call}: {error}");
            assert_eq!(error["function"], "vtb::cmd::run", "{call}");
        }
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_before_spawning() {
        let dir = TempDir::new().unwrap();
        for call in [
            r#"vtb::cmd::run("", [], #{})"#,
            r#"vtb::cmd::run("  ", [], #{})"#,
            r#"vtb::cmd::run(1, [], #{})"#,
            r#"vtb::cmd::run("true", "-v", #{})"#,
            r#"vtb::cmd::run("true", [1], #{})"#,
            r#"vtb::cmd::run("true", ["a\x00b"], #{})"#,
            r#"vtb::cmd::run("true", [], ())"#,
            r#"vtb::cmd::run("true", [], #{ timeout: 5 })"#,
            r#"vtb::cmd::run("true", [], #{ cwd: "" })"#,
            r#"vtb::cmd::run("true", [], #{ cwd: 1 })"#,
            r#"vtb::cmd::run("true", [], #{ env: [] })"#,
            r#"vtb::cmd::run("true", [], #{ env: #{ A: 1 } })"#,
            r#"vtb::cmd::run("true", [], #{ env: #{ "A=B": "x" } })"#,
            r#"vtb::cmd::run("true", [], #{ env: #{ "": "x" } })"#,
            r#"vtb::cmd::run("true", [], #{ stdin: 1 })"#,
        ] {
            let error = caught(dir.path(), call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
        }
    }

    #[tokio::test]
    async fn leftover_group_members_are_killed_when_the_leader_exits() {
        let dir = TempDir::new().unwrap();
        // The background sleep inherits stdout, so the call also proves the
        // drain does not wait on it.
        let result = run_in(
            dir.path(),
            r#"vtb::cmd::run("sh", ["-c", "sleep 60 & echo $!"], #{})"#,
        )
        .await;
        let mut survivors = Survivors::default();
        let sleeper = survivors.own(result["stdout"].as_str().unwrap());
        assert_eq!(result["exit_code"], 0);
        assert_gone(&sleeper).await;
    }

    #[tokio::test]
    async fn cancelling_kills_and_reaps_the_group_then_settles_once() {
        let dir = TempDir::new().unwrap();
        let worker = ScriptWorker::new(ScriptSlots {
            active: 1,
            pending: 4,
        });
        let (terminal_tx, mut terminal_rx) = tokio::sync::mpsc::unbounded_channel();
        let attempt = admit(
            &worker,
            dir.path(),
            r#"let kind = ();
               try {
                   vtb::cmd::run("sh", ["-c", "sleep 60 & echo $! > child; echo $$ > leader; wait"], #{});
               } catch (error) { kind = error.kind; }
               kind"#,
            move |result| {
                let _ = terminal_tx.send(result);
            },
        );
        let mut survivors = Survivors::default();
        let leader = survivors.own(&read_when_written(&dir.path().join("leader")).await);
        let child = survivors.own(&read_when_written(&dir.path().join("child")).await);
        let (queued_tx, mut queued_rx) = tokio::sync::mpsc::unbounded_channel();
        let queued = admit(&worker, dir.path(), "5", move |result| {
            let _ = queued_tx.send(result);
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            queued_rx.try_recv().is_err(),
            "a running command holds the only active slot"
        );

        attempt.cancel();
        // Catching the cancellation cannot turn it into a success.
        assert_eq!(failure(bounded(attempt.settle()).await), "Cancelled");
        assert!(!alive(&leader), "the leader is reaped before settling");
        assert_gone(&child).await;
        assert_eq!(
            failure(bounded(terminal_rx.recv()).await.unwrap()),
            "Cancelled"
        );
        assert!(terminal_rx.try_recv().is_err(), "one terminal result");
        assert_eq!(completed(bounded(queued.settle()).await, "5"), json!(5));
        assert!(bounded(queued_rx.recv()).await.is_some());
    }

    #[tokio::test]
    async fn a_command_ignoring_sigterm_is_killed_after_the_grace_period() {
        let dir = TempDir::new().unwrap();
        let attempt = admit(
            &ScriptWorker::default(),
            dir.path(),
            r#"vtb::cmd::run("sh", ["-c", "trap '' TERM; echo $$ > leader; while :; do sleep 1; done"], #{})"#,
            |_| {},
        );
        let mut survivors = Survivors::default();
        let leader = survivors.own(&read_when_written(&dir.path().join("leader")).await);
        let cancelled_at = Instant::now();
        attempt.cancel();
        assert_eq!(failure(bounded(attempt.settle()).await), "Cancelled");
        assert!(cancelled_at.elapsed() >= super::TERMINATE_GRACE);
        assert!(
            !alive(&leader),
            "SIGKILL reaps a leader that ignores SIGTERM"
        );
    }

    #[tokio::test]
    async fn another_active_slot_lets_a_second_script_run_beside_a_command() {
        let dir = TempDir::new().unwrap();
        let worker = ScriptWorker::new(ScriptSlots {
            active: 2,
            pending: 4,
        });
        let long = admit(
            &worker,
            dir.path(),
            r#"vtb::cmd::run("sh", ["-c", "echo $$ > leader; exec sleep 60"], #{})"#,
            |_| {},
        );
        let mut survivors = Survivors::default();
        survivors.own(&read_when_written(&dir.path().join("leader")).await);
        let quick = admit(&worker, dir.path(), "7", |_| {});
        let quick = tokio::time::timeout(Duration::from_secs(5), quick.settle())
            .await
            .expect("the second slot runs while the command does");
        assert_eq!(completed(quick, "7"), json!(7));
        long.cancel();
        assert_eq!(failure(bounded(long.settle()).await), "Cancelled");
    }

    #[tokio::test]
    async fn an_already_cancelled_call_does_not_start_the_command() {
        // Spawning a missing program fails as `not_found`, so `cancelled`
        // proves the call never reached the spawn.
        let spec = super::Spec {
            program: "/nonexistent/vtb-cmd-never-started".into(),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
            env: std::collections::BTreeMap::new(),
            stdin: None,
        };
        let (_cancel, cancelled) = tokio::sync::watch::channel(true);
        let error = super::supervise(spec, CancelSignal::new(cancelled))
            .await
            .err()
            .expect("an already-cancelled call fails");
        assert_eq!(error.kind, super::HostErrorKind::Cancelled);
    }
}
