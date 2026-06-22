use cucumber::{given, then, when};
use fantoccini::Locator;

use crate::GuiWorld;

pub async fn navigate_to(world: &mut GuiWorld, path: &str, label: &str) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let url = format!("{}{}", gui_acceptance::tauri_base_url(), path);
    client
        .goto(&url)
        .await
        .unwrap_or_else(|_| panic!("failed to navigate to {path}"));

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    world.screenshot(&client, label).await;
}

#[given("the GUI is showing the task list")]
async fn gui_showing_task_list(world: &mut GuiWorld) {
    navigate_to(world, "/tasks", "nav-tasks").await;
}

#[given("the GUI is on the kanban board")]
async fn gui_on_kanban_board(world: &mut GuiWorld) {
    navigate_to(world, "/board", "nav-board").await;
}

#[given("the GUI is on the pipeline view")]
#[when("the GUI is on the pipeline view")]
async fn gui_on_pipeline_view(world: &mut GuiWorld) {
    navigate_to(world, "/design", "nav-pipeline").await;
}

#[given("the GUI is on the operations view")]
async fn gui_on_operations_view(world: &mut GuiWorld) {
    navigate_to(world, "/operations", "nav-operations").await;
}

#[then(expr = "the GUI shows {string}")]
async fn gui_shows_text(world: &mut GuiWorld, expected_text: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-shows-{expected_text}"))
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::XPath(&format!(
            "//*[contains(normalize-space(.), '{}')]",
            expected_text
        )))
        .await;

    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-shows-{expected_text}"))
            .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' but it was not found on the page",
        expected_text
    );

    world
        .screenshot(&client, &format!("after-assert-shows-{expected_text}"))
        .await;
}

#[then(expr = "the GUI should show {string} within {int} seconds")]
async fn gui_should_show_text_within(world: &mut GuiWorld, expected_text: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-show-{expected_text}"))
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&format!(
            "//*[contains(normalize-space(.), '{}')]",
            expected_text
        )))
        .await;

    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-show-{expected_text}"))
            .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show text '{}' within {} seconds, but it was not found",
        expected_text,
        timeout
    );

    world
        .screenshot(&client, &format!("after-assert-show-{expected_text}"))
        .await;
}

#[then(expr = "the GUI should not show {string} within {int} seconds")]
async fn gui_should_not_show_text_within(world: &mut GuiWorld, absent_text: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-not-show-{absent_text}"))
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
            world
                .screenshot(&client, &format!("after-assert-not-show-{absent_text}"))
                .await;
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-not-show-{absent_text}"))
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
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let text_xpath = format!("//*[contains(text(), '{}')]", text);
    let clickable_xpath = format!(
        "//*[contains(text(), '{}')]/ancestor-or-self::*[self::button or @role='button'][1]",
        text
    );

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::XPath(&text_xpath))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "element containing text '{}' not found within 5 seconds",
                text
            )
        });

    let click_result = element.click().await;
    if let Err(element_click_err) = click_result {
        let clickable = client
            .wait()
            .at_most(std::time::Duration::from_secs(5))
            .for_element(Locator::XPath(&clickable_xpath))
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "clickable element containing text '{}' not found within 5 seconds",
                    text
                )
            });

        if let Err(clickable_click_err) = clickable.click().await {
            let clickable_json = serde_json::to_value(&clickable).expect("serialize element");
            client
                .execute(
                    "arguments[0].scrollIntoView({ block: 'center', inline: 'center' }); arguments[0].click();",
                    vec![clickable_json],
                )
                .await
                .unwrap_or_else(|js_click_err| {
                    panic!(
                        "failed to click element containing text '{}': element click: {}; clickable click: {}; js click: {}",
                        text, element_click_err, clickable_click_err, js_click_err
                    )
                });
        }
    }

    // Brief pause to let the UI respond to the click.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, &format!("after-click-{text}"))
        .await;
}

#[then(expr = "the GUI should show an element with title {string} within {int} seconds")]
async fn gui_should_show_element_with_title_within(
    world: &mut GuiWorld,
    title: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-title-{title}"))
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&format!("//*[@title='{}']", title)))
        .await;

    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-title-{title}"))
            .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show an element with title '{}' within {} seconds, but it was not found",
        title,
        timeout
    );

    world
        .screenshot(&client, &format!("after-assert-title-{title}"))
        .await;
}

