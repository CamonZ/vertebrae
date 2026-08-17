use std::path::PathBuf;

use cucumber::{then, when};
use fantoccini::Locator;

use crate::GuiWorld;

fn export_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "vertebrae-debug-console-export-{}.json",
        std::process::id()
    ))
}

#[when("I open the diagnostic console")]
async fn open_diagnostic_console(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    client
        .execute(
            "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true, bubbles: true }));",
            vec![],
        )
        .await
        .expect("failed to open diagnostic console shortcut");

    client
        .wait()
        .at_most(std::time::Duration::from_secs(5))
        .for_element(Locator::Css("[data-testid='debug-console-export']"))
        .await
        .expect("diagnostic console export button did not appear");
}

#[when("I export diagnostic console JSON")]
async fn export_diagnostic_console_json(world: &mut GuiWorld) {
    let path = export_path();
    let _ = std::fs::remove_file(&path);

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;

    let path_arg = serde_json::json!(path.to_string_lossy().to_string());
    client
        .execute(
            r#"
                const path = arguments[0];
                const internals = window.__TAURI_INTERNALS__;
                if (!internals || typeof internals.invoke !== 'function') {
                    throw new Error('Tauri IPC internals are unavailable');
                }
                if (!internals.__vertebraeAcceptanceOriginalInvoke) {
                    internals.__vertebraeAcceptanceOriginalInvoke = internals.invoke;
                }
                const original = internals.__vertebraeAcceptanceOriginalInvoke;
                internals.invoke = (command, args, options) => {
                    if (command === 'plugin:dialog|save') {
                        return Promise.resolve(path);
                    }
                    return original.call(internals, command, args, options);
                };
            "#,
            vec![path_arg],
        )
        .await
        .expect("failed to stub the native save dialog path");

    client
        .find(Locator::Css("[data-testid='debug-console-export']"))
        .await
        .expect("diagnostic console export button not found")
        .click()
        .await
        .expect("failed to click diagnostic console export button");

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !path.is_file() {
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "diagnostic export file was not written to {}",
                path.display()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[then("the diagnostic export file should contain valid JSON")]
async fn diagnostic_export_file_contains_valid_json(_world: &mut GuiWorld) {
    let path = export_path();
    let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "failed to read diagnostic export {}: {error}",
            path.display()
        )
    });
    let payload: serde_json::Value = serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("diagnostic export is not valid JSON: {error}"));

    assert_eq!(payload["schema_version"], serde_json::json!(1));
    assert!(payload["exported_at"].as_str().is_some());
    assert!(payload["logs"].is_array());
    assert!(payload["traces"].is_array());

    let _ = std::fs::remove_file(path);
}
