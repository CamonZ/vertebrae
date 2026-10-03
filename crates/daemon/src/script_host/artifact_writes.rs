//! `vtb::artifacts` writes: `put` and `put_json`.
//!
//! A write is the scoped lookup by subject and logical name followed by an
//! update of what that lookup found, or a create when it found nothing, so
//! sequential reruns converge on one attachment. Writes apply immediately
//! and stay if the script later fails. Each one records the execution that
//! wrote it in the attachment's provenance.

use rhai::{Dynamic, Module};
use serde_json::Value;
use vertebrae_core::ServiceError;
use vertebrae_core::models::{
    ArtifactLinkMetadata, CreateArtifactInput, GetArtifactByLogicalNameInput, UpdateArtifactInput,
};

use super::artifacts::{NAMESPACE, address, artifact_info, named_artifact};
use super::task_writes::require_task;
use super::{read, set_host_fn3, string_argument};
use crate::script_worker::{HostContext, HostError, rhai_to_json};

pub(super) fn register(module: &mut Module, host: &HostContext) {
    set_host_fn3(module, host, NAMESPACE, "put", put);
    set_host_fn3(module, host, NAMESPACE, "put_json", put_json);
}

#[derive(Clone, Copy)]
enum Format {
    Text,
    Json,
}

impl Format {
    fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Text => "txt",
            Self::Json => "json",
        }
    }
}

fn put(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
    body: Dynamic,
) -> Result<Dynamic, HostError> {
    let address = address(host, subject, name)?;
    let body = string_argument(body, "Artifact body")?;
    upsert(host, address, body, Format::Text)
}

/// Serialization need not keep the script's key order or number formatting.
fn put_json(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
    value: Dynamic,
) -> Result<Dynamic, HostError> {
    let address = address(host, subject, name)?;
    let value = rhai_to_json(&value)
        .map_err(|error| HostError::invalid(format!("Artifact value {error}")))?;
    upsert(host, address, value.to_string(), Format::Json)
}

fn upsert(
    host: &HostContext,
    address: GetArtifactByLogicalNameInput,
    body: String,
    format: Format,
) -> Result<Dynamic, HostError> {
    // Sacrum reads a blank body as a missing one and rejects it; refuse it
    // before any request.
    if body.trim().is_empty() {
        return Err(HostError::invalid("Artifact body must not be blank"));
    }
    if address.subject_type == "task" {
        require_task(host, &address.subject_id, ServiceError::task_not_found)?;
    }
    let metadata = provenance(host, format)?;
    let filename = format!("{}.{}", address.logical_name, format.extension());
    let existing = read(host, |services, _| {
        named_artifact(services, address.clone())
    })?;
    let written = match existing {
        // Sacrum refuses to replace the metadata of an artifact linked to
        // more than one subject (`ambiguous_attachment`, so `invalid`) and
        // rolls the whole update back.
        Some(artifact) => host.call(|services, _| {
            services.artifacts().update_artifact(
                &artifact.id,
                UpdateArtifactInput::new()
                    .with_filename(filename)
                    .with_body(body)
                    .with_metadata(metadata),
            )
        })?,
        None => host.call(|services, _| {
            services.artifacts().create_artifact(
                CreateArtifactInput::new(filename, body)
                    .with_subject(address.subject_type, address.subject_id)
                    .with_logical_name(address.logical_name)
                    .with_metadata(metadata),
            )
        })?,
    };
    artifact_info(&written)
}

