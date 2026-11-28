use super::*;
use vertebrae_core::ProviderProfile;

#[tokio::test]
async fn named_acp_provider_runs_its_model_on_workflow_dispatch() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let worktree = cwd.join("worktree");
    std::fs::create_dir(&worktree).unwrap();
    let shell_path = format!(
        "{}:{}",
        cwd.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../harness-acp/tests/fixtures/agent.py");
    let args = vec![
        "python3".into(),
        fixture.display().to_string(),
        "--workflow".into(),
        "literal $HOME; value".into(),
    ];
    for (scenario, expected_status, expected_output) in [
        ("saved", "completed", "Hello workflow"),
        ("provider", "completed", "Hello workflow"),
        ("cancel", "failed", "Cancelled"),
        (
            "unlisted-model",
            "failed",
            "is not configured for provider 'workflow-agent'",
        ),
        (
            "session-routing",
            "failed",
            "does not support workflow session routing",
        ),
        ("missing", "failed", "Check [providers.workflow-agent]"),
        (
            "startup-failure",
            "failed",
            "Could not start ACP workflow agent",
        ),
    ] {
        let executable = match scenario {
            "missing" => cwd.join("missing-acp-agent"),
            "startup-failure" => "/usr/bin/false".into(),
            _ => "/usr/bin/env".into(),
        };
        let provider_id = ProviderId::new("workflow-agent").unwrap();
        let text_persisted = Arc::new(tokio::sync::Notify::new());
        let signal = text_persisted.clone();
        let server = provider_execution_server_with_logs(move |request| {
            if normalized_event(request).is_some_and(|event| event["type"] == "text") {
                signal.notify_one();
            }
        })
        .await;
        let mut config = test_execute_config(&server, Arc::new(ScriptWorker::default()));
        let profiles = [
            (
                provider_id,
                ProviderProfile {
                    executable: Some(executable),
                    args: args.clone(),
                    env: [
                        ("VTB_ACP_WORKSPACE".into(), worktree.display().to_string()),
                        ("VTB_ACP_PATH_HEAD".into(), cwd.display().to_string()),
                    ]
                    .into(),
                    models: vec!["selected".into()],
                    ..ProviderProfile::new(StepHarness::Acp)
                },
            ),
            (
                ProviderId::new("other-agent").unwrap(),
                ProviderProfile {
                    executable: Some("/usr/bin/false".into()),
                    ..ProviderProfile::new(StepHarness::Acp)
                },
            ),
        ]
        .into();
        let path = cwd.join("config.toml");
        let file = vertebrae_sacrum_client::VertebraeConfigFile {
            providers: profiles,
            ..Default::default()
        };
        std::fs::write(&path, toml::to_string(&file).unwrap()).unwrap();
        let mut capabilities = (*config.capabilities)
            .clone()
            .with_provider_config_path(Some(path));
        capabilities.shell_path = shell_path.clone();
        config.capabilities = Arc::new(capabilities);
        config.project_root = cwd.clone();
        let prompt = if scenario == "cancel" {
            "cancel"
        } else {
            "complete"
        };
        let mut payload = serde_json::json!({
            "id": "session-attempt",
            "task_id": "session-task",
            "project_id": "execute-project",
            "step_type": "llm_inference",
            "agent_config": {"provider": "workflow-agent", "model": "selected"},
            "worktree": worktree,
            "prompt": prompt,
        });
        if scenario != "provider" {
            payload["harness"] = "acp".into();
        }
        if scenario == "saved" {
            let step = create_named_acp_step(&server, &config.services).await;
            payload["harness"] = serde_json::to_value(step.harness).unwrap();
            payload["agent_config"] = serde_json::to_value(step.agent_config()).unwrap();
            payload["prompt"] = serde_json::to_value(step.prompt()).unwrap();
        }
        let (project, handle) = Actor::spawn(None, ProjectSupervisor, config).await.unwrap();
        if scenario == "unlisted-model" {
            payload["agent_config"]["model"] = "unlisted".into();
        }
        if scenario == "session-routing" {
            payload["session"] = serde_json::json!({"mode": "new"});
        }
        project
            .cast(ProjectMessage::ChannelEvent(msg(
                "daemon:test",
                "run_step",
                payload,
            )))
            .unwrap();
        if scenario == "cancel" {
            tokio::time::timeout(Duration::from_secs(5), text_persisted.notified())
                .await
                .expect("agent did not reach the cancellation checkpoint");
            project
                .cast(ProjectMessage::CancelStep {
                    step_execution_id: "session-attempt".into(),
                    task_id: "session-task".into(),
                })
                .unwrap();
        }
        let updates = execution_updates(&server, |updates| {
            updates
                .iter()
                .any(|update| update["status"] != "in_progress")
        })
        .await;
        let terminal = updates.last().unwrap();
        assert_eq!(
            terminal["status"], expected_status,
            "{scenario}: {updates:?}"
        );
        assert!(
            terminal["output"]
                .as_str()
                .is_some_and(|output| output.contains(expected_output)),
            "{scenario}: {updates:?}"
        );
        if expected_status == "completed" || scenario == "cancel" {
            let normalized = normalized_events(&server).await;
            assert!(
                normalized
                    .iter()
                    .any(|event| event["type"] == "text" && event["data"]["text"] == "Hello "),
                "{scenario}: {normalized:?}"
            );
            assert_eq!(
                normalized
                    .iter()
                    .filter(|event| event["type"] == "run_finished")
                    .count(),
                1
            );
        }
        project
            .stop_and_wait(None, Some(Duration::from_secs(5)))
            .await
            .unwrap();
        handle.await.unwrap();
    }
}

