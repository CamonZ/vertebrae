use super::*;
use crate::commands::chat_catalog::{
    enqueue, exchange, load, merge,
    tests::{accept, empty_thread_snapshot, payload},
    Record, ThreadId,
};
use hegel::{generators as gs, TestCase};
use serde_json::Value;
use std::fs;
use vertebrae_sacrum_client::SacrumConfig;
use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

async fn server(
    respond: impl Fn(&Value) -> ResponseTemplate + Send + Sync + 'static,
) -> (MockServer, GraphqlClient) {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .respond_with(move |request: &wiremock::Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            if body["query"].as_str().unwrap().contains("reviewThreads(") {
                return empty_thread_snapshot();
            }
            respond(&body)
        })
        .mount(&server)
        .await;
    let client = GraphqlClient::new(SacrumConfig {
        base_url: server.uri(),
        api_token: "fixture".into(),
        project_id: "project".into(),
    });
    (server, client)
}

async fn writes(server: &MockServer) -> Vec<(String, String, String)> {
    server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter_map(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let vars = &body["variables"];
            Some((
                vars["p"].as_str()?.into(),
                vars["c"].as_str()?.into(),
                vars["n"].as_str()?.into(),
            ))
        })
        .collect()
}

fn accepted(body: &Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"data": accept(body, 1)}))
}

