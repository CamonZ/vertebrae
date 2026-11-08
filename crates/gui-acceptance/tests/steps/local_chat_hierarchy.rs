//! Durable chat-index fixtures and real entity metadata, isolated by the GUI
//! runner's per-scenario project and container home. No task/cache mocks.
use std::{collections::HashMap, time::Duration};

use cucumber::{given, then, when};
use fantoccini::Locator;
use serde_json::json;

use crate::GuiWorld;

async fn cli(world: &mut GuiWorld, args: &[&str]) {
    world.run_vtb(args).await;

    assert_eq!(
        world.last_exit_code, 0,
        "{args:?}: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[given("the following entity conversations exist:")]
async fn entity_conversations(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("conversation table");
    let rows = &table.rows;
    let mut entities = HashMap::<String, String>::new();
    let mut sessions = Vec::new();
    let mut finish_step = None;
    let has_completed_conversations = rows.iter().skip(1).any(|row| row[4] == "yes");

    if has_completed_conversations {
        cli(world, &["workflow", "add", "chat-completion-fixture"]).await;

        let workflow = world
            .extract_workflow_id_from_output()
            .expect("workflow ID");
        let workflow_to_track = workflow.clone();

        world.track_workflow(workflow_to_track, None);

        cli(
            world,
            &[
                "step",
                "add",
                "--workflow",
                &workflow,
                "--harness",
                "claude",
                "--step-type",
                "finish",
                "--order",
                "1",
                "done",
            ],
        )
        .await;

        let finish_id = world.extract_step_id_from_output().expect("finish step ID");
        let step_to_track = finish_id.clone();

        world.track_step(step_to_track);

        cli(
            world,
            &[
                "step",
                "add",
                "--workflow",
                &workflow,
                "--harness",
                "claude",
                "--step-type",
                "stop",
                "--order",
                "0",
                "--transition-to",
                &finish_id,
                "open",
            ],
        )
        .await;

        let open_step = world.extract_step_id_from_output().expect("open step ID");

        world.track_step(open_step);
        finish_step = Some(finish_id);
    }

    for row in rows.iter().skip(1) {
        let title = &row[0];

        if title == "-" {
            continue;
        }

        cli(world, &["add", title, "--level", &row[1]]).await;

        let id = world.extract_task_id_from_output().expect("entity ID");
        let task_to_track = id.clone();

        world.track_task(task_to_track);

        if row[2] != "-" {
            let parent = entities.get(&row[2]).expect("parent must precede child");

            cli(world, &["update", &id, "--parent", parent]).await;
        }

        if row[4] == "yes" {
            let workflow = world.workflow_id.clone().expect("completion workflow");
            let target_step = finish_step.as_deref().unwrap();

            cli(world, &["workflow", "assign", &id, &workflow]).await;
            cli(
                world,
                &["transition-to", &id, target_step, "--skip-validation"],
            )
            .await;

            cli(world, &["--json", "show", &id]).await;

            let task: serde_json::Value =
                serde_json::from_str(&world.last_stdout).expect("task JSON");
            let is_completed = task["completed_at"].is_string();

            assert!(
                is_completed,
                "fixture must have canonical completion: {task}"
            );
        }

        let entity_title = title.clone();

        entities.insert(entity_title, id);
    }

    let project_path = world.project_path("primary");

    for row in rows.iter().skip(1).filter(|row| row[3] != "-") {
        let id = uuid::Uuid::new_v4().to_string();
        let updated_at = format!("2026-01-01T00:00:{:02}Z", sessions.len());
        let association = entities
            .get(&row[0])
            .map(|entity| json!({ "ticketId": entity, "ticketTitle": row[0] }));
        let session = json!({
            "id": id,
            "label": row[3],
            "title": row[3],
            "titleStatus": "manual",
            "titleConfidence": 1,
            "titleUserMessageCount": 1,
            "harness": "claude",

            "model": null,
            "selectedModelId": null,
            "selectedReasoningEffort": null,
            "selectedPersonality": null,
            "permissionMode": "default",

            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": updated_at,
            "projectPath": project_path,
            "providerResumeId": null,
            "threadTotalTokens": null,
            "messageCount": 1,
            "lifecycle": "idle",
            "status": "open",
            "association": association,
        });

        sessions.push(session);
    }

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver initialized")
        .clone();
    let client = wd.lock().await;

    let persist_sessions_script = r#"
        const done = arguments[arguments.length - 1];
        const input = { sessions: arguments[0] };

        window.__TAURI_INTERNALS__.invoke('save_local_chat_session_index', { input })
          .then(() => done(null))
          .catch(error => done(String(error)));
    "#;
    let arguments = vec![json!(sessions)];
    let result = client
        .execute_async(persist_sessions_script, arguments)
        .await
        .expect("persist conversation fixtures");

    assert!(
        result.is_null(),
        "chat fixture persistence failed: {result}"
    );

    let base_url = gui_acceptance::tauri_base_url();
    let task_list_url = format!("{base_url}/tasks");

    client
        .goto(&task_list_url)
        .await
        .expect("reload chat index");

    let project_slug = world.project_slug.as_deref();

    gui_acceptance::wait_for_page(&client, "/tasks", project_slug).await;
}

#[when("I open the entity conversation browser")]
async fn open_browser(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver initialized")
        .clone();
    let client = wd.lock().await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid='local-chat-launcher']"),
        "chat launcher",
    )
    .await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[title='Toggle chat history']"),
        "conversation history",
    )
    .await;

    gui_acceptance::wait_for_js(
        &client,
        "conversation browser visible",
        "return !!document.querySelector('[data-testid=local-chat-mini-panel]');",
        vec![],
        Duration::from_secs(10),
    )
    .await;
}

