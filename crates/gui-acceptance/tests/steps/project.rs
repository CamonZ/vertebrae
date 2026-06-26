use cucumber::{then, when};
use fantoccini::Locator;

use crate::GuiWorld;

/// Resolve the slug of the second (`@multi_project`) project, panicking with a
/// helpful message if the scenario was not tagged `@multi_project`.
fn second_project_slug(world: &GuiWorld) -> String {
    world
        .second_project_slug
        .clone()
        .expect("no second project slug — tag the scenario @multi_project so the setup hook provisions a second project")
}

/// Resolve the slug of the primary (active) project, panicking if the setup
/// hook did not register one (i.e. a non-project scenario like @first_run).
fn active_project_slug(world: &GuiWorld) -> String {
    world.project_slug.clone().expect(
        "no active project slug — the setup hook must register a project (non-@first_run scenario)",
    )
}

/// Click the popover entry for the given project slug, mirroring
/// navigation.rs's wait/scroll/click pattern.
async fn click_project_entry(world: &mut GuiWorld, slug: &str) {
    let test_id = format!("sidebar-project-entry-{slug}");
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

#[when("I switch to the second project")]
async fn switch_to_second_project(world: &mut GuiWorld) {
    let slug = second_project_slug(world);
    click_project_entry(world, &slug).await;
}

#[when("I click the active project entry")]
async fn click_active_project_entry(world: &mut GuiWorld) {
    let slug = active_project_slug(world);
    click_project_entry(world, &slug).await;
}

#[then(expr = "the second project is the active project within {int} seconds")]
async fn second_project_is_active_within(world: &mut GuiWorld, timeout: u64) {
    let slug = second_project_slug(world);

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    // Re-open the popover by clicking the project avatar so the entries (and
    // their aria-current marker) render again.
    let avatar = client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::Css("[data-testid=\"sidebar-project-avatar\"]"))
        .await
        .expect("project avatar not found within 5 seconds");
    avatar
        .click()
        .await
        .expect("failed to click project avatar to re-open the switcher");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    world
        .screenshot(&client, "before-assert-second-project-active")
        .await;

    // The active entry carries aria-current='true'. Asserting both the slug and
    // aria-current proves the ✓ moved to the second project.
    let locator = Locator::Css(&format!(
        "[data-testid=\"sidebar-project-entry-{slug}\"][aria-current=\"true\"]"
    ));
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(locator)
        .await;

    if element.is_err() {
        world
            .screenshot(&client, "fail-second-project-active")
            .await;
    }

    assert!(
        element.is_ok(),
        "expected the second project '{}' to be the active project (entry with aria-current='true') within {} seconds",
        slug,
        timeout
    );

    world
        .screenshot(&client, "after-assert-second-project-active")
        .await;
}

#[then(expr = "the local chat history drawer should show the active project within {int} seconds")]
async fn local_chat_history_drawer_shows_active_project(world: &mut GuiWorld, timeout: u64) {
    let slug = active_project_slug(world);

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    world
        .screenshot(&client, "before-assert-local-chat-project-group")
        .await;

    let locator = Locator::XPath(&format!(
        "//*[@data-testid='local-chat-history-drawer']//h3[normalize-space(.)='{}']",
        slug
    ));
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(locator)
        .await;

    if element.is_err() {
        world
            .screenshot(&client, "fail-local-chat-project-group")
            .await;
    }

    assert!(
        element.is_ok(),
        "expected local chat history drawer to show active project heading '{}' within {} seconds",
        slug,
        timeout
    );

    world
        .screenshot(&client, "after-assert-local-chat-project-group")
        .await;
}
