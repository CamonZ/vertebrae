use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::DaemonWorld;

const TRANSFORM: &str = "#{ name: execution.previous_output.name, total: execution.previous_output.quantity * execution.previous_output.unit_price }";

fn transform_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "total": {"type": "number"}},
        "required": ["name", "total"],
        "additionalProperties": false
    })
}

pub(crate) async fn create_workflow(world: &mut DaemonWorld) -> String {
    let response: Value = world
        .graphql_client
        .as_ref()
        .unwrap()
        .execute(
            vertebrae_sacrum_client::queries::workflows::CREATE_WORKFLOW,
            json!({
                "project_id": world.project_id,
                "name": format!("daemon-acc-rhai-{}", uuid::Uuid::new_v4().simple())
            }),
            "create_workflow",
        )
        .await
        .expect("create disposable Rhai workflow");
    let id = response["id"].as_str().unwrap().to_owned();
    world.workflow_id = Some(id.clone());
    world.created_workflow_ids.push(id.clone());
    id
}

pub(crate) async fn create_step(
    world: &DaemonWorld,
    workflow_id: &str,
    name: &str,
    step_type: &str,
    order: i32,
    config: Value,
) -> String {
    assert_ne!(
        step_type, "execute",
        "execute fixtures must exercise the CLI"
    );
    let query = r#"
        mutation CreateFixtureStep($workflow_id: Uuid4!, $name: String!,
            $step_type: String!, $order: Int!, $config: Json) {
            create_workflow_step(workflow_id: $workflow_id, name: $name,
                step_type: $step_type, step_order: $order, config: $config, harness: "claude") {
                id step_type harness
            }
        }"#;
    let response: Value = world
        .graphql_client
        .as_ref()
        .unwrap()
        .execute(
            query,
            json!({
                "workflow_id": workflow_id, "name": name, "step_type": step_type,
                "order": order,
                "config": if config.is_null() { Value::Null } else { json!(config.to_string()) }
            }),
            "create_workflow_step",
        )
        .await
        .expect("create fixture step");
    assert_eq!(response["step_type"], step_type);
    response["id"].as_str().unwrap().to_owned()
}

async fn assert_execute_definition(
    world: &mut DaemonWorld,
    id: &str,
    script: &str,
    schema: &Value,
) {
    let response = world.run_vtb_json(&["step", "show", id]).await;
    world.assert_vtb_ok("CLI execute definition read");
    let definition = response.expect("execute definition JSON");
    assert_eq!(definition["step_type"], "execute");
    assert!(definition["harness"].is_null());
    assert_eq!(definition["config"]["version"], 1);
    assert_eq!(definition["config"]["script"], script);
    assert_eq!(definition["config"]["output_schema"], *schema);
    assert!(definition["config"]["context"].is_null());
    assert!(definition["config"].get("input").is_none());
}

pub(crate) async fn create_execute_step(
    world: &mut DaemonWorld,
    workflow_id: &str,
    name: &str,
    order: i32,
    script_flag: &str,
    schema: Value,
) -> String {
    let expected_script = match script_flag.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).expect("fixture Rhai source"),
        None => script_flag.to_owned(),
    };
    let schema_json = schema.to_string();
    let order = order.to_string();
    let response = world
        .run_vtb_json(&[
            "step",
            "add",
            name,
            "--workflow",
            workflow_id,
            "--step-type",
            "execute",
            "--script",
            script_flag,
            "--output-schema",
            &schema_json,
            "--order",
            &order,
        ])
        .await;
    world.assert_vtb_ok("CLI execute creation without harness");
    let response = response.expect("execute creation JSON envelope");
    let id = response["step_id"].as_str().unwrap().to_owned();
    assert_execute_definition(world, &id, &expected_script, &schema).await;
    id
}

pub(crate) async fn connect(world: &DaemonWorld, from: &str, to: &str) {
    let query = r#"mutation ConnectFixture($id: Uuid4!, $to: Uuid4!) {
        sync_step_transitions(id: $id, transitions: [{to_step_id: $to}]) { id }
    }"#;
    let _: Value = world
        .graphql_client
        .as_ref()
        .unwrap()
        .execute(
            query,
            json!({"id": from, "to": to}),
            "sync_step_transitions",
        )
        .await
        .expect("connect fixture steps");
}

