use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vertebrae_harness_core::{
    ApprovalCategory, ApprovalRequest, ControlRequest, ControlRequestEnvelope, ControlRequestId,
    SessionId,
};

use super::*;
use crate::local_chat::{HarnessCreateSessionInput, LocalChatHarnessInfo, LocalChatModelOption};

// Test-only call log; boxing the create input would only obscure assertions.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum MockCall {
    Create(HarnessCreateSessionInput),
    Send {
        backend_session_id: String,
        content: String,
    },
    Close {
        backend_session_id: String,
    },
}

#[derive(Clone)]
struct MockHarness {
    kind: LocalChatHarnessKind,
    available: bool,
    unavailable_reason: Option<String>,
    fail_create: Option<LocalChatSessionError>,
    fail_close: Option<LocalChatSessionError>,
    calls: Arc<Mutex<Vec<MockCall>>>,
}

impl MockHarness {
    fn new(kind: LocalChatHarnessKind) -> Self {
        Self {
            kind,
            available: true,
            unavailable_reason: None,
            fail_create: None,
            fail_close: None,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn unavailable(mut self, reason: &str) -> Self {
        self.available = false;
        self.unavailable_reason = Some(reason.to_string());
        self
    }

    fn fail_create(mut self, error: LocalChatSessionError) -> Self {
        self.fail_create = Some(error);
        self
    }

    fn fail_close(mut self, error: LocalChatSessionError) -> Self {
        self.fail_close = Some(error);
        self
    }

    fn calls(&self) -> Vec<MockCall> {
        self.calls.lock().expect("mock calls lock poisoned").clone()
    }
}

#[async_trait]
impl LocalChatHarness for MockHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        self.kind
    }

    async fn info(&self) -> LocalChatHarnessInfo {
        LocalChatHarnessInfo {
            harness: self.kind,
            label: format!("{:?}", self.kind),
            available: self.available,
            unavailable_reason: self.unavailable_reason.clone(),
            default_model_id: Some("default-model".to_string()),
            models: vec![LocalChatModelOption {
                id: "default-model".to_string(),
                label: "Default Model".to_string(),
                supported_reasoning_effort_ids: None,
                supported_speed_tier_ids: None,
                supports_personality: None,
            }],
            default_reasoning_effort: None,
            reasoning_efforts: Vec::new(),
            speed_tiers: Vec::new(),
            permission_modes: None,
            personality_options: None,
            supports_resume: true,
        }
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        _runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        self.calls
            .lock()
            .expect("mock calls lock poisoned")
            .push(MockCall::Create(input));
        if let Some(error) = self.fail_create.clone() {
            return Err(error);
        }
        Ok(())
    }

    async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        self.calls
            .lock()
            .expect("mock calls lock poisoned")
            .push(MockCall::Send {
                backend_session_id: backend_session_id.to_string(),
                content: content.to_string(),
            });
        Ok(())
    }

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError> {
        self.calls
            .lock()
            .expect("mock calls lock poisoned")
            .push(MockCall::Close {
                backend_session_id: backend_session_id.to_string(),
            });
        if let Some(error) = self.fail_close.clone() {
            return Err(error);
        }
        Ok(())
    }

    async fn has_session(&self, _backend_session_id: &str) -> bool {
        true
    }
}

fn create_input(
    harness: LocalChatHarnessKind,
    backend_session_id: &str,
) -> CreateLocalChatSessionInput {
    CreateLocalChatSessionInput {
        harness,
        backend_session_id: backend_session_id.to_string(),
        working_dir: Some("/tmp/project".to_string()),
        initial_prompt: Some("hello".to_string()),
        provider_resume_id: Some("provider-resume-1".to_string()),
        model_id: Some("model-1".to_string()),
        reasoning_effort: Some("high".to_string()),
        speed_tier: None,
        permission_mode: None,
        personality: None,
        provider_id: None,
        gate: None,
    }
}