/// The version-1 envelope for a script write. The TaskRun is read once per
/// attempt: Sacrum's dispatch carries only the execution and task IDs.
fn provenance(host: &HostContext, format: Format) -> Result<ArtifactLinkMetadata, HostError> {
    let task_run_id = match host.task_run_id().get() {
        Some(task_run_id) => task_run_id.clone(),
        None => {
            let execution_id = host.execution_id();
            let task_run_id = read(host, |services, _| async move {
                let execution = services.executions().get_execution(execution_id).await?;
                Ok(execution.and_then(|execution| execution.task_run_id))
            })?;
            host.task_run_id().get_or_init(|| task_run_id).clone()
        }
    };
    Ok(
        ArtifactLinkMetadata::new("artifact", format.name(), "rhai", "raw")
            .with_extension("execution_id", host.execution_id().into())
            .with_extension(
                "task_run_id",
                task_run_id.map_or(Value::Null, Value::String),
            )
            .with_extension("task_id", host.task_id().into()),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use wiremock::{MockServer, Request, Respond, ResponseTemplate};

    use super::super::test_support::{self, EXECUTION, OTHER_PROJECT, PROJECT, sacrum_requests};

    const SELF: &str = "d0000000-0000-4000-8000-000000000001";
    const OTHER: &str = "d0000000-0000-4000-8000-000000000002";
    const FOREIGN: &str = "d0000000-0000-4000-8000-000000000003";
    const MISSING: &str = "d0000000-0000-4000-8000-000000000004";
    const UNAUTHORIZED: &str = "d0000000-0000-4000-8000-000000000005";
    const TASK_RUN: &str = "d0000000-0000-4000-8000-0000000000aa";
    const SHARED: &str = "d0000000-0000-4000-8000-0000000000bb";

    const IDS: [(&str, &str); 4] = [
        ("OTHER", OTHER),
        ("FOREIGN", FOREIGN),
        ("MISSING", MISSING),
        ("UNAUTHORIZED", UNAUTHORIZED),
    ];

    /// Tasks Sacrum knows: (id, project).
    const TASKS: [(&str, &str); 3] = [(SELF, PROJECT), (OTHER, PROJECT), (FOREIGN, OTHER_PROJECT)];

    struct Link {
        subject_type: String,
        subject_id: String,
        artifact: Value,
    }

    struct State {
        links: Vec<Link>,
        next_id: usize,
    }

    /// A Sacrum that stores artifact links per subject and logical name and,
    /// like the real one, refuses an attachment update on an artifact linked
    /// to more than one subject.
    struct Sacrum(Mutex<State>);

    fn sacrum() -> Sacrum {
        let shared = |subject_type: &str, subject_id: &str| Link {
            subject_type: subject_type.into(),
            subject_id: subject_id.into(),
            artifact: json!({
                "id": SHARED, "filename": "shared.txt", "body": "shared body",
                "logical_name": "shared", "metadata": null,
                "inserted_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z"
            }),
        };
        Sacrum(Mutex::new(State {
            links: vec![shared("task", SELF), shared("project", PROJECT)],
            next_id: 0,
        }))
    }

    impl Respond for Sacrum {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let vars = &body["variables"];
            let mut state = self.0.lock().unwrap();
            let graphql_error = |message: &str| {
                ResponseTemplate::new(200)
                    .set_body_json(json!({"data": null, "errors": [{"message": message}]}))
            };
            let unavailable = || ResponseTemplate::new(503).set_body_string("upstream down");
            let data = if query.contains("query GetTask(") {
                if vars["id"] == UNAUTHORIZED {
                    return graphql_error("unauthorized");
                }
                let Some((id, project)) = TASKS.iter().find(|(task, _)| vars["id"] == *task) else {
                    return graphql_error("not_found");
                };
                json!({"task": {
                    "id": id, "project_id": project, "title": "Task", "level": "task",
                    "tags": [], "archived": false, "sections": [], "code_refs": [],
                    "inserted_at": "2026-10-01T10:00:00Z"
                }})
            } else if query.contains("query GetExecution(") {
                assert_eq!(vars["id"], EXECUTION);
                json!({"step_execution": {
                    "id": EXECUTION, "task_id": SELF, "task_run_id": TASK_RUN,
                    "workflow_id": "workflow", "step_name": "write", "status": "in_progress",
                    "inserted_at": "2026-10-01T10:00:00Z"
                }})
            } else if query.contains("query GetArtifactByLogicalName(") {
                assert_eq!(vars["project_id"], PROJECT);
                if vars["logical_name"] == "lookup-down" {
                    return unavailable();
                }
                let Some(link) = state.links.iter().find(|link| {
                    vars["subject_type"] == link.subject_type
                        && vars["subject_id"] == link.subject_id
                        && vars["logical_name"] == link.artifact["logical_name"]
                }) else {
                    return graphql_error("not_found");
                };
                json!({"artifactByLogicalName": link.artifact})
            } else if query.contains("mutation CreateArtifact(") {
                assert_eq!(vars["project_id"], PROJECT);
                if vars["logical_name"] == "create-down" {
                    return unavailable();
                }
                if state.links.iter().any(|link| {
                    vars["subject_type"] == link.subject_type
                        && vars["subject_id"] == link.subject_id
                        && vars["logical_name"] == link.artifact["logical_name"]
                }) {
                    return graphql_error("logical_name: has already been taken");
                }
                state.next_id += 1;
                let artifact = json!({
                    "id": format!("d0000000-0000-4000-8000-{:012}", 100 + state.next_id),
                    "filename": vars["filename"], "body": vars["body"],
                    "logical_name": vars["logical_name"],
                    "metadata": serde_json::from_str::<Value>(vars["metadata"].as_str().unwrap()).unwrap(),
                    "inserted_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z"
                });
                state.links.push(Link {
                    subject_type: vars["subject_type"].as_str().unwrap().into(),
                    subject_id: vars["subject_id"].as_str().unwrap().into(),
                    artifact: artifact.clone(),
                });
                json!({"createArtifact": artifact})
            } else if query.contains("mutation UpdateArtifact(") {
                let links: Vec<_> = state
                    .links
                    .iter_mut()
                    .filter(|link| link.artifact["id"] == vars["id"])
                    .collect();
                if links.len() > 1 {
                    return graphql_error("ambiguous_attachment");
                }
                let artifact = &mut links.into_iter().next().unwrap().artifact;
                artifact["filename"] = vars["filename"].clone();
                artifact["body"] = vars["body"].clone();
                artifact["metadata"] =
                    serde_json::from_str(vars["metadata"].as_str().unwrap()).unwrap();
                artifact["updated_at"] = json!("2026-10-01T11:00:00Z");
                json!({"updateArtifact": artifact})
            } else {
                panic!("unexpected Sacrum request: {query}");
            };
            ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
        }
    }

    async fn run(server: &MockServer, script: &str) -> Value {
        test_support::completed(test_support::run(server, SELF, &IDS, script).await, script)
    }

    fn provenance(format: &str) -> Value {
        json!({
            "version": 1, "content_kind": "artifact", "format": format, "origin": "rhai",
            "presentation": "raw",
            "extensions": {"execution_id": EXECUTION, "task_run_id": TASK_RUN, "task_id": SELF}
        })
    }

    const WRITE_AND_READ: &str = r#"
        let round = |notes, result, policy| {
            let infos = [
                vtb::artifacts::put(task.id, "notes", notes),
                vtb::artifacts::put_json($OTHER, "result", result),
                vtb::artifacts::put("project", "policy", policy),
            ];
            #{
                infos: infos,
                notes: vtb::artifacts::read(task.id, "notes"),
                result: vtb::artifacts::read_json($OTHER, "result"),
                policy: vtb::artifacts::read("project", "policy"),
            }
        };
    "#;

    #[tokio::test]
    async fn puts_create_then_replace_on_self_another_task_and_the_project() {
        let server = test_support::sacrum(sacrum()).await;
        let script = format!(
            r#"{WRITE_AND_READ}
            #{{
                first: round.call("  first\n\tnotes ✓\r\n", #{{ passed: true, n: 1 }}, "v1"),
                second: round.call("second", #{{ passed: false, n: 2, none: () }}, "v2\n"),
            }}"#
        );
        let output = run(&server, &script).await;
        assert_eq!(output["first"]["notes"], "  first\n\tnotes ✓\r\n");
        assert_eq!(output["first"]["result"], json!({"passed": true, "n": 1}));
        assert_eq!(output["first"]["policy"], "v1");
        assert_eq!(output["second"]["notes"], "second");
        assert_eq!(
            output["second"]["result"],
            json!({"passed": false, "n": 2, "none": null})
        );
        assert_eq!(output["second"]["policy"], "v2\n");
        for round in ["first", "second"] {
            let infos = output[round]["infos"].as_array().unwrap();
            let summary: Vec<_> = infos
                .iter()
                .map(|info| (info["logical_name"].clone(), info["filename"].clone()))
                .collect();
            assert_eq!(
                summary,
                [
                    (json!("notes"), json!("notes.txt")),
                    (json!("result"), json!("result.json")),
                    (json!("policy"), json!("policy.txt"))
                ]
            );
            for (info, format) in infos.iter().zip(["text", "json", "text"]) {
                assert_eq!(info["metadata"], provenance(format), "{info}");
                assert!(info.get("body").is_none());
            }
        }
        // The replacement updates the artifact the first round created.
        assert_eq!(output["first"]["infos"], {
            let mut first = output["second"]["infos"].clone();
            for info in first.as_array_mut().unwrap() {
                info["updated_at"] = json!("2026-10-01T10:00:00+00:00");
            }
            first
        });
        assert_eq!(
            sacrum_requests(&server, "mutation CreateArtifact(")
                .await
                .len(),
            3
        );
        let created = sacrum_requests(&server, "mutation CreateArtifact(").await;
        let targets: Vec<_> = created
            .iter()
            .map(|vars| (vars["subject_type"].clone(), vars["subject_id"].clone()))
            .collect();
        assert_eq!(
            targets,
            [
                (json!("task"), json!(SELF)),
                (json!("task"), json!(OTHER)),
                (json!("project"), json!(PROJECT))
            ]
        );
        assert_eq!(
            sacrum_requests(&server, "mutation UpdateArtifact(")
                .await
                .len(),
            3
        );
        // The TaskRun is read once per attempt.
        assert_eq!(
            sacrum_requests(&server, "query GetExecution(").await.len(),
            1
        );
    }

    #[tokio::test]
    async fn a_rerun_after_a_failed_script_converges_on_one_artifact_per_name() {
        let server = test_support::sacrum(sacrum()).await;
        let failing = format!(
            r#"{WRITE_AND_READ}
            round.call("draft", #{{ n: 1 }}, "draft");
            throw "failed after writing";"#
        );
        let failed = test_support::run(&server, SELF, &IDS, &failing).await;
        assert!(
            format!("{failed:?}").contains("failed after writing"),
            "{failed:?}"
        );
        let rerun = format!(r#"{WRITE_AND_READ} round.call("final", #{{ n: 2 }}, "final")"#);
        let output = run(&server, &rerun).await;
        assert_eq!(output["notes"], "final");
        assert_eq!(output["result"], json!({"n": 2}));
        assert_eq!(output["policy"], "final");
        let created = sacrum_requests(&server, "mutation CreateArtifact(").await;
        assert_eq!(created.len(), 3, "the rerun replaces, never duplicates");
        assert_eq!(
            sacrum_requests(&server, "mutation UpdateArtifact(")
                .await
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn put_json_stores_json_values_and_rejects_values_json_cannot_hold() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(
            &server,
            r#"
            let value = #{
                max: 9223372036854775807, ratio: 0.5, none: (), text: "quote \" ✓",
                nested: [#{ ok: true }, [], #{}]
            };
            vtb::artifacts::put_json(task.id, "value", value);
            vtb::artifacts::put_json(task.id, "null", ());
            let caught = [];
            for bad in [|| 1, 1.0 / 0.0, [1, 'c'], #{ inner: #{ f: || 2 } }] {
                try { vtb::artifacts::put_json(task.id, "bad", bad); }
                catch (error) { caught.push(error); }
            }
            #{
                value: vtb::artifacts::read_json(task.id, "value"),
                exact: vtb::artifacts::read_json(task.id, "value").max == 9223372036854775807,
                null_body: vtb::artifacts::read(task.id, "null"),
                caught: caught,
            }
            "#,
        )
        .await;
        assert_eq!(
            output["value"],
            json!({
                "max": i64::MAX, "ratio": 0.5, "none": null, "text": "quote \" ✓",
                "nested": [{"ok": true}, [], {}]
            })
        );
        assert_eq!(output["exact"], true);
        assert_eq!(output["null_body"], "null");
        let caught = output["caught"].as_array().unwrap();
        assert_eq!(caught.len(), 4);
        for (error, detail) in caught.iter().zip([
            "type 'Fn' is not JSON",
            "contains a non-finite JSON number",
            "type 'char' is not JSON",
            "type 'Fn' is not JSON",
        ]) {
            assert_eq!(error["kind"], "invalid", "{error}");
            assert_eq!(error["function"], "vtb::artifacts::put_json");
            assert!(
                error["message"].as_str().unwrap().contains(detail),
                "{error}"
            );
        }
        let names: Vec<_> = sacrum_requests(&server, "mutation CreateArtifact(")
            .await
            .iter()
            .map(|vars| vars["logical_name"].clone())
            .collect();
        assert_eq!(names, [json!("value"), json!("null")]);
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_without_calling_sacrum() {
        let server = test_support::sacrum(sacrum()).await;
        for call in [
            r#"vtb::artifacts::put("Project", "notes", "body")"#,
            r#"vtb::artifacts::put("d0000000", "notes", "body")"#,
            r#"vtb::artifacts::put(task.id, "", "body")"#,
            r#"vtb::artifacts::put(task.id, "   ", "body")"#,
            r#"vtb::artifacts::put(task.id, 7, "body")"#,
            r#"vtb::artifacts::put(task.id, "notes", 42)"#,
            r#"vtb::artifacts::put(task.id, "notes", ())"#,
            r#"vtb::artifacts::put(task.id, "notes", "")"#,
            r#"vtb::artifacts::put("project", "notes", " \n\t")"#,
            r#"vtb::artifacts::put_json(task.id, "", 1)"#,
            r#"vtb::artifacts::put_json(task.id, "value", || 1)"#,
            r#"vtb::artifacts::put_json((), "value", 1)"#,
        ] {
            let caught = run(
                &server,
                &format!(
                    "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
                ),
            )
            .await;
            assert_eq!(caught["kind"], "invalid", "{call}: {caught}");
            assert!(
                caught["function"]
                    .as_str()
                    .unwrap()
                    .starts_with("vtb::artifacts::put"),
                "{call}: {caught}"
            );
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn missing_or_foreign_tasks_raise_not_found_without_writing() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(
            &server,
            r#"
            let caught = [];
            for subject in [$FOREIGN, $MISSING] {
                try { vtb::artifacts::put(subject, "notes", "body"); } catch (error) { caught.push(error); }
                try { vtb::artifacts::put_json(subject, "notes", 1); } catch (error) { caught.push(error); }
            }
            caught
            "#,
        )
        .await;
        let caught = output.as_array().unwrap();
        assert_eq!(caught.len(), 4);
        for error in caught {
            assert_eq!(error["kind"], "not_found", "{error}");
            assert!(!error.to_string().contains("Foreign"));
        }
        for operation in [
            "query GetArtifactByLogicalName(",
            "mutation CreateArtifact(",
            "mutation UpdateArtifact(",
        ] {
            assert!(
                sacrum_requests(&server, operation).await.is_empty(),
                "{operation}"
            );
        }
    }

    #[tokio::test]
    async fn failed_writes_raise_catchable_errors_and_a_retry_converges() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(
            &server,
            r#"
            let caught = [];
            for write in [
                || vtb::artifacts::put($UNAUTHORIZED, "notes", "body"),
                || vtb::artifacts::put(task.id, "lookup-down", "body"),
                || vtb::artifacts::put(task.id, "create-down", "body"),
                || vtb::artifacts::put(task.id, "shared", "replaced"),
                || vtb::artifacts::put_json("project", "shared", #{ replaced: true }),
            ] {
                try { write.call(); } catch (error) { caught.push(error); }
            }
            let retried = ();
            for attempt in 0..2 {
                try {
                    if attempt == 0 { throw #{ kind: "transport" }; }
                    retried = vtb::artifacts::put(task.id, "retried", "body");
                } catch (error) {
                    if error.kind != "transport" { throw error; }
                }
            }
            #{
                caught: caught,
                retried: retried.logical_name,
                shared_on_self: vtb::artifacts::read(task.id, "shared"),
                shared_on_project: vtb::artifacts::read("project", "shared"),
            }
            "#,
        )
        .await;
        let caught = output["caught"].as_array().unwrap();
        let kinds: Vec<_> = caught
            .iter()
            .map(|error| (error["kind"].clone(), error["function"].clone()))
            .collect();
        assert_eq!(
            kinds,
            [
                (json!("transport"), json!("vtb::artifacts::put")),
                (json!("transport"), json!("vtb::artifacts::put")),
                (json!("transport"), json!("vtb::artifacts::put")),
                (json!("invalid"), json!("vtb::artifacts::put")),
                (json!("invalid"), json!("vtb::artifacts::put_json")),
            ]
        );
        for (error, detail) in caught.iter().zip([
            "unauthorized",
            "503",
            "503",
            "ambiguous_attachment",
            "ambiguous_attachment",
        ]) {
            assert!(
                error["message"].as_str().unwrap().contains(detail),
                "{error}"
            );
        }
        assert_eq!(output["retried"], "retried");
        // A refused replacement leaves the shared artifact as it was.
        assert_eq!(output["shared_on_self"], "shared body");
        assert_eq!(output["shared_on_project"], "shared body");
    }
}
