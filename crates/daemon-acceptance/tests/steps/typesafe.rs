use cucumber::given;
use serde_json::json;
use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

use crate::DaemonWorld;

#[given("a stub TypeSafe server returning structured answers")]
pub async fn stub_typesafe_server(world: &mut DaemonWorld) {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "model": "jev",
            "answers": {"priority": {"type": "noul", "noul": 0.9}},
            "usage": {"input_tokens": 41, "output_tokens": 8}
        })))
        .expect(1)
        .mount(&server)
        .await;
    world
        .env
        .insert("TYPESAFE_API_KEY".into(), "daemon-acceptance-key".into());
    world.env.insert("TYPESAFE_BASE_URL".into(), server.uri());
    world.typesafe_server = Some(server);
}

#[given("a workflow with one structured_inference step using TypeSafe")]
pub async fn workflow_with_structured_inference(world: &mut DaemonWorld) {
    let workflow_name = format!("daemon-acc-structured-{}", uuid::Uuid::new_v4().simple());
    world.run_vtb(&["workflow", "add", &workflow_name]).await;
    world.assert_vtb_ok("workflow add");
    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.workflow_id = Some(workflow_id.clone());
    world.created_workflow_ids.push(workflow_id.clone());

    world
        .run_vtb(&[
            "step", "add", "classify", "--workflow", &workflow_id,
            "--step-type", "structured_inference", "--provider", "typesafe",
            "--model", "jev", "--state", r#"{"title":"{{ task.title }}"}"#,
            "--questions", r#"{"priority":{"type":"noul","instructions":"Is this urgent?","criteria":{"true":"It blocks work","false":"It can wait"}}}"#,
        ])
        .await;
    world.assert_vtb_ok("step add structured_inference");
    world
        .run_vtb(&[
            "step",
            "add",
            "finish",
            "--workflow",
            &workflow_id,
            "--step-type",
            "finish",
            "--order",
            "1",
        ])
        .await;
    world.assert_vtb_ok("step add finish");

    let steps = world
        .run_vtb_json(&["step", "list", &workflow_id])
        .await
        .expect("step list JSON");
    let steps = steps.as_array().expect("step list is an array");
    let classify_id = steps
        .iter()
        .find(|step| step["name"] == "classify")
        .expect("structured inference step exists")["id"]
        .as_str()
        .unwrap()
        .to_string();
    let finish_id = steps
        .iter()
        .find(|step| step["name"] == "finish")
        .expect("finish step exists")["id"]
        .as_str()
        .unwrap()
        .to_string();
    world
        .run_vtb(&[
            "step",
            "update",
            &classify_id,
            "--transition-to",
            &finish_id,
        ])
        .await;
    world.assert_vtb_ok("step update structured inference transition");
    world.step_id = Some(classify_id);
}
