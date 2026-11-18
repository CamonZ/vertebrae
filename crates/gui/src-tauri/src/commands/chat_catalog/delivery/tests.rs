use super::*;
use crate::commands::chat_catalog::{
    enqueue, exchange, load, merge,
    tests::{accept, payload},
    Record,
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
            respond(&serde_json::from_slice(&request.body).unwrap())
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
            let record = &catalog.records[&key(project, &chat.to_string())];
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
                let id = key("project", chat);
                let record = &persisted.records[&id];
                if chat < failed_chat {
                    assert_eq!(record.remote.payload, payload(1));
                    assert!(record.desired.is_none());
                } else {
                    assert_eq!(
                        serde_json::to_vec(record).unwrap(),
                        serde_json::to_vec(&original.records[&id]).unwrap()
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
        .records
        .values()
        .all(|record| record.desired.is_none()));
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
        catalog.records["project/child"].desired,
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
    assert!(!catalog.records.contains_key("project/child"));
    assert_eq!(
        catalog.records["project/parent"].remote.payload["deleted"],
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
    assert!(!catalog.records.contains_key("project/child"));
    assert_eq!(
        catalog.records["project/ordinary-child"].remote.payload,
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
            &key(project, "chat"),
            Outcome::Rejected("not_found".into()),
        );
    }
    save(&path, &catalog).unwrap();
    let mut catalog = load(&path).unwrap();
    let mutation = catalog.records["project/chat"].mutation_id.clone();
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
    assert!(catalog.records["project/chat"].desired.is_none());
    assert!(catalog.records["project/chat"].rejection_code.is_none());
    assert_eq!(
        catalog.records["other/chat"].rejection_code.as_deref(),
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
                    let id = key("project", chat);
                    let mut record = Record::new(chat);
                    if pending & (1 << node) != 0 {
                        record.desired = Some(desired.clone());
                        expected.insert(node);
                    }
                    catalog.records.insert(id, record);
                    enqueue(&mut catalog, "other", chat, desired);
                }
                let actual = pending_order(&catalog, "project");
                assert_eq!(actual.len(), expected.len());
                for id in actual {
                    let node = names
                        .iter()
                        .position(|chat| id == key("project", chat))
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
        let id = key("project", chat);
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
                    &id,
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
                    .map(|&n| key("project", ["a", "b"][n]))
                    .collect();
                let mut all_ids = expected_ids;
                if local_tombstone {
                    all_ids.insert(0, key("project", "parent"));
                }
                assert_eq!(writes, all_ids);
                let stop = if op == 5 {
                    usize::from(value).min(writes.len())
                } else {
                    writes.len()
                };
                for id in writes.into_iter().take(stop) {
                    let Some(record) = catalog.records.get(&id) else {
                        continue;
                    };
                    let Some(payload) = &record.desired else {
                        continue;
                    };
                    let entry = Entry {
                        chat_id: record.remote.chat_id.clone(),
                        revision: record.remote.revision + 1,
                        payload: payload.clone(),
                    };
                    if entry.chat_id == "parent" {
                        parent_deleted = true;
                        local_tombstone = false;
                        intent.fill(None);
                        rejected.fill(false);
                    } else {
                        let n = usize::from(entry.chat_id == "b");
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
                            chat_id: "parent".into(),
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
            match catalog.records.get(&key("project", chat)) {
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
