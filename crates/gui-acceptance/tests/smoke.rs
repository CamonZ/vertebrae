use fantoccini::{ClientBuilder, Locator};
use serde_json::json;

/// Smoke test: verify the Tauri app launches under tauri-driver and renders
/// the expected window title element.
///
/// Prerequisites (handled by the Docker entrypoint):
///   - Xvfb is running (provides a virtual display)
///   - tauri-driver is listening on port 4444
///   - The Tauri app binary has been built at /app/target/debug/gui
#[tokio::test]
async fn app_launches_and_renders_title() {
    let webdriver_url = std::env::var("WEBDRIVER_URL")
        .unwrap_or_else(|_| gui_acceptance::WEBDRIVER_URL.to_string());

    let gui_binary =
        std::env::var("GUI_BINARY").unwrap_or_else(|_| gui_acceptance::GUI_BINARY.to_string());

    // Configure WebDriver capabilities for tauri-driver.
    // tauri-driver expects the app binary path in tauri:options.
    let capabilities = json!({
        "tauri:options": {
            "application": gui_binary
        }
    });

    let client = ClientBuilder::native()
        .capabilities(capabilities.as_object().unwrap().clone())
        .connect(&webdriver_url)
        .await
        .expect("failed to connect to tauri-driver at port 4444");

    // Wait for the page to load (up to 10 seconds)
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    // The Tauri app window title is "Vertebrae" (set in tauri.conf.json)
    let title = client.title().await.expect("failed to get window title");
    assert_eq!(title, "Vertebrae", "window title should be 'Vertebrae'");

    // Verify the page has rendered some content (the body should not be empty)
    let body = client
        .find(Locator::Css("body"))
        .await
        .expect("failed to find <body> element");

    let body_text = body.text().await.expect("failed to get body text");

    assert!(
        !body_text.is_empty(),
        "page body should contain rendered content but was empty"
    );

    client
        .close()
        .await
        .expect("failed to close WebDriver session");
}
