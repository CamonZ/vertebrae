use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

const TOOL_NAME: &str = "permission_prompt";

const AWAIT_PERMISSION_DECISION: &str = r#"
    mutation AwaitPermissionDecision(
        $project_id: Uuid4!,
        $session_id: String!,
        $tool_name: String!,
        $tool_use_id: String!,
        $input: Json!
    ) {
        await_permission_decision(
            project_id: $project_id,
            session_id: $session_id,
            tool_name: $tool_name,
            tool_use_id: $tool_use_id,
            input: $input
        )
    }
"#;

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
    let config = SacrumConfig::load().map_err(|e| e.to_string())?;
    let project_id = config.project_id.clone();
    let client = GraphqlClient::new(config);
    let variables = json!({
        "project_id": project_id,
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_use_id": tool_use_id,
        "input": input,
    });

    client
        .execute(
            AWAIT_PERMISSION_DECISION,
            variables,
            "await_permission_decision",
        )
        .await
        .map_err(|e| e.to_string())
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
