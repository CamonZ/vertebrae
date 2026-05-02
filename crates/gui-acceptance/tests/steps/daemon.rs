use cucumber::{given, when};

use crate::GuiWorld;

#[given("the daemon is running for the project")]
#[when("the daemon is running for the project")]
pub async fn daemon_is_running(world: &mut GuiWorld) {
    world.start_daemon().await;
}

#[when(expr = "the step prompt is set to a mock that sleeps {int} milliseconds")]
pub async fn set_sleep_prompt(world: &mut GuiWorld, ms: u64) {
    let envelope = world
        .mock_response("sleep")
        .with_exit_code(0)
        .with_delay_ms(ms)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-gui"}"#)
        .build()
        .expect("MockResponse envelope builds");

    let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--prompt", &envelope])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step update --prompt failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );
}
