//! Deterministic Codex App Server used by the daemon acceptance suite.
//!
//! The daemon launches this binary as `codex app-server --listen ws://…`.
//! It exposes the App Server readiness endpoint and a small JSON-RPC WebSocket
//! implementation. Scenario-specific notifications are read from the fixture
//! envelope passed as the first turn's text input.

use std::path::{Component, Path, PathBuf};

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    time::{Duration, sleep},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Clone, Deserialize)]
struct Envelope {
    exit_code: i32,
    delay_ms: u64,
    stdout_file: Option<String>,
    stderr_file: Option<String>,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    capture_invocation(&args);

    if is_model_discovery(&args) {
        print_model_catalog();
        return;
    }

    let address = listen_address(&args);
    let listener = TcpListener::bind(address)
        .await
        .unwrap_or_else(|error| panic!("mock-codex failed to bind {address}: {error}"));

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .expect("mock-codex failed to accept connection");
        tokio::spawn(async move {
            if is_readiness_probe(&stream).await {
                respond_ready(stream).await;
            } else if let Err(error) = serve_websocket(stream).await {
                eprintln!("mock-codex WebSocket failed: {error}");
            }
        });
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

fn listen_address(args: &[String]) -> std::net::SocketAddr {
    let raw = args
        .windows(2)
        .find(|pair| pair[0] == "--listen")
        .map(|pair| pair[1].as_str())
        .or_else(|| args.iter().find_map(|arg| arg.strip_prefix("--listen=")))
        .expect("mock-codex requires --listen");
    raw.strip_prefix("ws://")
        .or_else(|| raw.strip_prefix("wss://"))
        .unwrap_or(raw)
        .parse()
        .unwrap_or_else(|error| panic!("invalid Codex App Server listen address {raw:?}: {error}"))
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

async fn is_readiness_probe(stream: &TcpStream) -> bool {
    let mut probe = [0_u8; 64];
    let count = stream.peek(&mut probe).await.unwrap_or(0);
    probe[..count].starts_with(b"GET /readyz")
}

async fn respond_ready(mut stream: TcpStream) {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
    let _ = stream.write_all(response).await;
    let _ = stream.shutdown().await;
}

async fn serve_websocket(stream: TcpStream) -> Result<(), String> {
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
            "thread/start" | "thread/resume" => {
                send_response(
                    &mut socket,
                    id,
                    json!({"thread":{"id":"mock-codex-thread"},"model":"gpt-5.5"}),
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
                    .and_then(parse_envelope)
                    .unwrap_or(Envelope {
                        exit_code: 0,
                        delay_ms: 0,
                        stdout_file: None,
                        stderr_file: None,
                    });
                emit_script(&mut socket, &envelope).await?;
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

async fn send_response(
    socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
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

async fn emit_script(
    socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
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
