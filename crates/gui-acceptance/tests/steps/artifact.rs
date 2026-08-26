use cucumber::{then, when};
use fantoccini::Locator;

use crate::GuiWorld;

fn folder_test_id(folder: &str) -> String {
    format!("artifact-tree-folder-folder:{folder}")
}

fn xpath_literal(value: &str) -> String {
    if !value.contains('\'') {
        return format!("'{value}'");
    }
    if !value.contains('"') {
        return format!("\"{value}\"");
    }

    let parts = value
        .split('\'')
        .map(|part| format!("'{part}'"))
        .collect::<Vec<_>>()
        .join(", \"'\", ");
    format!("concat({parts})")
}

async fn toggle_artifact_folder(world: &mut GuiWorld, folder: &str, action: &str) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let folder_element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::Css(&format!(
            "[data-testid=\"{}\"]",
            folder_test_id(folder)
        )))
        .await
        .unwrap_or_else(|_| panic!("artifact folder '{folder}' was not found"));
    let button = folder_element
        .find(Locator::Css(&format!("button[aria-label=\"{action}\"]")))
        .await
        .unwrap_or_else(|_| panic!("artifact folder '{folder}' is not {action}able"));
    button
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to {action} artifact folder '{folder}'"));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    world
        .screenshot(&client, &format!("after-{action}-artifact-folder-{folder}"))
        .await;
}

#[then(expr = "the artifact tree folder {string} should be expanded within {int} seconds")]
async fn artifact_tree_folder_should_be_expanded(
    world: &mut GuiWorld,
    folder: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator = Locator::Css(&format!("[data-testid=\"{}\"]", folder_test_id(&folder)));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    loop {
        if let Ok(element) = client.find(locator).await {
            if element
                .attr("aria-expanded")
                .await
                .ok()
                .flatten()
                .as_deref()
                == Some("true")
            {
                world
                    .screenshot(
                        &client,
                        &format!("after-assert-expanded-artifact-folder-{folder}"),
                    )
                    .await;
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-expanded-artifact-folder-{folder}"))
                .await;
            panic!("artifact folder '{folder}' was not expanded within {timeout} seconds");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[when(expr = "I collapse the artifact tree folder {string}")]
async fn collapse_artifact_tree_folder(world: &mut GuiWorld, folder: String) {
    toggle_artifact_folder(world, &folder, "Collapse").await;
}

#[when(expr = "I expand the artifact tree folder {string}")]
async fn expand_artifact_tree_folder(world: &mut GuiWorld, folder: String) {
    toggle_artifact_folder(world, &folder, "Expand").await;
}

#[then(
    expr = "the artifact tree leaf {string} should show type badge {string} within {int} seconds"
)]
async fn artifact_tree_leaf_should_show_type_badge(
    world: &mut GuiWorld,
    label: String,
    badge: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let row_locator = Locator::XPath(&format!(
        "//*[@role='treeitem'][.//*[normalize-space(.)={}]]",
        xpath_literal(&label)
    ));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    loop {
        if let Ok(row) = client.find(row_locator).await {
            let row_json = serde_json::to_value(&row).expect("serialize artifact tree row");
            let actual_badge = client
                .execute(
                    "const badge = arguments[0].querySelector('[data-testid^=\"artifact-tree-type-\"]'); return badge?.textContent?.trim() || '';",
                    vec![row_json],
                )
                .await
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned));
            if actual_badge.as_deref() == Some(badge.as_str()) {
                world
                    .screenshot(&client, &format!("after-assert-artifact-type-{label}"))
                    .await;
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-artifact-type-{label}"))
                .await;
            panic!(
                "artifact tree leaf '{label}' did not show type badge '{badge}' within {timeout} seconds"
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
