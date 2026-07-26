use super::*;

fn harness_approval_request(id: &str) -> ControlRequestEnvelope {
    ControlRequestEnvelope {
        request_id: vertebrae_harness_core::ControlRequestId::new(id),
        session_id: Some(vertebrae_harness_core::SessionId::new("provider-session")),
        turn_id: Some(vertebrae_harness_core::TurnId::new("turn-1")),
        request: ControlRequest::Approval(vertebrae_harness_core::ApprovalRequest {
            category: vertebrae_harness_core::ApprovalCategory::CommandExecution,
            title: "Run shell command".into(),
            details: Some(serde_json::json!({
                "tool_name": "Bash",
                "tool_use_id": "tool-control",
                "input": {"command": "pwd"}
            })),
            modification_supported: true,
        }),
        presentation: None,
        timeout_ms: None,
        automatic_resolution: None,
    }
}

#[test]
fn harness_control_allow_and_deny_preserve_gui_and_neutral_shapes() {
    let request = harness_approval_request("allow-control");
    let event = harness_permission_event("backend-control", &request).unwrap();
    assert_eq!(event.session_id.as_deref(), Some("backend-control"));
    assert_eq!(event.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(event.thread_id, None);
    assert!(event.is_root);
    assert_eq!(event.tool_name, "Bash");
    assert_eq!(event.tool_use_id, "tool-control");
    assert_eq!(event.input, serde_json::json!({"command": "pwd"}));

    let allow = local_decision_to_control_resolution(
        &request,
        LocalPermissionDecision {
            behavior: "allow".into(),
            message: None,
            updated_input: None,
        },
    )
    .unwrap();
    assert_eq!(allow.decision, Some(ControlDecision::AllowOnce));

    let deny = local_decision_to_control_resolution(
        &harness_approval_request("deny-control"),
        LocalPermissionDecision {
            behavior: "deny".into(),
            message: Some("not allowed".into()),
            updated_input: None,
        },
    )
    .unwrap();
    assert_eq!(deny.decision, Some(ControlDecision::Deny));
    assert_eq!(deny.message.as_deref(), Some("not allowed"));
}

#[test]
fn harness_question_control_preserves_ui_shape_and_returns_exact_answer() {
    let request = ControlRequestEnvelope {
        request_id: vertebrae_harness_core::ControlRequestId::new("question-control"),
        session_id: Some(vertebrae_harness_core::SessionId::new("provider-session")),
        turn_id: Some(vertebrae_harness_core::TurnId::new("turn-1")),
        request: ControlRequest::UserQuestion {
            questions: vec![vertebrae_harness_core::UserQuestion {
                id: "environment".into(),
                prompt: "Which environment?".into(),
                header: Some("Environment".into()),
                options: vec![vertebrae_harness_core::QuestionOption {
                    id: "staging".into(),
                    label: "Staging".into(),
                    description: Some("Use staging".into()),
                }],
                multiple: false,
                free_form: true,
            }],
        },
        presentation: Some(vertebrae_harness_core::ControlPresentation {
            tool_name: Some("AskUserQuestion".into()),
            tool_call_id: Some(vertebrae_harness_core::ToolCallId::new("tool-question")),
            input: Some(serde_json::json!({
                "questions": [{
                    "question": "Which environment?",
                    "header": "Environment",
                    "options": [{"label": "Staging", "description": "Use staging"}],
                    "multiSelect": false
                }]
            })),
            message: Some("AskUserQuestion needs approval".into()),
        }),
        timeout_ms: Some(30_000),
        automatic_resolution: None,
    };
    let event = harness_permission_event("backend-control", &request).unwrap();
    assert_eq!(event.tool_name, "AskUserQuestion");
    assert_eq!(event.tool_use_id, "tool-question");
    assert_eq!(
        event.input,
        request
            .presentation
            .as_ref()
            .unwrap()
            .input
            .clone()
            .unwrap()
    );
    assert_eq!(
        event.message.as_deref(),
        Some("AskUserQuestion needs approval")
    );
    let questions = event.questions.unwrap();
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0].question, "Which environment?");
    assert_eq!(questions[0].header, "Environment");
    assert_eq!(questions[0].options[0].label, "Staging");
    assert!(!questions[0].multi_select);

    let resolution = local_decision_to_control_resolution(
        &request,
        LocalPermissionDecision {
            behavior: "allow".into(),
            message: None,
            updated_input: Some(serde_json::json!({
                "answers": {"Which environment?": "Staging"}
            })),
        },
    )
    .unwrap();
    assert!(
        matches!(resolution.decision, Some(ControlDecision::QuestionsAnswered(answers))
        if answers.len() == 1
            && answers[0].question_id == "environment"
            && answers[0].free_form.as_deref() == Some("Staging"))
    );
}