#[tokio::test]
async fn catalog_defaults_to_the_first_available_harness_and_retains_diagnostics() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(
            MockHarness::new(LocalChatHarnessKind::Claude).unavailable("Claude Code CLI not found"),
        ),
        Arc::new(MockHarness::new(LocalChatHarnessKind::Codex)),
    ]);
    let catalog = manager.catalog().await.unwrap();

    assert_eq!(catalog.default_harness, LocalChatHarnessKind::Codex);
    assert_eq!(
        catalog
            .harnesses
            .iter()
            .find(|info| info.harness == LocalChatHarnessKind::Claude)
            .and_then(|info| info.unavailable_reason.as_deref()),
        Some("Claude Code CLI not found")
    );
    assert!(catalog
        .harnesses
        .iter()
        .any(|info| info.harness == LocalChatHarnessKind::Claude));
    assert!(catalog
        .harnesses
        .iter()
        .any(|info| info.harness == LocalChatHarnessKind::Codex));
}

#[tokio::test]
async fn catalog_uses_claude_when_it_is_the_only_available_harness() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(MockHarness::new(LocalChatHarnessKind::Claude)),
        Arc::new(MockHarness::new(LocalChatHarnessKind::Codex).unavailable("Codex CLI not found")),
    ]);

    assert_eq!(
        manager.catalog().await.unwrap().default_harness,
        LocalChatHarnessKind::Claude
    );
}

#[tokio::test]
async fn catalog_falls_back_to_claude_kind_when_neither_harness_is_available() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(
            MockHarness::new(LocalChatHarnessKind::Claude).unavailable("Claude Code CLI not found"),
        ),
        Arc::new(MockHarness::new(LocalChatHarnessKind::Codex).unavailable("Codex CLI not found")),
    ]);

    assert_eq!(
        manager.catalog().await.unwrap().default_harness,
        LocalChatHarnessKind::Claude
    );
}

fn custom_profiles() -> std::collections::BTreeMap<ProviderId, ProviderProfile> {
    let profile = |harness, models: &[&str]| ProviderProfile {
        models: models.iter().map(|model| model.to_string()).collect(),
        ..ProviderProfile::new(harness)
    };
    std::collections::BTreeMap::from([
        (
            ProviderId::new("openrouter").unwrap(),
            ProviderProfile {
                default_model: Some("z-ai/glm-5".into()),
                ..profile(StepHarness::Claude, &["moonshotai/kimi-k2", "z-ai/glm-5"])
            },
        ),
        (
            ProviderId::new("local").unwrap(),
            profile(StepHarness::Codex, &["qwen3-coder"]),
        ),
        (
            ProviderId::new("staging").unwrap(),
            profile(StepHarness::Typesafe, &["jev-staging"]),
        ),
    ])
}

#[tokio::test]
async fn catalog_lists_builtin_and_custom_providers_but_not_typesafe_profiles() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(MockHarness::new(LocalChatHarnessKind::Claude)),
        Arc::new(MockHarness::new(LocalChatHarnessKind::Codex)),
    ])
    .with_provider_profiles_for_tests(custom_profiles());

    let catalog = manager.catalog().await.unwrap();

    let ids = catalog
        .providers
        .iter()
        .map(|provider| (provider.id.as_str(), provider.harness, provider.custom))
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        vec![
            ("anthropic", LocalChatHarnessKind::Claude, false),
            ("openai", LocalChatHarnessKind::Codex, false),
            ("local", LocalChatHarnessKind::Codex, true),
            ("openrouter", LocalChatHarnessKind::Claude, true),
        ]
    );
    assert_eq!(catalog.default_provider, "anthropic");
    let openrouter = catalog
        .providers
        .iter()
        .find(|provider| provider.id == "openrouter")
        .unwrap();
    assert!(openrouter.available);
    assert_eq!(
        openrouter
            .models
            .as_ref()
            .unwrap()
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["moonshotai/kimi-k2", "z-ai/glm-5"]
    );
    assert_eq!(openrouter.default_model_id.as_deref(), Some("z-ai/glm-5"));
    assert!(catalog
        .providers
        .iter()
        .find(|provider| provider.id == "anthropic")
        .unwrap()
        .models
        .is_none());
}

