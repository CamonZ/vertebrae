//! Deterministic Codex App Server used by the daemon acceptance suite.
//!
//! Implements `codex app-server daemon version|start` and the daemon's Unix
//! control socket. Scenario-specific notifications are read from the fixture
//! envelope passed as the first turn's text input; its `next_file` scripts
//! later runs of the same step (see `daemon_acceptance::scripted_turn`).
//!
//! Each `thread/start` creates a distinct thread. `thread/resume` and
//! `thread/fork` accept only threads this server created and still holds;
//! like Codex without a rollout, any other id gets `-32600 no rollout found
//! for thread id <id>`. An envelope with `discard_session` drops its thread
//! once the turn ends.

use std::{
    collections::HashSet,
    hash::{DefaultHasher, Hash, Hasher},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{UnixListener, UnixStream},
    time::{Duration, sleep},
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

const IDLE_EXIT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Deserialize)]
struct Envelope {
    exit_code: i32,
    delay_ms: u64,
    stdout_file: Option<String>,
    stderr_file: Option<String>,
    #[serde(default)]
    discard_session: bool,
}

/// Threads this server has created and not discarded, shared by every
/// connection like a Codex home's rollouts.
#[derive(Default)]
struct Threads {
    next: AtomicU64,
    live: Mutex<HashSet<String>>,
}

impl Threads {
    fn create(&self) -> String {
        let id = format!(
            "mock-codex-thread-{}",
            self.next.fetch_add(1, Ordering::SeqCst) + 1
        );
        self.live.lock().unwrap().insert(id.clone());
        id
    }

    fn contains(&self, id: &str) -> bool {
        self.live.lock().unwrap().contains(id)
    }

