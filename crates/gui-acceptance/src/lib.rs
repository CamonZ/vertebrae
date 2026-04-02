use fantoccini::Client;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

/// Default WebDriver URL where tauri-driver listens.
pub const WEBDRIVER_URL: &str = "http://localhost:4444";

/// Path to the built Tauri app binary (debug build inside Docker).
pub const GUI_BINARY: &str = "/app/target/debug/gui";

/// Global WebDriver session, initialized once before the first scenario.
///
/// Persists across all scenarios so we avoid reopening the browser.
/// The `Mutex` ensures only one scenario drives the session at a time
/// (Cucumber concurrency is set to 1 anyway, but the Mutex makes it safe).
static WEBDRIVER: OnceCell<Arc<Mutex<Client>>> = OnceCell::const_new();

/// Get or initialize the global WebDriver session.
///
/// On first call, connects to the WebDriver endpoint and returns the
/// shared client handle. Subsequent calls return the same handle.
pub async fn webdriver() -> Arc<Mutex<Client>> {
    WEBDRIVER
        .get_or_init(|| async {
            let webdriver_url =
                std::env::var("WEBDRIVER_URL").unwrap_or_else(|_| WEBDRIVER_URL.to_string());

            let gui_binary = std::env::var("GUI_BINARY").unwrap_or_else(|_| GUI_BINARY.to_string());

            let capabilities = serde_json::json!({
                "tauri:options": {
                    "application": gui_binary
                }
            });

            let client = fantoccini::ClientBuilder::native()
                .capabilities(capabilities.as_object().unwrap().clone())
                .connect(&webdriver_url)
                .await
                .expect("failed to connect to tauri-driver — is it running on port 4444?");

            Arc::new(Mutex::new(client))
        })
        .await
        .clone()
}

/// Close the global WebDriver session. Call once after all scenarios.
pub async fn close_webdriver() {
    if let Some(wd) = WEBDRIVER.get() {
        let client = wd.lock().await;
        let _ = client.clone().close().await;
    }
}
