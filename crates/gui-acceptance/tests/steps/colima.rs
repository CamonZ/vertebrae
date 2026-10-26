//! UI actions only; no direct setup, initialize-project or selection commands.
use crate::GuiWorld;
use cucumber::{given, then, when};
use fantoccini::Locator;
use std::{path::PathBuf, time::Duration};

pub async fn before_scenario(world: &mut GuiWorld, name: &str) {
    assert_eq!(std::env::var("GUI_ACCEPTANCE_COLIMA").as_deref(), Ok("1"));
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    assert!(home.join(".colima-gui-acceptance").is_file());
    assert!(!home.join(".config/vertebrae/config.toml").exists());
    world.scenario_name = name.into();
    world.webdriver = Some(gui_acceptance::webdriver().await);
}

#[given("the fresh Colima GUI is on project setup")]
async fn on_setup(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(
        &client,
        "fresh backend choice",
        "return !!document.querySelector('[data-testid=\"backend-choice-local\"]');",
        vec![],
        Duration::from_secs(30),
    )
    .await;
    world.screenshot(&client, "fresh-colima-setup").await;
}

#[then("I can select Docker in the visible container runtime control")]
async fn select_docker(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let selector = client
        .wait()
        .at_most(Duration::from_secs(30))
        .for_element(Locator::Css("#local-container-runtime"))
        .await
        .expect("visible runtime selector must exist");
    gui_acceptance::wait_actionable(&selector).await;
    let option = client
        .find(Locator::Css(
            "#local-container-runtime option[value='docker']",
        ))
        .await
        .unwrap();
    assert!(
        option.is_enabled().await.unwrap(),
        "Docker must be available without Podman"
    );
    option
        .click()
        .await
        .expect("select Docker through the native select control");
    assert_eq!(
        selector.prop("value").await.unwrap().as_deref(),
        Some("docker")
    );
    assert_eq!(
        client
            .execute(
                "return document.body.innerText.toLowerCase().includes('podman was not found');",
                vec![]
            )
            .await
            .unwrap(),
        false,
        "Docker setup must not instruct the user to install optional Podman"
    );
    world.screenshot(&client, "docker-runtime-selectable").await;
}

#[then("the setup form should stay above its footer in small windows")]
async fn small_window_layout(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    for (width, height) in [(640, 480), (800, 600)] {
        client.set_window_size(width, height).await.unwrap();
        gui_acceptance::wait_for_js(&client, "form scroll region stays above footer",
            "const form = document.querySelector('.fr-scroll').getBoundingClientRect(); const footer = document.querySelector('.fr-foot').getBoundingClientRect(); return form.height > 0 && form.bottom <= footer.top;",
            vec![], Duration::from_secs(10)).await;
        world
            .screenshot(&client, &format!("setup-layout-{width}-{height}"))
            .await;
    }
}

#[when("I refresh container runtimes using the setup screen")]
async fn refresh(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::click_when_ready(
        &client,
        Locator::XPath("//button[normalize-space()='Refresh runtimes']"),
        "Refresh runtimes button",
    )
    .await;
    gui_acceptance::wait_for_js(&client, "runtime refresh completed", "return document.querySelector('#local-container-runtime')?.disabled === false && !document.body.innerText.includes('Checking container runtimes');", vec![], Duration::from_secs(30)).await;
}

#[when("I choose the Colima project folder using the native dialog")]
async fn choose_folder(world: &mut GuiWorld) {
    let folder = PathBuf::from(std::env::var_os("HOME").unwrap()).join("colima-project");
    std::fs::create_dir_all(&folder).unwrap();
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid='project-folder-choose']"),
        "Choose folder button",
    )
    .await;
    let status = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("python3")
            .args([
                "/app/scripts/gui-acceptance-folder.py",
                folder.to_str().unwrap(),
            ])
            .kill_on_drop(true)
            .status(),
    )
    .await
    .expect("native chooser automation timeout")
    .unwrap();
    assert!(
        status.success(),
        "native folder chooser could not select the project directory"
    );
    gui_acceptance::wait_for_js(
        &client,
        "chosen project folder shown",
        "return document.querySelector('.fpath')?.textContent.includes(arguments[0]);",
        vec![folder.to_string_lossy().into_owned().into()],
        Duration::from_secs(20),
    )
    .await;
    world
        .screenshot(&client, "colima-project-folder-selected")
        .await;
}

#[then("the Create project button should be unobstructed")]
async fn create_unobstructed(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let hit = client
        .execute(
            r#"
        const button = document.querySelector('[data-testid="project-phase-continue"]');
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {ready: !!target && button.contains(target),
                blockingElement: target?.outerHTML, buttonBounds: rect.toJSON()};
    "#,
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(hit["ready"], true, "Create project is obstructed: {hit}");
}

#[when("I enter the Colima project name through the setup form")]
async fn name_project(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::click_when_ready(&client, Locator::Css("#project-name"), "Project name input")
        .await;
    let input = client.find(Locator::Css("#project-name")).await.unwrap();
    input.clear().await.unwrap();
    input.send_keys("Colima Project").await.unwrap();
    world
        .screenshot(&client, "colima-project-name-edited")
        .await;
}

#[then(expr = "the GUI should finish Colima project setup within {int} seconds")]
async fn setup_finished(world: &mut GuiWorld, seconds: u64) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(&client, "project setup completed or failed", "return !!document.querySelector('[data-testid=\"ignition-screen\"]') || !!document.querySelector('[data-testid=\"project-phase-error\"]');", vec![], Duration::from_secs(seconds)).await;
    let error = client.execute("return document.querySelector('[data-testid=\"project-phase-error\"]')?.textContent ?? '';", vec![]).await.unwrap();
    world
        .screenshot(&client, "colima-project-setup-result")
        .await;
    assert_eq!(error.as_str(), Some(""), "visible setup error: {error}");
    assert!(
        client
            .find(Locator::Css("[data-testid='ignition-screen']"))
            .await
            .unwrap()
            .is_displayed()
            .await
            .unwrap()
    );
}

#[then("the Colima project should be selected in the sidebar")]
async fn selected(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    gui_acceptance::wait_for_js(&client, "Colima project active in sidebar", "return document.querySelector('[data-testid=\"sidebar-project-avatar\"]')?.getAttribute('aria-label') === 'Switch project · colima-project';", vec![], Duration::from_secs(30)).await;
    gui_acceptance::wait_for_page(&client, "/tasks", Some("colima-project")).await;
    world.screenshot(&client, "colima-project-active").await;
}
