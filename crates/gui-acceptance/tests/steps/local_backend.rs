//! Real rootless Podman scenarios, isolated from the normal acceptance backend.
use crate::GuiWorld;
use cucumber::{given, then, when};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio::process::Command;

fn backend_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("acceptance HOME"))
        .join(".local/share/vertebrae/local-backend")
}
fn config_path() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("acceptance HOME"))
        .join(".config/vertebrae/config.toml")
}
fn saved_state() -> Value {
    serde_json::from_slice(
        &std::fs::read(backend_dir().join("state.json")).expect("saved backend state"),
    )
    .expect("valid backend JSON")
}
fn project(state: &Value) -> String {
    let id = state["installation_id"]
        .as_str()
        .expect("installation id")
        .replace('-', "");
    assert_eq!(
        id.len(),
        32,
        "only test-generated installation ids are allowed"
    );
    format!("vertebrae-local-{id}")
}
fn volume(state: &Value) -> String {
    format!("{}_pgdata", project(state))
}
async fn native(args: &[&str]) -> String {
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        Command::new("/usr/local/bin/podman")
            .kill_on_drop(true)
            .arg("--remote=false")
            .args(args)
            .env_remove("CONTAINER_HOST")
            .env_remove("CONTAINER_CONNECTION")
            .env_remove("PODMAN_COMPOSE_PROVIDER")
            .output(),
    )
    .await
    .expect("Podman command timeout")
    .expect("spawn real Podman");
    assert!(
        output.status.success(),
        "real Podman {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("UTF-8 Podman output")
}
async fn containers(state: &Value, service: Option<&str>) -> Vec<String> {
    let label = format!("label=com.docker.compose.project={}", project(state));
    let mut args = vec!["ps", "--all", "--filter", &label, "--format", "{{.ID}}"];
    let service_label = service.map(|s| format!("label=com.docker.compose.service={s}"));
    if let Some(label) = &service_label {
        args.extend(["--filter", label]);
    }
    native(&args).await.lines().map(str::to_string).collect()
}
async fn invoke(world: &mut GuiWorld, command: &str, args: Value) -> Value {
    let wd = world.webdriver.as_ref().expect("Podman WebDriver").clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "Tauri command bridge ready",
        "return typeof window.__TAURI_INTERNALS__?.invoke === 'function';",
        vec![],
        Duration::from_secs(60),
    )
    .await;
    client.execute(r#"
        window.__podmanAcceptanceResult = null;
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
          .then(value => { window.__podmanAcceptanceResult = {ok:true, value}; })
          .catch(error => { window.__podmanAcceptanceResult = {ok:false, error:String(error?.message ?? error)}; });
        return true;
    "#, vec![command.into(), args]).await.expect("invoke actual Tauri command");
    gui_acceptance::wait_for_js(
        &client,
        "local backend command completed",
        "return window.__podmanAcceptanceResult !== null;",
        vec![],
        Duration::from_secs(600),
    )
    .await;
    client
        .execute("return window.__podmanAcceptanceResult;", vec![])
        .await
        .expect("read Tauri result")
}

pub async fn before_scenario(world: &mut GuiWorld, name: &str) {
    assert_eq!(std::env::var("GUI_ACCEPTANCE_PODMAN").as_deref(), Ok("1"));
    world.scenario_name = name.to_string();
    gui_acceptance::close_webdriver().await;
    assert!(
        !backend_dir().exists(),
        "previous scenario must clean up its local stack"
    );
    let config = config_path();
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
        config,
        "[sacrum]\nurl = \"http://127.0.0.1:4000\"\ntoken = \"\"\n",
    )
    .unwrap();
    world.webdriver = Some(gui_acceptance::webdriver().await);
}

