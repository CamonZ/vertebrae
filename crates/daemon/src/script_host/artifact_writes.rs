//! `vtb::artifacts` writes: `put`, `put_json` and `delete`.
//!
//! A write is the scoped lookup by subject and logical name followed by an
//! update of what that lookup found, or a create when it found nothing, so
//! sequential reruns converge on one attachment. Writes apply immediately
//! and stay if the script later fails. Each one records the execution that
//! wrote it in the attachment's provenance. `delete` removes only what the
//! same scoped lookup finds.

use rhai::{Dynamic, Module};
use serde_json::Value;
use vertebrae_core::ServiceError;
use vertebrae_core::models::{
    ArtifactLinkMetadata, CreateArtifactInput, GetArtifactByLogicalNameInput, UpdateArtifactInput,
};

use super::artifacts::{NAMESPACE, address, artifact_info, named_artifact};
use super::task_writes::require_task;
use super::{map_argument, read, set_host_fn2, set_host_fn3, set_host_fn4, string_argument};
use crate::script_worker::{HostContext, HostError, HostErrorKind, rhai_to_json};

pub(super) fn register(module: &mut Module, host: &HostContext) {
    set_host_fn3(module, host, NAMESPACE, "put", put);
    set_host_fn3(module, host, NAMESPACE, "put_json", put_json);
    set_host_fn4(module, host, NAMESPACE, "put", put_with_options);
    set_host_fn4(module, host, NAMESPACE, "put_json", put_json_with_options);
    set_host_fn2(module, host, NAMESPACE, "delete", delete);
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
    put_with_options(host, subject, name, body, rhai::Map::new().into())
}

fn put_with_options(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
    body: Dynamic,
    options: Dynamic,
) -> Result<Dynamic, HostError> {
    let address = address(host, subject, name)?;
    let body = string_argument(body, "Artifact body")?;
    let options = WriteOptions::parse(options, Format::Text)?;
    upsert(host, address, body, Format::Text, options)
}

/// Serialization need not keep the script's key order or number formatting.
fn put_json(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
    value: Dynamic,
) -> Result<Dynamic, HostError> {
    put_json_with_options(host, subject, name, value, rhai::Map::new().into())
}

fn put_json_with_options(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
    value: Dynamic,
    options: Dynamic,
) -> Result<Dynamic, HostError> {
    let address = address(host, subject, name)?;
    let value = rhai_to_json(&value)
        .map_err(|error| HostError::invalid(format!("Artifact value {error}")))?;
    let options = WriteOptions::parse(options, Format::Json)?;
    upsert(host, address, value.to_string(), Format::Json, options)
}

struct WriteOptions {
    filename: Option<String>,
    metadata: ArtifactLinkMetadata,
}

impl WriteOptions {
    /// Validate all script-controlled fields before resolving provenance or
    /// looking up the subject. Even a refused write must make no requests.
    fn parse(options: Dynamic, format: Format) -> Result<Self, HostError> {
        let mut parsed = Self {
            filename: None,
            metadata: ArtifactLinkMetadata::new("artifact", format.name(), "rhai", "raw"),
        };
        for (key, value) in map_argument(options, "Artifact options")? {
            match key.as_str() {
                "filename" | "content_kind" | "format" | "presentation" => {
                    let text = string_argument(value, &key)?;
                    if text.trim().is_empty() {
                        return Err(HostError::invalid(format!("{key} must not be blank")));
                    }
                    match key.as_str() {
                        "filename" => {
                            if text.contains(['/', '\\']) {
                                return Err(HostError::invalid(
                                    "filename must not contain a path separator",
                                ));
                            }
                            parsed.filename = Some(text);
                        }
                        "content_kind" => parsed.metadata.content_kind = text,
                        "format" => parsed.metadata.format = text,
                        "presentation" => parsed.metadata.presentation = text,
                        _ => unreachable!(),
                    }
                }
                "extensions" => {
                    for (key, value) in map_argument(value, "Artifact extensions")? {
                        if matches!(key.as_str(), "execution_id" | "task_run_id" | "task_id") {
                            return Err(HostError::invalid(format!(
                                "Reserved artifact extension {key:?}"
                            )));
                        }
                        let value = rhai_to_json(&value).map_err(|error| {
                            HostError::invalid(format!("Artifact extension {key:?} {error}"))
                        })?;
                        parsed.metadata = parsed.metadata.with_extension(key.to_string(), value);
                    }
                }
                other => {
                    return Err(HostError::invalid(format!(
                        "Unknown artifact option {other:?}"
                    )));
                }
            }
        }
        Ok(parsed)
    }
}

