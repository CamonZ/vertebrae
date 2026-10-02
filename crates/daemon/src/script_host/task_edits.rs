//! `vtb::tasks` content and relationship edits: sections, checklist items,
//! code refs, parents and dependencies.
//!
//! Each edit reads the target first and writes only when the requested state
//! doesn't already hold, so a rerun converges. Sections are addressed by their
//! stored ordinal, which Sacrum never renumbers. Every task a script names is
//! checked against the execution's project, even when nothing is written.

use std::collections::HashSet;

use rhai::{Dynamic, Module};
use vertebrae_core::ServiceError;
use vertebrae_core::models::{CodeRef, Section, SectionType, Task};

use super::task_writes::{clearable, require_task};
use super::tasks::{nonblank, scoped_task, section_value};
use super::{
    bool_argument, map_argument, read, set_host_fn, set_host_fn2, set_host_fn4, string_argument,
    uuid_argument,
};
use crate::script_worker::{HostContext, HostError};

const NAMESPACE: &str = "vtb::tasks";

pub(super) fn register(module: &mut Module, host: &HostContext) {
    set_host_fn2(module, host, NAMESPACE, "add_section", add_section);
    set_host_fn4(module, host, NAMESPACE, "edit_section", edit_section);
    set_host_fn2(module, host, NAMESPACE, "check_item", check_item);
    set_host_fn2(module, host, NAMESPACE, "uncheck_item", uncheck_item);
    set_host_fn2(module, host, NAMESPACE, "add_code_ref", add_code_ref);
    set_host_fn2(module, host, NAMESPACE, "remove_code_ref", remove_code_ref);
    set_host_fn2(module, host, NAMESPACE, "set_parent", set_parent);
    set_host_fn(module, host, NAMESPACE, "remove_parent", remove_parent);
    set_host_fn2(module, host, NAMESPACE, "add_dependency", add_dependency);
    set_host_fn2(
        module,
        host,
        NAMESPACE,
        "remove_dependency",
        remove_dependency,
    );
}

/// A single-instance type replaces the stored section unless its content is
/// already the same; any other type appends, which is not idempotent.
fn add_section(host: &HostContext, id: Dynamic, section: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let section = section_input(section)?;
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    let single = section.section_type.is_single_instance();
    if single
        && let Some(stored) = task.sections.iter().find(|stored| {
            stored.section_type == section.section_type && stored.content == section.content
        })
    {
        return Ok(section_value(stored));
    }
    let stored = host.call(|services, _| async move {
        if single {
            services.tasks().upsert_section(&id, section).await
        } else {
            services.tasks().add_section(&id, section).await
        }
    })?;
    Ok(section_value(&stored))
}

fn edit_section(
    host: &HostContext,
    id: Dynamic,
    section_type: Dynamic,
    order: Dynamic,
    content: Dynamic,
) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let section_type = section_type_argument(section_type)?;
    let order = ordinal_argument(order)?;
    let content = nonblank(string_argument(content, "Content")?, "Content")?;
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    let stored = stored_section(&task, &section_type, order)?;
    if stored.content == content {
        return Ok(section_value(stored));
    }
    let edited = host.call(|services, _| {
        services
            .tasks()
            .edit_section_by_ordinal(&id, section_type, order, &content)
    })?;
    Ok(section_value(&edited))
}

fn check_item(host: &HostContext, id: Dynamic, order: Dynamic) -> Result<Dynamic, HostError> {
    set_item_done(host, id, order, true)
}

fn uncheck_item(host: &HostContext, id: Dynamic, order: Dynamic) -> Result<Dynamic, HostError> {
    set_item_done(host, id, order, false)
}

/// Toggle only when the stored state differs, so the toggle always lands on
/// `done` (barring a concurrent writer).
fn set_item_done(
    host: &HostContext,
    id: Dynamic,
    order: Dynamic,
    done: bool,
) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let order = ordinal_argument(order)?;
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    let stored = stored_section(&task, &SectionType::ChecklistItem, order)?;
    if stored.done.unwrap_or(false) == done {
        return Ok(section_value(stored));
    }
    let updated = host.call(|services, _| async move {
        if done {
            services.tasks().mark_checklist_item_done(&id, order).await
        } else {
            services
                .tasks()
                .toggle_checklist_item_done(&id, order)
                .await
        }
    })?;
    Ok(section_value(&updated))
}

