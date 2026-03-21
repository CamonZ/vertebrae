use cucumber::when;

use crate::SmokeWorld;

#[when(expr = "I add a {string} section with content {string}")]
async fn add_section(world: &mut SmokeWorld, section_type: String, content: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world
        .run_vtb(&["section", &task_id, &section_type, &content])
        .await;
}

#[when(expr = "I remove the {string} section")]
async fn remove_section(world: &mut SmokeWorld, section_type: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["unsection", &task_id, &section_type]).await;
}

#[when(expr = "I remove the {string} section at index {int}")]
async fn remove_section_at_index(world: &mut SmokeWorld, section_type: String, index: i32) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let index_str = index.to_string();
    world
        .run_vtb(&["unsection", &task_id, &section_type, "--index", &index_str])
        .await;
}

#[when(expr = "I remove the {string} section without index")]
async fn remove_section_without_index(world: &mut SmokeWorld, section_type: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["unsection", &task_id, &section_type]).await;
}

#[when("I list sections")]
async fn list_sections(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["sections", &task_id]).await;
}

#[when(expr = "I list sections with --type {string}")]
async fn list_sections_with_type(world: &mut SmokeWorld, type_filter: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world
        .run_vtb(&["sections", &task_id, "--type", &type_filter])
        .await;
}

#[when(expr = "I check item {int}")]
async fn check_item(world: &mut SmokeWorld, index: i32) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let index_str = index.to_string();
    world.run_vtb(&["check-item", &task_id, &index_str]).await;
}

#[when(expr = "I uncheck item {int}")]
async fn uncheck_item(world: &mut SmokeWorld, index: i32) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let index_str = index.to_string();
    world.run_vtb(&["uncheck-item", &task_id, &index_str]).await;
}