fn upsert(
    host: &HostContext,
    address: GetArtifactByLogicalNameInput,
    body: String,
    format: Format,
    options: WriteOptions,
) -> Result<Dynamic, HostError> {
    // Sacrum reads a blank body as a missing one and rejects it; refuse it
    // before any request.
    if body.trim().is_empty() {
        return Err(HostError::invalid("Artifact body must not be blank"));
    }
    if address.subject_type == "task" {
        require_task(host, &address.subject_id, ServiceError::task_not_found)?;
    }
    let metadata = provenance(host, options.metadata)?;
    let filename = options
        .filename
        .unwrap_or_else(|| format!("{}.{}", address.logical_name, format.extension()));
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

/// Sacrum deletes the artifact with every link to it; artifacts are created
/// per subject, so that is this subject's attachment.
fn delete(host: &HostContext, subject: Dynamic, name: Dynamic) -> Result<Dynamic, HostError> {
    let address = address(host, subject, name)?;
    if address.subject_type == "task" {
        require_task(host, &address.subject_id, ServiceError::task_not_found)?;
    }
    let existing = read(host, |services, _| {
        named_artifact(services, address.clone())
    })?;
    let Some(artifact) = existing else {
        return Err(HostError::new(
            HostErrorKind::NotFound,
            format!(
                "No artifact named '{}' on {}",
                address.logical_name,
                subject_label(&address)
            ),
        ));
    };
    host.call(|services, _| services.artifacts().delete_artifact(&artifact.id))?;
    Ok(Dynamic::UNIT)
}

fn subject_label(address: &GetArtifactByLogicalNameInput) -> String {
    if address.subject_type == "project" {
        "the project".into()
    } else {
        format!("task {}", address.subject_id)
    }
}

/// The version-1 envelope for a script write. The TaskRun is read once per
/// attempt: Sacrum's dispatch carries only the execution and task IDs.
fn provenance(
    host: &HostContext,
    metadata: ArtifactLinkMetadata,
) -> Result<ArtifactLinkMetadata, HostError> {
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
    Ok(metadata
        .with_extension("execution_id", host.execution_id().into())
        .with_extension(
            "task_run_id",
            task_run_id.map_or(Value::Null, Value::String),
        )
        .with_extension("task_id", host.task_id().into()))
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
            } else if query.contains("mutation DeleteArtifact(") {
                let Some(artifact) = state
                    .links
                    .iter()
                    .find(|link| link.artifact["id"] == vars["id"])
                    .map(|link| link.artifact.clone())
                else {
                    return graphql_error("not_found");
                };
                if artifact["logical_name"] == "delete-down" {
                    return unavailable();
                }
                // Like Sacrum, every link to the artifact goes with it.
                state.links.retain(|link| link.artifact["id"] != vars["id"]);
                json!({"deleteArtifact": artifact})
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
    async fn rendered_options_create_and_replace_the_same_artifact() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(&server, r#"
            let first = vtb::artifacts::put(task.id, "flow", "version: 1", #{
                filename: "diagram.flow.yaml", content_kind: "flow", format: "yaml",
                presentation: "rendered", extensions: #{ flow_format: "flow-v1", head_sha: "abc" }
            });
            let second = vtb::artifacts::put_json(task.id, "flow", #{ version: 1 }, #{
                filename: "diagram.flow.json", content_kind: "flow", presentation: "rendered",
                extensions: #{ flow_format: "flow-v1", nested: [(), #{ ok: true }], head_sha: "def" }
            });
            #{ first: first, second: second, body: vtb::artifacts::read_json(task.id, "flow") }
        "#).await;
        assert_eq!(output["first"]["id"], output["second"]["id"]);
        assert_eq!(output["body"], json!({"version": 1}));
        for (round, format, filename, sha) in [
            ("first", "yaml", "diagram.flow.yaml", "abc"),
            ("second", "json", "diagram.flow.json", "def"),
        ] {
            let mut expected = provenance(format);
            expected["content_kind"] = json!("flow");
            expected["presentation"] = json!("rendered");
            expected["extensions"]["flow_format"] = json!("flow-v1");
            expected["extensions"]["head_sha"] = json!(sha);
            if round == "second" {
                expected["extensions"]["nested"] = json!([null, {"ok": true}]);
            }
            assert_eq!(output[round]["filename"], filename);
            assert_eq!(output[round]["metadata"], expected);
            let operation = if round == "first" {
                "mutation CreateArtifact("
            } else {
                "mutation UpdateArtifact("
            };
            let requests = sacrum_requests(&server, operation).await;
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["filename"], filename);
            assert_eq!(
                serde_json::from_str::<Value>(requests[0]["metadata"].as_str().unwrap()).unwrap(),
                expected
            );
            if round == "second" {
                assert_eq!(requests[0]["id"], output["first"]["id"]);
                assert_eq!(requests[0]["body"], r#"{"version":1}"#);
            } else {
                assert_eq!(requests[0]["body"], "version: 1");
            }
        }
    }

    #[tokio::test]
    async fn documented_flow_example_runs_without_a_command_host_call() {
        let doc = include_str!(
            "../../../../docs/agent-context/workflows/steps/execute/host-artifact-writes.md"
        );
        let script = doc
            .split("```rhai")
            .nth(2)
            .unwrap()
            .split("```")
            .next()
            .unwrap();
        let server = test_support::sacrum(sacrum()).await;
        let info = run(&server, script).await;
        assert_eq!(info["filename"], "pr-flow.flow.yaml");
        assert_eq!(info["metadata"]["content_kind"], "flow");
        assert_eq!(info["metadata"]["presentation"], "rendered");
        assert_eq!(info["metadata"]["extensions"]["flow_format"], "flow-v1");
    }

    #[tokio::test]
    async fn empty_options_and_three_arguments_have_identical_wire_requests() {
        let mut traces = Vec::new();
        for options in ["", ", #{}"] {
            let server = test_support::sacrum(sacrum()).await;
            run(
                &server,
                &format!(
                    r#"
                vtb::artifacts::put(task.id, "notes", "first"{options});
                vtb::artifacts::put(task.id, "notes", "second"{options});
                vtb::artifacts::put_json("project", "value", #{{ n: 1 }}{options});
                vtb::artifacts::put_json("project", "value", (){options})
            "#
                ),
            )
            .await;
            traces.push(
                server
                    .received_requests()
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
                    .collect::<Vec<_>>(),
            );
        }
        assert_eq!(
            traces[0], traces[1],
            "including read order and provenance lookup"
        );
    }

    #[tokio::test]
    async fn invalid_options_make_no_sacrum_requests_for_either_overload() {
        let server = test_support::sacrum(sacrum()).await;
        for options in [
            "()",
            "42",
            "[]",
            r##"#{ typo: "x" }"##,
            r##"#{ origin: "forged" }"##,
            r##"#{ version: 1 }"##,
            r##"#{ filename: "" }"##,
            r##"#{ filename: " \n\t" }"##,
            r##"#{ filename: "dir/file" }"##,
            r##"#{ filename: "dir\\file" }"##,
            r##"#{ extensions: () }"##,
            r##"#{ extensions: [] }"##,
            r##"#{ extensions: "x" }"##,
            r##"#{ extensions: #{ execution_id: "forged" } }"##,
            r##"#{ extensions: #{ task_run_id: () } }"##,
            r##"#{ extensions: #{ task_id: "forged" } }"##,
            r##"#{ extensions: #{ nested: [#{ bad: || 1 }] } }"##,
            r##"#{ extensions: #{ bad: 1.0 / 0.0 } }"##,
            r##"#{ extensions: #{ bad: 'c' } }"##,
        ]
        .into_iter()
        .map(str::to_owned)
        .chain(
            ["filename", "content_kind", "format", "presentation"]
                .into_iter()
                .flat_map(|key| {
                    ["42", "()", "[]", "#{}", "true", r#"" \n\t""#]
                        .map(|value| format!("#{{ {key}: {value} }}"))
                }),
        ) {
            for (function, body) in [("put", r#""body""#), ("put_json", "#{ n: 1 }")] {
                let call =
                    format!("vtb::artifacts::{function}(task.id, \"notes\", {body}, {options})");
                let caught = run(&server, &format!(
                    "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
                )).await;
                assert_eq!(caught["kind"], "invalid", "{call}: {caught}");
                assert_eq!(caught["function"], format!("vtb::artifacts::{function}"));
            }
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(32))]

        // Independent lexical oracle over arbitrary Unicode, including blank
        // strings and either platform's path separator. No service is involved.
        #[test]
        fn filename_validation_matches_the_contract(filename in ".{0,80}") {
            let options = rhai::Map::from_iter([("filename".into(), filename.clone().into())]);
            let result = super::WriteOptions::parse(options.into(), super::Format::Text);
            let valid = !filename.chars().all(char::is_whitespace)
                && !filename.chars().any(|c| c == '/' || c == '\\');
            proptest::prop_assert_eq!(result.is_ok(), valid);
            if let Ok(parsed) = result {
                proptest::prop_assert_eq!(parsed.filename, Some(filename));
            }
        }

        // Model: each logical name owns one stable ID; the last write replaces
        // body, filename and metadata completely. Compare each observed step
        // and its create/update request against the model, across both arities
        // and serializers. All effects stay in a disposable Wiremock server.
        #[test]
        fn generated_write_sequences_match_last_write_wins_model(
            actions in proptest::collection::vec((0u8..3, proptest::bool::ANY, 0u8..32, "[a-z]{1,16}"), 1..9)
        ) {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
                let server = test_support::sacrum(sacrum()).await;
                let mut model = std::collections::HashMap::new();
                for (step, (name, json_body, mask, body)) in actions.into_iter().enumerate() {
                    let name = format!("name-{name}");
                    let format = if json_body { "json" } else { "text" };
                    let mut metadata = provenance(format);
                    let mut filename = format!("{name}.{}", if json_body { "json" } else { "txt" });
                    let mut fields = Vec::new();
                    for (bit, key, value) in [
                        (1, "filename", "custom.flow.yaml"), (2, "content_kind", "flow"),
                        (4, "format", "yaml"), (8, "presentation", "rendered"),
                    ] {
                        if mask & bit != 0 {
                            fields.push(format!("{key}: {value:?}"));
                            if key == "filename" { filename = value.into(); }
                            else { metadata[key] = json!(value); }
                        }
                    }
                    if mask & 16 != 0 {
                        fields.push("extensions: #{ flow_format: \"flow-v1\", head: [1, (), true] }".into());
                        metadata["extensions"]["flow_format"] = json!("flow-v1");
                        metadata["extensions"]["head"] = json!([1, null, true]);
                    }
                    let options = if mask == 0 { String::new() } else { format!(", #{{ {} }}", fields.join(", ")) };
                    let function = if json_body { "put_json" } else { "put" };
                    let stored_body = if json_body { serde_json::to_string(&body).unwrap() } else { body.clone() };
                    let output = run(&server, &format!(r#"
                        let info = vtb::artifacts::{function}(task.id, "{name}", "{body}"{options});
                        #{{ info: info, body: vtb::artifacts::read(task.id, "{name}") }}
                    "#)).await;
                    assert_eq!(output["body"], stored_body);
                    assert_eq!(output["info"]["filename"], filename);
                    assert_eq!(output["info"]["metadata"], metadata);
                    let id = output["info"]["id"].clone();
                    let previous = model.insert(name, id.clone());
                    let operation = if let Some(previous) = previous {
                        assert_eq!(id, previous);
                        "mutation UpdateArtifact("
                    } else { "mutation CreateArtifact(" };
                    let requests = sacrum_requests(&server, operation).await;
                    assert_eq!(requests.len(), if operation.contains("Create") { model.len() } else { step + 1 - model.len() });
                    let request = requests.last().unwrap();
                    if operation.contains("Update") { assert_eq!(request["id"], id); }
                    assert_eq!(request["filename"], filename);
                    assert_eq!(request["body"], stored_body);
                    assert_eq!(serde_json::from_str::<Value>(request["metadata"].as_str().unwrap()).unwrap(), metadata);
                }
                assert_eq!(sacrum_requests(&server, "mutation CreateArtifact(").await.len(), model.len());
            });
        }
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
                for options in [false, true] {
                    try {
                        if options { vtb::artifacts::put_json(task.id, "bad", bad, #{}); }
                        else { vtb::artifacts::put_json(task.id, "bad", bad); }
                    } catch (error) { caught.push(error); }
                }
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
        assert_eq!(caught.len(), 8);
        for (error, detail) in caught.iter().zip([
            "type 'Fn' is not JSON",
            "type 'Fn' is not JSON",
            "contains a non-finite JSON number",
            "contains a non-finite JSON number",
            "type 'char' is not JSON",
            "type 'char' is not JSON",
            "type 'Fn' is not JSON",
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

    #[tokio::test]
    async fn delete_removes_one_named_artifact_and_a_rerun_converges() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(
            &server,
            r#"
            let gone = |subject, name| {
                let outcome = "deleted";
                try { vtb::artifacts::delete(subject, name); }
                catch (error) { if error.kind != "not_found" { throw error; } outcome = "already gone"; }
                outcome
            };
            vtb::artifacts::put(task.id, "notes", "body");
            vtb::artifacts::put($OTHER, "notes", "kept");
            vtb::artifacts::put("project", "policy", "body");
            #{
                outcomes: [
                    gone.call(task.id, "notes"), gone.call(task.id, "notes"),
                    gone.call("project", "policy"), gone.call("project", "policy"),
                ],
                notes: vtb::artifacts::lookup(task.id, "notes"),
                other: vtb::artifacts::read($OTHER, "notes"),
                policy: vtb::artifacts::lookup("project", "policy"),
            }
            "#,
        )
        .await;
        assert_eq!(
            output,
            json!({
                "outcomes": ["deleted", "already gone", "deleted", "already gone"],
                "notes": null, "other": "kept", "policy": null
            })
        );
        assert_eq!(
            sacrum_requests(&server, "mutation DeleteArtifact(")
                .await
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn delete_errors_are_catchable_and_never_reach_another_subject() {
        let server = test_support::sacrum(sacrum()).await;
        let output = run(
            &server,
            r#"
            vtb::artifacts::put(task.id, "delete-down", "body");
            let caught = [];
            for attempt in [
                || vtb::artifacts::delete("Project", "notes"),
                || vtb::artifacts::delete(task.id, ""),
                || vtb::artifacts::delete(task.id, 7),
                || vtb::artifacts::delete($FOREIGN, "notes"),
                || vtb::artifacts::delete($MISSING, "notes"),
                || vtb::artifacts::delete(task.id, "absent"),
                || vtb::artifacts::delete($UNAUTHORIZED, "notes"),
                || vtb::artifacts::delete(task.id, "delete-down"),
            ] {
                try { attempt.call(); } catch (error) { caught.push(error); }
            }
            caught
            "#,
        )
        .await;
        let kinds: Vec<_> = output
            .as_array()
            .unwrap()
            .iter()
            .map(|error| {
                assert_eq!(error["function"], "vtb::artifacts::delete", "{error}");
                error["kind"].clone()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "invalid",
                "invalid",
                "invalid",
                "not_found",
                "not_found",
                "not_found",
                "transport",
                "transport"
            ]
        );
        assert!(
            output[5]["message"]
                .as_str()
                .unwrap()
                .contains(&format!("No artifact named 'absent' on task {SELF}")),
            "{output}"
        );
        let deletes = sacrum_requests(&server, "mutation DeleteArtifact(").await;
        assert_eq!(deletes.len(), 1, "only the failing delete was sent");
    }
}
