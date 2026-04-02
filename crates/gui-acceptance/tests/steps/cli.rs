use cucumber::when;

use crate::GuiWorld;

#[when(expr = "I create a task {string} via the CLI")]
async fn create_task_via_cli(world: &mut GuiWorld, title: String) {
    world.run_vtb(&["add", &title]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_task_id_from_output() {
        world.track_task(id);
    } else {
        panic!(
            "failed to extract task ID from vtb add output: {}",
            world.last_stdout
        );
    }
}

#[when(expr = "I update the task title to {string} via the CLI")]
async fn update_task_title_via_cli(world: &mut GuiWorld, new_title: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world
        .run_vtb(&["update", &task_id, "--title", &new_title])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb update failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I delete the task via the CLI")]
async fn delete_task_via_cli(world: &mut GuiWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["delete", &task_id, "--force"]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb delete failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    world.created_task_ids.retain(|id| id != &task_id);
}