fn add_code_ref(host: &HostContext, id: Dynamic, code_ref: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let code_ref = code_ref_input(code_ref)?;
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    if !task.code_refs.contains(&code_ref) {
        host.call(|services, _| services.tasks().add_code_ref(&id, code_ref))?;
    }
    Ok(Dynamic::UNIT)
}

/// Ref identity is the whole five-field ref; matching positions are resolved
/// from the read just before removal.
fn remove_code_ref(
    host: &HostContext,
    id: Dynamic,
    code_ref: Dynamic,
) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let code_ref = code_ref_input(code_ref)?;
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    let matches: Vec<usize> = task
        .code_refs
        .iter()
        .enumerate()
        .filter_map(|(index, stored)| (*stored == code_ref).then_some(index))
        .collect();
    if !matches.is_empty() {
        host.call(|services, _| services.tasks().remove_code_refs(&id, Some(matches)))?;
    }
    Ok(Dynamic::UNIT)
}

/// Sacrum doesn't reject parent cycles, so the new parent's ancestors are
/// walked first.
fn set_parent(host: &HostContext, id: Dynamic, parent_id: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let parent_id = uuid_argument(parent_id, "Parent ID")?;
    if id == parent_id {
        return Err(HostError::invalid(format!(
            "Task {id} cannot be its own parent"
        )));
    }
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    let parent = require_task(host, &parent_id, ServiceError::parent_not_found)?;
    if task.parent_id.as_deref() == Some(parent_id.as_str()) {
        return Ok(Dynamic::UNIT);
    }
    if is_ancestor(host, &id, parent.parent_id)? {
        return Err(HostError::invalid(format!(
            "Task {parent_id} is a descendant of {id}, so it cannot become its parent"
        )));
    }
    host.call(|services, _| services.tasks().set_parent(&id, &parent_id))?;
    Ok(Dynamic::UNIT)
}

/// Whether `id` appears on the parent chain that starts at `next`. The walk
/// stops at a task outside the project or one it has already seen.
fn is_ancestor(host: &HostContext, id: &str, mut next: Option<String>) -> Result<bool, HostError> {
    read(host, |services, project| async move {
        let mut seen = HashSet::new();
        while let Some(ancestor) = next {
            if ancestor == id {
                return Ok(true);
            }
            if !seen.insert(ancestor.clone()) {
                break;
            }
            next = scoped_task(services, project, &ancestor)
                .await?
                .and_then(|task| task.parent_id);
        }
        Ok(false)
    })
}

fn remove_parent(host: &HostContext, id: Dynamic) -> Result<Dynamic, HostError> {
    let id = uuid_argument(id, "Task ID")?;
    if require_task(host, &id, ServiceError::task_not_found)?
        .parent_id
        .is_some()
    {
        host.call(|services, _| services.tasks().remove_parent(&id))?;
    }
    Ok(Dynamic::UNIT)
}

/// Sacrum rejects a dependency cycle, which surfaces as `invalid`.
fn add_dependency(
    host: &HostContext,
    id: Dynamic,
    depends_on: Dynamic,
) -> Result<Dynamic, HostError> {
    let (id, depends_on, present) = dependency_edge(host, id, depends_on)?;
    if !present {
        host.call(|services, _| services.tasks().add_dependency(&id, &depends_on))?;
    }
    Ok(Dynamic::UNIT)
}

fn remove_dependency(
    host: &HostContext,
    id: Dynamic,
    depends_on: Dynamic,
) -> Result<Dynamic, HostError> {
    let (id, depends_on, present) = dependency_edge(host, id, depends_on)?;
    if present {
        host.call(|services, _| services.tasks().remove_dependency(&id, &depends_on))?;
    }
    Ok(Dynamic::UNIT)
}