#[tokio::test]
async fn custom_provider_session_runs_on_its_configured_harness() {
    let claude = MockHarness::new(LocalChatHarnessKind::Claude);
    let codex = MockHarness::new(LocalChatHarnessKind::Codex);
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(claude.clone()),
        Arc::new(codex.clone()),
    ])
    .with_provider_profiles_for_tests(custom_profiles());

    let mut input = create_input(LocalChatHarnessKind::Codex, "backend-local");
    input.provider_id = Some("local".into());
    manager
        .create_session_with_runtime(input, LocalChatRuntime::inert_for_tests())
        .await
        .expect("custom Codex provider should route to Codex");

    let MockCall::Create(created) = &codex.calls()[0] else {
        panic!("expected a create call");
    };
    let provider = created
        .provider
        .as_ref()
        .expect("custom provider selection");
    assert_eq!(provider.id.as_str(), "local");
    assert_eq!(provider.profile.harness, StepHarness::Codex);
    assert!(claude.calls().is_empty());

    for (harness, provider_id, expected) in [
        (
            LocalChatHarnessKind::Claude,
            "local",
            "configured for the codex harness",
        ),
        (
            LocalChatHarnessKind::Claude,
            "staging",
            "configured for the typesafe harness",
        ),
        (LocalChatHarnessKind::Claude, "bedrock", "not configured"),
        (
            LocalChatHarnessKind::Claude,
            "openai",
            "does not run on the claude harness",
        ),
    ] {
        let mut input = create_input(harness, &format!("backend-{provider_id}"));
        input.provider_id = Some(provider_id.into());
        let error = manager
            .create_session_with_runtime(input, LocalChatRuntime::inert_for_tests())
            .await
            .expect_err("mismatched provider must fail");
        assert!(
            error.to_string().contains(expected),
            "{provider_id}: {error}"
        );
    }
}

#[test]
fn provider_selection_falls_back_to_default_model_with_warning() {
    let selection = LocalChatProviderSelection {
        id: ProviderId::new("openrouter").unwrap(),
        profile: custom_profiles()[&ProviderId::new("openrouter").unwrap()].clone(),
    };
    assert_eq!(
        selection.resolve_model(Some("moonshotai/kimi-k2")),
        ("moonshotai/kimi-k2".to_string(), None)
    );
    assert_eq!(
        selection.resolve_model(None),
        ("z-ai/glm-5".to_string(), None)
    );
    let (model, warning) = selection.resolve_model(Some("sonnet"));
    assert_eq!(model, "z-ai/glm-5");
    assert!(warning.unwrap().contains("sonnet"));
}

#[tokio::test]
async fn manager_routes_create_send_and_close_through_registry() {
    let claude = MockHarness::new(LocalChatHarnessKind::Claude);
    let codex = MockHarness::new(LocalChatHarnessKind::Codex);
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(claude.clone()),
        Arc::new(codex.clone()),
    ]);

    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "backend-claude"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("Claude create should route");
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "backend-codex"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("Codex create should route");

    manager
        .send_message("backend-claude", "message to claude")
        .await
        .expect("Claude send should route by backend session id");
    manager
        .send_message("backend-codex", "message to codex")
        .await
        .expect("Codex send should route by backend session id");
    manager
        .close_session("backend-claude")
        .await
        .expect("Claude close should route by backend session id");

    let claude_calls = claude.calls();
    assert_eq!(
        claude_calls,
        vec![
            MockCall::Create(HarnessCreateSessionInput {
                backend_session_id: "backend-claude".to_string(),
                working_dir: Some("/tmp/project".to_string()),
                initial_prompt: Some("hello".to_string()),
                provider_resume_id: Some("provider-resume-1".to_string()),
                model_id: Some("model-1".to_string()),
                reasoning_effort: Some("high".to_string()),
                speed_tier: None,
                permission_mode: None,
                personality: None,
                provider: None,
                gate: None,
            }),
            MockCall::Send {
                backend_session_id: "backend-claude".to_string(),
                content: "message to claude".to_string(),
            },
            MockCall::Close {
                backend_session_id: "backend-claude".to_string(),
            },
        ]
    );

    let codex_calls = codex.calls();
    assert_eq!(
        codex_calls,
        vec![
            MockCall::Create(HarnessCreateSessionInput {
                backend_session_id: "backend-codex".to_string(),
                working_dir: Some("/tmp/project".to_string()),
                initial_prompt: Some("hello".to_string()),
                provider_resume_id: Some("provider-resume-1".to_string()),
                model_id: Some("model-1".to_string()),
                reasoning_effort: Some("high".to_string()),
                speed_tier: None,
                permission_mode: None,
                personality: None,
                provider: None,
                gate: None,
            }),
            MockCall::Send {
                backend_session_id: "backend-codex".to_string(),
                content: "message to codex".to_string(),
            },
        ]
    );
}

