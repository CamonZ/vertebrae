//! `vtb::tasks` writes: `create`, `update`, `archive` and `unarchive`.
//!
//! Writes apply immediately and are never rolled back. Every task or
//! workflow a script names is checked against the execution's project before
//! the write; anything outside it is `not_found`. Arguments are validated
//! before any request. Creating a task never starts a TaskRun.

use rhai::{Dynamic, Module};
use vertebrae_core::models::{Level, Task};
use vertebrae_core::{CreateTaskOptions, ServiceError, UpdateTaskOptions};

use super::tasks::{level, nonblank, priority, scoped_task, string_array, task_value};
use super::{
    map_argument, read, set_host_fn, set_host_fn2, string_argument, uuid_argument, uuid_text,
};
use crate::script_worker::{HostContext, HostError, HostErrorKind};

const NAMESPACE: &str = "vtb::tasks";

pub(super) fn register(module: &mut Module, host: &HostContext) {
    set_host_fn(module, host, NAMESPACE, "create", create);
    set_host_fn2(module, host, NAMESPACE, "update", update);
    set_host_fn(module, host, NAMESPACE, "archive", archive);
    set_host_fn(module, host, NAMESPACE, "unarchive", unarchive);
}

/// Target checks are reads, so their failures classify as reads do; only
/// the write itself reports backend rejections as `invalid`.
fn create(host: &HostContext, fields: Dynamic) -> Result<Dynamic, HostError> {
    let options = create_options(fields)?;
    if let Some(parent_id) = &options.parent_id {
        require_task(host, parent_id, ServiceError::parent_not_found)?;
    }
    for dependency_id in &options.depends_on {
        require_task(host, dependency_id, ServiceError::dependency_not_found)?;
    }
    if let Some(workflow_id) = &options.workflow_id {
        require_workflow(host, workflow_id)?;
    }
    let id = host.call(|services, _| services.tasks().create_task(options))?;
    let task = read(host, |services, project| {
        scoped_task(services, project, &id)
    })?;
    // The task exists but can't be read back; a retry must look for it.
    let task = task.ok_or_else(|| {
        HostError::new(
            HostErrorKind::Transport,
            format!("Created task {id} could not be read back"),
        )
    })?;
    Ok(task_value(&task))
}

/// A by-ID workflow read is not project scoped, so membership comes from the
/// project's own workflow listing.
fn require_workflow(host: &HostContext, id: &str) -> Result<(), HostError> {
    let workflows = read(host, |services, _| services.workflows().list_workflows())?;
    if workflows.iter().any(|workflow| workflow.id == id) {
        Ok(())
    } else {
        Err(ServiceError::workflow_not_found(id).into())
    }
}

/// Read a task in the execution's project, raising `absent(id)` otherwise.
pub(super) fn require_task(
    host: &HostContext,
    id: &str,
    absent: fn(&str) -> ServiceError,
) -> Result<Task, HostError> {
    read(host, |services, project| scoped_task(services, project, id))?
        .ok_or_else(|| absent(id).into())
}

/// A patch that changes nothing only checks that the task exists.
fn update(host: &HostContext, id: Dynamic, patch: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let options = update_options(patch)?;
    require_task(host, &id, ServiceError::task_not_found)?;
    if options.has_updates() {
        host.call(|services, _| services.tasks().update_task(&id, options))?;
    }
    Ok(Dynamic::UNIT)
}

fn archive(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    set_archived(host, id, true)
}

fn unarchive(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    set_archived(host, id, false)
}

/// Only write when the flag differs, so a repeat is a no-op.
fn set_archived(host: &HostContext, id: Dynamic, archived: bool) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    if require_task(host, &id, ServiceError::task_not_found)?.archived != archived {
        let options = UpdateTaskOptions {
            archived: Some(archived),
            ..UpdateTaskOptions::default()
        };
        host.call(|services, _| services.tasks().update_task(&id, options))?;
    }
    Ok(Dynamic::UNIT)
}