pub async fn after_scenario() {
    gui_acceptance::close_webdriver().await;
    if backend_dir().join("state.json").is_file() {
        let state = saved_state();
        for id in containers(&state, None).await {
            native(&["rm", "--force", &id]).await;
        }
        let name = volume(&state);
        if native(&["volume", "ls", "--format", "{{.Name}}"])
            .await
            .lines()
            .any(|v| v == name)
        {
            native(&["volume", "rm", &name]).await;
        }
    }
    if backend_dir().exists() {
        std::fs::remove_dir_all(backend_dir()).unwrap();
    }
}

#[given("a fresh GUI-managed Podman backend")]
async fn fresh_backend(world: &mut GuiWorld) {
    let runtimes = invoke(world, "local_backend_runtimes", json!({})).await;
    assert_eq!(runtimes["ok"], true, "runtime discovery failed: {runtimes}");
    assert!(
        runtimes["value"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["runtime"] == "podman" && v["installed"] == true)
    );
    let result = invoke(
        world,
        "setup_local_backend",
        json!({"runtime":"podman", "adoptLegacy":false}),
    )
    .await;
    assert_eq!(
        result["ok"], true,
        "real Podman provisioning failed: {result}"
    );
    assert_eq!(result["value"]["status"], "ready");
    let state = saved_state();
    world.backend_token = Some(std::fs::read(backend_dir().join("api-token")).unwrap());
    world.backend_snapshot = Some(state.clone());
    let ids = containers(&state, Some("postgres")).await;
    assert_eq!(ids.len(), 1);
    native(&["exec", &ids[0], "psql", "-U", "postgres", "-d", "sacrum_prod", "-tAc",
        "CREATE TABLE acceptance_sentinel (value text); INSERT INTO acceptance_sentinel VALUES ('survived');"]).await;
}

#[then("the Podman installation should have valid saved runtime identity")]
async fn saved_identity(world: &mut GuiWorld) {
    let state = saved_state();
    assert_eq!(state["schema_version"], 2);
    assert_eq!(state["runtime"], "podman");
    assert!(state.get("docker_target").is_none());
    assert!(
        state["podman_target"]["endpoint"]
            .as_str()
            .unwrap()
            .starts_with("unix:///run/user/1000/")
    );
    assert!(
        state["podman_target"]["provider"]
            .as_str()
            .unwrap()
            .starts_with('/')
    );
    assert_eq!(state["provisioning_state"], "ready");
    assert!(!world.backend_token.as_ref().unwrap().is_empty());
}

#[then("the local backend should accept authenticated requests using the saved GUI settings")]
async fn authenticated_backend(world: &mut GuiWorld) {
    let result = invoke(world, "sacrum_config_status", json!({})).await;
    assert_eq!(result["ok"], true, "read GUI settings failed: {result}");
    assert_eq!(result["value"]["has_token"], true);
    let config = vertebrae_sacrum_client::load_config_file().expect("saved GUI settings");
    assert_eq!(result["value"]["url"], config.sacrum.url);
    let token = config.sacrum.token.expect("saved API token");
    assert!(
        token.trim().as_bytes() == world.backend_token.as_ref().unwrap().as_slice(),
        "saved GUI credential must match the provisioned credential"
    );
    let client = vertebrae_sacrum_client::GraphqlClient::new(
        vertebrae_sacrum_client::SacrumConfig::new(config.sacrum.url, token, String::new()),
    );
    let projects: Value = client
        .execute("query { projects { id } }", json!({}), "projects")
        .await
        .expect("provisioned backend accepts authenticated GraphQL requests");
    assert!(projects.is_array());
}

