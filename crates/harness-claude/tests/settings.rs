#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};

use tempfile::TempDir;
use vertebrae_harness_claude::{ClaudePermissionMode, ClaudeProviderConfig, ClaudeRuntime};
use vertebrae_harness_core::{
    ControlRequestEnvelope, ControlResolution, ControlSink, EventSink, HarnessError,
    HarnessEventV1, HarnessRuntime, PermissionMode, RequestConfig, SendTurnRequest, SessionHandle,
    SessionId, SessionMode, SpeedTier, StartSessionRequest, StreamId, TurnId, TurnSettings,
};

struct Sink;
#[async_trait::async_trait]
impl EventSink for Sink {
    async fn emit(&self, _: HarnessEventV1) -> Result<(), HarnessError> {
        Ok(())
    }
}
#[async_trait::async_trait]
impl ControlSink for Sink {
    async fn request(&self, _: ControlRequestEnvelope) -> Result<ControlResolution, HarnessError> {
        panic!("fixture does not request permissions")
    }
}

async fn session(temp: &TempDir, mode: &str) -> Arc<dyn SessionHandle> {
    let executable = temp.path().join("claude");
    fs::write(&executable, r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$FIXTURE/capture"
  case "$line" in
    *'"type":"control_request"'*)
      if [ "$MODE" = "delay" ]; then
        while [ ! -f "$FIXTURE/release" ]; do sleep 0.01; done
      fi
      if [ "$MODE" = "timeout" ]; then continue; fi
      id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      case "$line" in
        *'"set_permission_mode"'*)
          if [ "$MODE" = "reject-permission" ]; then
            printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"permission rejected"}}\n' "$id"
            continue
          fi
          ;;
        *'"effortLevel"'*)
          if [ "$MODE" = "reject" ] && [ ! -f "$FIXTURE/rejected" ]; then
            touch "$FIXTURE/rejected"
            printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"effort rejected"}}\n' "$id"
            continue
          fi
      esac
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$id"
      ;;
    *'"type":"user"'*)
      printf '%s\n' '{"type":"system","subtype":"init","session_id":"conversation","model":"sonnet","transcript_path":"opaque://fixture"}'
      printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
      ;;
  esac
done
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = ClaudeProviderConfig {
        executable: Some(executable),
        permission_mode: Some(ClaudePermissionMode::BypassPermissions),
        initialization_timeout: if mode == "timeout" {
            Duration::from_millis(100)
        } else {
            Duration::from_secs(3)
        },
        ..Default::default()
    };
    config
        .environment
        .insert("FIXTURE".into(), temp.path().to_string_lossy().into_owned());
    config.environment.insert("MODE".into(), mode.into());
    ClaudeRuntime::new(config)
        .start_session(
            StartSessionRequest {
                session_id: SessionId::new("execution"),
                stream_id: StreamId::new("stream"),
                mode: SessionMode::Resume("conversation".into()),
                config: RequestConfig {
                    model: Some("haiku".into()),
                    reasoning_effort: Some("high".into()),
                    speed_tier: Some(SpeedTier::Default),
                    ..Default::default()
                },
            },
            Arc::new(Sink),
            Arc::new(Sink),
        )
        .await
        .unwrap()
}

fn request(id: &str) -> SendTurnRequest {
    SendTurnRequest {
        turn_id: TurnId::new(id),
        content: "must use selected settings".into(),
        output_schema: None,
        settings: TurnSettings {
            model: Some("sonnet".into()),
            reasoning_effort: Some("low".into()),
            permission_mode: Some(PermissionMode::Plan),
            speed_tier: Some(SpeedTier::Fast),
        },
    }
}

fn captured(temp: &TempDir) -> Vec<serde_json::Value> {
    fs::read_to_string(temp.path().join("capture"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn wait_for_request(temp: &TempDir) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while captured(temp).is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn settings_are_acknowledged_before_the_prompt_and_unchanged_values_are_not_resent() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp, "delay").await;
    let sender = session.clone();
    let send = tokio::spawn(async move { sender.send(request("first")).await });
    wait_for_request(&temp).await;
    assert!(!send.is_finished());
    assert!(
        captured(&temp)
            .iter()
            .all(|record| record["type"] != "user")
    );
    fs::write(temp.path().join("release"), "").unwrap();
    let turn = send.await.unwrap().unwrap();
    turn.await_outcome().await.unwrap();
    let first = captured(&temp);
    assert_eq!(first.len(), 5);
    assert!(
        first[..4]
            .iter()
            .all(|record| record["type"] == "control_request")
    );
    assert_eq!(first[4]["type"], "user");
    assert_eq!(first[4]["session_id"], "conversation");
    assert!(
        first
            .iter()
            .any(|record| record["request"]["settings"]["fastMode"] == true)
    );
    session
        .send(request("second"))
        .await
        .unwrap()
        .await_outcome()
        .await
        .unwrap();
    assert_eq!(
        captured(&temp).len(),
        6,
        "unchanged settings send only a prompt"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn partial_rejection_keeps_the_prompt_unsent_and_retries_only_unconfirmed_fields() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp, "reject").await;
    let error = match session.send(request("first")).await {
        Err(error) => error,
        Ok(_) => panic!("settings rejection must reject the send"),
    };
    assert!(error.to_string().contains("effort rejected"));
    let first = captured(&temp);
    assert_eq!(first.len(), 4);
    assert!(
        first
            .iter()
            .all(|record| record["type"] == "control_request")
    );
    // Reusing the caller's turn id must still create a fresh attempt id.
    session
        .send(request("first"))
        .await
        .unwrap()
        .await_outcome()
        .await
        .unwrap();
    let retry = captured(&temp);
    assert_eq!(retry.len(), 6);
    assert_eq!(retry[4]["request"]["settings"]["effortLevel"], "low");
    assert_ne!(retry[2]["request_id"], retry[4]["request_id"]);
    assert_eq!(retry[5]["type"], "user");
    session.close().await.unwrap();
}

#[tokio::test]
async fn missing_acknowledgement_rejects_the_unsent_message_and_closes_the_uncertain_session() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp, "timeout").await;
    let send = tokio::time::timeout(Duration::from_secs(3), session.send(request("first")))
        .await
        .unwrap();
    let error = match send {
        Err(error) => error,
        Ok(_) => panic!("missing acknowledgement must reject send"),
    };
    assert!(error.to_string().contains("timed out"));
    assert!(
        captured(&temp)
            .iter()
            .all(|record| record["type"] != "user")
    );
    assert!(session.send(request("second")).await.is_err());
    session.close().await.unwrap();
}

#[tokio::test]
async fn close_remains_responsive_while_settings_are_pending() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp, "timeout").await;
    let sender = session.clone();
    let send = tokio::spawn(async move { sender.send(request("first")).await });
    wait_for_request(&temp).await;
    tokio::time::timeout(Duration::from_secs(3), session.close())
        .await
        .unwrap()
        .unwrap();
    assert!(send.await.unwrap().is_err());
    assert!(
        captured(&temp)
            .iter()
            .all(|record| record["type"] != "user")
    );
}

#[tokio::test]
async fn rejected_permission_change_never_sends_the_prompt_under_the_previous_mode() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp, "reject-permission").await;
    let result = session.send(request("first")).await;
    assert!(matches!(result, Err(error) if error.to_string().contains("permission rejected")));
    let records = captured(&temp);
    assert_eq!(records.len(), 4);
    assert!(
        records
            .iter()
            .all(|record| record["type"] == "control_request")
    );
    session.close().await.unwrap();
}
