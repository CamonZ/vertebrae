use std::time::Duration;

use cucumber::{given, then, when};
use fantoccini::Locator;

use crate::GuiWorld;

fn registered_daemon_name(world: &GuiWorld) -> &str {
    world
        .daemon_name
        .as_deref()
        .expect("the scenario has not registered a daemon")
}

fn registered_daemon_row_xpath(name: &str) -> String {
    // The generated acceptance name contains only ASCII letters, digits, and
    // hyphens, so it is safe to embed in this XPath literal.
    format!("//button[starts-with(@aria-label, '{name},')]")
}

async fn click_test_id(world: &mut GuiWorld, test_id: &str) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let element = client
        .wait()
        .at_most(Duration::from_secs(10))
        .for_element(Locator::Css(&format!("[data-testid='{test_id}']")))
        .await
        .unwrap_or_else(|_| panic!("element with test id '{test_id}' was not found"));
    gui_acceptance::wait_actionable(&element).await;
    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click element with test id '{test_id}'"));
    world
        .screenshot(&client, &format!("after-click-{test_id}"))
        .await;
}

async fn wait_for_registered_daemon_row(world: &mut GuiWorld, timeout: u64) {
    let name = registered_daemon_name(world).to_string();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let row = client
        .wait()
        .at_most(Duration::from_secs(timeout))
        .for_element(Locator::XPath(&registered_daemon_row_xpath(&name)))
        .await
        .unwrap_or_else(|_| {
            panic!("registered daemon '{name}' was not visible within {timeout} seconds")
        });

    let test_id = row
        .attr("data-testid")
        .await
        .expect("failed to read registered daemon row test id")
        .expect("registered daemon row has no test id");
    let daemon_id = test_id
        .strip_prefix("daemon-row-")
        .expect("registered daemon row test id has an unexpected format")
        .to_string();
    world.daemon_id = Some(daemon_id);
    world
        .screenshot(&client, "registered-daemon-row-visible")
        .await;
}

#[given("the GUI is showing the daemon fleet")]
async fn gui_showing_daemon_fleet(world: &mut GuiWorld) {
    crate::steps::navigation::navigate_to(world, "/daemons", "nav-daemons").await;
}

#[when("I register a uniquely named daemon")]
async fn register_unique_daemon(world: &mut GuiWorld) {
    let name = format!("gui-acceptance-daemon-{}", uuid::Uuid::new_v4());
    world.daemon_name = Some(name.clone());

    click_test_id(world, "daemon-register").await;

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let input = client
        .wait()
        .at_most(Duration::from_secs(10))
        .for_element(Locator::Css("[data-testid='daemon-enrollment-name']"))
        .await
        .expect("daemon enrollment name input was not rendered");
    gui_acceptance::wait_actionable(&input).await;
    input
        .send_keys(&name)
        .await
        .expect("failed to enter the daemon name");
    drop(client);

    click_test_id(world, "daemon-enrollment-create").await;

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    client
        .wait()
        .at_most(Duration::from_secs(15))
        .for_element(Locator::Css("[data-testid='daemon-enrollment-token-step']"))
        .await
        .expect("daemon enrollment token step was not rendered");

    // Capture the ID while the bootstrap modal is still open so the after
    // hook can clean up even if a later UI step fails before the fleet row is
    // rendered.
    let daemon_id = client
        .wait()
        .at_most(Duration::from_secs(5))
        .for_element(Locator::Css(
            "[data-testid='daemon-enrollment-token-step'] code",
        ))
        .await
        .expect("daemon ID was not rendered in the enrollment modal")
        .text()
        .await
        .expect("failed to read daemon ID from the enrollment modal");
    world.daemon_id = Some(daemon_id);
    world
        .screenshot(&client, "daemon-enrollment-token-step-visible")
        .await;
}

#[then(expr = "the registered daemon row should be visible within {int} seconds")]
async fn registered_daemon_row_is_visible(world: &mut GuiWorld, timeout: u64) {
    wait_for_registered_daemon_row(world, timeout).await;
}

#[when("I search for the registered daemon")]
async fn search_for_registered_daemon(world: &mut GuiWorld) {
    let name = registered_daemon_name(world).to_string();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let input = client
        .wait()
        .at_most(Duration::from_secs(10))
        .for_element(Locator::Css("[data-testid='daemons-search']"))
        .await
        .expect("daemon search input was not rendered");
    gui_acceptance::wait_actionable(&input).await;
    input
        .send_keys(&name)
        .await
        .expect("failed to search for the registered daemon");
    world
        .screenshot(&client, "searched-registered-daemon")
        .await;
}

#[when("I open the registered daemon inspector")]
async fn open_registered_daemon_inspector(world: &mut GuiWorld) {
    let name = registered_daemon_name(world).to_string();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let row = client
        .wait()
        .at_most(Duration::from_secs(10))
        .for_element(Locator::XPath(&registered_daemon_row_xpath(&name)))
        .await
        .expect("registered daemon row was not rendered");
    gui_acceptance::wait_actionable(&row).await;
    row.click().await.expect("failed to open daemon inspector");
    world
        .screenshot(&client, "registered-daemon-inspector-open")
        .await;
}

#[then(expr = "the daemon status filter {string} should be selected within {int} seconds")]
async fn daemon_status_filter_selected(world: &mut GuiWorld, status: String, timeout: u64) {
    assert_daemon_status_filter(world, &status, true, timeout).await;
}

#[then(expr = "the daemon status filter {string} should not be selected within {int} seconds")]
async fn daemon_status_filter_not_selected(world: &mut GuiWorld, status: String, timeout: u64) {
    assert_daemon_status_filter(world, &status, false, timeout).await;
}

async fn assert_daemon_status_filter(
    world: &mut GuiWorld,
    status: &str,
    expected: bool,
    timeout: u64,
) {
    let test_id = format!("daemon-status-filter-{status}");
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    loop {
        if let Ok(element) = client
            .find(Locator::Css(&format!("[data-testid='{test_id}']")))
            .await
            && element.attr("aria-pressed").await.ok().flatten().as_deref()
                == Some(if expected { "true" } else { "false" })
        {
            world
                .screenshot(&client, &format!("assert-filter-{status}-{expected}"))
                .await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "daemon status filter '{status}' did not become {} within {timeout} seconds",
                if expected { "selected" } else { "unselected" }
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[then(expr = "the daemon inspector should close within {int} seconds")]
async fn daemon_inspector_closes(world: &mut GuiWorld, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    loop {
        if client
            .find(Locator::Css("[data-testid='daemon-inspector']"))
            .await
            .is_err()
        {
            world.screenshot(&client, "daemon-inspector-closed").await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon inspector did not close within {timeout} seconds");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[then(expr = "the registered daemon row should disappear within {int} seconds")]
async fn registered_daemon_row_disappears(world: &mut GuiWorld, timeout: u64) {
    let name = registered_daemon_name(world).to_string();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator = Locator::XPath(&registered_daemon_row_xpath(&name));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    loop {
        if client.find(locator).await.is_err() {
            world
                .screenshot(&client, "registered-daemon-row-disappeared")
                .await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("registered daemon row did not disappear within {timeout} seconds");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