fn create_options(fields: Dynamic) -> Result<CreateTaskOptions, HostError> {
    let mut title = None;
    let mut options = CreateTaskOptions {
        level: Some(Level::Task),
        ..CreateTaskOptions::default()
    };
    for (key, value) in map_argument(fields, "Fields")? {
        let what = format!("Field '{key}'");
        match key.as_str() {
            "title" => title = Some(nonblank(string_argument(value, &what)?, &what)?),
            "description" => options.description = clearable(value, |v| string_argument(v, &what))?,
            "level" => options.level = Some(level(&string_argument(value, &what)?)?),
            "priority" => {
                options.priority = clearable(value, |v| priority(&string_argument(v, &what)?))?;
            }
            "tags" => options.tags = string_array(value, &what)?,
            "parent_id" => options.parent_id = clearable(value, |v| uuid_argument(v, &what))?,
            "workflow_id" => options.workflow_id = Some(uuid_argument(value, &what)?),
            "worktree" => options.worktree = clearable(value, |v| string_argument(v, &what))?,
            "depends_on" => {
                options.depends_on = string_array(value, &what)?
                    .into_iter()
                    .map(|id| uuid_text(id, &format!("Each {what} entry")))
                    .collect::<Result<_, _>>()?;
            }
            _ => {
                return Err(HostError::invalid(format!(
                    "Unknown field '{key}'; accepted fields are title, description, level, \
                     priority, tags, parent_id, workflow_id, worktree and depends_on"
                )));
            }
        }
    }
    options.title = title.ok_or_else(|| HostError::invalid("Field 'title' is required"))?;
    Ok(options)
}

fn update_options(patch: Dynamic) -> Result<UpdateTaskOptions, HostError> {
    let mut options = UpdateTaskOptions::default();
    for (key, value) in map_argument(patch, "Patch")? {
        let what = format!("Patch key '{key}'");
        match key.as_str() {
            "title" => options.title = Some(nonblank(string_argument(value, &what)?, &what)?),
            "description" => {
                options.description = Some(clearable(value, |v| string_argument(v, &what))?);
            }
            "level" => {
                options.level = Some(level(&string_argument(value, &what)?)?.as_str().into());
            }
            "priority" => {
                options.priority =
                    Some(clearable(value, |v| priority(&string_argument(v, &what)?))?);
            }
            "worktree" => {
                options.worktree = Some(clearable(value, |v| string_argument(v, &what))?);
            }
            "add_tags" => options.add_tags = string_array(value, &what)?,
            "remove_tags" => options.remove_tags = string_array(value, &what)?,
            _ => {
                return Err(HostError::invalid(format!(
                    "Unknown patch key '{key}'; accepted keys are title, description, level, \
                     priority, worktree, add_tags and remove_tags"
                )));
            }
        }
    }
    Ok(options)
}

