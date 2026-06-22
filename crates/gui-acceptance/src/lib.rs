use fantoccini::Client;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

/// Default WebDriver URL where tauri-driver listens.
pub const WEBDRIVER_URL: &str = "http://localhost:4444";

/// Path to the built Tauri app binary (debug build inside Docker).
pub const GUI_BINARY: &str = "/app/target/debug/gui";

/// Base URL for the Tauri app inside WebDriver.
///
/// On Linux (WebKitGTK), Tauri v2 serves assets at `http://tauri.localhost`.
/// On macOS/Windows it uses the `tauri://localhost` custom scheme.
/// Override with the `TAURI_BASE_URL` environment variable if needed.
pub fn tauri_base_url() -> String {
    std::env::var("TAURI_BASE_URL").unwrap_or_else(|_| "http://tauri.localhost".to_string())
}

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

            let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":99".to_string());
            let claude_code_path = std::env::var("CLAUDE_CODE_PATH")
                .unwrap_or_else(|_| "/usr/local/bin/mock-claude".to_string());
            let mock_output_dir =
                std::env::var("MOCK_OUTPUT_DIR").unwrap_or_else(|_| "/mocks".to_string());

            let mut app_env = serde_json::Map::new();
            app_env.insert("DISPLAY".to_string(), serde_json::Value::String(display));
            app_env.insert(
                "CLAUDE_CODE_PATH".to_string(),
                serde_json::Value::String(claude_code_path),
            );
            app_env.insert(
                "MOCK_OUTPUT_DIR".to_string(),
                serde_json::Value::String(mock_output_dir),
            );
            if let Ok(vtb_gate_path) = std::env::var("VTB_GATE_PATH") {
                app_env.insert(
                    "VTB_GATE_PATH".to_string(),
                    serde_json::Value::String(vtb_gate_path),
                );
            }

            let capabilities = serde_json::json!({
                "tauri:options": {
                    "application": gui_binary,
                    "env": app_env
                }
            });

            let client = fantoccini::ClientBuilder::native()
                .capabilities(capabilities.as_object().unwrap().clone())
                .connect(&webdriver_url)
                .await
                .expect("failed to connect to tauri-driver — is it running on port 4444?");

            // Log the initial URL so we know what scheme Tauri is actually using.
            if let Ok(url) = client.current_url().await {
                eprintln!("DEBUG tauri initial URL: {}", url);
            }

            // Save a screenshot of the initial app state for debugging.
            if let Ok(png) = client.screenshot().await {
                let _ = std::fs::create_dir_all("/app/test-output");
                let _ = std::fs::write("/app/test-output/initial-app-state.png", png);
                eprintln!("DEBUG initial screenshot saved to test-output/initial-app-state.png");
            }

            Arc::new(Mutex::new(client))
        })
        .await
        .clone()
}

/// Sanitise a string so it is safe to use as a filesystem path component.
///
/// Any character that is not alphanumeric or `-` is replaced with `_`.
pub fn sanitize_name(name: &str) -> String {
    name.replace(|c: char| !c.is_alphanumeric() && c != '-', "_")
}

/// Save a screenshot of the current WebDriver window to `/app/test-output/<dir>/`.
///
/// The file is named `<seq:03>-<label>.png` where `seq` is a per-scenario
/// sequence number so files sort in execution order.  Both `dir` and `label`
/// are sanitised so they are safe as filesystem path components.  Errors are
/// silently ignored so a failing screenshot never aborts the test.
pub async fn screenshot(client: &Client, dir: &str, seq: u32, label: &str) {
    if let Ok(png) = client.screenshot().await {
        let safe_dir = sanitize_name(dir);
        let dir_path = format!("/app/test-output/{safe_dir}");
        let _ = std::fs::create_dir_all(&dir_path);
        let safe = sanitize_name(label);
        let path = format!("{dir_path}/{seq:03}-{safe}.png");
        let _ = std::fs::write(&path, &png);
    }
}

/// Close the global WebDriver session. Call once after all scenarios.
pub async fn close_webdriver() {
    if let Some(wd) = WEBDRIVER.get() {
        let client = wd.lock().await;
        let _ = client.clone().close().await;
    }
}
