//! `vtb::artifacts` reads: `list`, `lookup`, `read` and `read_json`. The
//! writes, `put` and `put_json`, are in `artifact_writes`.
//!
//! A subject is a task UUID in the execution's project or the literal
//! `"project"` for the project's own attachments. Artifacts are addressed by
//! subject plus logical name, never by artifact ID, and a name never falls
//! back to another subject. Anything absent or outside the project reads as
//! `()`.

use rhai::{Array, Dynamic, Map, Module};
use vertebrae_core::models::{Artifact, GetArtifactByLogicalNameInput, ListArtifactInput};
use vertebrae_core::{ServiceError, ServiceResult, VertebraeServices};

use super::tasks::scoped_task;
use super::{read, set_host_fn, set_host_fn2, string_argument, timestamp, uuid_text};
use crate::script_worker::{HostContext, HostError, json_to_rhai};

pub(super) const NAMESPACE: &str = "vtb::artifacts";

/// Sacrum caps artifact pages at this size, so a shorter page is the last.
const PAGE: i32 = 50;

pub(super) fn module(host: &HostContext) -> Module {
    let mut module = Module::new();
    set_host_fn(&mut module, host, NAMESPACE, "list", list);
    set_host_fn2(&mut module, host, NAMESPACE, "lookup", lookup);
    set_host_fn2(&mut module, host, NAMESPACE, "read", read_body);
    set_host_fn2(&mut module, host, NAMESPACE, "read_json", read_json);
    super::artifact_writes::register(&mut module, host);
    module
}

enum Subject {
    Project,
    Task(String),
}

impl Subject {
    fn parse(value: Dynamic) -> Result<Self, HostError> {
        let text = string_argument(value, "Artifact subject")?;
        if text == "project" {
            return Ok(Self::Project);
        }
        uuid_text(text, "Artifact subject")
            .map(Self::Task)
            .map_err(|error| HostError::invalid(format!("{} or \"project\"", error.message)))
    }

    /// The attachment target Sacrum knows this subject by.
    fn target<'a>(&'a self, project: &'a str) -> (&'static str, &'a str) {
        match self {
            Self::Project => ("project", project),
            Self::Task(id) => ("task", id),
        }
    }
}

/// A validated subject-plus-name address. The project is the execution's.
pub(super) fn address(
    host: &HostContext,
    subject: Dynamic,
    name: Dynamic,
) -> Result<GetArtifactByLogicalNameInput, HostError> {
    let subject = Subject::parse(subject)?;
    let name = string_argument(name, "Artifact name")?;
    let (subject_type, subject_id) = subject.target(host.project_id());
    let input = GetArtifactByLogicalNameInput::new(subject_type, subject_id, name);
    input
        .validate()
        .map_err(|error| HostError::invalid(format!("Invalid artifact name: {error}")))?;
    Ok(input)
}

fn list(host: &HostContext, subject: Dynamic) -> Result<Dynamic, HostError> {
    let subject = Subject::parse(subject)?;
    let listed = read(host, |services, project| async move {
        match &subject {
            Subject::Project => Ok(Some(
                all_pages(|page| services.artifacts().list_artifacts(page)).await?,
            )),
            Subject::Task(id) => {
                if scoped_task(services, project, id).await?.is_none() {
                    return Ok(None);
                }
                Ok(Some(
                    all_pages(|page| services.artifacts().list_task_artifacts(id, page)).await?,
                ))
            }
        }
    })?;
    let Some(listed) = listed else {
        return Ok(Dynamic::UNIT);
    };
    // Both listings are Sacrum subject queries: each row is one of this
    // subject's links, carrying that link's logical name. Unnamed links are
    // not addressable, so they are left out.
    listed
        .iter()
        .filter(|artifact| artifact.logical_name.is_some())
        .map(artifact_info)
        .collect::<Result<Array, _>>()
        .map(Dynamic::from_array)
}

async fn all_pages<F>(mut page: impl FnMut(ListArtifactInput) -> F) -> ServiceResult<Vec<Artifact>>
where
    F: std::future::Future<Output = ServiceResult<Vec<Artifact>>>,
{
    let mut artifacts = Vec::new();
    loop {
        let offset = i32::try_from(artifacts.len())
            .map_err(|_| ServiceError::invalid_input("Too many artifacts to page through"))?;
        let rows = page(
            ListArtifactInput::new()
                .with_limit(PAGE)
                .with_offset(offset),
        )
        .await?;
        let last = rows.len() < PAGE as usize;
        artifacts.extend(rows);
        if last {
            return Ok(artifacts);
        }
    }
}