#[tokio::test]
async fn invalid_harness_question_answer_remains_pending_for_retry() {
    let bridge = PermissionBridge::new();
    let request = ControlRequestEnvelope {
        request_id: vertebrae_harness_core::ControlRequestId::new("retry-question"),
        session_id: Some(vertebrae_harness_core::SessionId::new("provider-session")),
        turn_id: None,
        request: ControlRequest::UserQuestion {
            questions: vec![vertebrae_harness_core::UserQuestion {
                id: "environment".into(),
                prompt: "Which environment?".into(),
                header: Some("Environment".into()),
                options: Vec::new(),
                multiple: false,
                free_form: true,
            }],
        },
        presentation: None,
        timeout_ms: None,
        automatic_resolution: None,
    };
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    bridge.pending_harness_controls.lock().unwrap().insert(
        "retry-question".into(),
        PendingHarnessControl {
            session_id: "backend-control".into(),
            request,
            response_tx,
        },
    );

    let invalid = bridge.resolve_permission_request(
        "retry-question",
        LocalPermissionDecision {
            behavior: "allow".into(),
            message: None,
            updated_input: Some(serde_json::json!({"answers": {}})),
        },
    );
    assert!(matches!(invalid, Err(PermissionBridgeError::Invalid(_))));
    assert!(bridge
        .pending_harness_controls
        .lock()
        .unwrap()
        .contains_key("retry-question"));

    bridge
        .resolve_permission_request(
            "retry-question",
            LocalPermissionDecision {
                behavior: "allow".into(),
                message: None,
                updated_input: Some(serde_json::json!({
                    "answers": {"Which environment?": "Staging"}
                })),
            },
        )
        .unwrap();
    let decision = response_rx.await.unwrap();
    assert_eq!(
        decision.updated_input.unwrap()["answers"]["Which environment?"],
        "Staging"
    );
}

#[test]
fn test_resolve_permission_request_sends_local_decision() {
    let bridge = PermissionBridge::new();
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    bridge.pending_permissions.lock().unwrap().insert(
        "req-1".to_string(),
        PendingPermission {
            session_id: "session-1".to_string(),
            tool_name: "Bash".to_string(),
            input: serde_json::json!({ "command": "ls" }),
            response_tx,
        },
    );

    let result = bridge
        .resolve_permission_request(
            "req-1",
            LocalPermissionDecision {
                behavior: "allow".to_string(),
                message: None,
                updated_input: Some(serde_json::json!({ "command": "ls" })),
            },
        )
        .unwrap();

    assert_eq!(result["behavior"], "allow");
    assert!(bridge.pending_permissions.lock().unwrap().is_empty());

    let decision = response_rx.recv().unwrap();
    assert_eq!(decision.behavior, "allow");
    assert_eq!(
        decision.updated_input,
        Some(serde_json::json!({ "command": "ls" }))
    );
}

#[test]
fn test_resolve_permission_request_requires_local_pending_request() {
    let bridge = PermissionBridge::new();
    let result = bridge.resolve_permission_request(
        "missing",
        LocalPermissionDecision {
            behavior: "deny".to_string(),
            message: Some("Denied".to_string()),
            updated_input: None,
        },
    );

    assert_eq!(
        result.unwrap_err(),
        PermissionBridgeError::NotFound("missing".to_string())
    );
}

