use fantoccini::Client;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

/// Default WebDriver URL where tauri-driver listens.
pub const WEBDRIVER_URL: &str = "http://localhost:4444";

/// Path to the built Tauri app binary (debug build inside Docker).
pub const GUI_BINARY: &str = "/app/target/debug/gui";

/// Shared fixture path used by the mock Claude process for per-scenario local
/// chat responses. The mock output directory is inherited by GUI child
/// processes, so responses can contain IDs created during the scenario.
pub const MOCK_CHAT_RESPONSE_FILE: &str = "/mocks/gui-acceptance-chat-response.txt";

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
            let codex_path = std::env::var("CODEX_PATH")
                .unwrap_or_else(|_| "/usr/local/bin/mock-codex".to_string());
            let mock_output_dir =
                std::env::var("MOCK_OUTPUT_DIR").unwrap_or_else(|_| "/mocks".to_string());

            let mut app_env = serde_json::Map::new();
            app_env.insert("DISPLAY".to_string(), serde_json::Value::String(display));
            app_env.insert(
                "CLAUDE_CODE_PATH".to_string(),
                serde_json::Value::String(claude_code_path),
            );
            app_env.insert(
                "CODEX_PATH".to_string(),
                serde_json::Value::String(codex_path),
            );
            app_env.insert(
                "MOCK_OUTPUT_DIR".to_string(),
                serde_json::Value::String(mock_output_dir),
            );
            app_env.insert(
                "MOCK_STDIN_ASSISTANT_MESSAGE_FILE".to_string(),
                serde_json::Value::String(MOCK_CHAT_RESPONSE_FILE.to_string()),
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

            screenshot(&client, "startup", 0, "initial-app-state").await;

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
    if !capture_screenshot(full_screenshots(), label) {
        return;
    }
    let _timing = Timing::new("screenshot", label);
    if let Ok(Ok(png)) =
        tokio::time::timeout(std::time::Duration::from_secs(5), client.screenshot()).await
    {
        let safe_dir = sanitize_name(dir);
        let dir_path = format!("{}/{safe_dir}", output_dir().display());
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

/// Full diagnostics are opt-in; failures are always captured.
pub fn full_screenshots() -> bool {
    std::env::var("GUI_ACCEPTANCE_SCREENSHOTS").as_deref() == Ok("all")
}

fn capture_screenshot(full: bool, label: &str) -> bool {
    full || label.starts_with("fail-")
}

pub fn output_dir() -> std::path::PathBuf {
    std::env::var_os("ACCEPTANCE_OUTPUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/app/test-output".into())
}

/// A drop guard records failures and unwinds as well as successful phases.
pub struct Timing {
    phase: &'static str,
    name: String,
    started: std::time::Instant,
}

impl Timing {
    pub fn new(phase: &'static str, name: &str) -> Self {
        Self {
            phase,
            name: name.into(),
            started: std::time::Instant::now(),
        }
    }
}

impl Drop for Timing {
    fn drop(&mut self) {
        use std::io::Write;
        let record = serde_json::json!({"suite": "gui", "phase": self.phase,
            "name": self.name, "duration_ms": self.started.elapsed().as_millis()});
        eprintln!("ACCEPTANCE_TIMING {record}");
        let dir = output_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("gui-timings.jsonl"))
        {
            let _ = writeln!(file, "{record}");
        }
    }
}

/// Poll immediately, bound both retries and slow predicates by one deadline,
/// and report the last observed state when readiness cannot be established.
pub async fn wait_until<F, Fut>(
    description: &str,
    timeout: std::time::Duration,
    mut probe: F,
) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last = "condition was false".to_string();
    loop {
        match tokio::time::timeout_at(deadline, probe()).await {
            Ok(Ok(true)) => return Ok(()),
            Ok(Ok(false)) => last = "condition was false".into(),
            Ok(Err(error)) => last = error,
            Err(_) => {
                return Err(format!(
                    "Timed out after {timeout:?} waiting for {description}; {last}; probe exceeded deadline"
                ));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Timed out after {timeout:?} waiting for {description}; last observation: {last}"
            ));
        }
        tokio::time::sleep_until(std::cmp::min(
            deadline,
            tokio::time::Instant::now() + std::time::Duration::from_millis(50),
        ))
        .await;
    }
}

