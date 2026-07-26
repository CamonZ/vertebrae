use cucumber::when;

use crate::SmokeWorld;

/// Shared logic for creating a task from a data table.
/// Used by both Given and When steps.
pub async fn do_create_task(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("expected a data table");

    let mut args: Vec<String> = vec!["add".to_string()];
    let mut title = String::new();

    for row in &table.rows {
        let key = row[0].as_str();
        let value = world.resolve_vars(row[1].as_str());
        match key {
            "title" => title = value,
            "level" => {
                args.push("--level".to_string());
                args.push(value);
            }
            "description" => {
                args.push("--description".to_string());
                args.push(value);
            }
            "priority" => {
                args.push("--priority".to_string());
                args.push(value);
            }
            "tags" => {
                for tag in value.split(", ") {
                    args.push("--tag".to_string());
                    args.push(tag.trim().to_string());
                }
            }
            "parent" => {
                args.push("--parent".to_string());
                args.push(value);
            }
            "depends_on" => {
                args.push("--depends-on".to_string());
                args.push(value);
            }
            other => panic!("unsupported table key in create task: '{}'", other),
        }
    }

    // Title must be the first positional arg after "add"
    args.insert(1, title);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;

    if world.last_exit_code == 0 {
        let id = world.extract_task_id_from_output().unwrap_or_else(|| {
            panic!(
                "task creation succeeded but returned no task ID.\nstdout: '{}'\nstderr: '{}'",
                world.last_stdout, world.last_stderr
            )
        });
        world.track_task(id);
    }
}

#[when("I create a task with:")]
async fn create_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    do_create_task(world, step).await;
}

#[when("I update the task with:")]
async fn update_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    do_update_task(world, &task_id, step).await;
}

#[when(expr = "I update task {string} with:")]
async fn update_task_by_ref_with_table(
    world: &mut SmokeWorld,
    task_ref: String,
    step: &cucumber::gherkin::Step,
) {
    let task_id = world.resolve_vars(&task_ref);
    do_update_task(world, &task_id, step).await;
}

async fn do_update_task(world: &mut SmokeWorld, task_id: &str, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("expected a data table");

    let mut args: Vec<String> = vec!["update".to_string(), task_id.to_string()];

    for row in &table.rows {
        let key = row[0].as_str();
        let value = world.resolve_vars(row[1].as_str());
        match key {
            "title" => {
                args.push("--title".to_string());
                args.push(value);
            }
            "description" => {
                args.push("--description".to_string());
                args.push(value);
            }
            "priority" => {
                args.push("--priority".to_string());
                args.push(value);
            }
            "add_tags" => {
                for tag in value.split(", ") {
                    args.push("--add-tag".to_string());
                    args.push(tag.trim().to_string());
                }
            }
            "remove_tag" => {
                args.push("--remove-tag".to_string());
                args.push(value);
            }
            "parent" => {
                args.push("--parent".to_string());
                args.push(value);
            }
            "worktree" => {
                args.push("--worktree".to_string());
                args.push(value);
            }
            other => panic!("unsupported table key in update task: '{}'", other),
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;
}

#[when("I delete the task")]
async fn delete_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["delete", &task_id, "--force"]).await;
    if world.last_exit_code == 0 {
        world.created_task_ids.retain(|id| id != &task_id);
    }
}

#[when("I delete the task with --force")]
async fn delete_task_force(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["delete", &task_id, "--force"]).await;
    if world.last_exit_code == 0 {
        world.created_task_ids.retain(|id| id != &task_id);
    }
}

#[when(expr = "I delete task {string} with --cascade --force")]
async fn delete_task_cascade_force(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world
        .run_vtb(&["delete", &task_id, "--cascade", "--force"])
        .await;
    if world.last_exit_code == 0 {
        world.created_task_ids.retain(|id| id != &task_id);
    }
}

#[when(expr = "I delete task {string} with --force")]
async fn delete_task_by_ref_force(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["delete", &task_id, "--force"]).await;
    if world.last_exit_code == 0 {
        world.created_task_ids.retain(|id| id != &task_id);
    }
}

#[when("I show the task")]
async fn show_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["show", &task_id]).await;
}

#[when(expr = "I show the task {string}")]
async fn show_task_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["show", &task_id]).await;
}

#[when("I list tasks")]
async fn list_all_tasks(world: &mut SmokeWorld) {
    world.run_vtb(&["list"]).await;
}

#[when("I list tasks with:")]
async fn list_tasks_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("expected a data table");
    let mut args: Vec<String> = vec!["list".to_string()];

    for row in &table.rows {
        let key = row[0].as_str();
        let value = world.resolve_vars(row[1].as_str());
        match key {
            "level" => {
                args.push("--level".to_string());
                args.push(value);
            }
            "priority" => {
                args.push("--priority".to_string());
                args.push(value);
            }
            "tag" => {
                args.push("--tag".to_string());
                args.push(value);
            }
            "root" => {
                if value == "true" {
                    args.push("--root".to_string());
                }
            }
            "parent" => {
                args.push("--parent".to_string());
                args.push(value);
            }
            "search" => {
                args.push("--search".to_string());
                args.push(value);
            }
            "include_archived" => {
                if value == "true" {
                    args.push("--include-archived".to_string());
                }
            }
            "step" => {
                args.push("--step".to_string());
                args.push(value);
            }
            "workflow" => {
                args.push("--workflow".to_string());
                args.push(value);
            }
            other => panic!("unsupported table key in list tasks: '{}'", other),
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;
}