#[test]
fn test_fail_pending_permissions_for_session_sends_denials() {
    let bridge = PermissionBridge::new();
    let (session_a_tx_1, session_a_rx_1) = std::sync::mpsc::channel();
    let (session_a_tx_2, session_a_rx_2) = std::sync::mpsc::channel();
    let (session_b_tx, session_b_rx) = std::sync::mpsc::channel();

    {
        let mut pending = bridge.pending_permissions.lock().unwrap();
        pending.insert(
            "req-a-1".to_string(),
            PendingPermission {
                session_id: "session-a".to_string(),
                tool_name: "Bash".to_string(),
                input: serde_json::json!({}),
                response_tx: session_a_tx_1,
            },
        );
        pending.insert(
            "req-a-2".to_string(),
            PendingPermission {
                session_id: "session-a".to_string(),
                tool_name: "Bash".to_string(),
                input: serde_json::json!({}),
                response_tx: session_a_tx_2,
            },
        );
        pending.insert(
            "req-b".to_string(),
            PendingPermission {
                session_id: "session-b".to_string(),
                tool_name: "Bash".to_string(),
                input: serde_json::json!({}),
                response_tx: session_b_tx,
            },
        );
    }

    bridge.fail_pending_permissions_for_session(
        "session-a",
        "Claude session ended before the permission request was resolved",
    );

    for receiver in [session_a_rx_1, session_a_rx_2] {
        let decision = receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        assert_eq!(decision.behavior, "deny");
        assert_eq!(
            decision.message.as_deref(),
            Some("Claude session ended before the permission request was resolved")
        );
        assert!(decision.updated_input.is_none());
    }
    assert!(matches!(
        session_b_rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));

    let pending = bridge.pending_permissions.lock().unwrap();
    assert!(!pending.contains_key("req-a-1"));
    assert!(!pending.contains_key("req-a-2"));
    assert!(pending.contains_key("req-b"));
}

#[test]
fn test_local_permission_decision_serializes_for_provider_schema() {
    let allow = serde_json::to_value(LocalPermissionDecision {
        behavior: "allow".to_string(),
        message: None,
        updated_input: Some(serde_json::json!({ "command": "ls" })),
    })
    .unwrap();
    assert_eq!(
        allow,
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": { "command": "ls" }
        })
    );

    let deny = serde_json::to_value(LocalPermissionDecision {
        behavior: "deny".to_string(),
        message: Some("Denied from Vertebrae GUI".to_string()),
        updated_input: None,
    })
    .unwrap();
    assert_eq!(
        deny,
        serde_json::json!({
            "behavior": "deny",
            "message": "Denied from Vertebrae GUI"
        })
    );
}

#[cfg(unix)]
#[test]
fn test_parse_ask_user_question_input_preserves_supported_fields() {
    let input = serde_json::json!({
        "questions": [{
            "question": "Which changes?",
            "header": "Scope",
            "options": [
                { "label": "Backend", "description": "Rust only" },
                { "label": "Frontend", "description": "React only" }
            ],
            "multiSelect": true
        }]
    });

    let questions = parse_ask_user_question_input(&input).unwrap();
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0].question, "Which changes?");
    assert_eq!(questions[0].header, "Scope");
    assert!(questions[0].multi_select);
    assert_eq!(questions[0].options[1].label, "Frontend");
    assert_eq!(questions[0].options[1].description, "React only");
}

#[cfg(unix)]
#[test]
fn test_parse_ask_user_question_input_defaults_missing_multi_select_to_false() {
    let input = serde_json::json!({
        "questions": [{
            "question": "Which target?",
            "header": "Target",
            "options": [{ "label": "Staging", "description": "Test environment" }]
        }]
    });

    let questions = parse_ask_user_question_input(&input).unwrap();
    assert!(!questions[0].multi_select);
}

#[cfg(unix)]
#[test]
fn test_parse_ask_user_question_input_rejects_missing_and_malformed_fields() {
    for input in [
        serde_json::json!({}),
        serde_json::json!({ "questions": [] }),
        serde_json::json!({ "questions": [{
            "question": "Pick",
            "header": "Choice",
            "options": "invalid",
            "multiSelect": false
        }]}),
        serde_json::json!({ "questions": [{
            "question": "Pick",
            "header": "Choice",
            "options": [{ "label": "A" }],
            "multiSelect": false
        }]}),
        serde_json::json!({ "questions": [{
            "question": "Pick",
            "header": "Choice",
            "options": [{ "label": "A", "description": "First" }],
            "multiSelect": "false"
        }]}),
    ] {
        assert!(parse_ask_user_question_input(&input).is_err());
    }
}