#[when("I toggle completed entity conversations")]
async fn toggle_completed(world: &mut GuiWorld) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver initialized")
        .clone();
    let client = wd.lock().await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[role=switch][aria-label='Show completed']"),
        "Show completed",
    )
    .await;
}

#[then("the conversation browser should contain this hierarchy:")]
async fn assert_hierarchy(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("hierarchy table");
    let expected: Vec<_> = table
        .rows
        .iter()
        .skip(1)
        .map(|row| {
            let path: Vec<_> = row[0].split(" / ").collect();
            let chats: Vec<_> = if row[1] == "-" {
                vec![]
            } else {
                row[1].split(", ").collect()
            };

            json!({ "path": path, "chats": chats })
        })
        .collect();

    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver initialized")
        .clone();
    let client = wd.lock().await;

    let hierarchy_script = r#"
      const panel = document.querySelector('[data-testid=local-chat-mini-panel]');
      if (!panel) return false;

      const visible = node => node.getClientRects().length > 0;
      const collapsedButtons = panel.querySelectorAll('.hc-mini-history-ticket-toggle[aria-expanded=false]');

      for (const button of collapsedButtons) {
        if (visible(button)) button.click();
      }

      const allRegions = [...panel.querySelectorAll('.hc-mini-history-group')];
      const regions = allRegions.filter(visible);
      const expected = arguments[0];

      if (regions.length !== expected.length) return false;

      return expected.every((entry, index) => {
        const region = regions[index];
        const path = [];

        for (let node = region; node; node = node.parentElement?.closest('.hc-mini-history-group')) {
          const label = node.getAttribute('aria-label');
          const entityTitle = label.replace(/ conversations$/, '');

          path.unshift(entityTitle);
        }

        const allRows = [...region.querySelectorAll('.hc-mini-history-open')];
        const rows = allRows.filter(visible);
        const ownRows = rows.filter(row => row.closest('.hc-mini-history-group') === region);
        const children = rows.filter(row => row.closest('.hc-mini-history-group') !== region);
        const ownTitles = ownRows.map(row => row.textContent.trim());

        const actualPath = JSON.stringify(path);
        const expectedPath = JSON.stringify(entry.path);
        const actualChats = JSON.stringify(ownTitles);
        const expectedChats = JSON.stringify(entry.chats);
        const lastChild = children.at(-1);
        const firstOwnRow = ownRows[0];
        const childFirst = !children.length || !ownRows.length ||
          rows.indexOf(lastChild) < rows.indexOf(firstOwnRow);

        return actualPath === expectedPath && actualChats === expectedChats && childFirst;
      });
    "#;
    let arguments = vec![json!(expected)];
    let timeout = Duration::from_secs(10);

    gui_acceptance::wait_for_js(
        &client,
        "exact nested conversation hierarchy and child-first ordering",
        hierarchy_script,
        arguments,
        timeout,
    )
    .await;

    world.screenshot(&client, "conversation-hierarchy").await;
}
