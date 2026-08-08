use std::path::PathBuf;

use fantoccini::Locator;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::GuiWorld;

/// Paths of the managed `~/.local/bin` symlinks the `InstallationGuard`
/// probes (`installed_at_symlink`). MUST match `vertebrae_installer::symlink_path`.
fn installed_link_paths() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    let bin = PathBuf::from(home).join(".local").join("bin");
    vec![
        bin.join("vtb"),
        bin.join("vtb-daemon"),
        bin.join("vtb-gate"),
    ]
}

/// Restore the installer-managed symlinks to the binaries preinstalled by the
/// GUI acceptance runner. Every non-`@first_run` scenario relies on this —
/// without it the clean container would be redirected to `/welcome`.
fn restore_installed_links() {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    let data_bin = PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("vertebrae")
        .join("bin");

    for path in installed_link_paths() {
        let name = path
            .file_name()
            .expect("managed component path must have a file name");
        let staged = data_bin.join(name);
        assert!(
            staged.is_file(),
            "GUI acceptance image must preinstall the managed component at {}",
            staged.display()
        );

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("failed to create ~/.local/bin");
        }

        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            assert!(
                metadata.file_type().is_symlink(),
                "managed component path is not a symlink: {}",
                path.display()
            );
            std::fs::remove_file(&path).expect("failed to replace managed component symlink");
        }

        #[cfg(unix)]
        std::os::unix::fs::symlink(&staged, &path).unwrap_or_else(|error| {
            panic!("failed to seed managed symlink {}: {error}", path.display())
        });

        #[cfg(not(unix))]
        panic!("GUI acceptance requires Unix symlink support");
    }
}

/// Remove the managed symlinks so a `@first_run` scenario sees the genuine
/// first-run state (nothing installed) and the guard redirects to `/welcome`.
fn clear_installed_links() {
    for path in installed_link_paths() {
        let _ = std::fs::remove_file(&path);
    }
}

/// Create a unique Sacrum project via GraphQL, back it with a fresh temp
/// directory, and register it in `~/.config/vertebrae/config.toml`. Returns the
/// `(slug, project_id, temp_path)` so callers can wire it into the GUI flow or
/// store it for cleanup. The slug doubles as the project name so the avatar
/// monogram and config slug agree.
async fn create_and_register_project(base_url: &str, api_token: &str) -> (String, String, PathBuf) {
    let slug = format!("gui-test-{}", uuid::Uuid::new_v4());
    let name = slug.clone();

    // Create the Sacrum project via GraphQL
    let config = SacrumConfig::new(base_url.to_string(), api_token.to_string(), String::new());
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

    // Create a real temp directory (the GUI validates the path exists).
    let temp_dir = tempfile::tempdir().expect("failed to create temp directory");
    let temp_path = temp_dir.path().to_path_buf();

    // Register the project in ~/.config/vertebrae/config.toml
    vertebrae_sacrum_client::register_project(&slug, &project_id, &temp_path.to_string_lossy())
        .expect("failed to register project in config.toml");

    // Intentionally leak the TempDir handle so it is not deleted on drop.
    // The after-hook removes it explicitly via the stored path.
    std::mem::forget(temp_dir);

    (slug, project_id, temp_path)
}

/// Before-hook: create a unique Sacrum project, register it in config.toml,
/// navigate the GUI to /setup, select the project, and wait for redirect.
///
/// `first_run` is `true` for scenarios tagged `@first_run`. For those we
/// REMOVE the managed symlinks (so the welcome screen appears) and do NOT
/// drive the project-selection flow — the first-run scenarios assert on the
/// welcome screen itself. For every other scenario we RESTORE the managed
/// symlinks to the binaries preinstalled by the runner and run the usual
/// project selection.
///
/// `multi_project` is `true` for scenarios tagged `@multi_project`. After the
/// usual single-project selection completes, a SECOND project is provisioned
/// (created + registered in config.toml with its own temp dir) but NOT
/// selected — the sidebar project switcher exercises switching to it. Its slug
/// and temp dir are stored on the world for the step assertions and cleanup.
pub async fn before_scenario(
    world: &mut GuiWorld,
    scenario_name: &str,
    first_run: bool,
    multi_project: bool,
) {
    world.scenario_name = scenario_name.to_string();

    if first_run {
        // Genuine first-run state: nothing installed, so InstallationGuard
        // routes to /welcome. The scenario steps navigate and assert from
        // there, so we still need the shared WebDriver session — just not the
        // project flow.
        clear_installed_links();
        let wd = gui_acceptance::webdriver().await;
        world.webdriver = Some(wd);
        return;
    }

    // Default for all other scenarios: restore the preinstalled components so
    // guarded routes render normally.
    restore_installed_links();

    let api_token =
        std::env::var("VTB_TOKEN").expect("VTB_TOKEN must be set for GUI acceptance tests");
    let base_url = std::env::var("VTB_URL").unwrap_or_else(|_| "http://localhost:4000".to_string());

    // Create + register the primary project (unique slug per scenario to avoid
    // config.toml collisions).
    let (slug, project_id, temp_path) = create_and_register_project(&base_url, &api_token).await;

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
    let scoped_config = SacrumConfig::new(base_url.clone(), api_token.clone(), project_id.clone());
    world.graphql_client = Some(GraphqlClient::new(scoped_config));

    world.project_slug = Some(slug.clone());
    world.project_id = Some(project_id);
    // Keep the TempDir handle alive by storing the path; the after-hook removes it.
    world.temp_dir = Some(temp_path);

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

    // Wait for redirect away from /setup (the app navigates to / -> /tasks)
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    world.screenshot(&client, "after-setup-select").await;

    // Release the WebDriver lock before any further provisioning.
    drop(client);

    // For `@multi_project` scenarios, provision a SECOND project so the sidebar
    // project switcher has another project to switch to. It is registered in
    // config.toml (which the popover reads via getProjects() on open) but NOT
    // selected — the test drives the switch through the UI.
    if multi_project {
        let (second_slug, _second_id, second_path) =
            create_and_register_project(&base_url, &api_token).await;
        world.second_project_slug = Some(second_slug);
        world.second_temp_dir = Some(second_path);
    }
}

/// After-hook: unregister the project from config.toml and clean up the temp
/// directory. First-run scenarios remove their temporary managed links; the
/// normal GUI scenarios leave the image's preinstalled links in place. The
/// binaries in the shared data bin remain the GUI runner's component image.
pub async fn after_scenario(world: &mut GuiWorld, first_run: bool) {
    // Unregister from config.toml
    if let Some(slug) = &world.project_slug {
        let _ = vertebrae_sacrum_client::unregister_project(slug);
    }

    // Remove temp directory
    if let Some(path) = &world.temp_dir {
        let _ = std::fs::remove_dir_all(path);
    }

    // Clean up the second project provisioned for `@multi_project` scenarios.
    // Mirrors the project-#1 cleanup: unregister from config.toml and remove
    // the temp dir. Like project #1, the Sacrum project itself is left in place.
    if let Some(slug) = &world.second_project_slug {
        let _ = vertebrae_sacrum_client::unregister_project(slug);
    }
    if let Some(path) = &world.second_temp_dir {
        let _ = std::fs::remove_dir_all(path);
    }

    if first_run {
        clear_installed_links();
    }
}
