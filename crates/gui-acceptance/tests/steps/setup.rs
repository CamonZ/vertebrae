use fantoccini::Locator;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::GuiWorld;

/// Before-hook: create a unique Sacrum project, register it in config.toml,
/// navigate the GUI to /setup, select the project, and wait for redirect.
pub async fn before_scenario(world: &mut GuiWorld, scenario_name: &str) {
    world.scenario_name = scenario_name.to_string();
    let api_token =
        std::env::var("VTB_TOKEN").expect("VTB_TOKEN must be set for GUI acceptance tests");
    let base_url = std::env::var("VTB_URL").unwrap_or_else(|_| "http://localhost:4000".to_string());

    // Unique slug per scenario to avoid config.toml collisions
    let slug = format!("gui-test-{}", uuid::Uuid::new_v4());
    let name = slug.clone();

    // Create the Sacrum project via GraphQL
    let config = SacrumConfig::new(base_url.clone(), api_token.clone(), String::new());
    let client = GraphqlClient::new(config);

    let project: vertebrae_sacrum_client::ProjectResponse = client
        .execute(
            vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
            serde_json::json!({ "name": name, "slug": slug }),
            "create_project",
        )
        .await
        .expect("failed to create test project via GraphQL");

    let project_id = project.id.clone();

    // Configure vtb binary and environment for CLI mutations (before values are moved)
    let vtb_binary = std::env::var("VTB_BINARY").unwrap_or_else(|_| {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let workspace_root = std::path::Path::new(manifest_dir)
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        workspace_root
            .join("target")
            .join("debug")
            .join("vtb")
            .to_string_lossy()
            .to_string()
    });
    world.vtb_binary = std::path::PathBuf::from(vtb_binary);
    world.env.insert("VTB_TOKEN".to_string(), api_token.clone());
    world.env.insert("VTB_URL".to_string(), base_url.clone());
    world
        .env
        .insert("VTB_PROJECT_ID".to_string(), project_id.clone());

    // Re-create client scoped to the project for later cleanup
    let scoped_config = SacrumConfig::new(base_url, api_token, project_id.clone());
    world.graphql_client = Some(GraphqlClient::new(scoped_config));

    // Create a real temp directory (the GUI validates the path exists)
    let temp_dir = tempfile::tempdir().expect("failed to create temp directory");
    let temp_path = temp_dir.path().to_path_buf();

    // Register the project in ~/.config/vertebrae/config.toml
    vertebrae_sacrum_client::register_project(&slug, &project_id, &temp_path.to_string_lossy())
        .expect("failed to register project in config.toml");

    world.project_slug = Some(slug.clone());
    world.project_id = Some(project_id);
    // Keep the TempDir handle alive by storing the path; the after-hook removes it.
    world.temp_dir = Some(temp_path);
    // Intentionally leak the TempDir handle so it is not deleted on drop.
    // The after-hook will clean it up explicitly.
    std::mem::forget(temp_dir);

    // Acquire the global WebDriver session
    let wd = gui_acceptance::webdriver().await;
    world.webdriver = Some(wd.clone());

    let client = wd.lock().await;

    // Navigate to the project setup page
    let setup_url = format!("{}/setup", gui_acceptance::tauri_base_url());
    client
        .goto(&setup_url)
        .await
        .expect("failed to navigate to /setup");

    // Wait for the project list to render (up to 10 seconds)
    let project_row = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::XPath(&format!(
            "//*[contains(text(), '{}')]",
            slug
        )))
        .await;

    if project_row.is_err() {
        world.screenshot(&client, "setup-debug").await;
        panic!(
            "project row not found on /setup page for slug '{}' — check test-output/ for screenshot",
            slug
        );
    }

    let project_row = project_row.unwrap();

    // Click the project row to select it
    project_row
        .click()
        .await
        .expect("failed to click project row");

    // Wait for redirect away from /setup (the app navigates to / -> /operations)
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    world.screenshot(&client, "after-setup-select").await;
}

/// After-hook: unregister the project from config.toml and clean up the temp directory.
pub async fn after_scenario(world: &mut GuiWorld) {
    // Unregister from config.toml
    if let Some(slug) = &world.project_slug {
        let _ = vertebrae_sacrum_client::unregister_project(slug);
    }

    // Remove temp directory
    if let Some(path) = &world.temp_dir {
        let _ = std::fs::remove_dir_all(path);
    }
}
