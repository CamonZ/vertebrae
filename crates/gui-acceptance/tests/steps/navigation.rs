use cucumber::{given, then};
use fantoccini::Locator;

use crate::GuiWorld;

#[given("the GUI is showing the task list")]
async fn gui_showing_task_list(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    client
        .goto("tauri://localhost/tasks")
        .await
        .expect("failed to navigate to /tasks");

    // Wait for the page to load
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
}

#[then(expr = "the GUI shows {string}")]
async fn gui_shows_text(world: &mut GuiWorld, expected_text: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            expected_text
        )))
        .await;

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' but it was not found on the page",
        expected_text
    );
}