#[then(
    expr = "the pipeline step {string} should show an element with title {string} within {int} seconds"
)]
async fn pipeline_step_should_show_element_with_title_within(
    world: &mut GuiWorld,
    step_name: String,
    title: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator_xpath = format!(
        "//button[contains(normalize-space(.), '{}')]//*[@title='{}']",
        step_name, title
    );

    world
        .screenshot(
            &client,
            &format!("before-assert-step-title-{step_name}-{title}"),
        )
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::XPath(&locator_xpath))
        .await;

    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-step-title-{step_name}-{title}"))
            .await;
    }

    assert!(
        element.is_ok(),
        "expected pipeline step '{}' to show an element with title '{}' within {} seconds",
        step_name,
        title,
        timeout
    );

    world
        .screenshot(
            &client,
            &format!("after-assert-step-title-{step_name}-{title}"),
        )
        .await;
}

#[then(expr = "the GUI should show a disabled element with title {string} within {int} seconds")]
async fn gui_should_show_disabled_element_with_title_within(
    world: &mut GuiWorld,
    title: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-disabled-title-{title}"))
        .await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        if let Ok(element) = client
            .find(Locator::XPath(&format!("//*[@title='{}']", title)))
            .await
        {
            let disabled = element
                .attr("disabled")
                .await
                .expect("failed to read disabled attribute");
            if disabled.is_some() {
                world
                    .screenshot(&client, &format!("after-assert-disabled-title-{title}"))
                    .await;
                return;
            }
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-disabled-title-{title}"))
                .await;
            panic!(
                "expected the GUI to show a disabled element with title '{}' within {} seconds",
                title, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[then(expr = "the GUI should show an element with test id {string} within {int} seconds")]
async fn gui_should_show_element_with_test_id_within(
    world: &mut GuiWorld,
    test_id: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-testid-{test_id}"))
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::Css(&format!("[data-testid=\"{}\"]", test_id)))
        .await;

    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-testid-{test_id}"))
            .await;
    }

    assert!(
        element.is_ok(),
        "expected the GUI to show an element with test id '{}' within {} seconds, but it was not found",
        test_id,
        timeout
    );

    world
        .screenshot(&client, &format!("after-assert-testid-{test_id}"))
        .await;
}

#[then(
    expr = "the GUI element with test id {string} should have text {string} within {int} seconds"
)]
async fn gui_element_with_test_id_should_have_text_within(
    world: &mut GuiWorld,
    test_id: String,
    expected_text: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(
            &client,
            &format!("before-assert-testid-{test_id}-text-{expected_text}"),
        )
        .await;

    let locator = Locator::Css(&format!("[data-testid=\"{}\"]", test_id));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        if let Ok(element) = client.find(locator).await {
            let actual_text = element.text().await.unwrap_or_default();
            if actual_text.trim() == expected_text {
                world
                    .screenshot(
                        &client,
                        &format!("after-assert-testid-{test_id}-text-{expected_text}"),
                    )
                    .await;
                return;
            }
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(
                    &client,
                    &format!("fail-testid-{test_id}-text-{expected_text}"),
                )
                .await;
            panic!(
                "expected GUI element with test id '{}' to have text '{}' within {} seconds",
                test_id, expected_text, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[then(
    expr = "the GUI element with test id {string} should contain text {string} within {int} seconds"
)]
async fn gui_element_with_test_id_should_contain_text_within(
    world: &mut GuiWorld,
    test_id: String,
    expected_text: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(
            &client,
            &format!("before-assert-testid-{test_id}-contains-{expected_text}"),
        )
        .await;

    let locator = Locator::Css(&format!("[data-testid=\"{}\"]", test_id));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        if let Ok(element) = client.find(locator).await {
            let element_json = serde_json::to_value(&element).expect("serialize element");
            let actual_text = client
                .execute("return arguments[0].textContent || '';", vec![element_json])
                .await
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_default();
            if actual_text.contains(&expected_text) {
                world
                    .screenshot(
                        &client,
                        &format!("after-assert-testid-{test_id}-contains-{expected_text}"),
                    )
                    .await;
                return;
            }
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(
                    &client,
                    &format!("fail-testid-{test_id}-contains-{expected_text}"),
                )
                .await;
            panic!(
                "expected GUI element with test id '{}' to contain text '{}' within {} seconds",
                test_id, expected_text, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[then(expr = "the workflow final toggle should be {word} within {int} seconds")]
async fn workflow_final_toggle_should_be_state(
    world: &mut GuiWorld,
    expected_state: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let expected_checked = match expected_state.as_str() {
        "enabled" => "true",
        "disabled" => "false",
        other => panic!("unsupported workflow final toggle state '{}'", other),
    };
    let label = format!("Final workflow: {expected_state}");
    let locator = Locator::XPath(&format!(
        "//*[@role='switch' and @aria-label='{}' and @aria-checked='{}']",
        label, expected_checked
    ));

    world
        .screenshot(
            &client,
            &format!("before-assert-workflow-final-toggle-{expected_state}"),
        )
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(locator)
        .await;

    if element.is_err() {
        world
            .screenshot(
                &client,
                &format!("fail-workflow-final-toggle-{expected_state}"),
            )
            .await;
    }

    assert!(
        element.is_ok(),
        "expected workflow final toggle to be '{}' within {} seconds",
        expected_state,
        timeout
    );

    world
        .screenshot(
            &client,
            &format!("after-assert-workflow-final-toggle-{expected_state}"),
        )
        .await;
}

#[when("I toggle the workflow final setting")]
async fn toggle_workflow_final_setting(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::XPath(
            "//*[@role='switch' and starts-with(@aria-label, 'Final workflow: ')]",
        ))
        .await
        .expect("workflow final toggle not found within 5 seconds");

    element
        .click()
        .await
        .expect("failed to click workflow final toggle");

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, "after-toggle-workflow-final")
        .await;
}

#[then(expr = "the pipeline workflow {string} should show the final badge within {int} seconds")]
async fn pipeline_workflow_should_show_final_badge(
    world: &mut GuiWorld,
    workflow_name: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let locator = Locator::XPath(&format!(
        "//button[normalize-space()='{}']/following-sibling::span[normalize-space()='Final']",
        workflow_name
    ));

    world
        .screenshot(
            &client,
            &format!("before-assert-workflow-final-badge-{workflow_name}"),
        )
        .await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(locator)
        .await;

    if element.is_err() {
        world
            .screenshot(
                &client,
                &format!("fail-workflow-final-badge-{workflow_name}"),
            )
            .await;
    }

    assert!(
        element.is_ok(),
        "expected pipeline workflow '{}' to show the Final badge within {} seconds",
        workflow_name,
        timeout
    );

    world
        .screenshot(
            &client,
            &format!("after-assert-workflow-final-badge-{workflow_name}"),
        )
        .await;
}

#[when(expr = "I click on the element with title {string}")]
async fn click_element_with_title(world: &mut GuiWorld, title: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::XPath(&format!("//*[@title='{}']", title)))
        .await
        .unwrap_or_else(|_| panic!("element with title '{}' not found within 5 seconds", title));

    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click element with title '{}'", title));

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, &format!("after-click-title-{title}"))
        .await;
}

#[when(expr = "I click on the element with test id {string}")]
async fn click_element_with_test_id(world: &mut GuiWorld, test_id: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::Css(&format!("[data-testid=\"{}\"]", test_id)))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "element with test id '{}' not found within 5 seconds",
                test_id
            )
        });

    // Scroll the element into the viewport before clicking. Targets inside
    // scrollable panels (TaskDetailPanel, react-flow canvas) are otherwise
    // reported as found but get intercepted on click when off-screen.
    let element_json = serde_json::to_value(&element).expect("serialize element");
    let _ = client
        .execute(
            "arguments[0].scrollIntoView({block: 'center', inline: 'center'});",
            vec![element_json],
        )
        .await;

    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click element with test id '{}'", test_id));

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, &format!("after-click-testid-{test_id}"))
        .await;
}