#[tokio::test]
async fn close_all_sessions_drops_registry_when_provider_close_fails() {
    let harness = MockHarness::new(LocalChatHarnessKind::Codex)
        .fail_close(LocalChatSessionError::StartFailed("close timed out".into()));
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(harness)]);

    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "ghost-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("session should be registered");

    manager.close_all_sessions().await;

    assert!(
        !manager.has_session("ghost-session").await,
        "failed close must still drop live ownership"
    );
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "ghost-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("the same conversation id must be recreatable after a failed close");
}

#[tokio::test]
async fn close_all_sessions_closes_transient_ownership_and_can_be_reused() {
    let claude = MockHarness::new(LocalChatHarnessKind::Claude);
    let codex = MockHarness::new(LocalChatHarnessKind::Codex);
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(claude.clone()),
        Arc::new(codex.clone()),
    ]);

    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "project-a-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("first project session should be registered");
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "project-a-codex"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("second project session should be registered");

    manager.close_all_sessions().await;

    assert_eq!(
        manager.send_message("project-a-session", "stale").await,
        Err(LocalChatSessionError::SessionNotFound(
            "project-a-session".to_string()
        ))
    );
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "project-b-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("manager should accept sessions after a project switch");

    assert_eq!(
        claude
            .calls()
            .into_iter()
            .filter(|call| matches!(call, MockCall::Close { .. }))
            .count(),
        1
    );
    assert_eq!(
        codex
            .calls()
            .into_iter()
            .filter(|call| matches!(call, MockCall::Close { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn project_switch_guard_blocks_new_session_creation_until_boundary_finishes() {
    let manager = Arc::new(LocalChatSessionManager::with_harnesses_for_tests(vec![
        Arc::new(MockHarness::new(LocalChatHarnessKind::Claude)),
    ]));
    let project_switch = manager.begin_project_switch().await;
    let manager_for_create = Arc::clone(&manager);
    let mut create = tokio::spawn(async move {
        manager_for_create
            .create_session_with_runtime(
                create_input(LocalChatHarnessKind::Claude, "after-switch"),
                LocalChatRuntime::inert_for_tests(),
            )
            .await
    });

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut create)
            .await
            .is_err(),
        "session creation must wait while the project switch guard is held"
    );
    drop(project_switch);
    create
        .await
        .expect("creation task should join")
        .expect("creation should proceed after the project switch boundary");
}

#[tokio::test]
async fn close_all_sessions_denies_pending_controls_before_provider_close() {
    let bridge = PermissionBridge::new();
    let harness = MockHarness::new(LocalChatHarnessKind::Codex);
    let manager = LocalChatSessionManager::with_harnesses_and_permission_bridge(
        vec![Arc::new(harness.clone())],
        bridge.clone(),
    );
    let response = bridge.queue_harness_control_for_tests(
        "control-session",
        ControlRequestEnvelope {
            request_id: ControlRequestId::new("control-request"),
            session_id: Some(SessionId::new("control-session")),
            turn_id: None,
            thread_id: None,
            is_root: Some(true),
            request: ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::CommandExecution,
                title: "Run command".into(),
                details: None,
                modification_supported: false,
            }),
            presentation: None,
            timeout_ms: None,
            automatic_resolution: None,
        },
    );
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "control-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("control session should be registered");

    manager.close_all_sessions().await;

    let decision = response.await.expect("close should resolve the control");
    assert_eq!(decision.behavior, "deny");
    assert!(decision
        .message
        .as_deref()
        .is_some_and(|message| message.contains("project")));
    assert_eq!(
        bridge.pending_harness_control_count_for_session("control-session"),
        0
    );
}

