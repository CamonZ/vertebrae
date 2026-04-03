use cucumber::{given, then, when};
use fantoccini::Locator;

use crate::GuiWorld;

#[given("the GUI is showing the task list")]
async fn gui_showing_task_list(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let url = format!("{}/tasks", gui_acceptance::tauri_base_url());
    client
        .goto(&url)
        .await
        .expect("failed to navigate to /tasks");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    gui_acceptance::screenshot(&client, &world.scenario_name, "nav-tasks").await;
}

#[given("the GUI is on the kanban board")]
async fn gui_on_kanban_board(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let url = format!("{}/board", gui_acceptance::tauri_base_url());
    client
        .goto(&url)
        .await
        .expect("failed to navigate to /board");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    gui_acceptance::screenshot(&client, &world.scenario_name, "nav-board").await;
}

#[given("the GUI is on the pipeline view")]
async fn gui_on_pipeline_view(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let url = format!("{}/design", gui_acceptance::tauri_base_url());
    client
        .goto(&url)
        .await
        .expect("failed to navigate to /design");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    gui_acceptance::screenshot(&client, &world.scenario_name, "nav-pipeline").await;
}

#[given("the GUI is on the operations view")]
async fn gui_on_operations_view(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let url = format!("{}/operations", gui_acceptance::tauri_base_url());
    client
        .goto(&url)
        .await
        .expect("failed to navigate to /operations");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    gui_acceptance::screenshot(&client, &world.scenario_name, "nav-operations").await;
}

#[then(expr = "the GUI shows {string}")]
async fn gui_shows_text(world: &mut GuiWorld, expected_text: String) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    gui_acceptance::screenshot(
        &client,
        &scenario_name,
        &format!("before-assert-shows-{expected_text}"),
    )
    .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            expected_text
        )))
        .await;

    if element.is_err() {
        gui_acceptance::screenshot(
            &client,
            &scenario_name,
            &format!("fail-shows-{expected_text}"),
        )
        .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' but it was not found on the page",
        expected_text
    );
}

#[then(expr = "the GUI should show {string} within {int} seconds")]
async fn gui_should_show_text_within(world: &mut GuiWorld, expected_text: String, timeout: u64) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    gui_acceptance::screenshot(
        &client,
        &scenario_name,
        &format!("before-assert-show-{expected_text}"),
    )
    .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            expected_text
        )))
        .await;

    if element.is_err() {
        gui_acceptance::screenshot(
            &client,
            &scenario_name,
            &format!("fail-show-{expected_text}"),
        )
        .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' within {} seconds, but it was not found",
        expected_text,
        timeout
    );
}

#[then(expr = "the GUI should not show {string} within {int} seconds")]
async fn gui_should_not_show_text_within(world: &mut GuiWorld, absent_text: String, timeout: u64) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    gui_acceptance::screenshot(
        &client,
        &scenario_name,
        &format!("before-assert-not-show-{absent_text}"),
    )
    .await;

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
            gui_acceptance::screenshot(
                &client,
                &scenario_name,
                &format!("fail-not-show-{absent_text}"),
            )
            .await;
            panic!(
                "expected the GUI to NOT show text '{}' within {} seconds, but it was still present",
                absent_text, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[when(expr = "I click on the element containing text {string}")]
async fn click_element_containing_text(world: &mut GuiWorld, text: String) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            text
        )))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "element containing text '{}' not found within 5 seconds",
                text
            )
        });

    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click element containing text '{}'", text));

    // Brief pause to let the UI respond to the click.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    gui_acceptance::screenshot(&client, &scenario_name, &format!("after-click-{text}")).await;
}

#[then(expr = "the GUI should show an element with title {string} within {int} seconds")]
async fn gui_should_show_element_with_title_within(
    world: &mut GuiWorld,
    title: String,
    timeout: u64,
) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    gui_acceptance::screenshot(
        &client,
        &scenario_name,
        &format!("before-assert-title-{title}"),
    )
    .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&format!("//*[@title='{}']", title)))
        .await;

    if element.is_err() {
        gui_acceptance::screenshot(&client, &scenario_name, &format!("fail-title-{title}")).await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show an element with title '{}' within {} seconds, but it was not found",
        title,
        timeout
    );
}

#[then(expr = "the GUI should not show an element with title {string} within {int} seconds")]
async fn gui_should_not_show_element_with_title_within(
    world: &mut GuiWorld,
    absent_title: String,
    timeout: u64,
) {
    let scenario_name = world.scenario_name.clone();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized");
    let client = wd.lock().await;

    gui_acceptance::screenshot(
        &client,
        &scenario_name,
        &format!("before-assert-no-title-{absent_title}"),
    )
    .await;

    // Poll until the element disappears or the timeout expires.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let found = client
            .find(Locator::XPath(&format!("//*[@title='{}']", absent_title)))
            .await;

        if found.is_err() {
            // Element is absent — assertion passes.
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            gui_acceptance::screenshot(
                &client,
                &scenario_name,
                &format!("fail-no-title-{absent_title}"),
            )
            .await;
            panic!(
                "expected the GUI to NOT show an element with title '{}' within {} seconds, but it was still present",
                absent_title, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}