#[then(expr = "the GUI should not show an element with test id {string} within {int} seconds")]
async fn gui_should_not_show_element_with_test_id_within(
    world: &mut GuiWorld,
    absent_test_id: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(
            &client,
            &format!("before-assert-no-testid-{absent_test_id}"),
        )
        .await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let found = client
            .find(Locator::Css(&format!(
                "[data-testid=\"{}\"]",
                absent_test_id
            )))
            .await;

        if found.is_err() {
            world
                .screenshot(&client, &format!("after-assert-no-testid-{absent_test_id}"))
                .await;
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-no-testid-{absent_test_id}"))
                .await;
            panic!(
                "expected the GUI to NOT show an element with test id '{}' within {} seconds, but it was still present",
                absent_test_id, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[when(expr = "I type {string} into the element with test id {string}")]
async fn type_into_element_with_test_id(world: &mut GuiWorld, text: String, test_id: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::Css(&format!("[data-testid=\"{}\"]", test_id)))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "element with test id '{}' not found within 5 seconds",
                test_id
            )
        });

    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to focus element with test id '{}'", test_id));

    element.send_keys(&text).await.unwrap_or_else(|_| {
        panic!(
            "failed to send keys '{}' to element with test id '{}'",
            text, test_id
        )
    });

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, &format!("after-type-{test_id}"))
        .await;
}

