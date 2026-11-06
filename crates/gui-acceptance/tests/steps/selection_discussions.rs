//! Fixture setup uses production persistence; all selection gestures go through
//! the real renderer and WebDriver input, never renderer callback mocks.

use crate::GuiWorld;
use cucumber::{given, then, when};
use fantoccini::{
    Locator,
    actions::{InputSource, KeyAction, KeyActions, MouseActions, PointerAction},
};
use serde_json::{Value, json};
use std::time::Duration;

const DEEP: &str = r#"
function deep(root, selector) {
  const found = root.querySelector(selector);
  if (found) return found;

  for (const node of root.querySelectorAll("*")) {
    if (node.shadowRoot) {
      const found = deep(node.shadowRoot, selector);

      if (found) return found;
    }
  }

  return null;
}
"#;

fn harness_capture(filename: &str) -> Vec<Value> {
    let path = std::path::Path::new(gui_acceptance::HARNESS_CAPTURE_DIR).join(filename);
    let contents = std::fs::read_to_string(path).unwrap_or_default();

    contents
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn captured_turns() -> Vec<String> {
    let turns = harness_capture("stdin_turns.jsonl");

    turns
        .into_iter()
        .filter_map(|turn| turn.as_str().map(ToOwned::to_owned))
        .collect()
}

fn discussion_prompts() -> Vec<String> {
    let turns = captured_turns();

    turns
        .into_iter()
        .filter(|turn| turn.contains("This is a read-only side discussion."))
        .collect()
}

#[given("a Changes selection fixture is open beside a drafted main conversation")]
async fn fixture(world: &mut GuiWorld) {
    let path = world.temp_dir.as_ref().expect("fixture project").clone();
    let selection_path = path.join("selection.ts");

    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.email", "fixture@example.test"],
        vec!["config", "user.name", "Fixture"],
    ] {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&path)
            .status()
            .await
            .unwrap();

        assert!(status.success());
    }

    std::fs::write(
        &selection_path,
        "const first = 1;\nconst second = 2;\nconst third = 3;\n",
    )
    .unwrap();

    for args in [vec!["add", "."], vec!["commit", "-m", "fixture"]] {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&path)
            .status()
            .await
            .unwrap();

        assert!(status.success());
    }

    std::fs::write(
        &selection_path,
        "const first = 1;\nconst selected = 42;\nconst third = 3;\n",
    )
    .unwrap();

    let mock_response = "Fixture answer.\n\n".repeat(80);
    std::fs::write(gui_acceptance::MOCK_CHAT_RESPONSE_FILE, mock_response).unwrap();

    super::navigation::navigate_to(world, "/tasks", "selection-fixture").await;

    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let id = uuid::Uuid::new_v4().to_string();
    let entry = json!({
        "id": id,
        "label": "Project Chat",
        "title": null,
        "titleStatus": null,
        "titleConfidence": null,
        "titleUserMessageCount": 0,
        "harness": "claude",
        "providerId": "anthropic",
        "model": null,
        "selectedModelId": null,
        "selectedReasoningEffort": null,
        "selectedPersonality": null,
        "permissionMode": null,
        "createdAt": "2026-11-06T00:00:00Z",
        "updatedAt": "2026-11-06T00:00:00Z",
        "projectPath": path,
        "providerResumeId": null,
        "threadTotalTokens": null,
        "messageCount": 0,
        "lifecycle": "idle",
        "status": "open",
        "association": {
            "ticketId": null,
            "ticketTitle": null,
            "worktreePath": path,
            "branch": "main",
            "lastProcessedAt": null,
            "processedAtCount": 0,
            "awaitingWorktree": null,
            "recentWorktrees": [],
        },
    });

    let persist_session_script = r#"
            const done = arguments[arguments.length - 1];

            window.__TAURI_INTERNALS__
              .invoke("save_local_chat_session_index", {
                input: { sessions: [arguments[0]] },
              })
              .then(() => done(true))
              .catch((error) => done(String(error)));
        "#;

    let result = client
        .execute_async(persist_session_script, vec![entry])
        .await
        .unwrap();

    assert_eq!(result, json!(true));

    client.refresh().await.unwrap();
    let project_slug = world.project_slug.as_deref();
    gui_acceptance::wait_for_page(&client, "/tasks", project_slug).await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid='local-chat-launcher']"),
        "open fixture chat",
    )
    .await;

    let composer = client
        .wait()
        .at_most(Duration::from_secs(10))
        .for_element(Locator::Css("[data-testid='local-chat-composer']"))
        .await
        .expect("the fixture chat composer should mount after opening chat");

    gui_acceptance::wait_actionable(&composer).await;

    composer
        .send_keys("Initial fixture conversation")
        .await
        .unwrap();
    composer.send_keys("\u{e007}").await.unwrap();

    let reply_completed_script = r#"
            return (
              document.querySelectorAll("[data-local-chat-assistant-response-id]").length >
                0 &&
              !document.querySelector(
                "[data-testid=local-chat-stop-generation]:not(:disabled)",
              )
            );
        "#;

    gui_acceptance::wait_for_js(
        &client,
        "fixture reply completed",
        reply_completed_script,
        vec![],
        Duration::from_secs(20),
    )
    .await;

    composer
        .send_keys("Explain selected code before implementation")
        .await
        .unwrap();

    let capture_transcript_script = r#"
            const transcript = document.querySelector("[data-testid=chat-messages-scroll]");

            transcript.scrollTop = 20;
            window.__selectionTranscript = transcript;
            window.__selectionScroll = transcript.scrollTop;
        "#;

    client
        .execute(capture_transcript_script, vec![])
        .await
        .unwrap();

    // The initial conversation is fixture setup. Observe only subsequent turns.
    for filename in ["stdin_turns.jsonl", "invocations.jsonl"] {
        let path = std::path::Path::new(gui_acceptance::HARNESS_CAPTURE_DIR).join(filename);
        std::fs::write(path, "").unwrap();
    }

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid=local-chat-view-changes]"),
        "open Changes alongside chat",
    )
    .await;

    let diff_mounted_script = format!(
        r#"{DEEP}
            return !!deep(
              document.querySelector('[aria-label="Changes panel"]'),
              '[data-column-number="2"][data-line-type="change-addition"]',
            );
        "#
    );

    gui_acceptance::wait_for_js(
        &client,
        "real diff mounted",
        &diff_mounted_script,
        vec![],
        Duration::from_secs(15),
    )
    .await;
}