/// Check both endpoints and report whether `id` already depends on
/// `depends_on`.
fn dependency_edge(
    host: &HostContext,
    id: Dynamic,
    depends_on: Dynamic,
) -> Result<(String, String, bool), HostError> {
    let id = uuid_argument(id, "Task ID")?;
    let depends_on = uuid_argument(depends_on, "Dependency ID")?;
    if id == depends_on {
        return Err(HostError::invalid(format!(
            "Task {id} cannot depend on itself"
        )));
    }
    let task = require_task(host, &id, ServiceError::task_not_found)?;
    require_task(host, &depends_on, ServiceError::dependency_not_found)?;
    let present = task.blockers.iter().any(|blocker| blocker.id == depends_on);
    Ok((id, depends_on, present))
}

/// A section's address is its type plus stored ordinal, never its position.
fn stored_section<'a>(
    task: &'a Task,
    section_type: &SectionType,
    order: u32,
) -> Result<&'a Section, HostError> {
    task.sections
        .iter()
        .find(|section| section.section_type == *section_type && section.order == Some(order))
        .ok_or_else(|| {
            HostError::invalid(format!(
                "Task {} has no {section_type} section with order {order}",
                task.id
            ))
        })
}

fn section_input(section: Dynamic) -> Result<Section, HostError> {
    let mut section_type = None;
    let mut content = None;
    let mut done = None;
    for (key, value) in map_argument(section, "Section")? {
        let what = format!("Section key '{key}'");
        match key.as_str() {
            "type" => section_type = Some(section_type_argument(value)?),
            "content" => content = Some(nonblank(string_argument(value, &what)?, &what)?),
            "done" => done = Some(bool_argument(value, &what)?),
            _ => {
                return Err(HostError::invalid(format!(
                    "Unknown section key '{key}'; accepted keys are type, content and done"
                )));
            }
        }
    }
    let section_type =
        section_type.ok_or_else(|| HostError::invalid("Section key 'type' is required"))?;
    let content = content.ok_or_else(|| HostError::invalid("Section key 'content' is required"))?;
    let mut section = Section::new(section_type, content);
    if section.section_type == SectionType::ChecklistItem {
        section.done = Some(done.unwrap_or(false));
    } else if done.is_some() {
        return Err(HostError::invalid(
            "Section key 'done' applies only to checklist_item sections",
        ));
    }
    Ok(section)
}

fn section_type_argument(value: Dynamic) -> Result<SectionType, HostError> {
    string_argument(value, "Section type")?
        .parse()
        .map_err(HostError::invalid)
}

fn code_ref_input(code_ref: Dynamic) -> Result<CodeRef, HostError> {
    let mut path = None;
    let mut parsed = CodeRef::file(String::new());
    for (key, value) in map_argument(code_ref, "Code ref")? {
        let what = format!("Code ref key '{key}'");
        match key.as_str() {
            "path" => path = Some(nonblank(string_argument(value, &what)?, &what)?),
            "line_start" => parsed.line_start = clearable(value, |v| line(v, &what))?,
            "line_end" => parsed.line_end = clearable(value, |v| line(v, &what))?,
            "name" => parsed.name = clearable(value, |v| string_argument(v, &what))?,
            "description" => {
                parsed.description = clearable(value, |v| string_argument(v, &what))?;
            }
            _ => {
                return Err(HostError::invalid(format!(
                    "Unknown code ref key '{key}'; accepted keys are path, line_start, \
                     line_end, name and description"
                )));
            }
        }
    }
    parsed.path = path.ok_or_else(|| HostError::invalid("Code ref key 'path' is required"))?;
    match (parsed.line_start, parsed.line_end) {
        (None, Some(_)) => Err(HostError::invalid(
            "Code ref key 'line_end' requires 'line_start'",
        )),
        (Some(start), Some(end)) if end < start => Err(HostError::invalid(format!(
            "Code ref line_end {end} precedes line_start {start}"
        ))),
        _ => Ok(parsed),
    }
}

/// Ordinals and lines travel as GraphQL `Int`, a signed 32-bit integer.
fn int_in(value: Dynamic, what: &str, min: i64) -> Result<u32, HostError> {
    let type_name = value.type_name();
    let number = value
        .as_int()
        .map_err(|_| HostError::invalid(format!("{what} must be an integer, got {type_name}")))?;
    let max = i64::from(i32::MAX);
    u32::try_from(number)
        .ok()
        .filter(|_| (min..=max).contains(&number))
        .ok_or_else(|| {
            HostError::invalid(format!(
                "{what} must be between {min} and {max}, got {number}"
            ))
        })
}