fn lookup(host: &HostContext, subject: Dynamic, name: Dynamic) -> Result<Dynamic, HostError> {
    let input = address(host, subject, name)?;
    match read(host, |services, _| named_artifact(services, input))? {
        Some(artifact) => artifact_info(&artifact),
        None => Ok(Dynamic::UNIT),
    }
}

fn read_body(host: &HostContext, subject: Dynamic, name: Dynamic) -> Result<Dynamic, HostError> {
    let input = address(host, subject, name)?;
    let artifact = read(host, |services, _| named_artifact(services, input))?;
    Ok(artifact.map_or(Dynamic::UNIT, |artifact| artifact.body.into()))
}

/// Parse after the host call: a malformed body is the script's `invalid`
/// input, not a backend failure.
fn read_json(host: &HostContext, subject: Dynamic, name: Dynamic) -> Result<Dynamic, HostError> {
    let input = address(host, subject, name)?;
    let what = format!(
        "Artifact {:?} on {}",
        input.logical_name, input.subject_type
    );
    let Some(artifact) = read(host, |services, _| named_artifact(services, input))? else {
        return Ok(Dynamic::UNIT);
    };
    let value: serde_json::Value = serde_json::from_str(&artifact.body)
        .map_err(|error| HostError::invalid(format!("{what} is not valid JSON: {error}")))?;
    if let Some(integer) = out_of_range_integer(&artifact.body) {
        return Err(HostError::invalid(format!(
            "{what}: integer {integer} is outside Rhai's signed 64-bit integer range"
        )));
    }
    json_to_rhai(&value, "").map_err(|error| HostError::invalid(format!("{what}{error}")))
}

