//! Shared harness for host-module tests: run a script on the real worker
//! against a mocked Sacrum GraphQL endpoint.

use std::sync::Arc;

use serde_json::{Value, json};
use vertebrae_core::models::ExecuteConfig;
use wiremock::{Mock, MockServer, Respond, matchers};

use crate::actors::step_executor::StepResult;
use crate::script_worker::{ScriptScope, ScriptWorker};

/// The execution's project.
pub(super) const PROJECT: &str = "11111111-1111-4111-8111-111111111111";
pub(super) const OTHER_PROJECT: &str = "22222222-2222-4222-8222-222222222222";

pub(super) async fn sacrum(responder: impl Respond + 'static) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/graphql"))
        .respond_with(responder)
        .mount(&server)
        .await;
    server
}

/// Run `script` with `task.id` bound to `task_id`. Each `$NAME` in the script
/// is replaced by its quoted value from `ids`.
pub(super) async fn run(
    server: &MockServer,
    task_id: &str,
    ids: &[(&str, &str)],
    script: &str,
) -> StepResult {
    use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};
    let scope = ScriptScope {
        project_id: PROJECT.into(),
        services: Arc::new(vertebrae_sacrum_client::from_sacrum(Arc::new(
            GraphqlClient::new(SacrumConfig::new(
                server.uri(),
                "token".into(),
                PROJECT.into(),
            )),
        ))),
    };
    let script = ids.iter().fold(script.to_string(), |script, (name, id)| {
        script.replace(&format!("${name}"), &format!("\"{id}\""))
    });
    let config = ExecuteConfig {
        version: 1,
        script,
        context: Some(json!({
            "task": {"id": task_id}, "execution": {}, "inputs": {},
            "steps": {}, "workflow": {}, "artifacts": {}
        })),
        output_schema: json!({}),
    };
    ScriptWorker::default()
        .admit(config, scope, |_| {})
        .unwrap()
        .settle()
        .await
}

pub(super) fn completed(result: StepResult, script: &str) -> Value {
    match result {
        StepResult::Completed {
            output: Some(output),
            ..
        } => serde_json::from_str(&output).unwrap(),
        other => panic!("expected completion for {script}, got {other:?}"),
    }
}

/// The variables of every request whose query contains `operation`.
pub(super) async fn sacrum_requests(server: &MockServer, operation: &str) -> Vec<Value> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
        .filter(|body| body["query"].as_str().unwrap().contains(operation))
        .map(|body| body["variables"].clone())
        .collect()
}
