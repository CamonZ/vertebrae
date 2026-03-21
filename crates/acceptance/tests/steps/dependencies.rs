use cucumber::when;

use crate::SmokeWorld;

/// Shared logic for running depend command.
pub async fn do_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);
    world
        .run_vtb(&["depend", &task_id, "--on", &blocker_id])
        .await;
}

#[when(expr = "I run depend {string} --on {string}")]
async fn when_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    do_run_depend(world, task_ref, blocker_ref).await;
}

#[when(expr = "I run undepend {string} --on {string}")]
async fn when_run_undepend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);
    world
        .run_vtb(&["undepend", &task_id, "--on", &blocker_id])
        .await;
}

#[when("I run blockers for the task")]
async fn when_run_blockers_current(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["blockers", &task_id]).await;
}

#[when(expr = "I run blockers for task {string}")]
async fn when_run_blockers_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["blockers", &task_id]).await;
}

#[when(expr = "I run blockers for task {string} with --depth {int}")]
async fn when_run_blockers_with_depth(world: &mut SmokeWorld, task_ref: String, depth: i32) {
    let task_id = world.resolve_vars(&task_ref);
    let depth_str = depth.to_string();
    world
        .run_vtb(&["blockers", &task_id, "--depth", &depth_str])
        .await;
}

#[when(expr = "I run path {string} {string}")]
async fn when_run_path(world: &mut SmokeWorld, from_ref: String, to_ref: String) {
    let from_id = world.resolve_vars(&from_ref);
    let to_id = world.resolve_vars(&to_ref);
    world.run_vtb(&["path", &from_id, &to_id]).await;
}
