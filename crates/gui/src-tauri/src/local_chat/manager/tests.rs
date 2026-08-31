use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vertebrae_harness_core::{
    ApprovalCategory, ApprovalRequest, ControlRequest, ControlRequestEnvelope, ControlRequestId,
    SessionId,
};

use super::*;
use crate::local_chat::{HarnessCreateSessionInput, LocalChatHarnessInfo, LocalChatModelOption};

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
    calls: Arc<Mutex<Vec<MockCall>>>,
}

impl MockHarness {
    fn new(kind: LocalChatHarnessKind) -> Self {
        Self {
            kind,
            available: true,
            unavailable_reason: None,
            fail_create: None,
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
    let catalog = manager.catalog().await;

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
        manager.catalog().await.default_harness,
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
        manager.catalog().await.default_harness,
        LocalChatHarnessKind::Claude
    );
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
            }),
            MockCall::Send {
                backend_session_id: "backend-codex".to_string(),
                content: "message to codex".to_string(),
            },
        ]
    );
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