#[tokio::test]
async fn shutdown_reuses_close_all_sessions_and_is_idempotent() {
    let claude = MockHarness::new(LocalChatHarnessKind::Claude);
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(claude.clone())]);
    manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "shutdown-session"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .expect("shutdown session should be registered");

    manager.shutdown().await;
    manager.shutdown().await;

    assert_eq!(
        claude
            .calls()
            .into_iter()
            .filter(|call| matches!(call, MockCall::Close { .. }))
            .count(),
        1
    );

    assert_eq!(
        manager
            .create_session_with_runtime(
                create_input(LocalChatHarnessKind::Claude, "after-shutdown"),
                LocalChatRuntime::inert_for_tests(),
            )
            .await,
        Err(LocalChatSessionError::StartFailed(
            "cannot create a local chat session while the application is shutting down".into(),
        ))
    );
}

#[tokio::test]
async fn failed_create_does_not_leave_stale_registry_entry() {
    let failing = MockHarness::new(LocalChatHarnessKind::Claude).fail_create(
        LocalChatSessionError::SpawnFailed("mock spawn failed".to_string()),
    );
    let manager =
        LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(failing.clone())]);

    let result = manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "backend-failed"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await;

    assert_eq!(
        result,
        Err(LocalChatSessionError::SpawnFailed(
            "mock spawn failed".to_string()
        ))
    );
    assert_eq!(
        manager.send_message("backend-failed", "hello").await,
        Err(LocalChatSessionError::SessionNotFound(
            "backend-failed".to_string()
        ))
    );
    assert_eq!(failing.calls().len(), 1);
}

#[tokio::test]
async fn unsupported_harness_returns_before_spawning() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(
        MockHarness::new(LocalChatHarnessKind::Claude),
    )]);

    let result = manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Codex, "backend-codex"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await;

    assert_eq!(
        result,
        Err(LocalChatSessionError::UnsupportedHarness(
            LocalChatHarnessKind::Codex
        ))
    );
}

#[tokio::test]
async fn unavailable_harness_returns_before_calling_create() {
    let unavailable =
        MockHarness::new(LocalChatHarnessKind::Claude).unavailable("Claude binary missing");
    let manager =
        LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(unavailable.clone())]);

    let result = manager
        .create_session_with_runtime(
            create_input(LocalChatHarnessKind::Claude, "backend-claude"),
            LocalChatRuntime::inert_for_tests(),
        )
        .await;

    assert_eq!(
        result,
        Err(LocalChatSessionError::UnavailableHarness {
            harness: LocalChatHarnessKind::Claude,
            reason: Some("Claude binary missing".to_string()),
        })
    );
    assert!(unavailable.calls().is_empty());
}

fn gate() -> crate::local_chat::LocalChatGateBinding {
    crate::local_chat::LocalChatGateBinding {
        task_run_id: "run-1".into(),
        step_name: "approve".into(),
        execution_id: "exec-1".into(),
        artifact: "approval".into(),
        role: None,
        question: None,
        output_schema: None,
        revision: None,
        draftable: None,
        draft: None,
        fields: None,
    }
}

#[tokio::test]
async fn gate_sessions_bind_their_submission_until_closed() {
    let bridge = PermissionBridge::new();
    let harness = Arc::new(MockHarness::new(LocalChatHarnessKind::Codex));
    let manager = LocalChatSessionManager::with_harnesses_and_permission_bridge(
        vec![harness.clone()],
        bridge.clone(),
    );
    let mut input = create_input(LocalChatHarnessKind::Codex, "backend-gate");
    input.gate = Some(gate());

    manager
        .create_session_with_runtime(
            input,
            LocalChatRuntime::inert_with_permission_bridge_for_tests(bridge.clone()),
        )
        .await
        .expect("gate session should start");

    assert!(bridge.has_gate_binding("backend-gate"));
    assert!(matches!(
        harness.calls().as_slice(),
        [MockCall::Create(HarnessCreateSessionInput {
            gate: Some(_),
            ..
        })]
    ));

    manager.close_session("backend-gate").await.unwrap();
    assert!(!bridge.has_gate_binding("backend-gate"));
}

