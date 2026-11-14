use super::*;
use std::sync::{Arc, Mutex};
use vertebrae_sacrum_client::SacrumConfig;
use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

fn session(id: &str) -> LocalChatSessionIndexEntry {
    serde_json::from_value(json!({
        "id": id,
        "label": "Legacy conversation",
        "titleUserMessageCount": 1,
        "harness": "codex",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "projectPath": "/local/project",
        "providerResumeId": "provider-resume",
        "messageCount": 2,
        "lifecycle": "idle",
        "status": "open",
        "association": {"ticketId": null, "worktreePath": "/private/worktree", "processedAtCount": 9}
    })).unwrap()
}

fn queue_session(catalog: &mut Catalog, session: &LocalChatSessionIndexEntry) -> Value {
    let id = key("project", &session.id);
    let mut payload = projection(session);
    payload["classifications"] = json!([{
        "tool_id": "a".repeat(64),
        "input_hash": "b".repeat(64),
        "classifier_fingerprint": "c".repeat(64),
        "labels": []
    }]);
    catalog
        .sidecars
        .insert(id.clone(), Sidecar::from_session(session));
    queue(catalog, &id, payload.clone());
    enqueue(catalog, "project", &session.id, payload.clone());
    payload
}

#[tokio::test]
async fn interrupted_readback_retains_sources_then_restart_verifies_and_retires_only_catalog_data()
{
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("local-chat-session-index.json");
    let chat = session("chat");
    let source = json!({"version": 1, "sessions": [&chat]}).to_string();
    fs::write(&index, &source).unwrap();
    let annotations = root.path().join("local-chat-annotations");
    fs::create_dir(&annotations).unwrap();
    let git_record = json!({
        "session_id": "chat", "tool_id": "tool", "kind": "worktree_delta",
        "payload": {"patch": "private patch"}, "recorded_at": "2026-01-01T00:00:00Z"
    })
    .to_string();
    fs::write(annotations.join("chat.jsonl"), &git_record).unwrap();

    #[derive(Default)]
    struct Server {
        entry: Option<Entry>,
        offline: bool,
        writes: usize,
    }
    let server = MockServer::start().await;
    let remote = Arc::new(Mutex::new(Server::default()));
    let model = remote.clone();
    Mock::given(matchers::method("POST"))
        .respond_with(move |request: &wiremock::Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let mut remote = model.lock().unwrap();
            if remote.offline {
                return ResponseTemplate::new(503);
            }
            if body["query"].as_str().unwrap().contains("putChatCatalog") {
                remote.writes += 1;
                let payload: Value =
                    serde_json::from_str(body["variables"]["v"].as_str().unwrap()).unwrap();
                assert!(!payload.to_string().contains("private"));
                remote.entry = Some(Entry {
                    chat_id: "chat".into(),
                    revision: 1,
                    payload,
                });
                let entry = remote.entry.as_ref().unwrap();
                return ResponseTemplate::new(200).set_body_json(json!({
                    "data": {"putChatCatalog": {"status": "accepted", "entry": entry}}
                }));
            }
            ResponseTemplate::new(200).set_body_json(json!({
                "data": {"chatCatalog": {
                    "entries": remote.entry.iter().collect::<Vec<_>>(), "nextCursor": null
                }}
            }))
        })
        .mount(&server)
        .await;
    let client = GraphqlClient::new(SacrumConfig {
        base_url: server.uri(),
        api_token: "fixture".into(),
        project_id: "project".into(),
    });
    let path = root.path().join("catalog.json");
    let mut catalog = Catalog::default();
    let expected = queue_session(&mut catalog, &chat);
    save(&path, &catalog).unwrap();

    exchange(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    remote.lock().unwrap().offline = true;
    assert!(finish(
        &client,
        "project",
        "machine",
        &mut catalog,
        &path,
        root.path()
    )
    .await
    .is_err());
    assert_eq!(fs::read_to_string(&index).unwrap(), source);
    assert!(catalog.migration.verified.is_empty());

    let mut restarted = load(&path).unwrap();
    remote.lock().unwrap().offline = false;
    finish(
        &client,
        "project",
        "machine",
        &mut restarted,
        &path,
        root.path(),
    )
    .await
    .unwrap();

    assert!(!index.exists());
    assert_eq!(remote.lock().unwrap().writes, 1);
    assert_eq!(restarted.records["project/chat"].remote.payload, expected);
    assert_eq!(
        load(&path).unwrap().sidecars["project/chat"],
        Sidecar::from_session(&chat)
    );
    assert!(can_retire(&restarted, &chat));
    let mut recovered = Vec::new();
    hydrate_snapshot(&restarted, "project", "/local/project", &mut recovered);
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].label, "Legacy conversation");
    assert_eq!(
        recovered[0].provider_resume_id.as_deref(),
        Some("provider-resume")
    );
    assert_eq!(
        recovered[0].association.as_ref().unwrap()["worktreePath"],
        "/private/worktree"
    );
    assert_eq!(
        recovered[0].association.as_ref().unwrap()["processedAtCount"],
        9
    );
    assert_eq!(
        restarted.records["project/chat"].remote.payload["classifications"][0]["labels"],
        json!([])
    );
    assert_eq!(
        fs::read_to_string(annotations.join("chat.jsonl")).unwrap(),
        git_record
    );
    assert_eq!(
        inventory_annotations(root.path(), "chat")
            .unwrap()
            .local_only,
        1
    );

    // Crash after checkpointing but before cleanup: retry without a network connection.
    fs::write(&index, &source).unwrap();
    remote.lock().unwrap().offline = true;
    finish(
        &client,
        "project",
        "machine",
        &mut restarted,
        &path,
        root.path(),
    )
    .await
    .unwrap();
    assert!(!index.exists());
}