#[given(expr = "a CLI-authored Rhai transform consumer workflow with quantity {int}")]
async fn transform_workflow(world: &mut DaemonWorld, quantity: i64) {
    let workflow_id = create_workflow(world).await;
    let result = json!({
        "type": "result", "subtype": "success", "is_error": false,
        "result": "prepared", "session_id": "rhai-producer",
        "structured_output": {"name": "example", "quantity": quantity, "unit_price": 12},
        "usage": {"input_tokens": 1, "output_tokens": 1}
    });
    // Separate adjacent closing braces to satisfy the existing mock builder's
    // Liquid-trigger guard while keeping the stream event valid JSON.
    let result_line = result.to_string().replace("}}", "} }");
    let prompt = world
        .mock_response("prepare")
        .with_stdout_line(result_line)
        .build()
        .expect("producer mock envelope");
    let prepare = create_step(
        world,
        &workflow_id,
        "prepare",
        "llm_inference",
        0,
        json!({
            "version": 1, "prompt": prompt,
            "output_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "quantity": {"type": "number"},
                    "unit_price": {"type": "number"}},
                "required": ["name", "quantity", "unit_price"], "additionalProperties": false
            }
        }),
    )
    .await;
    let transform = create_execute_step(
        world,
        &workflow_id,
        "transform",
        1,
        "#{ name: \"before script update\", total: 0 }",
        transform_schema(),
    )
    .await;
    std::fs::create_dir_all(&world.capture_dir).expect("fixture script directory");
    let transform_path = world.capture_dir.join("transform.rhai");
    std::fs::write(&transform_path, TRANSFORM).expect("write transform script");
    let transform_flag = format!("@{}", transform_path.display());
    world
        .run_vtb(&["step", "update", &transform, "--script", &transform_flag])
        .await;
    world.assert_vtb_ok("CLI Rhai script update from file");
    assert_execute_definition(world, &transform, TRANSFORM, &transform_schema()).await;

    let consumer_path = world.capture_dir.join("consumer.rhai");
    std::fs::write(&consumer_path, "#{ observed_total: steps.transform.output.total, context: #{ task: task, execution: execution, inputs: inputs, steps: steps, workflow: workflow, artifacts: artifacts } }").expect("write consumer script");
    let consumer_flag = format!("@{}", consumer_path.display());
    let consumer = create_execute_step(world, &workflow_id, "consumer", 2, &consumer_flag, json!({
        "type": "object", "properties": {"observed_total": {"type": "number"}, "context": {"type": "object"}},
        "required": ["observed_total", "context"], "additionalProperties": false
    })).await;
    let finish = create_step(world, &workflow_id, "finish", "finish", 3, Value::Null).await;
    connect(world, &prepare, &transform).await;
    connect(world, &transform, &consumer).await;
    connect(world, &consumer, &finish).await;
    world.step_id = Some(transform);
}

#[given(expr = "a CLI-authored Rhai step returning script {string}")]
async fn failing_workflow(world: &mut DaemonWorld, script: String) {
    let workflow_id = create_workflow(world).await;
    let step_id = create_execute_step(
        world,
        &workflow_id,
        "transform",
        0,
        &script,
        transform_schema(),
    )
    .await;
    world.step_id = Some(step_id);
    // Startup readiness probes may invoke `claude --version`. Observe provider
    // invocations only after the daemon is online and this fixture is ready.
    let capture = world.capture_dir.join("argv.json");
    if capture.exists() {
        std::fs::remove_file(capture).expect("clear startup provider probe capture");
    }
}

pub(crate) async fn executions(world: &DaemonWorld) -> Vec<Value> {
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    world
        .graphql_client
        .as_ref()
        .unwrap()
        .execute(&query, json!({"task_id": world.task_id}), "step_executions")
        .await
        .expect("list execute fixture executions")
}