async fn gesture(world: &mut GuiWorld, drag: bool, shift: bool) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let selection_point_script = format!(
        r#"{DEEP}
            const panel = document.querySelector('[aria-label="Changes panel"]');
            const node = deep(
              panel,
              '[data-column-number="2"][data-line-type="change-addition"]',
            );

            node.scrollIntoView({{ block: "center" }});

            const rect = node.getBoundingClientRect();
            const x = Math.round(rect.x + rect.width / 2);
            const y = Math.round(rect.y + rect.height / 2);

            return [x, y];
        "#
    );

    let point = client
        .execute(&selection_point_script, vec![])
        .await
        .unwrap();
    let x = point[0].as_i64().unwrap();
    let y = point[1].as_i64().unwrap();

    if shift {
        let shift_actions =
            KeyActions::new("selection-shift".into()).then(KeyAction::Down { value: '\u{e008}' });

        client.perform_actions(shift_actions).await.unwrap();
    }

    let mut actions = MouseActions::new("diff-selection".into())
        .then(PointerAction::MoveTo {
            duration: None,
            x,
            y,
        })
        .then(PointerAction::Down { button: 0 });

    if drag {
        actions = actions.then(PointerAction::MoveTo {
            duration: Some(Duration::from_millis(150)),
            x,
            y: y + 20,
        });
    }

    let actions = actions.then(PointerAction::Up { button: 0 });

    client.perform_actions(actions).await.unwrap();
    client.release_actions().await.unwrap();
}

