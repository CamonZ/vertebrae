//! `vtb::tasks` reads: `get`, `find`, `parent`, `children`, `dependencies`
//! and `dependents`.
//!
//! A task is visible only when Sacrum reports it in the execution's project;
//! any other task, including one missing a project, reads as absent. Missing
//! targets return `()`, empty listings `[]`, and listings are sorted by
//! creation time, then ID.

use rhai::{Array, Dynamic, Map, Module};
use vertebrae_core::models::{CodeRef, Level, Priority, Section, Task, TaskFilter};
use vertebrae_core::{ServiceError, ServiceResult, VertebraeServices};

use super::{bool_argument, optional_string, set_host_fn, string_argument, uuid_argument};
use crate::script_worker::{HostContext, HostError, HostErrorKind};

const NAMESPACE: &str = "vtb::tasks";

pub(super) fn module(host: &HostContext) -> Module {
    let mut module = Module::new();
    set_host_fn(&mut module, host, NAMESPACE, "get", get);
    set_host_fn(&mut module, host, NAMESPACE, "find", find);
    set_host_fn(&mut module, host, NAMESPACE, "parent", parent);
    set_host_fn(&mut module, host, NAMESPACE, "children", children);
    set_host_fn(&mut module, host, NAMESPACE, "dependencies", dependencies);
    set_host_fn(&mut module, host, NAMESPACE, "dependents", dependents);
    module
}

fn get(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let task = read(host, |services, project| async move {
        scoped_task(services, project, &id).await
    })?;
    Ok(task.as_ref().map_or(Dynamic::UNIT, task_value))
}

fn parent(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let parent = read(host, |services, project| async move {
        let Some(parent_id) = scoped_task(services, project, &id)
            .await?
            .and_then(|task| task.parent_id)
        else {
            return Ok(None);
        };
        scoped_task(services, project, &parent_id).await
    })?;
    Ok(parent.as_ref().map_or(Dynamic::UNIT, task_value))
}

fn children(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    related(host, id, |task| task.children)
}

fn dependencies(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    related(host, id, |task| task.blockers)
}

fn dependents(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    related(host, id, |task| task.dependents)
}

/// Sacrum's task read embeds direct children, blockers and dependents with
/// their full fields, so one read returns the hydrated relationship.
fn related(
    host: &HostContext,
    id: Dynamic,
    select: fn(Task) -> Vec<Task>,
) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let related = read(host, |services, project| async move {
        Ok(scoped_task(services, project, &id)
            .await?
            .map(|task| in_project(select(task), project)))
    })?;
    Ok(related.map_or(Dynamic::UNIT, |tasks| task_list(tasks).into()))
}

fn find(host: &HostContext, filter: Dynamic) -> Result<Dynamic, HostError> {
    let query = FindQuery::parse(filter)?;
    let found = read(host, |services, project| async move {
        if let Some(parent_id) = &query.filter.children_of
            && scoped_task(services, project, parent_id).await?.is_none()
        {
            return Ok(None);
        }
        let listed = services
            .tasks()
            .list_tasks_without_lookups(&query.filter)
            .await?;
        // List rows carry no sections or refs; reread each match in full.
        let mut tasks = Vec::new();
        for summary in listed.iter().filter(|task| query.matches(task)) {
            if let Some(task) = scoped_task(services, project, &summary.id).await?
                && query.matches(&task)
            {
                tasks.push(task);
            }
        }
        Ok(Some(tasks))
    })?;
    Ok(found.map_or(Dynamic::UNIT, |tasks| task_list(tasks).into()))
}

/// Make one host call for a read. Arguments are validated before any request,
/// so whatever the service reports here is a backend failure rather than a
/// script mistake: everything but cancellation surfaces as `transport`.
fn read<'a, T, F>(
    host: &'a HostContext,
    request: impl FnOnce(&'a VertebraeServices, &'a str) -> F,
) -> Result<T, HostError>
where
    F: std::future::Future<Output = ServiceResult<T>>,
{
    host.call(request).map_err(|error| match error.kind {
        HostErrorKind::Cancelled => error,
        _ => HostError {
            kind: HostErrorKind::Transport,
            ..error
        },
    })
}