#[tokio::test]
async fn refreshing_a_gate_rebinds_it_and_sends_the_updated_hidden_protocol() {
    let bridge = PermissionBridge::new();
    let harness = Arc::new(MockHarness::new(LocalChatHarnessKind::Codex));
    let manager = LocalChatSessionManager::with_harnesses_and_permission_bridge(
        vec![harness.clone()],
        bridge.clone(),
    );
    let mut input = create_input(LocalChatHarnessKind::Codex, "backend-gate");
    input.gate = Some(gate());
    manager
        .create_session_with_runtime(
            input,
            LocalChatRuntime::inert_with_permission_bridge_for_tests(bridge),
        )
        .await
        .unwrap();

    let updated = crate::local_chat::LocalChatGateBinding {
        execution_id: "exec-2".into(),
        role: None,
        question: Some("Updated question?".into()),
        ..gate()
    };
    let sent = manager
        .refresh_gate("backend-gate", updated)
        .await
        .expect("gate refresh should send");
    assert!(sent);

    let calls = harness.calls();
    let Some(MockCall::Send { content, .. }) = calls.last() else {
        panic!("expected a gate refresh send, got {calls:?}");
    };
    assert!(content.starts_with("<vertebrae-hidden-turn>"));
    assert!(content.contains("exec-2"));
    assert!(content.contains("Updated question?"));
}

#[tokio::test]
async fn refreshing_a_gate_twice_for_the_same_execution_sends_one_turn() {
    let bridge = PermissionBridge::new();
    let harness = Arc::new(MockHarness::new(LocalChatHarnessKind::Claude));
    let manager = LocalChatSessionManager::with_harnesses_and_permission_bridge(
        vec![harness.clone()],
        bridge.clone(),
    );
    let mut input = create_input(LocalChatHarnessKind::Claude, "backend-gate");
    input.gate = Some(gate());
    manager
        .create_session_with_runtime(
            input,
            LocalChatRuntime::inert_with_permission_bridge_for_tests(bridge),
        )
        .await
        .unwrap();

    let revision = crate::local_chat::LocalChatGateBinding {
        execution_id: "exec-2".into(),
        revision: Some(crate::local_chat::LocalChatGateRevision {
            attempt: 2,
            verdict: Some(serde_json::json!({ "reasons": "Missing rollback plan" })),
        }),
        ..gate()
    };
    let mut sent = Vec::new();
    for binding in [revision.clone(), revision, gate()] {
        sent.push(
            manager
                .refresh_gate("backend-gate", binding)
                .await
                .expect("gate refresh should succeed"),
        );
    }
    assert_eq!(sent, [true, false, true]);

    let sends = harness
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            MockCall::Send { content, .. } => Some(content),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(sends.len(), 2, "one turn per new execution: {sends:?}");
    assert!(sends[0].starts_with("<vertebrae-hidden-turn>\n[Vertebrae evaluation]"));
    assert!(sends[0].contains("Missing rollback plan"));
    assert!(sends[1].contains("exec-1"));
}

#[tokio::test]
async fn failed_gate_session_start_drops_the_binding() {
    let bridge = PermissionBridge::new();
    let manager = LocalChatSessionManager::with_harnesses_and_permission_bridge(
        vec![Arc::new(
            MockHarness::new(LocalChatHarnessKind::Claude)
                .fail_create(LocalChatSessionError::StartFailed("boom".into())),
        )],
        bridge.clone(),
    );
    let mut input = create_input(LocalChatHarnessKind::Claude, "backend-gate");
    input.gate = Some(gate());

    let result = manager
        .create_session_with_runtime(
            input,
            LocalChatRuntime::inert_with_permission_bridge_for_tests(bridge.clone()),
        )
        .await;

    assert!(result.is_err());
    assert!(!bridge.has_gate_binding("backend-gate"));
}

