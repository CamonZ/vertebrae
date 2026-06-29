use std::sync::{Arc, Mutex};

use async_trait::async_trait;

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

    fn info(&self) -> LocalChatHarnessInfo {
        LocalChatHarnessInfo {
            harness: self.kind,
            label: format!("{:?}", self.kind),
            available: self.available,
            unavailable_reason: self.unavailable_reason.clone(),
            default_model_id: Some("default-model".to_string()),
            models: vec![LocalChatModelOption {
                id: "default-model".to_string(),
                label: "Default Model".to_string(),
            }],
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
        permission_mode: None,
    }
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
                permission_mode: None,
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
                permission_mode: None,
            }),
            MockCall::Send {
                backend_session_id: "backend-codex".to_string(),
                content: "message to codex".to_string(),
            },
        ]
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