/// Read a task, treating an absent task or one from another project as `None`.
async fn scoped_task(
    services: &VertebraeServices,
    project: &str,
    id: &str,
) -> ServiceResult<Option<Task>> {
    match services.tasks().get_task_without_lookups(id).await {
        Ok(task) if task.project_id.as_deref() == Some(project) => Ok(Some(task)),
        Ok(_) | Err(ServiceError::TaskNotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

fn in_project(tasks: Vec<Task>, project: &str) -> Vec<Task> {
    tasks
        .into_iter()
        .filter(|task| task.project_id.as_deref() == Some(project))
        .collect()
}

fn task_list(mut tasks: Vec<Task>) -> Array {
    tasks.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    tasks.iter().map(task_value).collect()
}

/// `find`'s accepted filter. The backend applies it, and every field that a
/// list row carries is checked again locally so a backend that ignores one
/// can never widen the result.
struct FindQuery {
    filter: TaskFilter,
}

impl FindQuery {
    fn parse(filter: Dynamic) -> Result<Self, HostError> {
        let type_name = filter.type_name();
        let entries = filter
            .try_cast::<Map>()
            .ok_or_else(|| HostError::invalid(format!("Filter must be a map, got {type_name}")))?;
        let mut filter = TaskFilter::new();
        for (key, value) in entries {
            let what = format!("Filter key '{key}'");
            match key.as_str() {
                "level" => filter.levels.push(level(&string_argument(value, &what)?)?),
                "priority" => filter
                    .priorities
                    .push(priority(&string_argument(value, &what)?)?),
                "step_name" => filter
                    .step_names
                    .push(nonblank(string_argument(value, &what)?, &what)?),
                "tags" => filter.tags = string_array(value, &what)?,
                "parent_id" => filter.children_of = Some(uuid_argument(value, &what)?),
                "root_only" => filter.root_only = bool_argument(value, &what)?,
                "include_archived" => filter.include_archived = bool_argument(value, &what)?,
                "search" => filter.search = Some(nonblank(string_argument(value, &what)?, &what)?),
                _ => {
                    return Err(HostError::invalid(format!(
                        "Unknown filter key '{key}'; accepted keys are level, priority, \
                         step_name, tags, parent_id, root_only, include_archived and search"
                    )));
                }
            }
        }
        if filter.root_only && filter.children_of.is_some() {
            return Err(HostError::invalid(
                "Filter cannot combine parent_id with root_only: true",
            ));
        }
        Ok(Self { filter })
    }

    fn matches(&self, task: &Task) -> bool {
        let filter = &self.filter;
        (filter.include_archived || !task.archived)
            && filter.levels.iter().all(|level| *level == task.level)
            && filter
                .priorities
                .iter()
                .all(|priority| task.priority.as_ref() == Some(priority))
            && filter.tags.iter().all(|tag| task.tags.contains(tag))
            && filter
                .children_of
                .as_ref()
                .is_none_or(|parent| task.parent_id.as_ref() == Some(parent))
            && (!filter.root_only || task.parent_id.is_none())
    }
}

fn level(value: &str) -> Result<Level, HostError> {
    match value {
        "epic" => Ok(Level::Epic),
        "ticket" => Ok(Level::Ticket),
        "task" => Ok(Level::Task),
        _ => Err(HostError::invalid(format!(
            "Level must be \"epic\", \"ticket\" or \"task\", got {value:?}"
        ))),
    }
}

fn priority(value: &str) -> Result<Priority, HostError> {
    match value {
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        "critical" => Ok(Priority::Critical),
        _ => Err(HostError::invalid(format!(
            "Priority must be \"low\", \"medium\", \"high\" or \"critical\", got {value:?}"
        ))),
    }
}

fn nonblank(value: String, what: &str) -> Result<String, HostError> {
    if value.trim().is_empty() {
        return Err(HostError::invalid(format!("{what} must not be blank")));
    }
    Ok(value)
}

fn string_array(value: Dynamic, what: &str) -> Result<Vec<String>, HostError> {
    let type_name = value.type_name();
    value
        .try_cast::<Array>()
        .ok_or_else(|| HostError::invalid(format!("{what} must be an array, got {type_name}")))?
        .into_iter()
        .map(|item| string_argument(item, &format!("Each {what} entry")))
        .collect()
}

/// The script-facing `Task` map. Every documented key is present; project
/// IDs, run controls and nested relationships are deliberately left out.
fn task_value(task: &Task) -> Dynamic {
    let mut map = Map::new();
    map.insert("id".into(), task.id.clone().into());
    map.insert("title".into(), task.title.clone().into());
    map.insert(
        "description".into(),
        optional_string(task.description.as_deref()),
    );
    map.insert("level".into(), task.level.as_str().into());
    map.insert(
        "priority".into(),
        optional_string(task.priority.as_ref().map(Priority::as_str)),
    );
    map.insert(
        "tags".into(),
        task.tags
            .iter()
            .cloned()
            .map(Dynamic::from)
            .collect::<Array>()
            .into(),
    );
    map.insert(
        "parent_id".into(),
        optional_string(task.parent_id.as_deref()),
    );
    map.insert(
        "workflow_id".into(),
        optional_string(task.workflow_id.as_deref()),
    );
    map.insert(
        "current_step_id".into(),
        optional_string(task.current_step_id.as_deref()),
    );
    map.insert("archived".into(), task.archived.into());
    map.insert("worktree".into(), optional_string(task.worktree.as_deref()));
    map.insert(
        "sections".into(),
        task.sections
            .iter()
            .map(section_value)
            .collect::<Array>()
            .into(),
    );
    map.insert("code_refs".into(), code_refs(&task.code_refs));
    for (key, at) in [
        ("created_at", task.created_at),
        ("updated_at", task.updated_at),
        ("started_at", task.started_at),
        ("completed_at", task.completed_at),
    ] {
        map.insert(key.into(), timestamp(at));
    }
    map.into()
}

fn section_value(section: &Section) -> Dynamic {
    let mut map = Map::new();
    map.insert("type".into(), section.section_type.as_str().into());
    map.insert("content".into(), section.content.clone().into());
    map.insert("order".into(), optional_int(section.order));
    map.insert(
        "done".into(),
        section.done.map_or(Dynamic::UNIT, Dynamic::from),
    );
    map.insert("done_at".into(), timestamp(section.done_at));
    map.insert("refs".into(), code_refs(&section.refs));
    map.into()
}

fn code_refs(refs: &[CodeRef]) -> Dynamic {
    refs.iter()
        .map(|code_ref| {
            let mut map = Map::new();
            map.insert("path".into(), code_ref.path.clone().into());
            map.insert("line_start".into(), optional_int(code_ref.line_start));
            map.insert("line_end".into(), optional_int(code_ref.line_end));
            map.insert("name".into(), optional_string(code_ref.name.as_deref()));
            map.insert(
                "description".into(),
                optional_string(code_ref.description.as_deref()),
            );
            Dynamic::from(map)
        })
        .collect::<Array>()
        .into()
}

fn optional_int(value: Option<u32>) -> Dynamic {
    value.map_or(Dynamic::UNIT, |value| Dynamic::from(rhai::INT::from(value)))
}

fn timestamp(value: Option<chrono::DateTime<chrono::Utc>>) -> Dynamic {
    value.map_or(Dynamic::UNIT, |at| at.to_rfc3339().into())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};
    use vertebrae_core::models::ExecuteConfig;
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate, matchers};

    use crate::actors::step_executor::StepResult;
    use crate::script_worker::{ScriptScope, ScriptWorker};

    const PROJECT: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_PROJECT: &str = "22222222-2222-4222-8222-222222222222";
    const SELF: &str = "a0000000-0000-4000-8000-000000000001";
    const PARENT: &str = "a0000000-0000-4000-8000-000000000002";
    const CHILD_LATE: &str = "a0000000-0000-4000-8000-000000000003";
    const CHILD_EARLY: &str = "a0000000-0000-4000-8000-000000000004";
    const BLOCKER: &str = "a0000000-0000-4000-8000-000000000005";
    const DEPENDENT: &str = "a0000000-0000-4000-8000-000000000006";
    const UNRELATED: &str = "a0000000-0000-4000-8000-000000000007";
    const FOREIGN: &str = "a0000000-0000-4000-8000-000000000008";
    const MISSING: &str = "a0000000-0000-4000-8000-000000000009";
    const FAILING: &str = "a0000000-0000-4000-8000-00000000000a";
    const ARCHIVED: &str = "a0000000-0000-4000-8000-00000000000b";
    const NO_PROJECT: &str = "a0000000-0000-4000-8000-00000000000c";
    const UNAUTHORIZED: &str = "a0000000-0000-4000-8000-00000000000d";
    const MALFORMED: &str = "a0000000-0000-4000-8000-00000000000e";

    /// Base task rows: (id, project, parent, blockers, created minute, extra).
    fn rows() -> Vec<Value> {
        let row = |id: &str, project: &str, title: &str, parent: Option<&str>, minute: u32| {
            json!({
                "id": id,
                "project_id": project,
                "title": title,
                "level": "task",
                "priority": "high",
                "tags": ["key:a", "b"],
                "archived": false,
                "parent_id": parent,
                "inserted_at": format!("2026-10-01T10:{minute:02}:00Z"),
                "sections": [],
                "code_refs": [],
            })
        };
        let mut this = row(SELF, PROJECT, "Self", Some(PARENT), 5);
        this["description"] = json!("Roll up children");
        this["workflow_id"] = json!("b0000000-0000-4000-8000-000000000001");
        this["current_step_id"] = json!("b0000000-0000-4000-8000-000000000002");
        this["worktree"] = json!("../worktree");
        this["started_at"] = json!("2026-10-01T11:00:00Z");
        this["sections"] = json!([{
            "id": "s1", "section_type": "checklist_item", "content": "Check it",
            "section_order": 0, "done": true, "done_at": "2026-10-01T12:00:00Z",
            "code_refs": [{"id": "r1", "path": "src/lib.rs", "line_start": 3}]
        }]);
        this["code_refs"] = json!([{
            "id": "r2", "task_id": SELF, "path": "src/main.rs", "line_start": 1, "line_end": 9,
            "name": "main", "description": "Entry"
        }]);
        let mut parent = row(PARENT, PROJECT, "Parent", None, 1);
        parent["level"] = json!("ticket");
        let mut archived = row(ARCHIVED, PROJECT, "Archived child", Some(SELF), 50);
        archived["archived"] = json!(true);
        let mut no_project = row(NO_PROJECT, PROJECT, "Unscoped secret", None, 6);
        no_project.as_object_mut().unwrap().remove("project_id");
        vec![
            this,
            parent,
            row(CHILD_LATE, PROJECT, "Late child", Some(SELF), 30),
            row(CHILD_EARLY, PROJECT, "Early child", Some(SELF), 20),
            row(BLOCKER, PROJECT, "Blocker", None, 2),
            row(DEPENDENT, PROJECT, "Dependent", None, 40),
            row(UNRELATED, PROJECT, "Unrelated", None, 3),
            row(FOREIGN, OTHER_PROJECT, "Foreign secret", Some(SELF), 4),
            archived,
            no_project,
        ]
    }

    /// Edges: (task, depends on).
    const EDGES: [(&str, &str); 3] = [(SELF, BLOCKER), (DEPENDENT, SELF), (FOREIGN, SELF)];

    /// Answers the Sacrum GraphQL reads the task host functions make.
    struct Sacrum {
        listed: Vec<&'static str>,
    }

    impl Respond for Sacrum {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let rows = rows();
            let row = |id: &str| rows.iter().find(|row| row["id"] == id).cloned();
            let data = if query.contains("query GetTask(") {
                let id = body["variables"]["id"].as_str().unwrap();
                match id {
                    FAILING => {
                        return ResponseTemplate::new(503).set_body_string("upstream down");
                    }
                    UNAUTHORIZED => {
                        return ResponseTemplate::new(200).set_body_json(json!({
                            "data": {"task": null}, "errors": [{"message": "unauthorized"}]
                        }));
                    }
                    MALFORMED => {
                        return ResponseTemplate::new(200)
                            .set_body_json(json!({"data": {"task": {"id": MALFORMED}}}));
                    }
                    _ => {}
                }
                let Some(mut task) = row(id) else {
                    return ResponseTemplate::new(200).set_body_json(
                        json!({"data": {"task": null}, "errors": [{"message": "not_found"}]}),
                    );
                };
                task["children"] = rows
                    .iter()
                    .filter(|row| row["parent_id"] == id)
                    .cloned()
                    .collect();
                task["blockers"] = EDGES
                    .iter()
                    .filter(|(from, _)| *from == id)
                    .filter_map(|(_, to)| row(to))
                    .collect();
                task["dependents"] = EDGES
                    .iter()
                    .filter(|(_, to)| *to == id)
                    .filter_map(|(from, _)| row(from))
                    .collect();
                json!({"task": task})
            } else if query.contains("query ListTasks(") {
                json!({"tasks": self.listed.iter().map(|id| row(id).unwrap()).collect::<Vec<_>>()})
            } else {
                panic!("unexpected Sacrum request: {query}");
            };
            ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
        }
    }

    async fn sacrum(listed: Vec<&'static str>) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/graphql"))
            .respond_with(Sacrum { listed })
            .mount(&server)
            .await;
        server
    }

    async fn run(server: &MockServer, script: &str) -> StepResult {
        use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};
        let scope = ScriptScope {
            project_id: PROJECT.into(),
            services: Arc::new(vertebrae_sacrum_client::from_sacrum(Arc::new(
                GraphqlClient::new(SacrumConfig::new(
                    server.uri(),
                    "token".into(),
                    PROJECT.into(),
                )),
            ))),
        };
        let script = [
            ("SELF", SELF),
            ("PARENT", PARENT),
            ("UNRELATED", UNRELATED),
            ("FOREIGN", FOREIGN),
            ("MISSING", MISSING),
            ("FAILING", FAILING),
            ("NO_PROJECT", NO_PROJECT),
            ("UNAUTHORIZED", UNAUTHORIZED),
            ("MALFORMED", MALFORMED),
        ]
        .iter()
        .fold(script.to_string(), |script, (name, id)| {
            script.replace(&format!("${name}"), &format!("\"{id}\""))
        });
        let config = ExecuteConfig {
            version: 1,
            script,
            context: Some(json!({
                "task": {"id": SELF}, "execution": {}, "inputs": {},
                "steps": {}, "workflow": {}, "artifacts": {}
            })),
            output_schema: json!({}),
        };
        ScriptWorker::default()
            .admit(config, scope, |_| {})
            .unwrap()
            .settle()
            .await
    }

    async fn output(server: &MockServer, script: &str) -> Value {
        match run(server, script).await {
            StepResult::Completed {
                output: Some(output),
                ..
            } => serde_json::from_str(&output).unwrap(),
            other => panic!("expected completion for {script}, got {other:?}"),
        }
    }

    async fn sacrum_requests(server: &MockServer, operation: &str) -> Vec<Value> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
            .filter(|body| body["query"].as_str().unwrap().contains(operation))
            .map(|body| body["variables"].clone())
            .collect()
    }

    #[tokio::test]
    async fn reads_self_parent_children_unrelated_dependencies_and_dependents() {
        let server = sacrum(vec![]).await;
        let read = output(
            &server,
            r#"
            let ids = |tasks| tasks.map(|t| t.id);
            #{
                current: vtb::tasks::get(task.id),
                parent: vtb::tasks::parent(task.id).id,
                missing_parent: vtb::tasks::parent($PARENT),
                children: ids.call(vtb::tasks::children(task.id)),
                no_children: vtb::tasks::children($UNRELATED),
                unrelated: vtb::tasks::get($UNRELATED).title,
                dependencies: ids.call(vtb::tasks::dependencies(task.id)),
                dependents: ids.call(vtb::tasks::dependents(task.id)),
                no_dependencies: vtb::tasks::dependencies($UNRELATED),
                uppercase: vtb::tasks::get(task.id.to_upper()).id,
                missing: [
                    vtb::tasks::get($MISSING), vtb::tasks::parent($MISSING),
                    vtb::tasks::children($MISSING), vtb::tasks::dependencies($MISSING),
                    vtb::tasks::dependents($MISSING)
                ],
            }
            "#,
        )
        .await;
        assert_eq!(
            read["current"],
            json!({
                "id": SELF, "title": "Self", "description": "Roll up children",
                "level": "task", "priority": "high", "tags": ["key:a", "b"],
                "parent_id": PARENT,
                "workflow_id": "b0000000-0000-4000-8000-000000000001",
                "current_step_id": "b0000000-0000-4000-8000-000000000002",
                "archived": false, "worktree": "../worktree",
                "sections": [{
                    "type": "checklist_item", "content": "Check it", "order": 0,
                    "done": true, "done_at": "2026-10-01T12:00:00+00:00",
                    "refs": [{"path": "src/lib.rs", "line_start": 3, "line_end": null,
                              "name": null, "description": null}]
                }],
                "code_refs": [{"path": "src/main.rs", "line_start": 1, "line_end": 9,
                               "name": "main", "description": "Entry"}],
                "created_at": "2026-10-01T10:05:00+00:00", "updated_at": null,
                "started_at": "2026-10-01T11:00:00+00:00", "completed_at": null
            })
        );
        assert_eq!(read["parent"], PARENT);
        assert_eq!(read["missing_parent"], Value::Null);
        // Sorted by creation time. Relationship listings include archived
        // tasks; the foreign and project-less children are never listed.
        assert_eq!(read["children"], json!([CHILD_EARLY, CHILD_LATE, ARCHIVED]));
        assert_eq!(read["no_children"], json!([]));
        assert_eq!(read["unrelated"], "Unrelated");
        assert_eq!(read["dependencies"], json!([BLOCKER]));
        assert_eq!(read["dependents"], json!([DEPENDENT]));
        assert_eq!(read["no_dependencies"], json!([]));
        assert_eq!(read["uppercase"], SELF);
        assert_eq!(read["missing"], json!([null, null, null, null, null]));
        // Each read is one task request; workflow and step names are never resolved.
        assert!(sacrum_requests(&server, "workflows(").await.is_empty());
    }

    #[tokio::test]
    async fn tasks_from_another_project_read_as_absent_and_never_leak() {
        let server = sacrum(vec![FOREIGN, ARCHIVED, NO_PROJECT, UNRELATED]).await;
        let read = output(
            &server,
            r#"
            #{
                get: vtb::tasks::get($FOREIGN),
                no_project: vtb::tasks::get($NO_PROJECT),
                parent: vtb::tasks::parent($FOREIGN),
                children: vtb::tasks::children($FOREIGN),
                dependencies: vtb::tasks::dependencies($FOREIGN),
                dependents: vtb::tasks::dependents($FOREIGN),
                self_children: vtb::tasks::children(task.id).len(),
                self_dependents: vtb::tasks::dependents(task.id).len(),
                found: vtb::tasks::find(#{}).map(|t| t.id),
                foreign_parent: vtb::tasks::find(#{ parent_id: $FOREIGN }),
            }
            "#,
        )
        .await;
        assert_eq!(
            read,
            json!({
                "get": null, "no_project": null, "parent": null, "children": null,
                "dependencies": null, "dependents": null, "self_children": 3,
                "self_dependents": 1,
                "found": [UNRELATED], "foreign_parent": null
            })
        );
        assert!(!read.to_string().contains("Foreign secret"));
        assert!(!read.to_string().contains("Unscoped secret"));
        assert!(!read.to_string().contains(OTHER_PROJECT));
        // A parent outside the project short-circuits before any listing.
        assert_eq!(sacrum_requests(&server, "query ListTasks(").await.len(), 1);
    }

    #[tokio::test]
    async fn find_maps_every_filter_field_and_orders_results_deterministically() {
        // Out of order, with a foreign row and a row that fails the filter.
        let server = sacrum(vec![CHILD_LATE, FOREIGN, PARENT, CHILD_EARLY, ARCHIVED]).await;
        let found = output(
            &server,
            r#"
            vtb::tasks::find(#{
                level: "task", priority: "high", step_name: "todo", tags: ["key:a", "b"],
                parent_id: task.id, include_archived: true, search: "child"
            }).map(|t| [t.id, t.sections.len()])
            "#,
        )
        .await;
        assert_eq!(
            found,
            json!([[CHILD_EARLY, 0], [CHILD_LATE, 0], [ARCHIVED, 0]])
        );
        let roots = output(
            &server,
            "vtb::tasks::find(#{ root_only: true }).map(|t| t.id)",
        )
        .await;
        assert_eq!(roots, json!([PARENT]));
        let listings = sacrum_requests(&server, "query ListTasks(").await;
        assert_eq!(
            listings[0],
            json!({
                "project_id": PROJECT, "level": "task", "priority": "high",
                "status": "todo", "tags": ["key:a", "b"], "parent_id": SELF,
                "includeArchived": true, "search": "child"
            })
        );
        assert_eq!(
            listings[1],
            json!({"project_id": PROJECT, "root_only": true})
        );
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_without_calling_sacrum() {
        let server = sacrum(vec![UNRELATED]).await;
        for call in [
            "vtb::tasks::find(#{ bogus: 1 })",
            "vtb::tasks::find(#{ level: () })",
            r#"vtb::tasks::find(#{ level: ["task"] })"#,
            r#"vtb::tasks::find(#{ level: "huge" })"#,
            r#"vtb::tasks::find(#{ priority: "urgent" })"#,
            r#"vtb::tasks::find(#{ tags: ["ok", 1] })"#,
            r#"vtb::tasks::find(#{ search: "  " })"#,
            r#"vtb::tasks::find(#{ project_id: "x" })"#,
            "vtb::tasks::find(#{ parent_id: $UNRELATED, root_only: true })",
            r#"vtb::tasks::find("level")"#,
            r#"vtb::tasks::get("a0000000")"#,
            r#"vtb::tasks::children("a00000000000400080000000000000001")"#,
            "vtb::tasks::parent(42)",
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
                    .starts_with("vtb::tasks::"),
                "{call}: {caught}"
            );
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn service_failures_raise_transport_distinct_from_not_found() {
        let server = sacrum(vec![]).await;
        let read = output(
            &server,
            r#"
            let caught = [];
            for read in [
                || vtb::tasks::get($FAILING), || vtb::tasks::children($FAILING),
                || vtb::tasks::parent($UNAUTHORIZED), || vtb::tasks::find(#{ parent_id: $MALFORMED })
            ] {
                try { read.call(); } catch (error) { caught.push(error); }
            }
            #{ missing: vtb::tasks::get($MISSING), caught: caught }
            "#,
        )
        .await;
        assert_eq!(read["missing"], Value::Null);
        let caught = read["caught"].as_array().unwrap();
        assert_eq!(caught.len(), 4);
        // HTTP failures, GraphQL errors other than not-found, and responses
        // the client cannot decode are all backend failures.
        for (error, (function, detail)) in caught.iter().zip([
            ("vtb::tasks::get", "503"),
            ("vtb::tasks::children", "503"),
            ("vtb::tasks::parent", "unauthorized"),
            ("vtb::tasks::find", "title"),
        ]) {
            assert_eq!(error["kind"], "transport", "{error}");
            assert_eq!(error["function"], function);
            assert!(
                error["message"].as_str().unwrap().contains(detail),
                "{error}"
            );
        }
        match run(&server, "vtb::tasks::get($FAILING)").await {
            StepResult::Failed { error, .. } => {
                assert!(error.contains("transport"), "{error}");
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }
}