#[test]
fn reconciliation_refuses_missing_stale_changed_and_pending_records() {
    let mut catalog = Catalog::default();
    let chat = session("chat");
    let payload = queue_session(&mut catalog, &chat);
    let entry = Entry {
        chat_id: "chat".into(),
        revision: 2,
        payload: payload.clone(),
    };
    let snapshot = BTreeMap::from([("chat".into(), entry.clone())]);

    reconcile(&mut catalog, "project", &snapshot);
    assert!(catalog.migration.verified.is_empty());
    let record = catalog.records.get_mut("project/chat").unwrap();
    record.remote = entry.clone();
    record.desired = None;

    reconcile(&mut catalog, "project", &BTreeMap::new());
    assert!(catalog.migration.verified.is_empty());
    let mut wrong = entry.clone();
    wrong.payload["classifications"] = json!([]);
    reconcile(
        &mut catalog,
        "project",
        &BTreeMap::from([("chat".into(), wrong)]),
    );
    assert!(catalog.migration.verified.is_empty());
    let mut stale = entry;
    stale.revision = 1;
    reconcile(
        &mut catalog,
        "project",
        &BTreeMap::from([("chat".into(), stale)]),
    );
    assert!(catalog.migration.verified.is_empty());

    reconcile(&mut catalog, "project", &snapshot);
    assert!(can_retire(&catalog, &chat));
    assert!(catalog.migration.pending.is_empty());
}

#[test]
fn cleanup_preserves_foreign_unmapped_unknown_and_malformed_sources() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("local-chat-session-index.json");
    let mut catalog = Catalog::default();
    let chat = session("chat");
    queue_session(&mut catalog, &chat);
    catalog.migration.version = VERSION;
    catalog.migration.verified.insert("project/chat".into());
    let mut unknown = serde_json::to_value(session("future")).unwrap();
    unknown["futureField"] = json!("retain");
    let foreign = session("foreign");
    let unmapped = session("unmapped");
    let rows = vec![
        serde_json::to_value(&chat).unwrap(),
        serde_json::to_value(&foreign).unwrap(),
        serde_json::to_value(&unmapped).unwrap(),
        unknown,
    ];
    fs::write(&path, json!({"version": 1, "sessions": rows}).to_string()).unwrap();

    cleanup_index(root.path(), &catalog).unwrap();
    let remaining: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(remaining["sessions"].as_array().unwrap().len(), 3);
    assert_eq!(remaining["sessions"][0]["id"], "foreign");
    assert_eq!(remaining["sessions"][1]["id"], "unmapped");
    assert_eq!(remaining["sessions"][2]["futureField"], "retain");

    fs::write(&path, "{damaged").unwrap();
    assert!(cleanup_index(root.path(), &catalog).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{damaged");
}

#[test]
fn annotation_inventory_retains_unknown_and_damaged_records_without_inventing_classifications() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("local-chat-annotations");
    fs::create_dir(&directory).unwrap();
    let source = format!(
        "{}\n{{damaged\n",
        json!({
            "session_id": "chat", "tool_id": "tool", "kind": "future_kind",
            "payload": {"secret": "local"}, "recorded_at": "2026-01-01T00:00:00Z"
        })
    );
    let path = directory.join("chat.jsonl");
    fs::write(&path, &source).unwrap();

    let inventory = inventory_annotations(root.path(), "chat").unwrap();
    assert_eq!(
        inventory,
        AnnotationInventory {
            local_only: 0,
            unsupported: 1,
            malformed: 1,
            unavailable: false
        }
    );
    assert_eq!(fs::read_to_string(path).unwrap(), source);
}