fn ordinal_argument(value: Dynamic) -> Result<u32, HostError> {
    int_in(value, "Section order", 0)
}

fn line(value: Dynamic, what: &str) -> Result<u32, HostError> {
    int_in(value, what, 1)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use wiremock::{MockServer, Request, Respond, ResponseTemplate};

    use super::super::test_support::{self, OTHER_PROJECT, PROJECT, sacrum_requests};

    const SELF: &str = "e0000000-0000-4000-8000-000000000001";
    const OTHER: &str = "e0000000-0000-4000-8000-000000000002";
    const CHILD: &str = "e0000000-0000-4000-8000-000000000003";
    const GRANDCHILD: &str = "e0000000-0000-4000-8000-000000000004";
    const FOREIGN: &str = "e0000000-0000-4000-8000-000000000005";
    const MISSING: &str = "e0000000-0000-4000-8000-000000000006";
    const UNAUTHORIZED: &str = "e0000000-0000-4000-8000-000000000007";

    const IDS: [(&str, &str); 6] = [
        ("UNAUTHORIZED", UNAUTHORIZED),
        ("OTHER", OTHER),
        ("GRANDCHILD", GRANDCHILD),
        ("CHILD", CHILD),
        ("FOREIGN", FOREIGN),
        ("MISSING", MISSING),
    ];

    fn row(id: &str, project: &str, parent: Option<&str>) -> Value {
        json!({
            "id": id, "project_id": project, "title": id, "level": "task",
            "tags": [], "archived": false, "parent_id": parent,
            "inserted_at": "2026-10-01T10:00:00Z", "sections": [], "code_refs": [],
        })
    }

    fn section(id: usize, section_type: &str, content: &str, order: usize) -> Value {
        json!({
            "id": format!("f0000000-0000-4000-8000-{id:012}"),
            "section_type": section_type, "content": content,
            "section_order": order, "done": false, "code_refs": [],
        })
    }

    fn code_ref(id: usize, task_id: &str, path: &str, line_start: Option<u32>) -> Value {
        json!({
            "id": format!("a0000000-0000-4000-8000-{id:012}"), "task_id": task_id,
            "path": path, "line_start": line_start, "line_end": null,
            "name": null, "description": null,
        })
    }

    #[derive(Default)]
    struct State {
        rows: Vec<Value>,
        /// `(task, depends_on)` edges.
        edges: Vec<(String, String)>,
        next_id: usize,
    }

    impl State {
        fn row_mut(&mut self, id: &Value) -> &mut Value {
            self.rows.iter_mut().find(|row| row["id"] == *id).unwrap()
        }

        fn fresh_id(&mut self) -> usize {
            self.next_id += 1;
            100 + self.next_id
        }

        fn depends_transitively(&self, from: &str, on: &str) -> bool {
            self.edges
                .iter()
                .filter(|(task, _)| task == from)
                .any(|(_, dep)| dep == on || self.depends_transitively(dep, on))
        }
    }

    /// A Sacrum that applies content and relationship mutations to its rows
    /// and, like the real one, never renumbers sections and rejects
    /// dependency cycles but not parent cycles.
    struct Sacrum(Mutex<State>);

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
            let data = if query.contains("query GetTask(") {
                if vars["id"] == UNAUTHORIZED {
                    return graphql_error("unauthorized");
                }
                let Some(task) = state.rows.iter().find(|row| row["id"] == vars["id"]) else {
                    return ResponseTemplate::new(200).set_body_json(
                        json!({"data": {"task": null}, "errors": [{"message": "not_found"}]}),
                    );
                };
                let mut task = task.clone();
                task["blockers"] = state
                    .edges
                    .iter()
                    .filter(|(from, _)| *from == vars["id"])
                    .map(|(_, on)| state.rows.iter().find(|row| row["id"] == *on).unwrap())
                    .cloned()
                    .collect();
                json!({"task": task})
            } else if query.contains("mutation CreateSection(")
                || query.contains("mutation UpsertSection(")
            {
                let id = state.fresh_id();
                let section_type = vars["section_type"].as_str().unwrap().to_string();
                let task = state.row_mut(&vars["task_id"]);
                let sections = task["sections"].as_array_mut().unwrap();
                if query.contains("UpsertSection") {
                    sections.retain(|s| s["section_type"] != section_type);
                }
                let order = sections
                    .iter()
                    .filter(|s| s["section_type"] == section_type)
                    .map(|s| s["section_order"].as_u64().unwrap() as usize + 1)
                    .max()
                    .unwrap_or(0);
                let mut created =
                    section(id, &section_type, vars["content"].as_str().unwrap(), order);
                created["done"] = vars["done"].clone();
                sections.push(created.clone());
                return ResponseTemplate::new(200).set_body_json(json!({"data": {
                    if query.contains("UpsertSection") { "upsert_section" } else { "create_section" }:
                    created
                }}));
            } else if query.contains("mutation UpdateSection(") {
                let section = state
                    .rows
                    .iter_mut()
                    .flat_map(|row| row["sections"].as_array_mut().unwrap())
                    .find(|section| section["id"] == vars["id"])
                    .unwrap();
                for key in ["content", "done", "done_at"] {
                    if let Some(value) = vars.get(key) {
                        section[key] = value.clone();
                    }
                }
                json!({"update_section": section.clone()})
            } else if query.contains("mutation CreateCodeRef(") {
                match vars["path"].as_str() {
                    Some("rejected") => return graphql_error("path is reserved"),
                    Some("down") => {
                        return ResponseTemplate::new(503).set_body_string("upstream down");
                    }
                    _ => {}
                }
                let id = state.fresh_id();
                let mut created = code_ref(id, vars["task_id"].as_str().unwrap(), "", None);
                for key in ["path", "line_start", "line_end", "name", "description"] {
                    created[key] = vars[key].clone();
                }
                let task = state.row_mut(&vars["task_id"]);
                task["code_refs"].as_array_mut().unwrap().push(created);
                json!({"create_code_ref": {"id": "created"}})
            } else if query.contains("mutation DeleteCodeRef(") {
                for row in &mut state.rows {
                    row["code_refs"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|code_ref| code_ref["id"] != vars["id"]);
                }
                json!({"delete_code_ref": {"id": vars["id"]}})
            } else if query.contains("mutation UpdateTask(") {
                state.row_mut(&vars["id"])["parent_id"] = vars["parent_id"].clone();
                json!({"update_task": {"id": vars["id"]}})
            } else if query.contains("mutation CreateTaskDependency(") {
                let (task, on) = (
                    vars["task_id"].as_str().unwrap(),
                    vars["depends_on_id"].as_str().unwrap(),
                );
                if state.depends_transitively(on, task) {
                    return graphql_error("would create a circular dependency");
                }
                state.edges.push((task.into(), on.into()));
                json!({"create_task_dependency": {"id": task}})
            } else if query.contains("mutation DeleteTaskDependency(") {
                state.edges.retain(|(task, on)| {
                    !(*task == vars["task_id"] && *on == vars["depends_on_id"])
                });
                json!({"delete_task_dependency": {"id": vars["task_id"]}})
            } else {
                panic!("unexpected Sacrum request: {query}");
            };
            ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
        }
    }

    /// `SELF` has checklist items at orders 1 and 2 (order 0 was removed),
    /// a duplicated ref and a single-line ref; `CHILD` and `GRANDCHILD` hang
    /// below it, and `OTHER` depends on it.
    async fn sacrum() -> MockServer {
        let mut this = row(SELF, PROJECT, None);
        this["sections"] = json!([
            section(1, "checklist_item", "second", 1),
            section(2, "checklist_item", "third", 2),
            section(3, "goal", "Ship it", 0),
        ]);
        this["code_refs"] = json!([
            code_ref(1, SELF, "src/lib.rs", None),
            code_ref(2, SELF, "src/main.rs", Some(3)),
            code_ref(3, SELF, "src/lib.rs", None),
        ]);
        test_support::sacrum(Sacrum(Mutex::new(State {
            rows: vec![
                this,
                row(OTHER, PROJECT, None),
                row(CHILD, PROJECT, Some(SELF)),
                row(GRANDCHILD, PROJECT, Some(CHILD)),
                row(FOREIGN, OTHER_PROJECT, None),
            ],
            edges: vec![(OTHER.into(), SELF.into())],
            next_id: 0,
        })))
        .await
    }

    async fn output(server: &MockServer, script: &str) -> Value {
        test_support::completed(test_support::run(server, SELF, &IDS, script).await, script)
    }

    async fn caught(server: &MockServer, call: &str) -> Value {
        output(
            server,
            &format!(
                "let caught = (); try {{ {call}; }} catch (error) {{ caught = error; }} caught"
            ),
        )
        .await
    }

    async fn writes(server: &MockServer) -> Vec<Value> {
        sacrum_requests(server, "mutation ").await
    }

    #[tokio::test]
    async fn sections_are_edited_and_checked_by_stored_ordinal() {
        let server = sacrum().await;
        let read = output(
            &server,
            r#"
            let added = vtb::tasks::add_section(task.id, #{ type: "checklist_item", content: "fourth" });
            let kept_goal = vtb::tasks::add_section(task.id, #{ type: "goal", content: "Ship it" });
            let goal = vtb::tasks::add_section(task.id, #{ type: "goal", content: "Ship it twice" });
            let done = vtb::tasks::add_section(task.id, #{ type: "checklist_item", content: "fifth", done: true });
            let edited = vtb::tasks::edit_section(task.id, "checklist_item", 2, "third, edited");
            vtb::tasks::edit_section(task.id, "checklist_item", 2, "third, edited");
            let checked = vtb::tasks::check_item(task.id, 2);
            vtb::tasks::check_item(task.id, 2);
            vtb::tasks::check_item(task.id, added.order);
            vtb::tasks::uncheck_item(task.id, 1);
            vtb::tasks::uncheck_item(task.id, added.order);
            let items = vtb::tasks::get(task.id).sections.filter(|s| s.type == "checklist_item");
            #{
                added: added, kept_goal: kept_goal.content, goal: goal.content,
                done: done.done, edited: edited, checked: checked.done,
                items: items.map(|s| [s.order, s.content, s.done])
            }
            "#,
        )
        .await;
        assert_eq!(read["added"]["order"], 3);
        assert_eq!(read["added"]["type"], "checklist_item");
        assert_eq!(read["added"]["done"], false);
        assert_eq!(read["kept_goal"], "Ship it");
        assert_eq!(read["goal"], "Ship it twice");
        assert_eq!(read["done"], true);
        assert_eq!(read["edited"]["order"], 2);
        assert_eq!(read["edited"]["content"], "third, edited");
        assert_eq!(read["checked"], true);
        assert_eq!(
            read["items"],
            json!([
                [1, "second", false],
                [2, "third, edited", true],
                [3, "fourth", false],
                [4, "fifth", true]
            ])
        );
        // Two appends, one goal replacement, one edit, two checks and one
        // uncheck of `fourth`; the repeats and `second`'s uncheck write nothing.
        assert_eq!(writes(&server).await.len(), 7);
        assert_eq!(
            sacrum_requests(&server, "mutation UpsertSection(").await,
            [
                json!({"task_id": SELF, "section_type": "goal", "content": "Ship it twice", "done": null})
            ]
        );
    }

    #[tokio::test]
    async fn code_refs_are_matched_by_all_five_fields() {
        let server = sacrum().await;
        let refs = output(
            &server,
            r#"
            let line = #{ path: "src/main.rs", line_start: 3 };
            vtb::tasks::add_code_ref(task.id, line);
            vtb::tasks::add_code_ref(task.id, #{ path: "src/main.rs", line_start: 3, line_end: 9, name: "main", description: () });
            vtb::tasks::add_code_ref(task.id, #{ path: "src/main.rs", line_start: 3, line_end: 9, name: "main" });
            vtb::tasks::remove_code_ref(task.id, #{ path: "src/lib.rs" });
            vtb::tasks::remove_code_ref(task.id, #{ path: "src/lib.rs" });
            vtb::tasks::remove_code_ref(task.id, #{ path: "src/main.rs", line_start: 4 });
            vtb::tasks::get(task.id).code_refs.map(|r| [r.path, r.line_start, r.line_end, r.name])
            "#,
        )
        .await;
        assert_eq!(
            refs,
            json!([
                ["src/main.rs", 3, null, null],
                ["src/main.rs", 3, 9, "main"]
            ])
        );
        assert_eq!(
            sacrum_requests(&server, "mutation CreateCodeRef(").await,
            [json!({
                "task_id": SELF, "path": "src/main.rs", "line_start": 3, "line_end": 9,
                "name": "main", "description": null
            })]
        );
        // Both copies of the duplicated ref go in one removal.
        assert_eq!(
            sacrum_requests(&server, "mutation DeleteCodeRef(")
                .await
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn relationship_edits_converge_on_reruns() {
        let server = sacrum().await;
        let read = output(
            &server,
            r#"
            for pass in 0..2 {
                vtb::tasks::set_parent($OTHER, task.id);
                vtb::tasks::add_dependency(task.id, $CHILD);
                vtb::tasks::remove_dependency($OTHER, task.id);
                vtb::tasks::remove_parent($GRANDCHILD);
            }
            #{
                parent: vtb::tasks::get($OTHER).parent_id,
                grandchild_parent: vtb::tasks::get($GRANDCHILD).parent_id,
                blockers: vtb::tasks::dependencies(task.id).map(|t| t.id),
                other_blockers: vtb::tasks::dependencies($OTHER).len()
            }
            "#,
        )
        .await;
        assert_eq!(read["parent"], SELF);
        assert_eq!(read["grandchild_parent"], Value::Null);
        assert_eq!(read["blockers"], json!([CHILD]));
        assert_eq!(read["other_blockers"], 0);
        assert_eq!(
            writes(&server).await,
            [
                json!({"id": OTHER, "parent_id": SELF}),
                json!({"task_id": SELF, "depends_on_id": CHILD}),
                json!({"task_id": OTHER, "depends_on_id": SELF}),
                json!({"id": GRANDCHILD, "parent_id": null}),
            ]
        );
    }

    #[tokio::test]
    async fn cycles_self_edges_and_descendant_parents_are_invalid_and_change_nothing() {
        let server = sacrum().await;
        for call in [
            "vtb::tasks::set_parent(task.id, task.id)",
            "vtb::tasks::set_parent(task.id, $CHILD)",
            "vtb::tasks::set_parent(task.id, $GRANDCHILD)",
            "vtb::tasks::add_dependency(task.id, task.id)",
            "vtb::tasks::remove_dependency(task.id, task.id)",
            // `OTHER` already depends on this task; Sacrum refuses the cycle.
            "vtb::tasks::add_dependency(task.id, $OTHER)",
        ] {
            let error = caught(&server, call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
        }
        assert_eq!(
            writes(&server).await,
            [json!({"task_id": SELF, "depends_on_id": OTHER})]
        );
        let blockers = output(&server, "vtb::tasks::dependencies(task.id).len()").await;
        assert_eq!(blockers, 0);
    }

    #[tokio::test]
    async fn absent_or_foreign_targets_are_not_found_and_write_nothing() {
        let server = sacrum().await;
        for target in ["$FOREIGN", "$MISSING"] {
            for call in [
                format!(r#"vtb::tasks::add_section({target}, #{{ type: "goal", content: "x" }})"#),
                format!(r#"vtb::tasks::edit_section({target}, "goal", 0, "x")"#),
                format!("vtb::tasks::check_item({target}, 0)"),
                format!("vtb::tasks::uncheck_item({target}, 0)"),
                format!(r#"vtb::tasks::add_code_ref({target}, #{{ path: "x" }})"#),
                format!(r#"vtb::tasks::remove_code_ref({target}, #{{ path: "x" }})"#),
                format!("vtb::tasks::set_parent({target}, task.id)"),
                format!("vtb::tasks::set_parent(task.id, {target})"),
                format!("vtb::tasks::remove_parent({target})"),
                format!("vtb::tasks::add_dependency({target}, task.id)"),
                format!("vtb::tasks::add_dependency(task.id, {target})"),
                format!("vtb::tasks::remove_dependency(task.id, {target})"),
            ] {
                let error = caught(&server, &call).await;
                assert_eq!(error["kind"], "not_found", "{call}: {error}");
            }
        }
        // A failed target read is a backend failure, never `invalid`.
        let error = caught(
            &server,
            "vtb::tasks::add_dependency(task.id, $UNAUTHORIZED)",
        )
        .await;
        assert_eq!(error["kind"], "transport", "{error}");
        assert_eq!(error["function"], "vtb::tasks::add_dependency");
        assert!(writes(&server).await.is_empty());
    }

    #[tokio::test]
    async fn missing_ordinals_and_wrong_section_types_are_invalid() {
        let server = sacrum().await;
        for call in [
            // Order 0 was removed; the remaining items keep orders 1 and 2.
            r#"vtb::tasks::edit_section(task.id, "checklist_item", 0, "x")"#,
            "vtb::tasks::check_item(task.id, 0)",
            "vtb::tasks::uncheck_item(task.id, 7)",
            r#"vtb::tasks::edit_section(task.id, "constraint", 1, "x")"#,
        ] {
            let error = caught(&server, call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
        }
        assert!(writes(&server).await.is_empty());
    }

    #[tokio::test]
    async fn write_failures_keep_their_categories() {
        let server = sacrum().await;
        let caught = output(
            &server,
            r#"
            let caught = [];
            for path in ["rejected", "down"] {
                try {
                    vtb::tasks::add_code_ref(task.id, #{ path: path });
                } catch (error) {
                    caught.push([error.kind, error.function]);
                }
            }
            caught
            "#,
        )
        .await;
        assert_eq!(
            caught,
            json!([
                // A backend rejection of the write itself.
                ["invalid", "vtb::tasks::add_code_ref"],
                // The outcome of a failed request is unknown.
                ["transport", "vtb::tasks::add_code_ref"]
            ])
        );
    }

    #[tokio::test]
    async fn invalid_arguments_raise_invalid_without_calling_sacrum() {
        let server = sacrum().await;
        for call in [
            r#"vtb::tasks::add_section(task.id, #{ type: "summary", content: "x" })"#,
            r#"vtb::tasks::add_section(task.id, #{ type: "goal" })"#,
            r#"vtb::tasks::add_section(task.id, #{ content: "x" })"#,
            r#"vtb::tasks::add_section(task.id, #{ type: "goal", content: " " })"#,
            r#"vtb::tasks::add_section(task.id, #{ type: "goal", content: "x", done: true })"#,
            r#"vtb::tasks::add_section(task.id, #{ type: "checklist_item", content: "x", done: "yes" })"#,
            r#"vtb::tasks::add_section(task.id, #{ type: "goal", content: "x", order: 1 })"#,
            r#"vtb::tasks::add_section(task.id, "goal")"#,
            r#"vtb::tasks::edit_section(task.id, "goal", -1, "x")"#,
            r#"vtb::tasks::edit_section(task.id, "goal", 2147483648, "x")"#,
            r#"vtb::tasks::edit_section(task.id, "goal", "0", "x")"#,
            r#"vtb::tasks::edit_section(task.id, "goal", 0, "")"#,
            "vtb::tasks::check_item(task.id, 1.0)",
            r#"vtb::tasks::add_code_ref(task.id, #{})"#,
            r#"vtb::tasks::add_code_ref(task.id, #{ path: "" })"#,
            r#"vtb::tasks::add_code_ref(task.id, #{ path: "x", line_start: 0 })"#,
            r#"vtb::tasks::add_code_ref(task.id, #{ path: "x", line_end: 3 })"#,
            r#"vtb::tasks::add_code_ref(task.id, #{ path: "x", line_start: 5, line_end: 4 })"#,
            r#"vtb::tasks::add_code_ref(task.id, #{ path: "x", lines: "1-2" })"#,
            r#"vtb::tasks::remove_code_ref(task.id, #{ path: "x", name: 1 })"#,
            r#"vtb::tasks::set_parent(task.id, "e0000000")"#,
            "vtb::tasks::remove_parent(())",
            r#"vtb::tasks::add_dependency("short", task.id)"#,
            "vtb::tasks::remove_dependency(task.id, 1)",
        ] {
            let error = caught(&server, call).await;
            assert_eq!(error["kind"], "invalid", "{call}: {error}");
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
