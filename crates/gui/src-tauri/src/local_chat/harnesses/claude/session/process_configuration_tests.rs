use super::*;
use crate::types::PermissionMode;

#[test]
fn persistent_process_keeps_existing_transport_resume_and_cwd_with_plugin_root() {
    let working_dir = tempfile::tempdir().expect("create working directory");
    let plugin_root = vertebrae_installer::data_dir().expect("resolve app-data root");
    let mcp_config = r#"{"mcpServers":{"vtb-gate":{"command":"/absolute/bin/vtb-gate"}}}"#;
    let args = build_claude_args(
        mcp_config,
        Some("conversation-123"),
        Some("opus"),
        Some(PermissionMode::Plan),
        Some(&plugin_root),
    );

    let command = configure_claude_process(
        Path::new("/absolute/bin/claude"),
        &args,
        working_dir.path(),
        "/augmented/bin:/usr/bin",
        "backend-session-123",
    );
    let configured_args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    assert_eq!(configured_args, args);
    assert_eq!(
        command.get_current_dir(),
        Some(working_dir.path()),
        "plugin injection must not replace the selected working directory"
    );
    let configured_env: HashMap<_, _> = command
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key.to_os_string(), value.to_os_string())))
        .collect();
    assert_eq!(
        configured_env.get(std::ffi::OsStr::new("PATH")),
        Some(&std::ffi::OsString::from("/augmented/bin:/usr/bin"))
    );
    assert_eq!(
        configured_env.get(std::ffi::OsStr::new("VTB_CLAUDE_SESSION_ID")),
        Some(&std::ffi::OsString::from("backend-session-123"))
    );

    let plugin_indexes: Vec<_> = configured_args
        .iter()
        .enumerate()
        .filter_map(|(index, arg)| (arg == "--plugin-dir").then_some(index))
        .collect();
    assert_eq!(plugin_indexes.len(), 1);
    assert_eq!(
        configured_args.get(plugin_indexes[0] + 1),
        Some(&plugin_root.to_string_lossy().into_owned())
    );
    assert!(configured_args
        .windows(2)
        .any(|pair| pair == ["--mcp-config", mcp_config]));
    assert!(configured_args.windows(2).any(|pair| pair
        == [
            "--permission-prompt-tool",
            "mcp__vtb-gate__permission_prompt"
        ]));
    assert!(configured_args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "plan"]));
    assert!(configured_args
        .iter()
        .any(|arg| arg == "--resume=conversation-123"));
}

#[cfg(unix)]
#[tokio::test]
async fn configured_persistent_process_receives_plugin_root_and_streams_jsonl() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let tempdir = tempfile::tempdir().expect("create tempdir");
    let binary = tempdir.path().join("fake-claude");
    let captured_args = tempdir.path().join("args.txt");
    let captured_cwd = tempdir.path().join("cwd.txt");
    let captured_stdin = tempdir.path().join("stdin.jsonl");
    std::fs::write(
        &binary,
        r#"#!/bin/sh
printf '%s\n' "$@" > "$CAPTURED_ARGS"
printf '%s\n' "$PWD" > "$CAPTURED_CWD"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"plugin stream ok"}]}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CAPTURED_STDIN"
done
"#,
    )
    .expect("write fake Claude binary");
    let mut permissions = std::fs::metadata(&binary)
        .expect("read fake binary metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&binary, permissions).expect("make fake binary executable");

    let plugin_root = vertebrae_installer::data_dir().expect("resolve app-data root");
    let args = build_claude_args(
        r#"{"mcpServers":{"vtb-gate":{"command":"/absolute/bin/vtb-gate"}}}"#,
        Some("conversation-123"),
        Some("opus"),
        Some(PermissionMode::Plan),
        Some(&plugin_root),
    );
    let mut command = configure_claude_process(
        &binary,
        &args,
        tempdir.path(),
        "/usr/bin:/bin",
        "backend-session-123",
    );
    command.env("CAPTURED_ARGS", &captured_args);
    command.env("CAPTURED_CWD", &captured_cwd);
    command.env("CAPTURED_STDIN", &captured_stdin);

    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let runner = ClaudeLiveJsonlProcessRunner::new(
        "backend-session-123".to_string(),
        command,
        command_rx,
        Box::new(encode_claude_user_jsonl_message),
        Box::new(move |reader, session_id| {
            jsonl::process_jsonl_lines(reader, &session_id, |events| {
                for event in events {
                    let _ = event_tx.send(event);
                }
            });
        }),
        Box::new(|reader, _| for _ in reader.lines() {}),
    )
    .with_initial_prompt(Some("hello from GUI".to_string()));
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(runner.run());
    });

    let started_at = Instant::now();
    while !captured_stdin.exists() && started_at.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(captured_stdin.exists(), "fake Claude should receive stdin");
    match event_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("fake Claude stdout should be streamed")
    {
        EmittedEvent::Text(event) => assert_eq!(event.text, "plugin stream ok"),
        other => panic!("expected streamed text event, got {other:?}"),
    }

    let (response_tx, response_rx) = oneshot::channel();
    command_tx
        .send(ClaudeLiveJsonlCommand::Close {
            response: response_tx,
        })
        .expect("runner should accept Close");
    tokio::time::timeout(Duration::from_secs(2), response_rx)
        .await
        .expect("Close response should not time out")
        .expect("Close response should not be dropped")
        .expect("Close should succeed");
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("runner should finish")
        .expect("runner should not error");

    let actual_args: Vec<_> = std::fs::read_to_string(&captured_args)
        .expect("read captured args")
        .lines()
        .map(ToString::to_string)
        .collect();
    assert_eq!(actual_args, args);
    assert_eq!(
        Path::new(
            std::fs::read_to_string(&captured_cwd)
                .expect("read captured cwd")
                .trim()
        )
        .canonicalize()
        .expect("canonicalize captured cwd"),
        tempdir.path().canonicalize().expect("canonicalize tempdir")
    );
    let input: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(&captured_stdin)
            .expect("read captured stdin")
            .trim(),
    )
    .expect("stdin should contain Claude JSONL");
    assert_eq!(input["session_id"], "backend-session-123");
    assert_eq!(input["message"]["content"], "hello from GUI");
}

#[test]
fn resumed_process_omits_plugin_flag_when_compatibility_check_skips_it() {
    let args = build_claude_args(
        "{}",
        Some("conversation-123"),
        None,
        Some(PermissionMode::Auto),
        None,
    );

    assert!(!args.iter().any(|arg| arg == "--plugin-dir"));
    assert!(args.iter().any(|arg| arg == "--resume=conversation-123"));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "auto"]));
}

#[test]
fn skipped_plugin_resolution_emits_session_warning() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let resolution = ClaudePluginDirResolution {
        plugin_root: None,
        warning: Some("Update Claude Code and copy skills manually".to_string()),
    };

    report_plugin_dir_resolution(&event_sink, "backend-session-123", &resolution);

    assert_eq!(
        events
            .lock()
            .expect("event capture lock should not be poisoned")
            .as_slice(),
        &[LocalChatEvent::Warning(NeutralSessionWarningEvent {
            backend_session_id: "backend-session-123".to_string(),
            harness: LocalChatHarnessKind::Claude,
            warning: "Update Claude Code and copy skills manually".to_string(),
        })]
    );
}
