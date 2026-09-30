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

#[when("I initialize the prepared project directory through the GUI command")]
async fn initialize_prepared_project_directory(world: &mut GuiWorld) {
    let dir = tempfile::Builder::new()
        .prefix("gui-add-project-")
        .tempdir()
        .expect("failed to create project directory for GUI acceptance");
    let path = dir.path().to_path_buf();
    let slug = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("temporary project directory should have a UTF-8 name")
        .to_ascii_lowercase()
        .to_string();
    std::mem::forget(dir);
    world.project_creation_dir = Some(path.clone());
    world.gui_created_project_slug = Some(slug);

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    // The native directory picker cannot be driven through WebDriver. Invoke
    // the same Tauri commands used by the GUI add-project path, then reload the
    // app so its active-project indicator reflects the selection.
    let result = client
        .execute_async(
            r#"
                const done = arguments[arguments.length - 1];
                const internals = window.__TAURI_INTERNALS__;
                if (!internals || typeof internals.invoke !== "function") {
                    done({ error: "Tauri invoke API was not available" });
                    return;
                }
                internals.invoke("initialize_project", { path: arguments[0], name: null })
                    .then(async project => {
                        await internals.invoke("set_current_project", { slug: project.slug });
                        done({ slug: project.slug });
                    })
                    .catch(error => done({ error: String(error) }));
            "#,
            vec![serde_json::Value::String(
                path.to_string_lossy().into_owned(),
            )],
        )
        .await
        .expect("failed to invoke GUI project commands");
    assert_eq!(
        result.get("slug").and_then(serde_json::Value::as_str),
        Some(world.gui_created_project_slug.as_deref().unwrap()),
        "GUI project command failed: {result}"
    );
    client
        .goto(&gui_acceptance::tauri_base_url())
        .await
        .expect("failed to reload GUI after selecting the new project");
}

#[then(expr = "the GUI-created project should be active within {int} seconds")]
async fn gui_created_project_should_be_active(world: &mut GuiWorld, timeout: u64) {
    let slug = world
        .gui_created_project_slug
        .as_deref()
        .expect("project-creation step did not prepare a directory")
        .to_string();
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "GUI-created project selected",
        "return document.querySelector('[data-testid=\"sidebar-project-avatar\"]')?.getAttribute('aria-label') === 'Switch project · ' + arguments[0];",
        vec![slug.clone().into()],
        std::time::Duration::from_secs(timeout),
    )
    .await;

    let projects: Vec<vertebrae_sacrum_client::ProjectResponse> = world
        .graphql_client
        .as_ref()
        .expect("configured Sacrum client not initialized")
        .execute(
            vertebrae_sacrum_client::queries::projects::LIST_PROJECTS,
            serde_json::json!({}),
            "projects",
        )
        .await
        .expect("failed to list projects after GUI creation");
    assert!(
        projects.iter().any(|project| project.slug == slug),
        "GUI did not create project {slug} in Sacrum"
    );
    world.screenshot(&client, "after-gui-project-created").await;
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

    gui_acceptance::wait_actionable(&element).await;
    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click element with test id '{}'", test_id));

    gui_acceptance::wait_for_js(&client, "selected project and closed switcher",
        "return document.querySelector('[data-testid=\"sidebar-project-avatar\"]')?.getAttribute('aria-label') === 'Switch project · ' + arguments[0] && !document.querySelector('[data-testid=\"sidebar-project-switcher\"]');",
        vec![slug.into()], std::time::Duration::from_secs(10)).await;
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

#[when(expr = "I click the local chat plus action for the {string} project")]
async fn click_local_chat_plus_action(world: &mut GuiWorld, project: String) {
    let slug = match project.as_str() {
        "primary" => active_project_slug(world),
        "second" => second_project_slug(world),
        other => panic!("unknown acceptance project {other:?}; use primary or second"),
    };
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let title = format!("Start a new chat in {slug}");
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::XPath(&format!("//*[@title='{title}']")))
        .await
        .unwrap_or_else(|_| panic!("local chat plus action for project '{slug}' not found"));
    gui_acceptance::wait_actionable(&element).await;
    element
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to click local chat plus action for '{slug}'"));
    world
        .screenshot(&client, &format!("after-project-chat-plus-{project}"))
        .await;
}

#[then(
    expr = "the active local chat should use the {string} project directory within {int} seconds"
)]
async fn active_local_chat_uses_project_directory(
    world: &mut GuiWorld,
    project: String,
    timeout: u64,
) {
    let expected_path = world.project_path(&project);
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator = Locator::XPath(&format!(
        "//*[@data-testid='local-chat-window' and @data-project-path='{}']",
        expected_path
    ));
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(locator)
        .await;
    if element.is_err() {
        world
            .screenshot(&client, &format!("fail-active-project-path-{project}"))
            .await;
    }
    assert!(
        element.is_ok(),
        "expected the active local chat to use project '{project}' directory '{expected_path}' within {timeout}s"
    );
    world
        .screenshot(&client, &format!("after-active-project-path-{project}"))
        .await;
}

#[when(expr = "I choose local chat provider {string}")]
async fn choose_local_chat_provider(world: &mut GuiWorld, provider: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::Css("[data-testid='local-chat-provider-picker']"))
        .await
        .expect("local chat provider picker not found");
    element
        .select_by_value(&provider)
        .await
        .expect("failed to select local chat provider");
    world
        .screenshot(&client, &format!("after-select-provider-{provider}"))
        .await;
}

#[then(expr = "the local chat provider should be {string} within {int} seconds")]
async fn local_chat_provider_should_be(world: &mut GuiWorld, provider: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let element = client
        .wait()
        .at_most(std::time::Duration::from_secs(timeout))
        .for_element(Locator::Css("[data-testid='local-chat-provider-picker']"))
        .await
        .expect("local chat provider picker not found");
    gui_acceptance::wait_for_js(&client, "selected local chat provider",
        "return document.querySelector('[data-testid=\"local-chat-provider-picker\"]')?.value === arguments[0];",
        vec![provider.clone().into()], std::time::Duration::from_secs(timeout)).await;
    let value = element
        .prop("value")
        .await
        .expect("failed to read local chat provider")
        .unwrap_or_default();
    assert_eq!(value, provider);
    world
        .screenshot(&client, &format!("after-assert-provider-{provider}"))
        .await;
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
    gui_acceptance::wait_actionable(&avatar).await;
    avatar
        .click()
        .await
        .expect("failed to click project avatar to re-open the switcher");

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
        "//*[@data-testid='local-chat-history-drawer']//h3/span[normalize-space(.)='{}']",
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
