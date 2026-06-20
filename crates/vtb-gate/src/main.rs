use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

const TOOL_NAME: &str = "permission_prompt";

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: PermissionArguments,
}

#[derive(Debug, Default, Deserialize)]
struct PermissionArguments {
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    #[serde(default)]
    input: Value,
}

#[derive(Debug, Serialize)]
struct PermissionSocketRequest {
    request_id: String,
    tool_name: String,
    tool_use_id: String,
    input: Value,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("vtb-gate: {err}");
    }
}

async fn run() -> Result<(), String> {
    let stdin = BufReader::new(io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = io::stdout();

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(err) => {
                write_response(&mut stdout, None, error_obj(-32700, err.to_string())).await?;
                continue;
            }
        };

        if request.id.is_none() {
            continue;
        }

        let result = handle_request(&request).await;
        write_response(&mut stdout, request.id, result).await?;
    }

    Ok(())
}

async fn handle_request(request: &JsonRpcRequest) -> Value {
    match request.method.as_str() {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "vtb-gate", "version": env!("CARGO_PKG_VERSION") }
            }
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "result": {
                "tools": [{
                    "name": TOOL_NAME,
                    "description": "Ask the Vertebrae GUI to approve, deny, or modify a Claude tool permission request.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name": { "type": "string" },
                            "tool_use_id": { "type": "string" },
                            "input": { "type": "object" }
                        },
                        "required": ["tool_name", "tool_use_id", "input"]
                    }
                }]
            }
        }),
        "tools/call" => match serde_json::from_value::<ToolCallParams>(request.params.clone()) {
            Ok(params) if params.name == TOOL_NAME => call_permission_tool(params.arguments).await,
            Ok(params) => error_obj(-32602, format!("unknown tool: {}", params.name)),
            Err(err) => error_obj(-32602, err.to_string()),
        },
        _ => error_obj(-32601, format!("unknown method: {}", request.method)),
    }
}

async fn call_permission_tool(args: PermissionArguments) -> Value {
    let tool_name = args.tool_name.unwrap_or_else(|| "unknown".to_string());
    let tool_use_id = args.tool_use_id.unwrap_or_else(|| "unknown".to_string());
    let session_id =
        std::env::var("VTB_CLAUDE_SESSION_ID").unwrap_or_else(|_| "unknown".to_string());

    match await_permission_decision(&session_id, &tool_name, &tool_use_id, args.input).await {
        Ok(decision) => json!({
            "jsonrpc": "2.0",
            "result": {
                "content": [{ "type": "text", "text": decision.to_string() }]
            }
        }),
        Err(err) => json!({
            "jsonrpc": "2.0",
            "result": {
                "content": [{ "type": "text", "text": json!({ "behavior": "deny", "message": err }).to_string() }],
                "isError": true
            }
        }),
    }
}

async fn await_permission_decision(
    session_id: &str,
    tool_name: &str,
    tool_use_id: &str,
    input: Value,
) -> Result<Value, String> {
    let socket_path = std::env::var("VTB_GATE_SOCKET").map_err(|_| {
        "VTB_GATE_SOCKET is not set; permission prompts require the local GUI socket".to_string()
    })?;

    ask_over_socket(&socket_path, session_id, tool_name, tool_use_id, input).await
}

#[cfg(unix)]
async fn ask_over_socket(
    socket_path: &str,
    session_id: &str,
    tool_name: &str,
    tool_use_id: &str,
    input: Value,
) -> Result<Value, String> {
    let request_id = request_id_for(session_id, tool_use_id);
    let request = PermissionSocketRequest {
        request_id,
        tool_name: tool_name.to_string(),
        tool_use_id: tool_use_id.to_string(),
        input,
    };
    let mut stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .map_err(|e| format!("failed to connect to VTB_GATE_SOCKET {socket_path}: {e}"))?;

    let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    let mut response_line = String::new();
    let mut reader = BufReader::new(stream);
    let bytes = reader
        .read_line(&mut response_line)
        .await
        .map_err(|e| e.to_string())?;
    if bytes == 0 {
        return Err("permission socket closed before returning a decision".to_string());
    }

    let response: Value =
        serde_json::from_str(response_line.trim_end()).map_err(|e| e.to_string())?;
    match response.get("behavior").and_then(Value::as_str) {
        Some("allow" | "deny") => Ok(response),
        Some(other) => Err(format!(
            "permission socket returned invalid behavior: {other}"
        )),
        None => Err("permission socket response missing behavior".to_string()),
    }
}

#[cfg(not(unix))]
async fn ask_over_socket(
    _socket_path: &str,
    _session_id: &str,
    _tool_name: &str,
    _tool_use_id: &str,
    _input: Value,
) -> Result<Value, String> {
    Err("VTB_GATE_SOCKET permission transport requires a Unix platform".to_string())
}

fn request_id_for(session_id: &str, tool_use_id: &str) -> String {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{session_id}:{tool_use_id}:{suffix}")
}

fn error_obj(code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message } })
}

async fn write_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    id: Option<Value>,
    mut response: Value,
) -> Result<(), String> {
    if let Some(id) = id {
        response["id"] = id;
    }
    let line = serde_json::to_string(&response).map_err(|e| e.to_string())?;
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[tokio::test]
    async fn ask_over_socket_sends_request_and_returns_decision() {
        use std::io::{BufRead as _, Write as _};
        use std::os::unix::net::UnixListener;

        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vtb-gate-test-{}-{suffix}.sock",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let server = std::thread::spawn(move || {
            let (mut stream, _addr) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(line.trim_end()).unwrap();

            assert_eq!(request["tool_name"], "Bash");
            assert_eq!(request["tool_use_id"], "tool-1");
            assert_eq!(request["input"], json!({ "command": "ls" }));
            assert!(request["request_id"]
                .as_str()
                .unwrap()
                .contains("session-1"));

            stream
                .write_all(
                    br#"{"behavior":"allow","message":null,"updated_input":{"command":"ls -la"}}"#,
                )
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let decision = ask_over_socket(
            path.to_str().unwrap(),
            "session-1",
            "Bash",
            "tool-1",
            json!({ "command": "ls" }),
        )
        .await
        .unwrap();

        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updated_input"], json!({ "command": "ls -la" }));
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
    }
}