    fn discard(&self, id: &str) {
        self.live.lock().unwrap().remove(id);
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    capture_invocation(&args);

    if is_model_discovery(&args) {
        print_model_catalog();
        return;
    }

    let daemon_command = args
        .windows(3)
        .find(|window| window[0] == "app-server" && window[1] == "daemon")
        .map(|window| window[2].as_str());
    match daemon_command {
        Some("version") => print_status(if is_serving(&socket_path()).await {
            "running"
        } else {
            "notRunning"
        }),
        Some("start") => start_daemon().await,
        Some("serve") => serve(socket_path()).await,
        other => panic!("mock-codex does not support {other:?} (argv {args:?})"),
    }
}

fn is_model_discovery(args: &[String]) -> bool {
    args.windows(3)
        .any(|window| window[0] == "debug" && window[1] == "models" && window[2] == "--bundled")
}

fn print_model_catalog() {
    println!(
        "{}",
        json!({
            "models": [{
                "slug": "gpt-5.5",
                "display_name": "GPT-5.5",
                "visibility": "list",
                "priority": 0,
                "supported_reasoning_levels": [{"effort": "medium"}]
            }]
        })
    );
}

fn socket_path() -> PathBuf {
    let mut hasher = DefaultHasher::new();
    for key in ["CODEX_HOME", "HOME", "MOCK_OUTPUT_DIR", "MOCK_CAPTURE_DIR"] {
        std::env::var_os(key).hash(&mut hasher);
    }
    std::env::temp_dir().join(format!("mock-codex-{:016x}.sock", hasher.finish()))
}

fn print_status(status: &str) {
    let socket = socket_path();
    println!(
        "{}",
        json!({"status": status, "backend": "mock", "socketPath": socket})
    );
}

async fn is_serving(socket: &Path) -> bool {
    UnixStream::connect(socket).await.is_ok()
}

async fn start_daemon() {
    let socket = socket_path();
    if is_serving(&socket).await {
        print_status("alreadyRunning");
        return;
    }
    let executable = std::env::current_exe().expect("mock-codex executable path");
    let mut command = std::process::Command::new(executable);
    command
        .args(["app-server", "daemon", "serve"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    // The daemon is detached on purpose: this `start` invocation exits and
    // the daemon is reparented, like Codex's own managed daemon.
    #[allow(clippy::zombie_processes)]
    let _daemon = command.spawn().expect("spawn mock-codex daemon");
    for _ in 0..100 {
        if is_serving(&socket).await {
            print_status("started");
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("mock-codex daemon did not start on {}", socket.display());
}

async fn serve(socket: PathBuf) {
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)
        .unwrap_or_else(|error| panic!("mock-codex failed to bind {}: {error}", socket.display()));
    let active = Arc::new(AtomicUsize::new(0));
    let last_activity = Arc::new(AtomicU64::new(now_secs()));
    let threads = Arc::new(Threads::default());
    {
        let active = Arc::clone(&active);
        let last_activity = Arc::clone(&last_activity);
        let socket = socket.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(5)).await;
                let idle = now_secs().saturating_sub(last_activity.load(Ordering::SeqCst));
                if active.load(Ordering::SeqCst) == 0 && idle >= IDLE_EXIT.as_secs() {
                    let _ = std::fs::remove_file(&socket);
                    std::process::exit(0);
                }
            }
        });
    }
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .expect("mock-codex failed to accept connection");
        active.fetch_add(1, Ordering::SeqCst);
        let active = Arc::clone(&active);
        let last_activity = Arc::clone(&last_activity);
        let threads = Arc::clone(&threads);
        tokio::spawn(async move {
            // Status probes connect and close without a WebSocket handshake.
            if let Err(error) = serve_websocket(stream, &threads).await
                && !error.contains("handshake")
            {
                eprintln!("mock-codex WebSocket failed: {error}");
            }
            last_activity.store(now_secs(), Ordering::SeqCst);
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn capture_invocation(args: &[String]) {
    let Some(dir) = std::env::var_os("MOCK_CAPTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("create MOCK_CAPTURE_DIR");
    let argv_json = serde_json::to_string(args).expect("argv serialises");
    std::fs::write(dir.join("argv.json"), argv_json).expect("write argv.json");
    let cwd = std::env::current_dir().expect("current_dir");
    std::fs::write(dir.join("cwd.txt"), cwd.to_string_lossy().as_bytes()).expect("write cwd.txt");
}

async fn serve_websocket<S>(stream: S, threads: &Threads) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut socket = accept_async(stream)
        .await
        .map_err(|error| format!("WebSocket handshake failed: {error}"))?;
    let mut turn_number = 0_u64;

    while let Some(frame) = socket.next().await {
        let frame = frame.map_err(|error| format!("WebSocket read failed: {error}"))?;
        let Message::Text(text) = frame else {
            continue;
        };
        let request: Value = serde_json::from_str(&text)
            .map_err(|error| format!("invalid JSON-RPC request {text:?}: {error}"))?;
        capture_request(&request);

        let Some(method) = request.get("method").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };

        match method {
            "initialize" => {
                send_response(&mut socket, id, json!({"capabilities": {}})).await?;
            }
            "thread/start" => {
                let thread = threads.create();
                send_response(
                    &mut socket,
                    id,
                    json!({"thread":{"id":thread},"model":"gpt-5.5"}),
                )
                .await?;
            }
            "thread/resume" | "thread/fork" => {
                let source = request
                    .pointer("/params/threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !threads.contains(source) {
                    send_error(
                        &mut socket,
                        id,
                        -32600,
                        &format!("no rollout found for thread id {source}"),
                    )
                    .await?;
                    continue;
                }
                let thread = if method == "thread/fork" {
                    threads.create()
                } else {
                    source.to_string()
                };
                send_response(
                    &mut socket,
                    id,
                    json!({"thread":{"id":thread},"model":"gpt-5.5"}),
                )
                .await?;
            }
            "skills/extraRoots/set" => {
                send_response(&mut socket, id, json!({})).await?;
            }
            "turn/start" => {
                turn_number += 1;
                let turn_id = format!("mock-codex-turn-{turn_number}");
                send_response(&mut socket, id, json!({"turn":{"id":turn_id}})).await?;
                let envelope = request
                    .get("params")
                    .and_then(|params| params.get("input"))
                    .and_then(Value::as_array)
                    .and_then(|input| input.first())
                    .and_then(|input| input.get("text"))
                    .and_then(Value::as_str)
                    .and_then(|raw| parse_envelope(&scripted(raw)))
                    .unwrap_or(Envelope {
                        exit_code: 0,
                        delay_ms: 0,
                        stdout_file: None,
                        stderr_file: None,
                        discard_session: false,
                    });
                emit_script(&mut socket, &envelope).await?;
                if envelope.discard_session
                    && let Some(thread) =
                        request.pointer("/params/threadId").and_then(Value::as_str)
                {
                    threads.discard(thread);
                }
            }
            "turn/interrupt" => {
                send_response(&mut socket, id, json!({})).await?;
            }
            _ => {
                send_response(&mut socket, id, json!({})).await?;
            }
        }
    }

    Ok(())
}

async fn send_response<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    socket
        .send(Message::Text(
            json!({"id": id, "result": result}).to_string(),
        ))
        .await
        .map_err(|error| format!("WebSocket response failed: {error}"))
}

async fn send_error<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: Value,
    code: i64,
    message: &str,
) -> Result<(), String> {
    socket
        .send(Message::Text(
            json!({"id": id, "error": {"code": code, "message": message}}).to_string(),
        ))
        .await
        .map_err(|error| format!("WebSocket error response failed: {error}"))
}

