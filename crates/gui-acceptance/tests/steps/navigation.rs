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

#[then(expr = "the GUI should show {string} within {int} seconds")]
async fn gui_should_show_text_within(world: &mut GuiWorld, expected_text: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            expected_text
        )))
        .await;

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' within {} seconds, but it was not found",
        expected_text,
        timeout
    );
}

#[then(expr = "the GUI should not show {string} within {int} seconds")]
async fn gui_should_not_show_text_within(world: &mut GuiWorld, absent_text: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    // Poll until the element disappears or the timeout expires.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let found = client
            .find(Locator::XPath(&format!(
                "//*[contains(text(), '{}')]",
                absent_text
            )))
            .await;

        if found.is_err() {
            // Element is absent — assertion passes.
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            panic!(
                "expected the GUI to NOT show text '{}' within {} seconds, but it was still present",
                absent_text, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}