/// Evaluate an observable browser condition; include the final URL on failure.
pub async fn wait_for_js(
    client: &Client,
    description: &str,
    script: &str,
    args: Vec<serde_json::Value>,
    timeout: std::time::Duration,
) {
    let result = wait_until(description, timeout, || async {
        client
            .execute(script, args.clone())
            .await
            .map(|value| value.as_bool() == Some(true))
            .map_err(|error| error.to_string())
    })
    .await;
    if let Err(error) = result {
        // Bound diagnostics too: an unresponsive driver must not hang the suite.
        let url =
            tokio::time::timeout(std::time::Duration::from_secs(2), client.current_url()).await;
        panic!("{error}; current URL: {url:?}");
    }
}

pub async fn wait_for_page(client: &Client, path: &str, project: Option<&str>) {
    let selector = match path.split('?').next().unwrap_or(path) {
        "/tasks" => "[data-testid='task-search-input']",
        "/board" => "[data-testid='board-task-search-input']",
        "/design" => ".uv-controls",
        "/artifacts" => "[role='tree'][aria-label='Project artifacts']",
        "/welcome" => "[data-testid='welcome-install']",
        "/settings" => "[data-testid='settings-page']",
        p if p.starts_with("/traces") => "[data-testid='traces-page']",
        _ => "main",
    };
    wait_for_js(
        client,
        &format!("page {path} with project {project:?}"),
        r#"const [path, selector, project] = arguments;
        const expected = new URL(path, location.origin);
        const element = document.querySelector(selector);
        const avatar = document.querySelector('[data-testid="sidebar-project-avatar"]');
        return location.pathname === expected.pathname && location.search === expected.search &&
            !!element && element.getClientRects().length > 0 &&
            (!project || avatar?.getAttribute('aria-label') === 'Switch project · ' + project);"#,
        vec![path.into(), selector.into(), project.into()],
        std::time::Duration::from_secs(10),
    )
    .await;
}

/// Used before interacting with elements that may still be mounting or disabled.
pub async fn wait_actionable(element: &fantoccini::elements::Element) {
    wait_until(
        "visible, enabled interaction target",
        std::time::Duration::from_secs(5),
        || async {
            let visible = element.is_displayed().await.map_err(|e| e.to_string())?;
            let enabled = element.is_enabled().await.map_err(|e| e.to_string())?;
            Ok(visible && enabled)
        },
    )
    .await
    .unwrap_or_else(|error| panic!("{error}"));
}

/// Retry only errors that guarantee the click was not dispatched. In particular,
/// do not repeat a command after a transport error with an unknown outcome.
fn retryable_click(error: &fantoccini::error::CmdError) -> bool {
    use fantoccini::error::{CmdError, ErrorStatus};
    matches!(error, CmdError::Standard(reply) if matches!(reply.error,
        ErrorStatus::ElementClickIntercepted | ErrorStatus::ElementNotInteractable
        | ErrorStatus::StaleElementReference | ErrorStatus::NoSuchElement))
}

/// Native clicks also test hit-target readiness while a panel is animating.
/// Re-resolve the locator so a React rerender cannot leave a stale target.
pub async fn click_when_ready(
    client: &Client,
    locator: fantoccini::Locator<'_>,
    description: &str,
) {
    wait_until(description, std::time::Duration::from_secs(5), || async {
        let result = async {
            let element = client.find(locator).await?;
            if !element.is_displayed().await? || !element.is_enabled().await? {
                return Ok(false);
            }
            element.click().await?;
            Ok::<_, fantoccini::error::CmdError>(true)
        }
        .await;
        match result {
            Ok(clicked) => Ok(clicked),
            Err(error) if retryable_click(&error) => Err(error.to_string()),
            Err(error) => panic!("failed to click {description}: {error}"),
        }
    })
    .await
    .unwrap_or_else(|error| panic!("{error}"));
}