#[then("the Podman backend should publish only the saved loopback port")]
async fn loopback_port(_world: &mut GuiWorld) {
    let state = saved_state();
    let ids = containers(&state, Some("sacrum")).await;
    assert_eq!(ids.len(), 1);
    let output = native(&[
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        &ids[0],
    ])
    .await;
    let ports: Value = serde_json::from_str(&output).unwrap();
    let bindings = ports["4000/tcp"].as_array().expect("published Sacrum port");
    assert!(!bindings.is_empty());
    for binding in bindings {
        assert_eq!(binding["HostIp"], "127.0.0.1");
        assert_eq!(
            binding["HostPort"],
            state["host_port"].as_u64().unwrap().to_string()
        );
    }
    let port = u16::try_from(state["host_port"].as_u64().unwrap()).unwrap();
    tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .expect("host loopback is reachable");
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let host_ip = route.local_addr().unwrap().ip();
    assert!(!host_ip.is_loopback() && !host_ip.is_unspecified());
    assert!(
        !matches!(
            tokio::time::timeout(
                Duration::from_secs(2),
                tokio::net::TcpStream::connect((host_ip, port))
            )
            .await,
            Ok(Ok(_))
        ),
        "backend must not accept non-loopback ingress"
    );
}

#[when("I restart the GUI application")]
async fn restart_gui(world: &mut GuiWorld) {
    gui_acceptance::close_webdriver().await;
    world.webdriver = Some(gui_acceptance::webdriver().await);
}
#[when("I reopen the saved Podman backend through the GUI command")]
async fn reopen(world: &mut GuiWorld) {
    world.backend_result = Some(
        invoke(
            world,
            "setup_local_backend",
            json!({"runtime":"podman","adoptLegacy":false}),
        )
        .await,
    );
}
#[when("I request Docker for the saved Podman backend through the GUI command")]
async fn switch_runtime(world: &mut GuiWorld) {
    world.backend_result = Some(
        invoke(
            world,
            "setup_local_backend",
            json!({"runtime":"docker","adoptLegacy":false}),
        )
        .await,
    );
}
#[then(expr = "the backend command should fail with {string}")]
async fn backend_error(world: &mut GuiWorld, message: String) {
    let result = world
        .backend_result
        .as_ref()
        .expect("backend command result");
    assert_eq!(
        result["ok"], false,
        "backend command unexpectedly succeeded"
    );
    assert!(
        result["error"].as_str().unwrap().contains(&message),
        "expected {message:?}, got {result}"
    );
}
#[then("the Podman database sentinel and token should be unchanged")]
async fn persistent_data(world: &mut GuiWorld) {
    let state = world.backend_snapshot.as_ref().unwrap();
    assert!(
        std::fs::read(backend_dir().join("api-token")).unwrap()
            == *world.backend_token.as_ref().unwrap(),
        "API token was unexpectedly changed"
    );
    let ids = containers(state, Some("postgres")).await;
    assert_eq!(ids.len(), 1);
    let value = native(&[
        "exec",
        &ids[0],
        "psql",
        "-U",
        "postgres",
        "-d",
        "sacrum_prod",
        "-tAc",
        "SELECT value FROM acceptance_sentinel;",
    ])
    .await;
    assert_eq!(value.trim(), "survived");
}
#[when("the saved Podman storage identity changes")]
async fn change_storage(_world: &mut GuiWorld) {
    let mut state = saved_state();
    state["podman_target"]["storage_root"] = "/different/rootless/storage".into();
    std::fs::write(
        backend_dir().join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
}
#[when("the managed Podman database volume is removed")]
async fn remove_volume(_world: &mut GuiWorld) {
    let state = saved_state();
    for id in containers(&state, None).await {
        native(&["rm", "--force", &id]).await;
    }
    native(&["volume", "rm", &volume(&state)]).await;
}
#[then("the lost Podman database volume should remain absent")]
async fn volume_absent(_world: &mut GuiWorld) {
    let name = volume(&saved_state());
    assert!(
        !native(&["volume", "ls", "--format", "{{.Name}}"])
            .await
            .lines()
            .any(|v| v == name)
    );
}

#[then("the backend command should succeed")]
async fn backend_success(world: &mut GuiWorld) {
    let result = world
        .backend_result
        .as_ref()
        .expect("backend command result");
    assert_eq!(result["ok"], true, "backend command failed: {result}");
    assert_eq!(result["value"]["status"], "ready");
}