#[tokio::test]
async fn a_failed_later_page_cannot_verify_a_matching_earlier_page() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("local-chat-session-index.json");
    let chat = session("chat");
    let source = json!({"version": 1, "sessions": [&chat]}).to_string();
    fs::write(&index, &source).unwrap();
    let path = root.path().join("catalog.json");
    let mut catalog = Catalog::default();
    let payload = queue_session(&mut catalog, &chat);
    let record = catalog.records.get_mut("project/chat").unwrap();
    record.desired = None;
    record.remote = Entry {
        chat_id: "chat".into(),
        revision: 1,
        payload: payload.clone(),
    };
    save(&path, &catalog).unwrap();

    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .respond_with(move |request: &wiremock::Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            if !body["variables"]["after"].is_null() {
                return ResponseTemplate::new(503);
            }
            ResponseTemplate::new(200).set_body_json(json!({
                "data": {"chatCatalog": {
                    "entries": [{"chatId": "chat", "revision": 1, "payload": payload}],
                    "nextCursor": "another-page"
                }}
            }))
        })
        .expect(2)
        .mount(&server)
        .await;
    let client = GraphqlClient::new(SacrumConfig {
        base_url: server.uri(),
        api_token: "fixture".into(),
        project_id: "project".into(),
    });

    assert!(finish(
        &client,
        "project",
        "machine",
        &mut catalog,
        &path,
        root.path()
    )
    .await
    .is_err());
    assert!(load(&path).unwrap().migration.verified.is_empty());
    assert_eq!(fs::read_to_string(index).unwrap(), source);
}

#[test]
fn terminal_deletion_wins_during_import_without_retaining_a_conflict() {
    let mut catalog = Catalog::default();
    let chat = session("chat");
    let mut deleted = queue_session(&mut catalog, &chat);
    catalog.records.get_mut("project/chat").unwrap().conflicted = true;
    deleted["deleted"] = json!(true);
    let entry = Entry {
        chat_id: "chat".into(),
        revision: 8,
        payload: deleted,
    };

    merge(&mut catalog, "project", entry.clone());
    reconcile(
        &mut catalog,
        "project",
        &BTreeMap::from([("chat".into(), entry)]),
    );

    assert!(can_retire(&catalog, &chat));
    assert!(catalog.records["project/chat"].desired.is_none());
    assert!(!catalog.records["project/chat"].conflicted);
    enqueue(&mut catalog, "project", "chat", projection(&chat));
    assert!(catalog.records["project/chat"].desired.is_none());
}

#[test]
fn competing_process_locks_fail_without_overwriting_state_and_release_on_drop() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("local-chat-session-index.json");
    let guard = lock_index(&path).unwrap();
    assert!(lock_index(&path).is_err());
    drop(guard);
    assert!(lock_index(&path).is_ok());
}

#[test]
fn a_newer_catalog_shape_is_preserved_instead_of_silently_downgraded() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("catalog.json");
    let mut data = serde_json::to_value(Catalog::default()).unwrap();
    data["futureField"] = json!({"important": "retain"});
    let source = data.to_string();
    fs::write(&path, &source).unwrap();

    assert!(load(&path).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), source);
}

#[test]
fn cold_hydration_restores_a_nullable_association_title_with_the_worktree() {
    let chat = session("chat");
    let mut catalog = Catalog::default();
    queue_session(&mut catalog, &chat);

    let mut recovered = Vec::new();
    hydrate_snapshot(&catalog, "project", "/local/project", &mut recovered);

    let association = recovered[0].association.as_ref().unwrap();
    assert_eq!(association.get("ticketTitle"), Some(&Value::Null));
    assert_eq!(association["worktreePath"], "/private/worktree");
    assert_eq!(association["processedAtCount"], 9);
}