/// The envelope this run of the step plays.
fn scripted(raw: &str) -> String {
    match std::env::var_os("MOCK_OUTPUT_DIR") {
        Some(output_dir) => daemon_acceptance::scripted_turn(
            raw,
            Path::new(&output_dir),
            std::env::var_os("MOCK_CAPTURE_DIR")
                .map(PathBuf::from)
                .as_deref(),
        ),
        None => raw.to_string(),
    }
}

async fn emit_script<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    envelope: &Envelope,
) -> Result<(), String> {
    if envelope.delay_ms > 0 {
        sleep(Duration::from_millis(envelope.delay_ms)).await;
    }

    let mut completed = false;
    if let Some(relative) = &envelope.stdout_file {
        let base =
            PathBuf::from(std::env::var_os("MOCK_OUTPUT_DIR").expect("MOCK_OUTPUT_DIR env var"));
        let path = resolve_fixture(&base, relative);
        let body = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read Codex fixture {}: {error}", path.display()));
        for line in body.lines().filter(|line| !line.is_empty()) {
            if let Some(ms) = daemon_acceptance::stdout_pause_ms(line) {
                sleep(Duration::from_millis(ms)).await;
                continue;
            }
            let notification: Value = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("parse Codex fixture line {line:?}: {error}"));
            if notification.get("method").and_then(Value::as_str) == Some("turn/completed") {
                completed = true;
            }
            socket
                .send(Message::Text(notification.to_string()))
                .await
                .map_err(|error| format!("WebSocket notification failed: {error}"))?;
        }
    }
    if let Some(relative) = &envelope.stderr_file {
        let base =
            PathBuf::from(std::env::var_os("MOCK_OUTPUT_DIR").expect("MOCK_OUTPUT_DIR env var"));
        let path = resolve_fixture(&base, relative);
        let body = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("read Codex stderr fixture {}: {error}", path.display())
        });
        for line in body.lines() {
            eprintln!("{line}");
        }
    }

    if !completed {
        let params = if envelope.exit_code == 0 {
            json!({"turn":{"status":"completed"}})
        } else {
            json!({
                "turn": {
                    "status": "failed",
                    "error": {"message": format!("mock-codex exited with code {}", envelope.exit_code)}
                }
            })
        };
        socket
            .send(Message::Text(
                json!({"method":"turn/completed","params":params}).to_string(),
            ))
            .await
            .map_err(|error| format!("WebSocket completion failed: {error}"))?;
    }
    Ok(())
}

fn capture_request(request: &Value) {
    let Some(dir) = std::env::var_os("MOCK_CAPTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("create MOCK_CAPTURE_DIR");
    let path = dir.join("codex_requests.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap_or_else(|error| panic!("open {}: {error}", path.display()));
    writeln!(file, "{request}").expect("write Codex request capture");
}

fn parse_envelope(raw: &str) -> Option<Envelope> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value.as_object()?;
    Some(serde_json::from_value(value).expect("Codex fixture envelope has valid fields"))
}

fn resolve_fixture(base: &Path, relative: &str) -> PathBuf {
    assert!(!relative.is_empty(), "Codex fixture path is empty");
    let candidate = Path::new(relative);
    assert!(
        !candidate.is_absolute(),
        "Codex fixture path must be relative"
    );
    for component in candidate.components() {
        match component {
            Component::ParentDir => panic!("Codex fixture path must not contain '..'"),
            Component::Prefix(_) | Component::RootDir => {
                panic!("Codex fixture path must be relative")
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    base.join(candidate)
}