#[tokio::test]
async fn new_sessions_and_catalogs_reload_without_mutating_existing_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    let profile = |model: &str, endpoint: &str, key: &str| {
        format!("[providers.dynamic]\nharness = 'codex'\nmodels = ['{model}']\nbase_url = '{endpoint}'\napi_key = '{key}'\n")
    };
    std::fs::write(
        &path,
        profile("old-model", "http://localhost:8001", "old-key"),
    )
    .unwrap();
    let harness = Arc::new(MockHarness::new(LocalChatHarnessKind::Codex));
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![harness.clone()])
        .with_provider_config_path_for_tests(path.clone());
    let mut first = create_input(LocalChatHarnessKind::Codex, "first");
    first.provider_id = Some("dynamic".into());
    manager
        .create_session_with_runtime(first, LocalChatRuntime::inert_for_tests())
        .await
        .unwrap();
    std::fs::write(
        &path,
        profile("new-model", "http://localhost:8002", "new-key"),
    )
    .unwrap();
    let catalog = manager.catalog().await.unwrap();
    let dynamic = catalog
        .providers
        .iter()
        .find(|provider| provider.id == "dynamic")
        .unwrap();
    assert_eq!(dynamic.models.as_ref().unwrap()[0].id, "new-model");
    let mut second = create_input(LocalChatHarnessKind::Codex, "second");
    second.provider_id = Some("dynamic".into());
    manager
        .create_session_with_runtime(second, LocalChatRuntime::inert_for_tests())
        .await
        .unwrap();
    let calls = harness.calls();
    let MockCall::Create(first) = &calls[0] else {
        panic!("expected first create")
    };
    let MockCall::Create(second) = &calls[1] else {
        panic!("expected second create")
    };
    let first = &first.provider.as_ref().unwrap().profile;
    let second = &second.provider.as_ref().unwrap().profile;
    assert_eq!(first.models, vec!["old-model"]);
    assert_eq!(first.api_key.as_deref(), Some("old-key"));
    assert_eq!(first.base_url.as_deref(), Some("http://localhost:8001"));
    assert_eq!(second.models, vec!["new-model"]);
    assert_eq!(second.api_key.as_deref(), Some("new-key"));
    assert_eq!(second.base_url.as_deref(), Some("http://localhost:8002"));
    std::fs::write(&path, "api_key = 'secret-that-must-not-leak\n").unwrap();
    assert!(manager.catalog().await.is_err());
    let mut invalid = create_input(LocalChatHarnessKind::Codex, "invalid");
    invalid.provider_id = Some("dynamic".into());
    let error = manager
        .create_session_with_runtime(invalid, LocalChatRuntime::inert_for_tests())
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("secret-that-must-not-leak"));
    manager.send_message("first", "still active").await.unwrap();
    assert!(
        matches!(harness.calls().last(), Some(MockCall::Send { backend_session_id, .. }) if backend_session_id == "first")
    );
    std::fs::write(
        &path,
        profile("recovered", "http://localhost:8003", "recovered-key"),
    )
    .unwrap();
    assert!(manager
        .catalog()
        .await
        .unwrap()
        .providers
        .iter()
        .any(|provider| provider.id == "dynamic"));
}

#[tokio::test]
async fn live_chat_session_ids_map_registered_runtimes_to_chat_sessions() {
    let manager = LocalChatSessionManager::with_harnesses_for_tests(vec![Arc::new(
        MockHarness::new(LocalChatHarnessKind::Claude),
    )]);
    manager
        .create_session_with_runtime(
            create_input(
                LocalChatHarnessKind::Claude,
                "local-chat-1700000000000-abc1234-1700000000123",
            ),
            LocalChatRuntime::inert_for_tests(),
        )
        .await
        .unwrap();

    let live = manager.live_chat_session_ids().await;

    assert_eq!(
        live,
        std::collections::HashSet::from(["chat-1700000000000-abc1234".to_string()])
    );
}

#[test]
fn runtime_ids_without_the_local_chat_shape_map_to_no_chat_session() {
    assert_eq!(
        chat_session_id_of_runtime("local-local-chat-codex-thread_1-42"),
        Some("local-chat-codex-thread_1")
    );
    assert_eq!(chat_session_id_of_runtime("local--42"), None);
    assert_eq!(chat_session_id_of_runtime("local-chat-1-abc"), None);
    assert_eq!(chat_session_id_of_runtime("remote-chat-1-42"), None);
    assert_eq!(chat_session_id_of_runtime("local-chat-"), None);
}