/// `()` clears the field; anything else must parse.
pub(super) fn clearable<T>(
    value: Dynamic,
    parse: impl FnOnce(Dynamic) -> Result<T, HostError>,
) -> Result<Option<T>, HostError> {
    if value.is_unit() {
        Ok(None)
    } else {
        parse(value).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use wiremock::{MockServer, Request, Respond, ResponseTemplate};

    use super::super::test_support::{self, OTHER_PROJECT, PROJECT, sacrum_requests};

    const SELF: &str = "c0000000-0000-4000-8000-000000000001";
    const BLOCKER: &str = "c0000000-0000-4000-8000-000000000002";
    const ARCHIVED: &str = "c0000000-0000-4000-8000-000000000003";
    const FOREIGN: &str = "c0000000-0000-4000-8000-000000000004";
    const MISSING: &str = "c0000000-0000-4000-8000-000000000005";
    const CREATED: &str = "c0000000-0000-4000-8000-000000000006";
    const UNAUTHORIZED: &str = "c0000000-0000-4000-8000-000000000007";
    const WORKFLOW: &str = "d0000000-0000-4000-8000-000000000001";
    const FOREIGN_WORKFLOW: &str = "d0000000-0000-4000-8000-000000000002";

    const IDS: [(&str, &str); 8] = [
        ("UNAUTHORIZED", UNAUTHORIZED),
        ("BLOCKER", BLOCKER),
        ("ARCHIVED", ARCHIVED),
        ("FOREIGN", FOREIGN),
        ("MISSING", MISSING),
        ("CREATED", CREATED),
        ("WORKFLOW", WORKFLOW),
        ("OTHER_WORKFLOW", FOREIGN_WORKFLOW),
    ];

    fn row(id: &str, project: &str, title: &str) -> Value {
        json!({
            "id": id, "project_id": project, "title": title, "level": "task",
            "tags": ["keep", "drop"], "archived": false,
            "inserted_at": "2026-10-01T10:00:00Z", "sections": [], "code_refs": [],
        })
    }

    /// A Sacrum that applies task mutations to its rows, so reads after a
    /// write observe it.
    struct Sacrum {
        rows: Mutex<Vec<Value>>,
    }

    impl Respond for Sacrum {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let vars = &body["variables"];
            let mut rows = self.rows.lock().unwrap();
            let graphql_error = |message: &str| {
                ResponseTemplate::new(200)
                    .set_body_json(json!({"data": null, "errors": [{"message": message}]}))
            };
            let data = if query.contains("query GetTask(") {
                if vars["id"] == UNAUTHORIZED {
                    return graphql_error("unauthorized");
                }
                let Some(task) = rows.iter().find(|row| row["id"] == vars["id"]) else {
                    return ResponseTemplate::new(200).set_body_json(
                        json!({"data": {"task": null}, "errors": [{"message": "not_found"}]}),
                    );
                };
                json!({"task": task})
            } else if query.contains("query ListWorkflows(") {
                json!({"workflows": [{"id": WORKFLOW, "name": "Delivery"}]})
            } else if query.contains("mutation CreateTask(") {
                let mut task = row(CREATED, PROJECT, "");
                for key in [
                    "title",
                    "description",
                    "level",
                    "priority",
                    "tags",
                    "parent_id",
                    "workflow_id",
                    "worktree",
                ] {
                    if let Some(value) = vars.get(key) {
                        task[key] = value.clone();
                    }
                }
                // Simulates a task that is created but can't be read back.
                if vars["title"] != "vanishes" {
                    rows.push(task);
                }
                json!({"create_task": {"id": CREATED}})
            } else if query.contains("mutation UpdateTask(") {
                if vars["title"] == "rejected" {
                    return graphql_error("title is reserved");
                }
                let task = rows.iter_mut().find(|row| row["id"] == vars["id"]).unwrap();
                for (key, value) in vars.as_object().unwrap() {
                    task[key] = value.clone();
                }
                json!({"update_task": {"id": vars["id"]}})
            } else if query.contains("mutation SyncTaskDependencies(") {
                if rows.iter().any(|row| row["title"] == "sync fails") {
                    return ResponseTemplate::new(503).set_body_string("upstream down");
                }
                json!({"sync_task_dependencies": {"id": vars["task_id"]}})
            } else {
                panic!("unexpected Sacrum request: {query}");
            };
            ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
        }
    }

    async fn sacrum() -> MockServer {
        let mut archived = row(ARCHIVED, PROJECT, "Archived");
        archived["archived"] = json!(true);
        test_support::sacrum(Sacrum {
            rows: Mutex::new(vec![
                row(SELF, PROJECT, "Self"),
                row(BLOCKER, PROJECT, "Blocker"),
                archived,
                row(FOREIGN, OTHER_PROJECT, "Foreign"),
            ]),
        })
        .await
    }

    async fn output(server: &MockServer, script: &str) -> Value {
        test_support::completed(test_support::run(server, SELF, &IDS, script).await, script)
    }

    /// Run `call` and return what it raised.
    async fn caught(server: &MockServer, call: &str) -> Value {
        output(
            server,
            &format!(
                "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
            ),
        )
        .await
    }

    async fn writes(server: &MockServer) -> usize {
        sacrum_requests(server, "mutation ").await.len()
    }

    #[tokio::test]
    async fn create_checks_every_target_then_returns_the_stored_task() {
        let server = sacrum().await;
        let created = output(
            &server,
            r#"
            let child = vtb::tasks::create(#{
                title: "Step 3", description: "Do it", level: "ticket", priority: "high",
                tags: ["key:plan-step-3"], parent_id: task.id, workflow_id: $WORKFLOW,
                worktree: "../wt", depends_on: [$BLOCKER]
            });
            #{ child: child, read: vtb::tasks::get(child.id).title }
            "#,
        )
        .await;
        let child = &created["child"];
        assert_eq!(child["id"], CREATED);
        assert_eq!(created["read"], "Step 3");
        for (key, value) in [
            ("description", json!("Do it")),
            ("level", json!("ticket")),
            ("priority", json!("high")),
            ("tags", json!(["key:plan-step-3"])),
            ("parent_id", json!(SELF)),
            ("workflow_id", json!(WORKFLOW)),
            ("worktree", json!("../wt")),
        ] {
            assert_eq!(child[key], value, "{key}");
        }
        assert_eq!(
            sacrum_requests(&server, "mutation CreateTask(").await,
            [json!({
                "project_id": PROJECT, "title": "Step 3", "description": "Do it",
                "level": "ticket", "priority": "high", "tags": ["key:plan-step-3"],
                "parent_id": SELF, "workflow_id": WORKFLOW, "worktree": "../wt"
            })]
        );
        assert_eq!(
            sacrum_requests(&server, "mutation SyncTaskDependencies(").await,
            [json!({"task_id": CREATED, "depends_on_ids": [BLOCKER]})]
        );
        assert_eq!(
            sacrum_requests(&server, "query ListWorkflows(").await,
            [json!({"project_id": PROJECT})]
        );
    }

    #[tokio::test]
    async fn create_defaults_to_a_task_on_the_project_default_workflow() {
        let server = sacrum().await;
        let child = output(
            &server,
            r#"vtb::tasks::create(#{ title: "Plain", description: (), priority: (), parent_id: () })"#,
        )
        .await;
        assert_eq!(child["level"], "task");
        assert_eq!(child["parent_id"], Value::Null);
        assert_eq!(
            sacrum_requests(&server, "mutation CreateTask(").await,
            [json!({"project_id": PROJECT, "title": "Plain", "level": "task"})]
        );
        // No workflow means no membership check and no dependency sync.
        assert!(
            sacrum_requests(&server, "query ListWorkflows(")
                .await
                .is_empty()
        );
        assert!(
            sacrum_requests(&server, "SyncTaskDependencies")
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn targets_outside_the_project_are_not_found_and_write_nothing() {
        let server = sacrum().await;
        for call in [
            r#"vtb::tasks::create(#{ title: "x", parent_id: $FOREIGN })"#,
            r#"vtb::tasks::create(#{ title: "x", parent_id: $MISSING })"#,
            r#"vtb::tasks::create(#{ title: "x", depends_on: [$BLOCKER, $FOREIGN] })"#,
            r#"vtb::tasks::create(#{ title: "x", workflow_id: $OTHER_WORKFLOW })"#,
            r#"vtb::tasks::update($FOREIGN, #{ title: "x" })"#,
            "vtb::tasks::update($MISSING, #{})",
            "vtb::tasks::archive($FOREIGN)",
            "vtb::tasks::unarchive($MISSING)",
        ] {
            let error = caught(&server, call).await;
            assert_eq!(error["kind"], "not_found", "{call}: {error}");
        }
        assert_eq!(writes(&server).await, 0);
    }

    #[tokio::test]
    async fn update_patches_and_clears_fields_and_removal_wins_for_tags() {
        let server = sacrum().await;
        let read = output(
            &server,
            r#"
            vtb::tasks::update(task.id, #{
                title: "Renamed", description: "Now described", level: "ticket",
                priority: "low", worktree: "../wt",
                add_tags: ["new", "both"], remove_tags: ["drop", "both"]
            });
            let patched = vtb::tasks::get(task.id);
            let result = vtb::tasks::update(task.id, #{ description: (), priority: (), worktree: () });
            let cleared = vtb::tasks::get(task.id);
            #{ result: result, patched: patched, cleared: cleared }
            "#,
        )
        .await;
        assert_eq!(read["result"], Value::Null);
        let patched = &read["patched"];
        assert_eq!(patched["title"], "Renamed");
        assert_eq!(patched["description"], "Now described");
        assert_eq!(patched["level"], "ticket");
        assert_eq!(patched["priority"], "low");
        assert_eq!(patched["worktree"], "../wt");
        assert_eq!(patched["tags"], json!(["keep", "new"]));
        let cleared = &read["cleared"];
        assert_eq!(cleared["title"], "Renamed");
        for key in ["description", "priority", "worktree"] {
            assert_eq!(cleared[key], Value::Null, "{key}");
        }
        assert_eq!(cleared["tags"], json!(["keep", "new"]));
    }

    #[tokio::test]
    async fn empty_patches_and_repeated_archive_flags_write_nothing() {
        let server = sacrum().await;
        let read = output(
            &server,
            r#"
            vtb::tasks::update(task.id, #{});
            vtb::tasks::update(task.id, #{ add_tags: [], remove_tags: [] });
            vtb::tasks::archive($ARCHIVED);
            vtb::tasks::unarchive(task.id);
            vtb::tasks::archive(task.id);
            vtb::tasks::archive(task.id);
            let archived = vtb::tasks::get(task.id).archived;
            vtb::tasks::unarchive(task.id);
            vtb::tasks::unarchive(task.id);
            [archived, vtb::tasks::get(task.id).archived]
            "#,
        )
        .await;
        assert_eq!(read, json!([true, false]));
        assert_eq!(
            sacrum_requests(&server, "mutation UpdateTask(").await,
            [
                json!({"id": SELF, "archived": true}),
                json!({"id": SELF, "archived": false})
            ]
        );
    }

    #[tokio::test]
    async fn failures_after_or_around_a_write_keep_their_categories() {
        let server = sacrum().await;
        let caught = output(
            &server,
            r#"
            let caught = [];
            for write in [
                || vtb::tasks::create(#{ title: "vanishes" }),
                || vtb::tasks::create(#{ title: "sync fails", depends_on: [$BLOCKER] }),
                || vtb::tasks::update(task.id, #{ title: "rejected" }),
                || vtb::tasks::create(#{ title: "x", parent_id: $UNAUTHORIZED }),
                || vtb::tasks::archive($UNAUTHORIZED)
            ] {
                try { write.call(); } catch (error) { caught.push([error.kind, error.function]); }
            }
            #{ caught: caught, kept: vtb::tasks::get($CREATED).title }
            "#,
        )
        .await;
        assert_eq!(
            caught["caught"],
            json!([
                // Created, but the read-back finds nothing: the outcome is unknown.
                ["transport", "vtb::tasks::create"],
                // The dependency sync failed after the create.
                ["transport", "vtb::tasks::create"],
                // A backend rejection of the write itself.
                ["invalid", "vtb::tasks::update"],
                // Target checks are reads: a backend failure is never `invalid`.
                ["transport", "vtb::tasks::create"],
                ["transport", "vtb::tasks::archive"]
            ])
        );
        // Writes are not undone: the task from the failed sync remains.
        assert_eq!(caught["kept"], "sync fails");
        assert_eq!(
            sacrum_requests(&server, "mutation CreateTask(").await.len(),
            2
        );
        assert_eq!(
            sacrum_requests(&server, "mutation UpdateTask(").await.len(),
            1
        );
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_without_calling_sacrum() {
        let server = sacrum().await;
        for call in [
            "vtb::tasks::create(#{})",
            r#"vtb::tasks::create(#{ title: "  " })"#,
            r#"vtb::tasks::create(#{ title: () })"#,
            r#"vtb::tasks::create(#{ title: "x", level: "huge" })"#,
            r#"vtb::tasks::create(#{ title: "x", priority: "urgent" })"#,
            r#"vtb::tasks::create(#{ title: "x", parent_id: "c0000000" })"#,
            r#"vtb::tasks::create(#{ title: "x", workflow_id: () })"#,
            r#"vtb::tasks::create(#{ title: "x", depends_on: ["nope"] })"#,
            r#"vtb::tasks::create(#{ title: "x", tags: "key" })"#,
            r#"vtb::tasks::create(#{ title: "x", id: $CREATED })"#,
            r#"vtb::tasks::create(#{ title: "x", project_id: "p" })"#,
            r#"vtb::tasks::create("x")"#,
            r#"vtb::tasks::update(task.id, #{ title: () })"#,
            r#"vtb::tasks::update(task.id, #{ level: () })"#,
            r#"vtb::tasks::update(task.id, #{ add_tags: [1] })"#,
            r#"vtb::tasks::update(task.id, #{ tags: ["x"] })"#,
            r#"vtb::tasks::update("short", #{})"#,
            "vtb::tasks::update(task.id, ())",
            "vtb::tasks::archive(1)",
        ] {
            let error = caught(&server, call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn update_refuses_workflow_run_and_relationship_fields() {
        let server = sacrum().await;
        for key in [
            "status",
            "workflow_id",
            "current_step_id",
            "parent_id",
            "archived",
            "completed_at",
            "started_at",
            "run_state",
            "depends_on",
        ] {
            let call = format!(r#"vtb::tasks::update(task.id, #{{ {key}: "x" }})"#);
            let error = caught(&server, &call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
            assert_eq!(error["function"], "vtb::tasks::update");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