#[when(expr = "I type the current task ID into the element with test id {string}")]
async fn type_current_task_id_into_element_with_test_id(world: &mut GuiWorld, test_id: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    type_into_element_with_test_id(world, task_id, test_id).await;
}

#[when(expr = "I type the current task short ID into the element with test id {string}")]
async fn type_current_task_short_id_into_element_with_test_id(
    world: &mut GuiWorld,
    test_id: String,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let short_id: String = task_id.chars().take(8).collect();
    type_into_element_with_test_id(world, short_id, test_id).await;
}

#[when(expr = "I press the {string} key")]
async fn press_key(world: &mut GuiWorld, key_name: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let key = match key_name.as_str() {
        "Enter" => "\u{E007}",
        "slash" => "/",
        "j" => "j",
        "k" => "k",
        other => panic!("unsupported key name '{}'", other),
    };

    let active = client
        .active_element()
        .await
        .unwrap_or_else(|_| panic!("failed to get active element to press key '{}'", key_name));

    active
        .send_keys(key)
        .await
        .unwrap_or_else(|_| panic!("failed to send key '{}' to active element", key_name));

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    world
        .screenshot(&client, &format!("after-key-{key_name}"))
        .await;
}

#[when(expr = "I navigate to {string}")]
async fn navigate_to_path(world: &mut GuiWorld, path: String) {
    navigate_to(world, &path, &format!("nav-{}", path.replace('/', "_"))).await;
}

#[then(expr = "the URL should contain {string}")]
async fn url_should_contain(world: &mut GuiWorld, needle: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let url = client
            .current_url()
            .await
            .unwrap_or_else(|_| panic!("failed to read current URL"));
        let url_str = url.as_str();
        if url_str.contains(&needle) {
            world
                .screenshot(&client, &format!("after-assert-url-contains-{needle}"))
                .await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-url-contains-{needle}"))
                .await;
            panic!(
                "expected URL to contain '{}', but current URL is '{}'",
                needle, url_str
            );
        }
        tokio::time::sleep(poll_interval).await;
    }
}

#[then(expr = "the focused element has test id {string}")]
async fn focused_element_has_test_id(world: &mut GuiWorld, expected_test_id: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let active = client
        .active_element()
        .await
        .unwrap_or_else(|_| panic!("failed to get active element"));

    let actual = active
        .attr("data-testid")
        .await
        .unwrap_or_else(|_| panic!("failed to read data-testid attr from active element"));

    if actual.as_deref() != Some(expected_test_id.as_str()) {
        world
            .screenshot(&client, &format!("fail-focused-testid-{expected_test_id}"))
            .await;
        panic!(
            "expected focused element to have test id '{}', got {:?}",
            expected_test_id, actual
        );
    }

    world
        .screenshot(&client, &format!("after-assert-focused-{expected_test_id}"))
        .await;
}

#[then(expr = "the GUI should not show an element with title {string} within {int} seconds")]
async fn gui_should_not_show_element_with_title_within(
    world: &mut GuiWorld,
    absent_title: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, &format!("before-assert-no-title-{absent_title}"))
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
            world
                .screenshot(&client, &format!("after-assert-no-title-{absent_title}"))
                .await;
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-no-title-{absent_title}"))
                .await;
            panic!(
                "expected the GUI to NOT show an element with title '{}' within {} seconds, but it was still present",
                absent_title, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[then(
    expr = "the pipeline step {string} should not show an element with title {string} within {int} seconds"
)]
async fn pipeline_step_should_not_show_element_with_title_within(
    world: &mut GuiWorld,
    step_name: String,
    absent_title: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator_xpath = format!(
        "//button[.//h3[normalize-space()='{}']]//*[@title='{}']",
        step_name, absent_title
    );

    world
        .screenshot(
            &client,
            &format!("before-assert-no-step-title-{step_name}-{absent_title}"),
        )
        .await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let found = client.find(Locator::XPath(&locator_xpath)).await;

        if found.is_err() {
            world
                .screenshot(
                    &client,
                    &format!("after-assert-no-step-title-{step_name}-{absent_title}"),
                )
                .await;
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(
                    &client,
                    &format!("fail-no-step-title-{step_name}-{absent_title}"),
                )
                .await;
            panic!(
                "expected pipeline step '{}' to NOT show an element with title '{}' within {} seconds, but it was still present",
                step_name, absent_title, timeout
            );
        }

        tokio::time::sleep(poll_interval).await;
    }
}