#[test]
fn test_ask_user_question_decision_requires_original_questions_and_string_answers() {
    let original = serde_json::json!({
        "questions": [{
            "question": "Choose targets",
            "header": "Targets",
            "options": [],
            "multiSelect": true
        }, {
            "question": "Anything else?",
            "header": "Notes",
            "options": [],
            "multiSelect": false
        }]
    });
    let valid = LocalPermissionDecision {
        behavior: "allow".to_string(),
        message: None,
        updated_input: Some(serde_json::json!({
            "questions": original["questions"].clone(),
            "answers": {
                "Choose targets": "Backend, Frontend",
                "Anything else?": "Keep compatibility"
            }
        })),
    };
    validate_ask_user_question_decision(&original, &valid).unwrap();

    let changed = LocalPermissionDecision {
        updated_input: Some(serde_json::json!({
            "questions": [],
            "answers": {
                "Choose targets": "Backend",
                "Anything else?": "None"
            }
        })),
        ..valid.clone()
    };
    assert!(validate_ask_user_question_decision(&original, &changed)
        .unwrap_err()
        .contains("preserve"));

    let non_string = LocalPermissionDecision {
        updated_input: Some(serde_json::json!({
            "questions": original["questions"].clone(),
            "answers": {
                "Choose targets": ["Backend"],
                "Anything else?": "None"
            }
        })),
        ..valid
    };
    assert!(validate_ask_user_question_decision(&original, &non_string)
        .unwrap_err()
        .contains("must be a string"));
}

#[test]
fn test_invalid_ask_user_question_resolution_remains_retryable() {
    let bridge = PermissionBridge::new();
    let (response_tx, _response_rx) = std::sync::mpsc::channel();
    bridge.pending_permissions.lock().unwrap().insert(
        "req-ask".to_string(),
        PendingPermission {
            session_id: "session-1".to_string(),
            tool_name: ASK_USER_QUESTION_TOOL.to_string(),
            input: serde_json::json!({
                "questions": [{ "question": "Proceed?" }]
            }),
            response_tx,
        },
    );

    let result = bridge.resolve_permission_request(
        "req-ask",
        LocalPermissionDecision {
            behavior: "allow".to_string(),
            message: None,
            updated_input: Some(serde_json::json!({
                "questions": [],
                "answers": { "Proceed?": "Yes" }
            })),
        },
    );

    assert!(matches!(
        result.unwrap_err(),
        PermissionBridgeError::Invalid(message) if message.contains("preserve")
    ));
    assert!(bridge
        .pending_permissions
        .lock()
        .unwrap()
        .contains_key("req-ask"));
}

#[test]
fn test_ask_user_question_resolution_returns_answers_to_same_pending_connection() {
    let bridge = PermissionBridge::new();
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    let questions = serde_json::json!([{
        "question": "Which layers?",
        "header": "Scope",
        "options": [],
        "multiSelect": true
    }]);
    bridge.pending_permissions.lock().unwrap().insert(
        "req-ask".to_string(),
        PendingPermission {
            session_id: "session-1".to_string(),
            tool_name: ASK_USER_QUESTION_TOOL.to_string(),
            input: serde_json::json!({ "questions": questions.clone() }),
            response_tx,
        },
    );

    bridge
        .resolve_permission_request(
            "req-ask",
            LocalPermissionDecision {
                behavior: "allow".to_string(),
                message: None,
                updated_input: Some(serde_json::json!({
                    "questions": questions,
                    "answers": { "Which layers?": "Backend, Frontend" }
                })),
            },
        )
        .unwrap();

    let decision = response_rx.recv().unwrap();
    assert_eq!(decision.behavior, "allow");
    assert_eq!(
        decision.updated_input.unwrap()["answers"]["Which layers?"],
        "Backend, Frontend"
    );
    assert!(bridge.pending_permissions.lock().unwrap().is_empty());
}

#[test]
fn test_disconnected_permission_connection_is_removed_and_reported_unavailable() {
    let bridge = PermissionBridge::new();
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    drop(response_rx);
    bridge.pending_permissions.lock().unwrap().insert(
        "req-disconnected".to_string(),
        PendingPermission {
            session_id: "session-1".to_string(),
            tool_name: "Bash".to_string(),
            input: serde_json::json!({}),
            response_tx,
        },
    );

    let error = bridge
        .resolve_permission_request(
            "req-disconnected",
            LocalPermissionDecision {
                behavior: "deny".to_string(),
                message: Some("Denied".to_string()),
                updated_input: None,
            },
        )
        .unwrap_err();

    assert_eq!(error, PermissionBridgeError::Unavailable);
    assert!(!bridge
        .pending_permissions
        .lock()
        .unwrap()
        .contains_key("req-disconnected"));
}