/// Factory options can rerender while a workflow update completes.
pub async fn select_when_ready(client: &Client, locator: fantoccini::Locator<'_>, value: &str) {
    wait_until(
        &format!("select option {value}"),
        std::time::Duration::from_secs(10),
        || async {
            let result = async {
                let element = client.find(locator).await?;
                if !element.is_displayed().await? || !element.is_enabled().await? {
                    return Ok(false);
                }
                element.select_by_value(value).await?;
                Ok::<_, fantoccini::error::CmdError>(true)
            }
            .await;
            match result {
                Ok(selected) => Ok(selected),
                Err(error) if retryable_click(&error) => Err(error.to_string()),
                Err(error) => panic!("failed to select {value}: {error}"),
            }
        },
    )
    .await
    .unwrap_or_else(|error| panic!("{error}"));
}

/// Reuse the existing browser for a setup failure; never start one during cleanup.
pub async fn screenshot_existing_session(scenario: &str) {
    if let Some(wd) = WEBDRIVER.get() {
        let client = wd.lock().await;
        screenshot(&client, scenario, 999, "fail-setup").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn readiness_returns_immediately() {
        let start = tokio::time::Instant::now();
        wait_until("ready", Duration::from_secs(10), || async { Ok(true) })
            .await
            .unwrap();
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_retries_until_state_changes() {
        let start = tokio::time::Instant::now();
        let calls = std::cell::Cell::new(0);
        wait_until("third probe", Duration::from_secs(10), || {
            calls.set(calls.get() + 1);
            std::future::ready(Ok(calls.get() == 3))
        })
        .await
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert_eq!(start.elapsed(), Duration::from_millis(100));
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_timeout_contains_condition_and_last_error() {
        let start = tokio::time::Instant::now();
        let error = wait_until(
            "project alpha on /tasks",
            Duration::from_secs(2),
            || async { Err("still on /setup".into()) },
        )
        .await
        .unwrap_err();
        assert_eq!(start.elapsed(), Duration::from_secs(2));
        assert!(error.contains("project alpha on /tasks"), "{error}");
        assert!(error.contains("still on /setup"), "{error}");
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_bounds_hung_probe() {
        let start = tokio::time::Instant::now();
        let error = wait_until("hung driver", Duration::from_secs(2), || async {
            std::future::pending::<Result<bool, String>>().await
        })
        .await
        .unwrap_err();
        assert_eq!(start.elapsed(), Duration::from_secs(2));
        assert!(error.contains("probe exceeded deadline"), "{error}");
    }

    #[test]
    fn click_retries_only_known_pre_dispatch_errors() {
        use fantoccini::error::{CmdError, ErrorStatus, WebDriver};
        for status in [
            ErrorStatus::ElementClickIntercepted,
            ErrorStatus::ElementNotInteractable,
            ErrorStatus::StaleElementReference,
            ErrorStatus::NoSuchElement,
        ] {
            assert!(retryable_click(&CmdError::Standard(WebDriver::new(
                status,
                "not clicked"
            ))));
        }
        assert!(!retryable_click(&CmdError::Standard(WebDriver::new(
            ErrorStatus::Timeout,
            "unknown outcome"
        ))));
        assert!(!retryable_click(&CmdError::Lost(std::io::Error::other(
            "connection lost"
        ))));
    }

    #[test]
    fn screenshot_policy_keeps_failures_and_explicit_full_diagnostics() {
        assert!(!capture_screenshot(false, "after-click"));
        assert!(!capture_screenshot(false, "initial-app-state"));
        assert!(capture_screenshot(false, "fail-before-hook"));
        assert!(capture_screenshot(false, "fail-step"));
        assert!(capture_screenshot(true, "after-click"));
    }
}
