//! Step definitions for the first-run installer welcome flow
//! (`features/first_run_install.feature`, tagged `@first_run`).
//!
//! These mirror the fantoccini/WebDriver style in `navigation.rs`: they drive
//! the shared `world.webdriver` session, locate elements via `Locator`, take
//! ordered screenshots, and assert with concrete data. The install scenario
//! additionally verifies real filesystem side effects under `$HOME/.local`.

use std::path::PathBuf;

use cucumber::{given, then, when};
use fantoccini::Locator;

use crate::GuiWorld;
use crate::steps::navigation::navigate_to;

/// Resolve `$HOME/.local/bin/<name>` — the user-facing symlink the installer
/// creates. Mirrors `vertebrae_installer::symlink_path` for the Linux/test
/// container where `dirs::home_dir()` resolves to `$HOME`.
fn cli_symlink_path(name: &str) -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    PathBuf::from(home).join(".local").join("bin").join(name)
}

/// Navigate to the app root. On a `@first_run` scenario the installed markers
/// have been removed, so `InstallationGuard` redirects to `/welcome`.
#[given("the GUI is on the welcome install screen")]
async fn gui_on_welcome_screen(world: &mut GuiWorld) {
    navigate_to(world, "/welcome", "nav-welcome").await;
}

/// Uncheck a checkbox identified by its `data-testid`. Used to deselect the
/// daemon so the installer runs the path that skips OS service registration
/// (no systemd in the container) while still staging the local chat tools.
#[when(expr = "I uncheck the install component {string}")]
async fn uncheck_install_component(world: &mut GuiWorld, test_id: String) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let checkbox = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::Css(&format!("[data-testid=\"{}\"]", test_id)))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "checkbox with test id '{}' not found within 10 seconds",
                test_id
            )
        });

    // Only click when currently checked, so the step is idempotent regardless
    // of the page's default checkbox state.
    let is_checked = checkbox
        .is_selected()
        .await
        .expect("failed to read checkbox selected state");

    if is_checked {
        checkbox
            .click()
            .await
            .unwrap_or_else(|_| panic!("failed to uncheck '{}'", test_id));
    }

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    world
        .screenshot(&client, &format!("after-uncheck-{test_id}"))
        .await;

    let still_checked = checkbox
        .is_selected()
        .await
        .expect("failed to re-read checkbox selected state");
    assert!(
        !still_checked,
        "expected checkbox '{}' to be unchecked after the step, but it is still checked",
        test_id
    );
}

/// Assert the URL no longer contains `needle` within `timeout` seconds. Used to
/// confirm a successful install navigated the app away from `/welcome`.
#[then(expr = "the URL should not contain {string} within {int} seconds")]
async fn url_should_not_contain_within(world: &mut GuiWorld, needle: String, timeout: u64) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let poll_interval = std::time::Duration::from_millis(250);

    loop {
        let url = client
            .current_url()
            .await
            .expect("failed to read current URL");
        let url_str = url.as_str();
        if !url_str.contains(&needle) {
            world
                .screenshot(&client, &format!("after-assert-url-not-contains-{needle}"))
                .await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-url-not-contains-{needle}"))
                .await;
            panic!(
                "expected URL to NOT contain '{}' within {} seconds, but current URL is '{}'",
                needle, timeout, url_str
            );
        }
        tokio::time::sleep(poll_interval).await;
    }
}

/// Assert the installer created the `$HOME/.local/bin/<name>` symlink. Polls
/// briefly because the install runs asynchronously after the button click.
#[then(expr = "the installed CLI binary {string} should exist on the filesystem")]
async fn installed_binary_should_exist(world: &mut GuiWorld, name: String) {
    let path = cli_symlink_path(&name);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        // `symlink_metadata` so we see the symlink itself, dangling or not.
        if std::fs::symlink_metadata(&path).is_ok() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            // Surface the welcome screen state to help diagnose a failed install.
            if let Some(wd) = world.webdriver.clone() {
                let client = wd.lock().await;
                world
                    .screenshot(&client, &format!("fail-binary-exists-{name}"))
                    .await;
            }
            panic!(
                "expected installed CLI binary at '{}' to exist, but it was not found",
                path.display()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// Assert the installer did NOT create `$HOME/.local/bin/<name>`. Used to prove
/// that unchecking a component left it uninstalled.
#[then(expr = "the installed CLI binary {string} should not exist on the filesystem")]
async fn installed_binary_should_not_exist(_world: &mut GuiWorld, name: String) {
    let path = cli_symlink_path(&name);
    assert!(
        std::fs::symlink_metadata(&path).is_err(),
        "expected no installed CLI binary at '{}', but one was found",
        path.display()
    );
}