#[cfg(unix)]
#[test]
fn test_prepare_permission_socket_directory_sets_private_mode() {
    use std::os::unix::fs::PermissionsExt;

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("vtbg-dir-test-{}-{suffix}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);

    PermissionBridge::prepare_permission_socket_directory(&directory).unwrap();

    let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);

    std::fs::remove_dir(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn test_permission_socket_path_stays_under_unix_limit_for_long_session_ids() {
    use std::os::unix::ffi::OsStrExt;

    let session_id = "scoped-chat-1781971607649-bijgbrn-1781971734050-extra-long-session-suffix";
    let path = PermissionBridge::permission_socket_path(session_id);
    let path_len = path.as_os_str().as_bytes().len();

    assert!(
        path_len < MAX_UNIX_SOCKET_PATH_BYTES,
        "socket path should fit Unix sockaddr limits: {:?} ({path_len} bytes)",
        path
    );
    assert!(
        !path.to_string_lossy().contains(session_id),
        "socket path should not embed the raw session id"
    );
}

#[cfg(unix)]
#[test]
fn test_ask_user_question_round_trips_from_socket_event_to_same_connection() {
    use std::io::{BufRead, Write};
    use std::os::unix::net::UnixStream;
    use tauri::Listener;

    let bridge = PermissionBridge::new();
    let manager = crate::local_chat::LocalChatSessionManager::with_permission_bridge_for_tests(
        bridge.clone(),
    );
    let app = tauri::test::mock_app();
    let app_handle = app.handle().clone();
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    app_handle.listen("permission-request-event", move |event| {
        event_tx.send(event.payload().to_string()).unwrap();
    });

    let session_id = format!(
        "round-trip-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let socket_guard = bridge.start_socket(&session_id, app_handle).unwrap();
    let socket_path = socket_guard.path().to_path_buf();
    let questions = serde_json::json!([{
        "question": "Which layers?",
        "header": "Scope",
        "options": [
            { "label": "Backend", "description": "Rust" },
            { "label": "Frontend", "description": "React" }
        ],
        "multiSelect": true
    }]);
    let request_questions = questions.clone();
    let client = std::thread::spawn(move || {
        let mut stream = UnixStream::connect(socket_path).unwrap();
        let request = serde_json::json!({
            "request_id": "req-round-trip",
            "tool_name": ASK_USER_QUESTION_TOOL,
            "tool_use_id": "tool-round-trip",
            "input": { "questions": request_questions }
        });
        writeln!(stream, "{request}").unwrap();
        let mut response = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut response)
            .unwrap();
        serde_json::from_str::<LocalPermissionDecision>(response.trim()).unwrap()
    });

    let event_payload = event_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let event: PermissionRequestEvent = serde_json::from_str(&event_payload).unwrap();
    assert_eq!(event.request_id, "req-round-trip");
    assert_eq!(event.session_id.as_deref(), Some(session_id.as_str()));
    assert_eq!(event.tool_use_id, "tool-round-trip");
    assert_eq!(event.questions.as_ref().unwrap()[0].header, "Scope");
    assert!(event.input_error.is_none());

    crate::commands::resolve_permission_request_inner(
        &manager,
        crate::types::ResolvePermissionRequestInput {
            request_id: event.request_id,
            behavior: crate::types::PermissionDecisionBehavior::Allow,
            message: None,
            updated_input: Some(serde_json::json!({
                "questions": event.input["questions"].clone(),
                "answers": { "Which layers?": "Backend, Frontend" }
            })),
        },
    )
    .unwrap();

    let response = client.join().unwrap();
    assert_eq!(response.behavior, "allow");
    assert_eq!(
        response.updated_input.unwrap(),
        serde_json::json!({
            "questions": questions,
            "answers": { "Which layers?": "Backend, Frontend" }
        })
    );
    assert!(bridge.pending_permissions.lock().unwrap().is_empty());
    drop(socket_guard);
}