#[when("I select fixture code with the real diff renderer")]
async fn select(world: &mut GuiWorld) {
    gesture(world, false, false).await;
}

#[when("I exercise click drag shift-click and keyboard diff selections")]
async fn gestures(world: &mut GuiWorld) {
    gesture(world, false, false).await;
    gesture(world, true, false).await;
    gesture(world, false, true).await;

    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let region = client
        .find(Locator::Css(
            "[aria-label='Changes panel'] [aria-label='Code diff selection']",
        ))
        .await
        .unwrap();

    region
        .send_keys("\u{e015}\u{e008}\u{e015}\u{e000}")
        .await
        .unwrap();
}

#[then("selection alone opens no editor and sends no model request")]
async fn passive(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let passive_selection_script = format!(
        r#"{DEEP}
            const panel = document.querySelector('[aria-label="Changes panel"]');
            const selectedLine = deep(panel, "[data-line][data-selected-line]");

            return (
              !document.querySelector("[data-testid=diff-comment-draft-input]") &&
              !document.querySelector('[aria-label^="Document " ]') &&
              !!selectedLine
            );
        "#
    );

    let result = client
        .execute(&passive_selection_script, vec![])
        .await
        .unwrap();

    assert_eq!(result, json!(true));

    let turns = captured_turns();
    assert!(turns.is_empty(), "unexpected provider turns: {turns:#?}");
}

#[then("the main draft and conversation scroll are preserved")]
async fn draft(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let preserved_conversation_script = r#"
            const composer = document.querySelector("[data-testid=local-chat-composer]");
            const transcript = document.querySelector("[data-testid=chat-messages-scroll]");
            const conversation = document.querySelector("[data-testid=main-conversation]");
            const conversationRect = conversation.getBoundingClientRect();

            return (
              composer.value === "Explain selected code before implementation" &&
              transcript === window.__selectionTranscript &&
              transcript.scrollTop === window.__selectionScroll &&
              conversationRect.width > 0
            );
        "#;

    let result = client
        .execute(preserved_conversation_script, vec![])
        .await
        .unwrap();

    assert_eq!(result, json!(true));
}

#[when("I attach the selection to the main composer")]
async fn attach(world: &mut GuiWorld) {
    open_comment_dialog(world).await;

    {
        let wd = world.webdriver.as_ref().unwrap().clone();
        let client = wd.lock().await;

        let input = client
            .find(Locator::Css("[data-testid=diff-comment-draft-input]"))
            .await
            .unwrap();

        input
            .send_keys("Please explain selected code")
            .await
            .unwrap();
    }

    click(world, "Send to main chat").await;
}

async fn click(world: &mut GuiWorld, label: &str) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let xpath = format!("//button[normalize-space(.)='{label}']");
    let locator = Locator::XPath(&xpath);

    gui_acceptance::click_when_ready(&client, locator, label).await;
}

#[then("attachment alone sends no model request")]
async fn attachment(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let attachment_context_script = r#"
            const comment = document.querySelector("[data-testid=local-chat-pending-comment]");
            const commentText = comment.textContent;

            return (
              commentText.includes("selection.ts:2")
            );
        "#;

    let result = client
        .execute(attachment_context_script, vec![])
        .await
        .unwrap();

    assert_eq!(result, json!(true));

    let turns = captured_turns();
    assert!(turns.is_empty(), "unexpected provider turns: {turns:#?}");
}

#[when("I explicitly send the main draft")]
async fn main_send(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let composer = client
        .find(Locator::Css("[data-testid=local-chat-composer]"))
        .await
        .unwrap();

    composer.send_keys("\u{e007}").await.unwrap();
}

