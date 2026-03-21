use cucumber::when;

use crate::SmokeWorld;

#[when("I archive the task")]
async fn archive_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["archive", &task_id]).await;
}

#[when(expr = "I archive task {string}")]
async fn archive_task_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["archive", &task_id]).await;
}

#[when("I unarchive the task")]
async fn unarchive_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["unarchive", &task_id]).await;
}

#[when("I run review for the task")]
async fn review_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["review", &task_id]).await;
}

#[when(expr = "I run review for task {string}")]
async fn review_task_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["review", &task_id]).await;
}

#[when(expr = "I run review for the task with --set {word}")]
async fn review_current_task_with_set(world: &mut SmokeWorld, value: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["review", &task_id, "--set", &value]).await;
}

#[when("I run ready")]
async fn run_ready(world: &mut SmokeWorld) {
    world.run_vtb(&["ready"]).await;
}