#[tokio::test]
async fn contracted_rejections_are_persisted_and_other_writes_continue() {
    for rejected_mask in 0..16 {
        let (server, client) = server(move |body| {
            let vars = &body["variables"];
            let chat: u8 = vars["c"].as_str().unwrap().parse().unwrap();
            if rejected_mask & (1 << chat) != 0 {
                let code = if chat % 2 == 0 {
                    "invalid_payload"
                } else {
                    "not_found"
                };
                return ResponseTemplate::new(200).set_body_json(json!({
                    "errors": [{"message": "rejected", "code": code}]
                }));
            }
            accepted(body)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalog.json");
        let mut catalog = Catalog::default();
        for chat in 0..4 {
            let project = if chat < 2 { "project" } else { "other" };
            enqueue(&mut catalog, project, &chat.to_string(), payload(chat));
        }
        save(&path, &catalog).unwrap();
        for project in ["project", "other"] {
            deliver(&client, project, "machine", &mut catalog, &path)
                .await
                .unwrap();
        }

        assert_eq!(
            writes(&server)
                .await
                .into_iter()
                .map(|(_, chat, _)| chat)
                .collect::<Vec<_>>(),
            ["0", "1", "2", "3"]
        );
        let catalog = load(&path).unwrap();
        let diagnostics: Value =
            serde_json::from_slice(&fs::read(path.with_extension("expected.json")).unwrap())
                .unwrap();
        for chat in 0..4 {
            let project = if chat < 2 { "project" } else { "other" };
            let record = &catalog.chat(project, &chat.to_string()).unwrap();
            if rejected_mask & (1 << chat) == 0 {
                assert_eq!(record.remote.payload, payload(chat));
                assert!(record.desired.is_none());
            } else {
                let code = if chat % 2 == 0 {
                    "invalid_payload"
                } else {
                    "not_found"
                };
                assert_eq!(record.desired, Some(payload(chat)));
                assert!(diagnostics["rejected"].as_array().unwrap().contains(
                    &json!({"project_id": project, "chat_id": chat.to_string(), "code": code})
                ));
            }
        }
    }
}

#[tokio::test]
async fn transport_errors_preserve_unsent_intents_after_partial_delivery() {
    for response in [
        ResponseTemplate::new(503),
        ResponseTemplate::new(200).set_body_json(json!({"errors": [{"message": "unavailable"}]})),
        ResponseTemplate::new(200).set_body_json(json!({
            "errors": [{"message": "unavailable", "code": "service_unavailable"}]
        })),
    ] {
        for failed_chat in ["a", "b", "c"] {
            let response = response.clone();
            let (server, client) = server(move |body| {
                if body["variables"]["c"] == failed_chat {
                    response.clone()
                } else {
                    accepted(body)
                }
            })
            .await;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("catalog.json");
            let mut catalog = Catalog::default();
            let chats = ["a", "b", "c"];
            for chat in chats {
                enqueue(&mut catalog, "project", chat, payload(1));
            }
            save(&path, &catalog).unwrap();
            let original = load(&path).unwrap();
            assert!(deliver(&client, "project", "machine", &mut catalog, &path)
                .await
                .is_err());
            let persisted = load(&path).unwrap();
            assert_eq!(
                writes(&server)
                    .await
                    .into_iter()
                    .map(|(_, chat, _)| chat)
                    .collect::<Vec<_>>(),
                chats[..=chats.iter().position(|chat| *chat == failed_chat).unwrap()]
            );
            for chat in chats {
                let record = persisted.chat("project", chat).unwrap();
                if chat < failed_chat {
                    assert_eq!(record.remote.payload, payload(1));
                    assert!(record.desired.is_none());
                } else {
                    assert_eq!(
                        serde_json::to_vec(record).unwrap(),
                        serde_json::to_vec(&original.chat("project", chat).unwrap()).unwrap()
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn recovery_delivers_main_chats_before_discussions_and_parents_before_children() {
    let (server, client) = server(|body| {
        if body["variables"]["c"].is_null() {
            return ResponseTemplate::new(200).set_body_json(json!({
                "data": {"chatCatalog": {"entries": [], "nextCursor": null}}
            }));
        }
        accepted(body)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut catalog = Catalog::default();
    let mut discussion = payload(1);
    discussion["metadata"]["kind"] = json!("discussion");
    discussion["parent_chat_id"] = json!("z-parent");
    enqueue(&mut catalog, "project", "a-discussion", discussion);
    let mut child = payload(2);
    child["parent_chat_id"] = json!("z-parent");
    enqueue(&mut catalog, "project", "b-chat", child);
    enqueue(&mut catalog, "project", "y-unrelated-main", payload(3));
    enqueue(&mut catalog, "project", "z-parent", payload(4));
    save(&path, &catalog).unwrap();

    let mut catalog = load(&path).unwrap();
    exchange(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    assert_eq!(
        writes(&server)
            .await
            .into_iter()
            .map(|(_, chat, _)| chat)
            .collect::<Vec<_>>(),
        ["y-unrelated-main", "z-parent", "b-chat", "a-discussion"]
    );
    assert!(catalog
        .records("project")
        .all(|(_, record)| record.desired.is_none()));
}

#[tokio::test]
async fn rejected_child_is_discarded_once_recovery_observes_remote_parent_tombstone() {
    let mut deleted = payload(3);
    deleted["deleted"] = json!(true);
    let (server, client) = server(move |body| match body["variables"]["c"].as_str() {
        None => ResponseTemplate::new(200).set_body_json(json!({
            "data": {"chatCatalog": {"entries": [{
                "chatId": "parent",
                "revision": 2,
                "payload": deleted,
            }], "nextCursor": null}}
        })),
        Some("child") => ResponseTemplate::new(200).set_body_json(json!({
            "errors": [{"message": "not found", "code": "not_found"}]
        })),
        Some(_) => accepted(body),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut catalog = Catalog::default();
    let mut child = payload(1);
    child["metadata"]["kind"] = json!("discussion");
    child["parent_chat_id"] = json!("parent");
    enqueue(&mut catalog, "project", "child", child.clone());
    save(&path, &catalog).unwrap();
    deliver(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    assert_eq!(
        catalog.chat("project", "child").unwrap().desired,
        Some(child.clone())
    );

    let mut ordinary_child = payload(2);
    ordinary_child["parent_chat_id"] = json!("parent");
    enqueue(
        &mut catalog,
        "project",
        "ordinary-child",
        ordinary_child.clone(),
    );
    exchange(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    let mut catalog = load(&path).unwrap();
    assert!(!catalog.chat("project", "child").is_some());
    assert_eq!(
        catalog.chat("project", "parent").unwrap().remote.payload["deleted"],
        true
    );
    enqueue(&mut catalog, "project", "child", child);
    deliver(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    assert_eq!(
        writes(&server)
            .await
            .into_iter()
            .map(|(_, chat, _)| chat)
            .collect::<Vec<_>>(),
        ["child", "ordinary-child"]
    );
    assert!(!catalog.chat("project", "child").is_some());
    assert_eq!(
        catalog
            .chat("project", "ordinary-child")
            .unwrap()
            .remote
            .payload,
        ordinary_child
    );
}

#[tokio::test]
async fn recovery_retries_the_same_mutation_only_in_the_recovered_project() {
    let (server, client) = server(|body| {
        if body["variables"]["c"].is_null() {
            return ResponseTemplate::new(200).set_body_json(json!({
                "data": {"chatCatalog": {"entries": [], "nextCursor": null}}
            }));
        }
        accepted(body)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut catalog = Catalog::default();
    for project in ["project", "other"] {
        enqueue(&mut catalog, project, "chat", payload(1));
        apply_outcome(
            &mut catalog,
            project,
            &EntityKey::chat("chat"),
            Outcome::Rejected("not_found".into()),
        );
    }
    save(&path, &catalog).unwrap();
    let mut catalog = load(&path).unwrap();
    let mutation = catalog.chat("project", "chat").unwrap().mutation_id.clone();
    enqueue(&mut catalog, "project", "chat", payload(1));
    deliver(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    assert!(writes(&server).await.is_empty());

    exchange(&client, "project", "machine", &mut catalog, &path)
        .await
        .unwrap();
    assert_eq!(
        writes(&server).await,
        [("project".into(), "chat".into(), mutation)]
    );
    let catalog = load(&path).unwrap();
    assert!(catalog.chat("project", "chat").unwrap().desired.is_none());
    assert!(catalog
        .chat("project", "chat")
        .unwrap()
        .rejection_code
        .is_none());
    assert_eq!(
        catalog
            .chat("other", "chat")
            .unwrap()
            .rejection_code
            .as_deref(),
        Some("not_found")
    );
}

#[test]
fn ordering_matches_an_exhaustive_small_graph_oracle() {
    let names = ["a", "b", "c"];
    // Parents 0..=2 refer to nodes, 3 to a missing parent, 4 to no parent.
    for graph in 0..125 {
        let parents = [graph % 5, graph / 5 % 5, graph / 25];
        for pending in 0..8 {
            for discussions in 0..8 {
                let mut catalog = Catalog::default();
                let mut expected = BTreeSet::new();
                for (node, chat) in names.into_iter().enumerate() {
                    let mut desired = payload(1);
                    desired["parent_chat_id"] = match parents[node] {
                        3 => json!("missing"),
                        4 => Value::Null,
                        parent => json!(names[parent]),
                    };
                    if discussions & (1 << node) != 0 {
                        desired["metadata"]["kind"] = json!("discussion");
                    }
                    let id = EntityKey::chat(chat);
                    let mut record = Record::default();
                    if pending & (1 << node) != 0 {
                        record.desired = Some(desired.clone());
                        expected.insert(node);
                    }
                    *catalog.upsert("project", &id) = record;
                    enqueue(&mut catalog, "other", chat, desired);
                }
                let actual = pending_order(&catalog, "project");
                assert_eq!(actual.len(), expected.len());
                for id in actual {
                    let node = names
                        .iter()
                        .position(|chat| id == EntityKey::chat(*chat))
                        .unwrap();
                    let ready: Vec<_> = expected
                        .iter()
                        .copied()
                        .filter(|candidate| !expected.contains(&parents[*candidate]))
                        .collect();
                    if ready.is_empty() {
                        // A parent walk must return to this node for it to be on a cycle.
                        let mut ancestor = parents[node];
                        assert!(
                            (0..names.len()).any(|_| {
                                if ancestor == node {
                                    return true;
                                }
                                ancestor = parents[ancestor];
                                false
                            }),
                            "graph {parents:?}, pending {expected:?}, node {node}"
                        );
                    } else {
                        assert!(ready.contains(&node));
                        if discussions & (1 << node) != 0 {
                            assert!(ready.iter().all(|chat| discussions & (1 << chat) != 0));
                        }
                    }
                    assert!(expected.remove(&node));
                }
                assert!(expected.is_empty());
            }
        }
    }
}

#[hegel::test]
fn delivery_model_tracks_recovery_edits_transport_and_parent_deletion(tc: TestCase) {
    let mut catalog = Catalog::default();
    let mut intent = [None; 2];
    let mut acknowledged = [None; 2];
    let mut rejected = [false; 2];
    let mut parent_deleted = false;
    let mut local_tombstone = false;
    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(50));
    for _ in 0..count {
        let op = tc.draw(gs::integers::<u8>().max_value(6));
        let node = tc.draw(gs::integers::<usize>().max_value(1));
        let value = tc.draw(gs::integers::<u8>().max_value(3));
        let chat = ["a", "b"][node];
        match op {
            0..=1 => {
                let mut desired = payload(value);
                desired["metadata"]["kind"] = json!("discussion");
                desired["parent_chat_id"] = json!("parent");
                enqueue(&mut catalog, "project", chat, desired);
                if !parent_deleted && intent[node].or(acknowledged[node]) != Some(value) {
                    intent[node] = Some(value);
                    rejected[node] = false;
                }
            }
            2 if intent[node].is_some() => {
                apply_outcome(
                    &mut catalog,
                    "project",
                    &EntityKey::chat(chat),
                    Outcome::Rejected("not_found".into()),
                );
                rejected[node] = true;
            }
            3..=5 => {
                if op == 4 {
                    retry_rejections(&mut catalog, "project");
                    rejected.fill(false);
                }
                let writes = pending_order(&catalog, "project");
                let expected: Vec<_> = (0..2)
                    .filter(|&n| intent[n].is_some() && !rejected[n])
                    .collect();
                let expected_ids: Vec<_> = expected
                    .iter()
                    .map(|&n| EntityKey::chat(["a", "b"][n]))
                    .collect();
                let mut all_ids = expected_ids;
                if local_tombstone {
                    all_ids.insert(0, EntityKey::chat("parent"));
                }
                assert_eq!(writes, all_ids);
                let stop = if op == 5 {
                    usize::from(value).min(writes.len())
                } else {
                    writes.len()
                };
                for id in writes.into_iter().take(stop) {
                    let Some(record) = catalog.record("project", &id) else {
                        continue;
                    };
                    let Some(payload) = &record.desired else {
                        continue;
                    };
                    let entry = Entry {
                        id: id.clone(),
                        revision: record.remote.revision + 1,
                        payload: payload.clone(),
                    };
                    if entry.id.to_string() == "parent" {
                        parent_deleted = true;
                        local_tombstone = false;
                        intent.fill(None);
                        rejected.fill(false);
                    } else {
                        let n = usize::from(entry.id.to_string() == "b");
                        acknowledged[n] = intent[n].take();
                    }
                    apply_outcome(&mut catalog, "project", &id, Outcome::Accepted(entry));
                }
            }
            6 if !parent_deleted => {
                let mut deleted = payload(0);
                deleted["deleted"] = json!(true);
                if value % 2 == 0 {
                    enqueue(&mut catalog, "project", "parent", deleted);
                    local_tombstone = true;
                } else {
                    merge(
                        &mut catalog,
                        "project",
                        Entry {
                            id: EntityKey::chat("parent"),
                            revision: 1,
                            payload: deleted,
                        },
                    );
                    local_tombstone = false;
                    parent_deleted = true;
                    intent.fill(None);
                    rejected.fill(false);
                }
            }
            _ => {}
        }

        for (node, chat) in ["a", "b"].into_iter().enumerate() {
            match catalog.chat("project", chat) {
                Some(record) => {
                    assert_eq!(
                        record
                            .desired
                            .as_ref()
                            .map(|p| p["metadata"]["label"].clone()),
                        intent[node].map(|value| json!(format!("chat-{value}")))
                    );
                    assert_eq!(record.rejection_code.is_some(), rejected[node]);
                    assert_eq!(
                        record.remote.payload["metadata"]["label"]
                            .as_str()
                            .map(str::to_owned),
                        acknowledged[node].map(|value| format!("chat-{value}"))
                    );
                }
                None => assert!(intent[node].is_none() && acknowledged[node].is_none()),
            }
        }
    }
}

fn thread_payload(parent: &str) -> Value {
    json!({"parent_chat_id": parent, "path": "src/lib.rs", "deleted": false})
}

fn linked_discussion(parent: &str, thread: Uuid) -> Value {
    let mut discussion = payload(1);
    discussion["metadata"]["kind"] = json!("discussion");
    discussion["parent_chat_id"] = json!(parent);
    discussion["review_thread_id"] = json!(thread);
    discussion
}

fn accept_catalog_entry(body: &Value) -> ResponseTemplate {
    let query = body["query"].as_str().unwrap();
    if query.contains("putReviewThread") {
        let vars = &body["variables"];
        let payload: Value = serde_json::from_str(vars["v"].as_str().unwrap()).unwrap();
        return ResponseTemplate::new(200).set_body_json(json!({
            "data": {"putReviewThread": {"status": "accepted", "entry": {
                "threadId": vars["c"],
                "revision": vars["r"].as_u64().unwrap() + 1,
                "payload": payload
            }}}
        }));
    }
    accepted(body)
}

#[tokio::test]
async fn durable_mixed_intents_replay_in_reference_order_across_passes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let durable = path.clone();
    let thread = Uuid::new_v4();
    let mut catalog = Catalog::default();
    super::super::enqueue_entity(
        &mut catalog,
        "project",
        &EntityKey::Thread(ThreadId(thread)),
        thread_payload("z-parent"),
    );
    enqueue(
        &mut catalog,
        "project",
        "a-discussion",
        linked_discussion("z-parent", thread),
    );
    enqueue(&mut catalog, "project", "z-parent", payload(1));
    save(&path, &catalog).unwrap();

    let rejected_once = std::sync::atomic::AtomicBool::new(false);
    let (server, client) = server(move |body| {
        let id = body["variables"]["c"].as_str().unwrap();
        if id == "z-parent" && !rejected_once.swap(true, std::sync::atomic::Ordering::Relaxed) {
            let disk = load(&durable).unwrap();
            assert!(disk
                .record("project", &EntityKey::Thread(ThreadId(thread)))
                .unwrap()
                .desired
                .is_some());
            assert!(disk
                .chat("project", "a-discussion")
                .unwrap()
                .desired
                .is_some());
            return ResponseTemplate::new(503);
        }
        accept_catalog_entry(body)
    })
    .await;

    assert!(deliver(&client, "project", "machine", &mut catalog, &path)
        .await
        .is_err());

    let mut restarted = load(&path).unwrap();

    assert_eq!(
        deliver(&client, "project", "machine", &mut restarted, &path)
            .await
            .unwrap(),
        3
    );

    let ids: Vec<_> = writes(&server)
        .await
        .into_iter()
        .map(|(_, id, _)| id)
        .collect();
    assert_eq!(
        ids,
        ["z-parent", "z-parent", &thread.to_string(), "a-discussion"]
    );
    assert!(load(&path)
        .unwrap()
        .record("project", &EntityKey::Thread(ThreadId(thread)))
        .unwrap()
        .desired
        .is_none());
}

#[tokio::test]
async fn rejected_thread_preserves_intent_without_blocking_independent_writes() {
    let rejected = Uuid::new_v4();
    let rejected_id = rejected.to_string();
    let good = Uuid::new_v4();

    let (server, client) = server(move |body| {
        let vars = &body["variables"];
        if vars["c"] == rejected_id && vars["v"].as_str().unwrap().contains("src/lib.rs") {
            return ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{"message": "invalid thread", "code": "invalid_payload"}]
            }));
        }
        accept_catalog_entry(body)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut catalog = Catalog::default();
    enqueue(&mut catalog, "project", "parent", payload(1));
    enqueue(&mut catalog, "other", "unrelated", payload(2));
    for thread in [rejected, good] {
        super::super::enqueue_entity(
            &mut catalog,
            "project",
            &EntityKey::Thread(ThreadId(thread)),
            thread_payload("parent"),
        );
    }
    enqueue(
        &mut catalog,
        "project",
        "blocked",
        linked_discussion("parent", rejected),
    );
    enqueue(
        &mut catalog,
        "project",
        "discussion",
        linked_discussion("parent", good),
    );
    save(&path, &catalog).unwrap();

    for project in ["project", "other", "project"] {
        deliver(&client, project, "machine", &mut catalog, &path)
            .await
            .unwrap();
    }

    let disk = load(&path).unwrap();
    assert_eq!(
        disk.record("project", &EntityKey::Thread(ThreadId(rejected)))
            .unwrap()
            .desired,
        Some(thread_payload("parent"))
    );
    assert_eq!(
        disk.record("project", &EntityKey::Thread(ThreadId(rejected)))
            .unwrap()
            .rejection_code
            .as_deref(),
        Some("invalid_payload")
    );
    assert!(disk.chat("project", "blocked").unwrap().desired.is_some());
    assert!(disk
        .chat("project", "discussion")
        .unwrap()
        .desired
        .is_none());
    assert!(disk.chat("other", "unrelated").unwrap().desired.is_none());
    assert_eq!(
        writes(&server)
            .await
            .iter()
            .filter(|(_, id, _)| id == &rejected.to_string())
            .count(),
        1
    );

    let diagnostics: Value =
        serde_json::from_slice(&fs::read(path.with_extension("expected.json")).unwrap()).unwrap();
    assert_eq!(
        diagnostics["rejected"],
        json!([
            {"project_id": "project", "thread_id": rejected, "code": "invalid_payload"}
        ])
    );

    let mut corrected = thread_payload("parent");
    corrected["path"] = json!("src/main.rs");
    super::super::enqueue_entity(
        &mut catalog,
        "project",
        &EntityKey::Thread(ThreadId(rejected)),
        corrected,
    );
    save(&path, &catalog).unwrap();

    assert_eq!(
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap(),
        2
    );
    assert!(catalog
        .chat("project", "blocked")
        .unwrap()
        .desired
        .is_none());
}

#[test]
fn tombstones_discard_pending_descendants_for_both_entity_kinds() {
    let mut catalog = Catalog::default();
    let thread = Uuid::new_v4();

    let thread_intent = thread_payload("parent");
    let discussion = linked_discussion("parent", thread);
    merge(
        &mut catalog,
        "project",
        Entry {
            id: EntityKey::Thread(ThreadId(thread)),
            revision: 1,
            payload: thread_intent.clone(),
        },
    );

    let mut updated = thread_intent.clone();
    updated["path"] = json!("src/main.rs");
    super::super::enqueue_entity(
        &mut catalog,
        "project",
        &EntityKey::Thread(ThreadId(thread)),
        updated,
    );
    enqueue(&mut catalog, "project", "discussion", discussion.clone());
    let parent = EntityKey::chat("parent");
    enqueue(&mut catalog, "project", "parent", payload(1));

    let mut deleted_parent = payload(1);
    deleted_parent["deleted"] = json!(true);
    apply_outcome(
        &mut catalog,
        "project",
        &parent,
        Outcome::Accepted(Entry {
            id: parent.clone(),
            revision: 2,
            payload: deleted_parent,
        }),
    );
    assert!(catalog
        .record("project", &EntityKey::Thread(ThreadId(thread)))
        .unwrap()
        .desired
        .is_none());
    assert!(pending_order(&catalog, "project").is_empty());
    assert!(!catalog.chat("project", "discussion").is_some());

    // A cascaded physical delete may follow a normal update at the same revision.
    enqueue(&mut catalog, "other", "discussion", discussion.clone());
    merge(
        &mut catalog,
        "other",
        Entry {
            id: EntityKey::Thread(ThreadId(thread)),
            revision: 1,
            payload: thread_intent.clone(),
        },
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut tombstone = thread_intent.clone();
    tombstone["deleted"] = json!(true);
    assert!(super::super::apply_entry(
        &mut catalog,
        &path,
        "other",
        Entry {
            id: EntityKey::Thread(ThreadId(thread)),
            revision: 1,
            payload: tombstone,
        },
    )
    .unwrap());
    enqueue(&mut catalog, "other", "discussion", discussion);
    assert!(!catalog.chat("other", "discussion").is_some());
    merge(
        &mut catalog,
        "other",
        Entry {
            id: EntityKey::Thread(ThreadId(thread)),
            revision: 2,
            payload: thread_intent,
        },
    );
    assert_eq!(
        catalog
            .record("other", &EntityKey::Thread(ThreadId(thread)))
            .unwrap()
            .remote
            .payload["deleted"],
        true
    );
}

#[hegel::test]
fn mixed_graph_waits_for_both_references(tc: TestCase) {
    let thread = Uuid::from_u128(1);
    let thread_key = EntityKey::Thread(ThreadId(thread));
    let main = EntityKey::chat("main");
    let secondary = EntityKey::chat("secondary");
    let discussion = EntityKey::chat("discussion");
    let entries = [
        (
            discussion.clone(),
            linked_discussion("secondary", thread),
            vec![secondary.clone(), thread_key.clone()],
        ),
        (secondary, payload(2), vec![]),
        (thread_key, thread_payload("main"), vec![main.clone()]),
        (main, payload(1), vec![]),
    ];

    let selected = tc.draw(gs::integers::<u8>().max_value(15));
    let mut catalog = Catalog::default();
    for (index, (id, payload, _)) in entries.iter().enumerate() {
        if selected & (1 << index) != 0 {
            super::super::enqueue_entity(&mut catalog, "project", id, payload.clone());
        }
        super::super::enqueue_entity(&mut catalog, "other", id, payload.clone());
    }

    let mut waiting: BTreeMap<_, _> = entries
        .iter()
        .enumerate()
        .filter(|(index, _)| selected & (1 << index) != 0)
        .map(|(_, (id, _, parents))| (id.clone(), parents))
        .collect();

    let order = pending_order(&catalog, "project");
    assert_eq!(order.len(), waiting.len());
    for id in order {
        let parents = waiting
            .remove(&id)
            .expect("order contains each selected row once");
        assert!(parents.iter().all(|parent| !waiting.contains_key(parent)));
    }
}

#[tokio::test]
async fn conflicted_missing_thread_keeps_live_revision_and_pending_intent() {
    let (server, client) = server(|body| {
        if body["query"].as_str().unwrap().contains("putReviewThread") {
            return ResponseTemplate::new(200).set_body_json(json!({
                "data": {"putReviewThread": {"status": "conflict", "entry": null}}
            }));
        }
        accepted(body)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let mut catalog = Catalog::default();
    let thread = EntityKey::Thread(ThreadId(Uuid::new_v4()));
    merge(
        &mut catalog,
        "project",
        Entry {
            id: thread.clone(),
            revision: 8,
            payload: thread_payload("parent"),
        },
    );

    let mut desired = thread_payload("parent");
    desired["path"] = json!("src/new.rs");
    super::super::enqueue_entity(&mut catalog, "project", &thread, desired.clone());
    let mutation = catalog
        .record("project", &thread)
        .unwrap()
        .mutation_id
        .clone();
    save(&path, &catalog).unwrap();

    assert_eq!(
        deliver(&client, "project", "machine", &mut catalog, &path)
            .await
            .unwrap(),
        1
    );

    let disk = load(&path).unwrap();
    let record = disk.record("project", &thread).unwrap();
    assert_eq!(record.remote.revision, 8);
    assert_eq!(record.remote.payload, thread_payload("parent"));
    assert_eq!(record.mutation_id, mutation);
    assert_eq!(record.desired, Some(desired));
    assert!(record.conflicted && !record.tombstoned());
    assert_eq!(writes(&server).await.len(), 1);

    let diagnostics: Value =
        serde_json::from_slice(&fs::read(path.with_extension("expected.json")).unwrap()).unwrap();
    assert_eq!(diagnostics["pending_threads"], json!([thread.to_string()]));
    assert_eq!(
        diagnostics["conflicted_threads"],
        json!([thread.to_string()])
    );
}

#[hegel::test]
fn mixed_outbox_model_preserves_terminal_ordering_and_project_isolation(tc: TestCase) {
    let uuid = Uuid::from_u128(7);
    let main = EntityKey::chat("main");
    let thread = EntityKey::Thread(ThreadId(uuid));
    let discussion = EntityKey::chat("discussion");
    let main_payload = payload(1);
    let original_thread = thread_payload("main");
    let mut edited_thread = original_thread.clone();
    edited_thread["path"] = json!("src/updated.rs");
    let edited_discussion = linked_discussion("main", uuid);

    let mut catalog = Catalog::default();
    for project in ["project", "other"] {
        for (id, payload) in [(&main, &main_payload), (&thread, &original_thread)] {
            merge(
                &mut catalog,
                project,
                Entry {
                    id: id.clone(),
                    revision: 2,
                    payload: payload.clone(),
                },
            );
        }
    }
    super::super::enqueue_entity(
        &mut catalog,
        "other",
        &discussion,
        edited_discussion.clone(),
    );

    let mut main_deleted = false;
    let mut thread_deleted = false;
    let mut thread_pending = false;
    let mut discussion_pending = false;
    let mut thread_rejected = false;

    let count = tc.draw(gs::integers::<usize>().min_value(1).max_value(30));
    for _ in 0..count {
        match tc.draw(gs::integers::<u8>().max_value(7)) {
            0 => {
                super::super::enqueue_entity(
                    &mut catalog,
                    "project",
                    &thread,
                    edited_thread.clone(),
                );
                thread_pending = !main_deleted && !thread_deleted;
            }
            1 => {
                super::super::enqueue_entity(
                    &mut catalog,
                    "project",
                    &discussion,
                    edited_discussion.clone(),
                );
                discussion_pending = !main_deleted && !thread_deleted;
            }
            2 if thread_pending => {
                apply_outcome(
                    &mut catalog,
                    "project",
                    &thread,
                    Outcome::Rejected("invalid_payload".into()),
                );
                thread_rejected = true;
            }
            3 => {
                retry_rejections(&mut catalog, "project");
                thread_rejected = false;
            }
            4 => {
                let mut tombstone = main_payload.clone();
                tombstone["deleted"] = json!(true);
                merge(
                    &mut catalog,
                    "project",
                    Entry {
                        id: main.clone(),
                        revision: 3,
                        payload: tombstone,
                    },
                );
                main_deleted = true;
                thread_pending = false;
                discussion_pending = false;
                thread_rejected = false;
            }
            5 => {
                let mut tombstone = original_thread.clone();
                tombstone["deleted"] = json!(true);
                merge(
                    &mut catalog,
                    "project",
                    Entry {
                        id: thread.clone(),
                        revision: 2,
                        payload: tombstone,
                    },
                );
                thread_deleted = true;
                thread_pending = false;
                discussion_pending = false;
                thread_rejected = false;
            }
            6 => {
                let bytes = super::super::storage::encode(&catalog).unwrap();
                catalog = super::super::storage::decode(&bytes).unwrap();
            }
            7 => {
                // Neither a stale row nor a duplicate live revision removes intent.
                merge(
                    &mut catalog,
                    "project",
                    Entry {
                        id: thread.clone(),
                        revision: 1,
                        payload: edited_thread.clone(),
                    },
                );
                merge(
                    &mut catalog,
                    "project",
                    Entry {
                        id: thread.clone(),
                        revision: 2,
                        payload: original_thread.clone(),
                    },
                );
            }
            _ => {}
        }

        let thread_record = catalog.record("project", &thread).unwrap();
        assert_eq!(thread_record.remote.payload["deleted"], thread_deleted);
        assert_eq!(thread_record.desired.is_some(), thread_pending);
        assert_eq!(thread_record.rejection_code.is_some(), thread_rejected);
        assert_eq!(
            catalog
                .record("project", &discussion)
                .is_some_and(|record| record.desired.is_some()),
            discussion_pending
        );

        let expected: Vec<_> = [
            (thread_pending && !thread_rejected, thread.clone()),
            (discussion_pending, discussion.clone()),
        ]
        .into_iter()
        .filter_map(|(pending, id)| pending.then_some(id))
        .collect();
        assert_eq!(pending_order(&catalog, "project"), expected);
        assert_eq!(
            pending_order(&catalog, "other").as_slice(),
            std::slice::from_ref(&discussion)
        );
    }
}