#[then("the main request contains the selected code and question")]
async fn main_context(_world: &mut GuiWorld) {
    gui_acceptance::wait_until(
        "main provider turn contains the attachment, question and draft",
        Duration::from_secs(10),
        || async {
            let turns = captured_turns();
            let delivered = turns.iter().any(|turn| {
                turn.contains("const selected = 42;")
                    && turn.contains("Please explain selected code")
                    && turn.contains("Explain selected code before implementation")
            });

            Ok(delivered)
        },
    )
    .await
    .unwrap();
}

async fn open_comment_dialog(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let gutter_visible_script = format!(
        r#"{DEEP}
            const panel = document.querySelector('[aria-label="Changes panel"]');
            const node = deep(
              panel,
              "[data-gutter-utility-slot] button",
            );

            const rect = node?.getBoundingClientRect();

            return !!rect && rect.width > 0;
        "#
    );

    gui_acceptance::wait_for_js(
        &client,
        "gutter plus visible",
        &gutter_visible_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;

    let gutter_point_script = format!(
        r#"{DEEP}
            const panel = document.querySelector('[aria-label="Changes panel"]');
            const node = deep(
              panel,
              "[data-gutter-utility-slot] button",
            );
            const rect = node.getBoundingClientRect();
            const x = Math.round(rect.x + rect.width / 2);
            const y = Math.round(rect.y + rect.height / 2);

            return [x, y];
        "#
    );

    let point = client.execute(&gutter_point_script, vec![]).await.unwrap();

    let x = point[0].as_i64().unwrap();
    let y = point[1].as_i64().unwrap();
    let actions = MouseActions::new("gutter-plus".into())
        .then(PointerAction::MoveTo {
            duration: None,
            x,
            y,
        })
        .then(PointerAction::Down { button: 0 })
        .then(PointerAction::Up { button: 0 });

    client.perform_actions(actions).await.unwrap();
    client.release_actions().await.unwrap();

    let dialog_open_script = r#"
            return (
              !!document.querySelector(
                '[role=dialog][aria-label="Comment on selected code"]',
              )
            );
        "#;

    gui_acceptance::wait_for_js(
        &client,
        "comment dialog opened by plus",
        dialog_open_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;

    let highlighted_selection_script = format!(
        r#"{DEEP}
            const panel = document.querySelector('[aria-label="Changes panel"]');
            return !!deep(panel, "[data-selected-line]");
        "#
    );

    gui_acceptance::wait_for_js(
        &client,
        "selected lines remain highlighted in the comment dialog",
        &highlighted_selection_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;

    let turns = captured_turns();
    assert!(
        turns.is_empty(),
        "opening the comment dialog sent provider turns: {turns:#?}"
    );
}

#[when("I ask about that selection and follow up")]
async fn ask(world: &mut GuiWorld) {
    open_comment_dialog(world).await;

    let questions = ["Why this value?", "Explain more"];

    for (index, question) in questions.into_iter().enumerate() {
        let wd = world.webdriver.as_ref().unwrap().clone();
        let client = wd.lock().await;

        let selector = if index == 0 {
            "[data-testid=diff-comment-draft-input]"
        } else {
            "[aria-label='Ask about selected code']"
        };
        let input = client.find(Locator::Css(selector)).await.unwrap();

        input.send_keys(question).await.unwrap();

        let button = if index == 0 { "Discuss inline" } else { "Ask" };
        let button_xpath = format!("//button[normalize-space(.)='{button}']");
        let button_locator = Locator::XPath(&button_xpath);

        gui_acceptance::click_when_ready(&client, button_locator, "ask inline question").await;

        let expected_turns = index + 1;
        gui_acceptance::wait_until(
            "inline question reached the provider",
            Duration::from_secs(10),
            || async { Ok(discussion_prompts().len() == expected_turns) },
        )
        .await
        .unwrap();

        let discussion_completed_script = r#"
            const thread = document.querySelector("[data-testid=selection-mini-thread]");
            const replies = thread?.querySelectorAll(".selection-mini-message.is-assistant");
            const status = thread?.querySelector('[role="status"]');
            const expectedReplies = arguments[0];

            return (
              thread?.closest(".diff-comment-thread") &&
              thread.textContent.includes("Fixture answer.") &&
              replies.length === expectedReplies &&
              status.textContent === "Reply complete."
            );
        "#;

        gui_acceptance::wait_for_js(
            &client,
            "discussion completed inside the code",
            discussion_completed_script,
            vec![json!(expected_turns)],
            Duration::from_secs(20),
        )
        .await;
    }
}

#[then("both discussion requests contain the original selected code")]
async fn discussion_context(_world: &mut GuiWorld) {
    let prompts = discussion_prompts();

    assert_eq!(
        prompts.len(),
        2,
        "captured discussion prompts: {prompts:#?}"
    );

    for prompt in &prompts {
        assert!(
            prompt.contains("const selected = 42;"),
            "unexpected code: {prompt}"
        );
    }

    let follow_up = &prompts[1];
    assert!(
        follow_up.contains("Why this value?"),
        "missing history: {follow_up}"
    );

    let invocations = harness_capture("invocations.jsonl");
    let read_only_launches = invocations
        .iter()
        .filter(|invocation| {
            let args = invocation.as_array().expect("provider argv");

            args.iter().any(|arg| arg == "--safe-mode")
        })
        .count();

    assert_eq!(
        read_only_launches, 2,
        "inline sessions must use the restricted launch policy"
    );
}

#[when("I close and reopen the discussion through its diff marker")]
async fn reopen(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[aria-label='Close discussion']"),
        "close discussion",
    )
    .await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[aria-label='Reopen selection discussion']"),
        "reopen diff marker",
    )
    .await;
}

#[then("the anchored discussion and main draft are preserved")]
async fn reopened(world: &mut GuiWorld) {
    draft(world).await;

    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let reopened_discussion_script = r#"
            const thread = document.querySelector("[data-testid=selection-mini-thread]");

            return (
              thread.textContent.includes("selection.ts:2") &&
              thread.textContent.includes("Explain more")
            );
        "#;

    let result = client
        .execute(reopened_discussion_script, vec![])
        .await
        .unwrap();

    assert_eq!(result, json!(true));
}

#[when("I edit the selected file and try to close Changes")]
async fn dirty(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[aria-label='Open selection.ts']"),
        "open document",
    )
    .await;

    let editable_document_script = format!(
        r#"{DEEP}
            return !!deep(
              document.querySelector('[aria-label="Document selection.ts"]'),
              "[contenteditable=true]",
            );
        "#
    );

    gui_acceptance::wait_for_js(
        &client,
        "editable document",
        &editable_document_script,
        vec![],
        Duration::from_secs(10),
    )
    .await;

    let focus_editor_script = format!(
        r#"{DEEP}
            const documentView = document.querySelector('[aria-label="Document selection.ts"]');
            const editor = deep(documentView, "[contenteditable=true]");

            editor.focus();
        "#
    );

    client.execute(&focus_editor_script, vec![]).await.unwrap();

    let editor = client.active_element().await.unwrap();
    editor.send_keys("unsaved").await.unwrap();

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid=local-chat-view-changes]"),
        "close dirty Changes",
    )
    .await;
}

#[then("unsaved document protection keeps Changes open")]
async fn protected(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    let unsaved_dialog_script = r#"
            const dialog = document.querySelector("[role=dialog]");
            const text = dialog?.textContent;

            return text?.includes("unsaved changes");
        "#;

    gui_acceptance::wait_for_js(
        &client,
        "unsaved protection",
        unsaved_dialog_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::XPath("//*[@role='dialog']//button[normalize-space(.)='Cancel']"),
        "retain dirty document",
    )
    .await;

    let panel_open_script = r#"
            return !!document.querySelector('[aria-label="Changes panel"]');
        "#;

    let result = client.execute(panel_open_script, vec![]).await.unwrap();

    assert_eq!(result, json!(true));
}