async fn create_named_acp_step(
    server: &wiremock::MockServer,
    services: &vertebrae_core::VertebraeServices,
) -> vertebrae_core::Step {
    wiremock::Mock::given(wiremock::matchers::body_string_contains(
        "create_workflow_step",
    ))
    .respond_with(|request: &wiremock::Request| {
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        let variables = &body["variables"];
        let config: serde_json::Value =
            serde_json::from_str(variables["config"].as_str().unwrap()).unwrap();
        assert_eq!(variables["harness"], "acp");
        assert_eq!(config["agent_config"]["provider"], "workflow-agent");
        assert_eq!(config["agent_config"]["model"], "selected");
        wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {"create_workflow_step": {
                "id": "workflow-step", "name": variables["name"], "goal": null,
                "step_type": "llm_inference", "harness": variables["harness"],
                "config": config, "persistence_options": null, "step_order": 0,
                "workflow_id": variables["workflow_id"], "project_id": "execute-project",
                "inserted_at": null, "updated_at": null, "transitions": []
            }}
        }))
    })
    .with_priority(1)
    .expect(1)
    .mount(server)
    .await;
    services
        .steps()
        .create_step(
            &vertebrae_core::Step::new("Run an ACP agent", "workflow")
                .with_harness(StepHarness::Acp)
                .with_prompt("complete")
                .with_agent_config(
                    AgentConfig::new()
                        .with_provider(ProviderId::new("workflow-agent").unwrap())
                        .with_model("selected"),
                ),
        )
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires an authenticated ACP agent or an isolated inference endpoint"]
async fn real_acp_daemon_step() {
    let model = std::env::var("ACP_SMOKE_MODEL").expect("set ACP_SMOKE_MODEL");
    let executable = std::env::var_os("ACP_SMOKE_EXECUTABLE").expect("set ACP_SMOKE_EXECUTABLE");
    let shell_path = std::env::var("PATH").unwrap_or_default();
    let temp = tempfile::tempdir().unwrap();
    let server = provider_execution_server().await;
    let mut config = test_execute_config(&server, Arc::new(ScriptWorker::default()));
    let mut capabilities = (*config.capabilities).clone().with_provider_profiles(
        [(
            ProviderId::new("smoke-agent").unwrap(),
            ProviderProfile {
                executable: Some(executable.into()),
                models: vec![model.clone()],
                ..ProviderProfile::new(StepHarness::Acp)
            },
        )]
        .into(),
    );
    capabilities.shell_path = shell_path;
    config.capabilities = Arc::new(capabilities);
    config.project_root = temp.path().to_path_buf();
    let (project, handle) = Actor::spawn(None, ProjectSupervisor, config).await.unwrap();
    project
        .cast(ProjectMessage::ChannelEvent(msg(
            "daemon:test",
            "run_step",
            serde_json::json!({
                "id": "session-attempt",
                "task_id": "session-task",
                "project_id": "execute-project",
                "step_type": "llm_inference",
                "harness": "acp",
                "prompt": "Reply with ACP_OK. Do not use tools.",
                "agent_config": {"provider": "smoke-agent", "model": model}
            }),
        )))
        .unwrap();
    let updates = execution_updates(&server, |updates| {
        updates
            .iter()
            .any(|update| update["status"] != "in_progress")
    })
    .await;
    let normalized = normalized_events(&server).await;
    let streamed: String = normalized
        .iter()
        .filter(|event| event["type"] == "text")
        .filter_map(|event| event["data"]["text"].as_str())
        .collect();
    assert!(streamed.contains("ACP_OK"), "{normalized:?}");
    assert_eq!(
        normalized
            .iter()
            .filter(|event| event["type"] == "run_finished")
            .count(),
        1
    );
    project
        .stop_and_wait(None, Some(Duration::from_secs(5)))
        .await
        .unwrap();
    handle.await.unwrap();
    let terminal = updates.last().unwrap();
    assert_eq!(terminal["status"], "completed", "{updates:?}");
    assert!(
        terminal["output"]
            .as_str()
            .is_some_and(|text| text.contains("ACP_OK")),
        "{updates:?}"
    );
}

async fn normalized_events(server: &wiremock::MockServer) -> Vec<serde_json::Value> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter_map(normalized_event)
        .collect()
}

fn normalized_event(request: &wiremock::Request) -> Option<serde_json::Value> {
    let body = serde_json::from_slice::<serde_json::Value>(&request.body).ok()?;
    serde_json::from_str(body["variables"]["content"].as_str()?).ok()
}