#[when("I wait for the Rhai consumer to complete")]
async fn wait_for_consumer(world: &mut DaemonWorld) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = executions(world).await;
        if rows
            .iter()
            .any(|row| row["step_name"] == "consumer" && row["status"] == "completed")
        {
            return;
        }
        assert!(
            !rows.iter().any(|row| row["status"] == "failed"),
            "workflow failed: {rows:?}"
        );
        assert!(
            Instant::now() < deadline,
            "consumer did not complete: {rows:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[then(expr = "the Rhai workflow persists total {int} and resolved snapshots in one TaskRun")]
async fn assert_transform(world: &mut DaemonWorld, total: i64) {
    let rows = executions(world).await;
    let one = |name| {
        let matching: Vec<_> = rows.iter().filter(|row| row["step_name"] == name).collect();
        assert_eq!(
            matching.len(),
            1,
            "expected one attempt for {name}: {rows:?}"
        );
        matching[0]
    };
    let prepare = one("prepare");
    let transform = one("transform");
    let consumer = one("consumer");
    for row in [prepare, transform, consumer] {
        assert_eq!(row["status"], "completed");
        assert!(row["task_run_id"].is_string());
        assert_eq!(row["task_run_id"], prepare["task_run_id"]);
    }
    assert_eq!(transform["step_type"], "execute");
    assert_eq!(transform["config"]["version"], 1);
    assert_eq!(transform["config"]["script"], TRANSFORM);
    let json_field = |value: &Value| match value.as_str() {
        Some(encoded) => serde_json::from_str::<Value>(encoded).expect("JSON scalar"),
        None => value.clone(),
    };
    assert_eq!(
        json_field(&transform["config"]["output_schema"]),
        transform_schema()
    );
    assert_eq!(
        json_field(&transform["config"]["context"])["execution"]["previous_output"],
        json!({
            "name": "example", "quantity": total / 12, "unit_price": 12
        })
    );
    assert_eq!(
        json_field(&consumer["config"]["context"])["steps"]["transform"]["output"],
        json!({"name": "example", "total": total})
    );
    let output =
        |row: &Value| serde_json::from_str::<Value>(row["output"].as_str().unwrap()).unwrap();
    assert_eq!(
        output(transform),
        json!({"name": "example", "total": total})
    );
    let consumer_output = output(consumer);
    assert_eq!(consumer_output["observed_total"], total);
    let context = json_field(&consumer["config"]["context"]);
    assert_eq!(
        consumer_output["context"], context,
        "every canonical binding must match the saved server snapshot"
    );
    for namespace in [
        "task",
        "execution",
        "inputs",
        "steps",
        "workflow",
        "artifacts",
    ] {
        assert!(
            context[namespace].is_object(),
            "missing namespace {namespace}"
        );
    }
    assert_eq!(
        context["task"]["id"],
        world.task_id.as_ref().unwrap().as_str()
    );
    assert_eq!(context["workflow"]["current_step"], "consumer");
    assert_eq!(context["inputs"], json!({}));
    assert!(context["execution"]["history"].is_array());
    assert!(context["artifacts"]["step_execution"]["history"].is_array());
    for row in [transform, consumer] {
        for field in [
            "model",
            "model_provider",
            "input_tokens",
            "output_tokens",
            "cost",
        ] {
            assert!(
                row[field].is_null(),
                "execute has inference metadata {field}: {row}"
            );
        }
    }
}

#[then("the Rhai failure attempts have failed status and no completed output")]
async fn assert_failure(world: &mut DaemonWorld) {
    let rows = executions(world).await;
    assert!(!rows.is_empty(), "no failed attempts persisted");
    // Sacrum owns retry policy. A new execution row is a distinct attempt,
    // rather than evidence of a duplicate daemon terminal report.
    for row in &rows {
        assert_eq!(row["step_type"], "execute");
        assert_eq!(row["status"], "failed");
        assert_eq!(row["task_run_id"], rows[0]["task_run_id"]);
        assert!(
            !row["output"].as_str().unwrap_or_default().is_empty(),
            "missing diagnostic"
        );
        for field in [
            "model",
            "model_provider",
            "input_tokens",
            "output_tokens",
            "cost",
        ] {
            assert!(
                row[field].is_null(),
                "execute has inference metadata {field}: {row}"
            );
        }
    }
    assert!(
        !world.capture_dir.join("argv.json").exists(),
        "execute launched a provider mock"
    );
}