/// Sacrum answers a missing name, a foreign subject and a foreign project
/// alike with GraphQL `not_found`, which the client reports as
/// `TaskNotFound`.
pub(super) async fn named_artifact(
    services: &VertebraeServices,
    input: GetArtifactByLogicalNameInput,
) -> ServiceResult<Option<Artifact>> {
    match services
        .artifacts()
        .get_artifact_by_logical_name(input)
        .await
    {
        Ok(artifact) => Ok(Some(artifact)),
        Err(ServiceError::TaskNotFound { .. } | ServiceError::ArtifactNotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// serde_json parses integers beyond `u64` as floats, which would silently
/// round them. Scan the already-valid text for integer literals that do not
/// fit Rhai's `INT` so they fail instead.
fn out_of_range_integer(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let (mut index, mut in_string) = (0, false);
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if in_string => index += 1,
            b'"' => in_string = !in_string,
            b'-' | b'0'..=b'9' if !in_string => {
                let start = index;
                while bytes.get(index + 1).is_some_and(|byte| {
                    matches!(byte, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                }) {
                    index += 1;
                }
                let token = &text[start..=index];
                if !token.contains(['.', 'e', 'E']) && token.parse::<rhai::INT>().is_err() {
                    return Some(token);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// The `ArtifactInfo` map: metadata only, never the body.
pub(super) fn artifact_info(artifact: &Artifact) -> Result<Dynamic, HostError> {
    let metadata = match &artifact.metadata {
        Some(metadata) => {
            let value = serde_json::to_value(metadata)
                .map_err(|error| HostError::invalid(format!("Artifact metadata: {error}")))?;
            json_to_rhai(&value, "")
                .map_err(|error| HostError::invalid(format!("Artifact metadata{error}")))?
        }
        None => Dynamic::UNIT,
    };
    let mut map = Map::new();
    map.insert("id".into(), artifact.id.clone().into());
    map.insert("filename".into(), artifact.filename.clone().into());
    map.insert(
        "logical_name".into(),
        artifact.logical_name.clone().unwrap_or_default().into(),
    );
    map.insert("metadata".into(), metadata);
    map.insert("created_at".into(), timestamp(artifact.created_at));
    map.insert("updated_at".into(), timestamp(artifact.updated_at));
    Ok(map.into())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use wiremock::{MockServer, Request, Respond, ResponseTemplate};

    use super::super::test_support::{self, OTHER_PROJECT, PROJECT, sacrum_requests};
    use crate::actors::step_executor::StepResult;

    const SELF: &str = "a0000000-0000-4000-8000-000000000001";
    const OTHER: &str = "a0000000-0000-4000-8000-000000000002";
    const MANY: &str = "a0000000-0000-4000-8000-000000000003";
    const FOREIGN: &str = "a0000000-0000-4000-8000-000000000004";
    const MISSING: &str = "a0000000-0000-4000-8000-000000000005";
    const FAILING: &str = "a0000000-0000-4000-8000-000000000006";
    const FOREIGN_ARTIFACT: &str = "c0000000-0000-4000-8000-0000000000ff";
    const PLAN_BODY: &str = "  # Plan\n\n\tstep one  \n✓ done\r\n";

    /// Tasks Sacrum knows: (id, project).
    const TASKS: [(&str, &str); 5] = [
        (SELF, PROJECT),
        (OTHER, PROJECT),
        (MANY, PROJECT),
        (FAILING, PROJECT),
        (FOREIGN, OTHER_PROJECT),
    ];

    struct Link {
        project: &'static str,
        subject_type: &'static str,
        subject_id: &'static str,
        artifact: Value,
    }

    fn artifact(id: String, name: Option<&str>, body: &str) -> Value {
        json!({
            "id": id, "filename": format!("{}.txt", name.unwrap_or("unnamed")),
            "body": body, "logical_name": name, "metadata": null,
            "inserted_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T11:00:00Z"
        })
    }

    fn links() -> Vec<Link> {
        let link = |project, subject_type, subject_id, id: u32, name, body: &str| Link {
            project,
            subject_type,
            subject_id,
            artifact: artifact(format!("c0000000-0000-4000-8000-{id:012x}"), name, body),
        };
        let mut plan = link(PROJECT, "task", SELF, 1, Some("plan"), PLAN_BODY);
        plan.artifact["metadata"] = json!({
            "version": 1, "content_kind": "artifact", "format": "text", "origin": "rhai",
            "presentation": "raw", "extensions": {"task_id": SELF, "attempt": 2}
        });
        let mut links = vec![
            plan,
            link(PROJECT, "task", SELF, 2, None, "unnamed"),
            link(
                PROJECT,
                "task",
                SELF,
                3,
                Some("outcome"),
                r#"{"max": 9223372036854775807, "min": -9223372036854775808,
                    "exact": 9007199254740993, "none": null, "text": "1e400 \" 99999999999999999999",
                    "nested": [{"ok": true, "ratio": 0.5}, [], {}]}"#,
            ),
            link(PROJECT, "task", SELF, 4, Some("null"), "null"),
            link(PROJECT, "task", SELF, 5, Some("broken"), r#"{"a": [1,}"#),
            link(
                PROJECT,
                "task",
                SELF,
                6,
                Some("above_i64"),
                "[9223372036854775808]",
            ),
            link(
                PROJECT,
                "task",
                SELF,
                7,
                Some("beyond_u64"),
                r#"{"n": 100000000000000000000}"#,
            ),
            link(PROJECT, "task", OTHER, 8, Some("result"), "other result"),
            link(PROJECT, "project", PROJECT, 9, Some("plan"), "project plan"),
            link(PROJECT, "project", PROJECT, 10, Some("shared"), "shared"),
            link(PROJECT, "project", PROJECT, 11, None, "unnamed"),
            Link {
                project: OTHER_PROJECT,
                subject_type: "task",
                subject_id: FOREIGN,
                artifact: artifact(FOREIGN_ARTIFACT.into(), Some("plan"), "Foreign secret"),
            },
            link(
                OTHER_PROJECT,
                "project",
                OTHER_PROJECT,
                12,
                Some("shared"),
                "Foreign secret",
            ),
        ];
        // Enough for two full pages and a partial one.
        links.extend((0..103).map(|n| link(PROJECT, "task", MANY, 100 + n, Some("many"), "many")));
        links
    }

    /// Answers the Sacrum GraphQL reads the artifact host functions make,
    /// scoping links the way Sacrum does.
    struct Sacrum;

    impl Respond for Sacrum {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let vars = &body["variables"];
            let not_found = || {
                ResponseTemplate::new(200).set_body_json(json!({
                    "data": null, "errors": [{"message": "not_found"}]
                }))
            };
            let page = |subject_type: &str, subject_id: &str, project: &str| {
                let offset = vars["offset"].as_u64().unwrap() as usize;
                let limit = vars["limit"].as_u64().unwrap().min(50) as usize;
                links()
                    .into_iter()
                    .filter(|link| {
                        link.project == project
                            && link.subject_type == subject_type
                            && link.subject_id == subject_id
                    })
                    .map(|link| link.artifact)
                    .skip(offset)
                    .take(limit)
                    .collect::<Vec<_>>()
            };
            let data = if query.contains("query GetArtifactByLogicalName(") {
                if vars["subject_id"] == FAILING {
                    return ResponseTemplate::new(503).set_body_string("upstream down");
                }
                if vars["logical_name"] == "denied" {
                    return ResponseTemplate::new(200).set_body_json(json!({
                        "data": null, "errors": [{"message": "unauthorized"}]
                    }));
                }
                let Some(link) = links().into_iter().find(|link| {
                    link.project == vars["project_id"]
                        && link.subject_type == vars["subject_type"]
                        && link.subject_id == vars["subject_id"]
                        && link.artifact["logical_name"] == vars["logical_name"]
                }) else {
                    return not_found();
                };
                json!({"artifactByLogicalName": link.artifact})
            } else if query.contains("query ListArtifacts(") {
                let project = vars["project_id"].as_str().unwrap();
                json!({"project": {"artifacts": page("project", project, project)}})
            } else if query.contains("query ListTaskArtifacts(") {
                let id = vars["task_id"].as_str().unwrap();
                if id == FAILING {
                    return ResponseTemplate::new(503).set_body_string("upstream down");
                }
                let project = TASKS.iter().find(|(task, _)| *task == id).unwrap().1;
                json!({"task": {"artifacts": page("task", id, project)}})
            } else if query.contains("query GetTask(") {
                let id = vars["id"].as_str().unwrap();
                let Some((_, project)) = TASKS.iter().find(|(task, _)| *task == id) else {
                    return not_found();
                };
                json!({"task": {
                    "id": id, "project_id": project, "title": "Task", "level": "task",
                    "tags": [], "archived": false, "sections": [], "code_refs": [],
                    "inserted_at": "2026-10-01T10:00:00Z"
                }})
            } else {
                panic!("unexpected Sacrum request: {query}");
            };
            ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
        }
    }

    const IDS: [(&str, &str); 8] = [
        ("SELF", SELF),
        ("OTHER", OTHER),
        ("MANY", MANY),
        // Before `FOREIGN`, which is its prefix.
        ("FOREIGN_ARTIFACT", FOREIGN_ARTIFACT),
        ("FOREIGN", FOREIGN),
        ("MISSING", MISSING),
        ("FAILING", FAILING),
        ("PROJECT", PROJECT),
    ];

    async fn run(server: &MockServer, script: &str) -> StepResult {
        test_support::run(server, SELF, &IDS, script).await
    }

    async fn output(server: &MockServer, script: &str) -> Value {
        test_support::completed(run(server, script).await, script)
    }

    #[tokio::test]
    async fn reads_bodies_on_self_another_task_and_the_project_by_logical_name() {
        let server = test_support::sacrum(Sacrum).await;
        let read = output(
            &server,
            r#"
            let names = |infos| infos.map(|info| info.logical_name);
            #{
                plan: vtb::artifacts::read(task.id, "plan"),
                other: vtb::artifacts::read($OTHER, "result"),
                project: vtb::artifacts::read("project", "plan"),
                uppercase: vtb::artifacts::read(task.id.to_upper(), "plan"),
                info: vtb::artifacts::lookup(task.id, "plan"),
                no_metadata: vtb::artifacts::lookup("project", "shared").metadata,
                self_names: names.call(vtb::artifacts::list(task.id)),
                project_names: names.call(vtb::artifacts::list("project")),
                other_list: vtb::artifacts::list($OTHER).len(),
                many: vtb::artifacts::list($MANY).len(),
            }
            "#,
        )
        .await;
        assert_eq!(read["plan"], PLAN_BODY);
        assert_eq!(read["other"], "other result");
        assert_eq!(read["project"], "project plan");
        assert_eq!(read["uppercase"], PLAN_BODY);
        assert_eq!(
            read["info"],
            json!({
                "id": "c0000000-0000-4000-8000-000000000001", "filename": "plan.txt",
                "logical_name": "plan",
                "metadata": {
                    "version": 1, "content_kind": "artifact", "format": "text",
                    "origin": "rhai", "presentation": "raw",
                    "extensions": {"task_id": SELF, "attempt": 2}
                },
                "created_at": "2026-10-01T10:00:00+00:00",
                "updated_at": "2026-10-01T11:00:00+00:00"
            })
        );
        assert_eq!(read["no_metadata"], Value::Null);
        // Unnamed links are left out of listings.
        assert_eq!(
            read["self_names"],
            json!([
                "plan",
                "outcome",
                "null",
                "broken",
                "above_i64",
                "beyond_u64"
            ])
        );
        assert_eq!(read["project_names"], json!(["plan", "shared"]));
        assert_eq!(read["other_list"], 1);
        assert_eq!(read["many"], 103);
        // Listings follow every page; a short page ends the listing.
        let pages = sacrum_requests(&server, "query ListTaskArtifacts(").await;
        let many: Vec<_> = pages
            .iter()
            .filter(|vars| vars["task_id"] == MANY)
            .map(|vars| (vars["offset"].clone(), vars["limit"].clone()))
            .collect();
        assert_eq!(
            many,
            [
                (json!(0), json!(50)),
                (json!(50), json!(50)),
                (json!(100), json!(50))
            ]
        );
        // Project artifacts use the execution's project as the subject.
        let lookups = sacrum_requests(&server, "query GetArtifactByLogicalName(").await;
        assert!(lookups.contains(&json!({
            "project_id": PROJECT, "subject_type": "project",
            "subject_id": PROJECT, "logical_name": "plan"
        })));
        assert!(lookups.iter().all(|vars| vars["project_id"] == PROJECT));
        assert!(
            sacrum_requests(&server, "query ListArtifacts(")
                .await
                .iter()
                .all(|vars| vars["project_id"] == PROJECT)
        );
    }

    #[tokio::test]
    async fn read_json_keeps_exact_values_and_rejects_what_it_cannot_represent() {
        let server = test_support::sacrum(Sacrum).await;
        let read = output(
            &server,
            r#"
            let caught = [];
            for name in ["broken", "above_i64", "beyond_u64"] {
                try { vtb::artifacts::read_json(task.id, name); } catch (error) { caught.push(error); }
            }
            #{
                outcome: vtb::artifacts::read_json(task.id, "outcome"),
                exact: vtb::artifacts::read_json(task.id, "outcome").exact + 1,
                json_null: vtb::artifacts::read_json(task.id, "null"),
                missing: vtb::artifacts::read_json(task.id, "absent"),
                caught: caught,
            }
            "#,
        )
        .await;
        assert_eq!(
            read["outcome"],
            json!({
                "max": i64::MAX, "min": i64::MIN, "exact": 9_007_199_254_740_993_i64,
                "none": null, "text": "1e400 \" 99999999999999999999",
                "nested": [{"ok": true, "ratio": 0.5}, [], {}]
            })
        );
        assert_eq!(read["exact"], 9_007_199_254_740_994_i64);
        assert_eq!(read["json_null"], Value::Null);
        assert_eq!(read["missing"], Value::Null);
        let caught = read["caught"].as_array().unwrap();
        assert_eq!(caught.len(), 3);
        for (error, detail) in caught.iter().zip([
            "not valid JSON: expected value at line 1 column 10",
            "integer 9223372036854775808 is outside",
            "integer 100000000000000000000 is outside",
        ]) {
            assert_eq!(error["kind"], "invalid", "{error}");
            assert_eq!(error["function"], "vtb::artifacts::read_json");
            assert!(
                error["message"].as_str().unwrap().contains(detail),
                "{error}"
            );
        }
    }

    #[tokio::test]
    async fn missing_names_never_fall_back_to_another_subject() {
        let server = test_support::sacrum(Sacrum).await;
        let read = output(
            &server,
            r#"
            #{
                other_plan: vtb::artifacts::read($OTHER, "plan"),
                self_shared: vtb::artifacts::lookup(task.id, "shared"),
                project_result: vtb::artifacts::read("project", "result"),
                missing_task: [
                    vtb::artifacts::list($MISSING), vtb::artifacts::lookup($MISSING, "plan"),
                    vtb::artifacts::read($MISSING, "plan"), vtb::artifacts::read_json($MISSING, "plan")
                ],
                // A project UUID is a task subject, not the project.
                project_uuid: vtb::artifacts::read($PROJECT, "plan"),
            }
            "#,
        )
        .await;
        assert_eq!(
            read,
            json!({
                "other_plan": null, "self_shared": null, "project_result": null,
                "missing_task": [null, null, null, null], "project_uuid": null
            })
        );
    }

    #[tokio::test]
    async fn artifacts_from_another_project_cannot_be_read_by_name_or_id() {
        let server = test_support::sacrum(Sacrum).await;
        let read = output(
            &server,
            r#"
            #{
                list: vtb::artifacts::list($FOREIGN),
                lookup: vtb::artifacts::lookup($FOREIGN, "plan"),
                read: vtb::artifacts::read($FOREIGN, "plan"),
                read_json: vtb::artifacts::read_json($FOREIGN, "plan"),
                by_id: vtb::artifacts::read($FOREIGN_ARTIFACT, "plan"),
                project_shared: vtb::artifacts::read("project", "shared"),
            }
            "#,
        )
        .await;
        assert_eq!(
            read,
            json!({
                "list": null, "lookup": null, "read": null, "read_json": null,
                "by_id": null, "project_shared": "shared"
            })
        );
        assert!(!read.to_string().contains("Foreign secret"));
        // A foreign task never reaches its artifact listing, and no
        // user-scoped by-ID artifact read is ever made.
        assert!(
            sacrum_requests(&server, "query ListTaskArtifacts(")
                .await
                .is_empty()
        );
        assert!(
            sacrum_requests(&server, "query GetArtifact(")
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_without_calling_sacrum() {
        let server = test_support::sacrum(Sacrum).await;
        let long_name = "n".repeat(256);
        for call in [
            r#"vtb::artifacts::list("Project")"#.to_string(),
            r#"vtb::artifacts::list("a0000000")"#.into(),
            "vtb::artifacts::list(42)".into(),
            r#"vtb::artifacts::lookup((), "plan")"#.into(),
            r#"vtb::artifacts::read(task.id, "")"#.into(),
            r#"vtb::artifacts::read("project", "   ")"#.into(),
            "vtb::artifacts::read_json(task.id, 7)".into(),
            format!(r#"vtb::artifacts::lookup(task.id, "{long_name}")"#),
        ] {
            let caught = output(
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
                    .starts_with("vtb::artifacts::"),
                "{call}: {caught}"
            );
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn service_failures_raise_transport_distinct_from_not_found() {
        let server = test_support::sacrum(Sacrum).await;
        let read = output(
            &server,
            r#"
            let caught = [];
            for read in [
                || vtb::artifacts::read($FAILING, "plan"),
                || vtb::artifacts::read_json($FAILING, "plan"),
                || vtb::artifacts::list($FAILING),
                || vtb::artifacts::lookup(task.id, "denied")
            ] {
                try { read.call(); } catch (error) { caught.push(error); }
            }
            #{ missing: vtb::artifacts::read(task.id, "absent"), caught: caught }
            "#,
        )
        .await;
        assert_eq!(read["missing"], Value::Null);
        let caught = read["caught"].as_array().unwrap();
        assert_eq!(caught.len(), 4);
        for (error, (function, detail)) in caught.iter().zip([
            ("vtb::artifacts::read", "503"),
            ("vtb::artifacts::read_json", "503"),
            ("vtb::artifacts::list", "503"),
            ("vtb::artifacts::lookup", "unauthorized"),
        ]) {
            assert_eq!(error["kind"], "transport", "{error}");
            assert_eq!(error["function"], function);
            assert!(
                error["message"].as_str().unwrap().contains(detail),
                "{error}"
            );
        }
    }
}
