//! Fixture setup uses production persistence; all selection gestures go through
//! the real renderer and WebDriver input, never renderer callback mocks.

use crate::GuiWorld;
use cucumber::{given, then, when};
use fantoccini::{
    Locator,
    actions::{
        InputSource, KeyAction, KeyActions, MouseActions, PointerAction, WheelAction, WheelActions,
    },
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

/// The main conversation's drafted question; every other captured turn in
/// these scenarios belongs to an inline discussion.
const MAIN_DRAFT: &str = "Explain selected code before implementation";

fn discussion_prompts() -> Vec<String> {
    let turns = captured_turns();

    turns
        .into_iter()
        .filter(|turn| !turn.contains(MAIN_DRAFT))
        .collect()
}

/// Launches of the restricted discussion runtime.
fn discussion_launches() -> Vec<Vec<String>> {
    harness_capture("invocations.jsonl")
        .into_iter()
        .filter_map(|invocation| {
            let args: Vec<String> = invocation
                .as_array()?
                .iter()
                .filter_map(|arg| arg.as_str().map(ToOwned::to_owned))
                .collect();

            args.iter().any(|arg| arg == "--safe-mode").then_some(args)
        })
        .collect()
}

fn flag_values<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    args.windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
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

    scroll_into_earlier_history(&client).await;

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

// Establish a real paused reading position before opening Changes. A bare
// scrollTop assignment does not express user intent to the chat's follow policy.
async fn scroll_into_earlier_history(client: &fantoccini::Client) {
    let ready_script = r#"
        const transcript = document.querySelector("[data-testid=chat-messages-scroll]");
        const panel = transcript.closest(".hc-panel");
        const animations = panel.getAnimations({ subtree: true });
        const moving = animations.some(animation => {
          const timing = animation.effect?.getComputedTiming();
          const finite = Number.isFinite(timing?.endTime);

          return animation.playState === "running" && finite;
        });
        const gap = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;

        if (moving || transcript.scrollTop <= 100 || gap > 1) return false;

        // Floating panels can extend beyond the viewport. Target only the
        // visible intersection, and verify that the transcript receives input.
        const rect = transcript.getBoundingClientRect();
        const left = Math.max(0, rect.left) + 8;
        const right = Math.min(window.innerWidth, rect.right) - 8;
        const top = Math.max(0, rect.top) + 8;
        const bottom = Math.min(window.innerHeight, rect.bottom) - 8;

        if (right <= left || bottom <= top) return false;

        const x = Math.floor((left + right) / 2);
        const y = Math.floor((top + bottom) / 2);
        const hit = document.elementFromPoint(x, y);

        if (!hit || !transcript.contains(hit)) return false;

        const delta = Math.floor(20 - transcript.scrollTop);
        window.__selectionScrollTarget = { x, y, delta };
        return true;
    "#;

    gui_acceptance::wait_for_js(
        client,
        "initial bottom-follow and visible transcript wheel target",
        ready_script,
        vec![],
        Duration::from_secs(10),
    )
    .await;

    let target_script = "return window.__selectionScrollTarget;";
    let target = client.execute(target_script, vec![]).await.unwrap();
    let x = target["x"]
        .as_i64()
        .expect("visible transcript x coordinate");
    let y = target["y"]
        .as_i64()
        .expect("visible transcript y coordinate");
    let delta_y = target["delta"].as_i64().expect("upward transcript delta");

    let pointer_move = PointerAction::MoveTo {
        duration: None,
        x,
        y,
    };
    let pointer = MouseActions::new("conversation-scroll-pointer".to_owned());
    let pointer_actions = pointer.then(pointer_move);

    client.perform_actions(pointer_actions).await.unwrap();

    let scroll = WheelAction::Scroll {
        duration: None,
        x,
        y,
        delta_x: 0,
        delta_y,
    };
    let wheel = WheelActions::new("read-earlier-conversation".to_owned());
    let wheel_actions = wheel.then(scroll);

    client.perform_actions(wheel_actions).await.unwrap();
    client.release_actions().await.unwrap();

    let capture_script = r#"
        const done = arguments[arguments.length - 1];
        const transcript = document.querySelector("[data-testid=chat-messages-scroll]");
        const deadline = performance.now() + 10000;
        let previous = null;
        let stableFrames = 0;

        function sample() {
          const top = transcript.scrollTop;
          const height = transcript.scrollHeight;
          const viewport = transcript.clientHeight;
          const gap = height - viewport - top;
          const readingEarlier = top >= 0 && top < 100 && gap > 24;
          const unchanged = previous && previous.top === top &&
            previous.height === height && previous.viewport === viewport;

          stableFrames = readingEarlier && unchanged ? stableFrames + 1 : 0;
          previous = { top, height, viewport };

          if (stableFrames >= 3) {
            window.__selectionTranscript = transcript;
            window.__selectionScroll = top;
            done({ settled: true, ...previous });
          } else if (performance.now() >= deadline) {
            done({ settled: false, ...previous });
          } else {
            requestAnimationFrame(sample);
          }
        }

        requestAnimationFrame(sample);
    "#;
    let captured = client.execute_async(capture_script, vec![]).await.unwrap();

    assert_eq!(
        captured["settled"],
        json!(true),
        "native upward scroll should settle in earlier history: {captured}"
    );
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

            node.scrollIntoView({{ block: "center", inline: "center", behavior: "instant" }});

            const rect = node.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const right = Math.min(window.innerWidth - 1, rect.right);
            const top = Math.max(0, rect.top);
            const bottom = Math.min(window.innerHeight - 21, rect.bottom);
            const x = Math.round((left + right) / 2);
            const y = Math.round((top + bottom) / 2);

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
            const left = Math.max(0, rect.left);
            const right = Math.min(window.innerWidth - 1, rect.right);
            const top = Math.max(0, rect.top);
            const bottom = Math.min(window.innerHeight - 21, rect.bottom);
            const x = Math.round((left + right) / 2);
            const y = Math.round((top + bottom) / 2);

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

    let model_disclosure_script = r#"
        const dialog = document.querySelector('[role=dialog][aria-label="Comment on selected code"]');

        return dialog && !dialog.querySelector('[role=alert]') &&
          !dialog.textContent.includes('Next reply:');
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "inline catalog ready without routine model labels",
        model_disclosure_script,
        vec![],
        Duration::from_secs(10),
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
        let delivered = gui_acceptance::wait_until(
            "inline question reached the provider",
            Duration::from_secs(10),
            || async { Ok(discussion_prompts().len() == expected_turns) },
        )
        .await;

        if let Err(reason) = delivered {
            let diagnostic_script = "return document.querySelector('[data-testid=selection-mini-thread]')?.textContent;";
            let diagnostic = client.execute(diagnostic_script, vec![]).await;
            let launches = harness_capture("invocations.jsonl");

            panic!("{reason}; discussion: {diagnostic:?}; launches: {launches:?}");
        }

        let discussion_completed_script = r#"
            const thread = document.querySelector("[data-testid=selection-mini-thread]");
            const replies = thread?.querySelectorAll(".selection-mini-messages .evrow--agent");
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

#[then("the discussion is one read-only session whose follow-up carries only the question")]
async fn discussion_context(_world: &mut GuiWorld) {
    let prompts = discussion_prompts();

    assert_eq!(
        prompts.len(),
        2,
        "captured discussion prompts: {prompts:#?}"
    );

    let first = &prompts[0];

    assert!(
        first.starts_with("Context: {")
            && first.contains("const selected = 42;")
            && first.contains("Why this value?"),
        "first turn must carry the anchor and question: {first}"
    );

    // The follow-up is a new turn in the same session, not a replay.
    assert_eq!(prompts[1], "Explain more", "follow-up turn: {}", prompts[1]);

    let launches = discussion_launches();

    assert_eq!(
        launches.len(),
        1,
        "a thread must launch one restricted runtime: {launches:#?}"
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

    let dirty_document_script = r#"
        const documentView = document.querySelector('[aria-label="Document selection.ts"]');
        const status = documentView?.querySelector('[role="status"]');

        return status?.textContent.includes("Unsaved");
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "document marked unsaved before closing Changes",
        dirty_document_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;

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

#[given("inline discussions use a dedicated model selected in Settings")]
async fn dedicated_model(world: &mut GuiWorld) {
    super::navigation::navigate_to(world, "/settings", "inline-model-settings").await;

    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid=settings-nav-code-editor]"),
        "code editor settings",
    )
    .await;
    let catalog_loaded_script = r#"
        const option = document.querySelector('[aria-label="Inline discussion mode"] option[value=dedicated]');

        return option?.disabled === false;
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "inline provider catalog loaded",
        catalog_loaded_script,
        vec![],
        Duration::from_secs(10),
    )
    .await;

    let selections = [
        ("Inline discussion mode", "dedicated"),
        ("Inline discussion provider", "anthropic"),
        ("Inline discussion model", "opus"),
        ("Inline discussion reasoning effort", "high"),
        ("Inline discussion speed tier", "fast"),
    ];

    for (label, value) in selections {
        let selector = format!("[aria-label='{label}']");
        let locator = Locator::Css(&selector);

        gui_acceptance::select_when_ready(&client, locator, value).await;
    }

    let layout_script = r#"
        const labels = ['provider', 'model', 'reasoning effort', 'speed tier'];
        const boxes = labels.map(label => document.querySelector(`[aria-label="Inline discussion ${label}"]`).getBoundingClientRect());
        const mode = document.querySelector('[aria-label="Inline discussion mode"]').getBoundingClientRect();
        const aligned = boxes.every(box => Math.abs(box.top - boxes[0].top) < 1);
        const ordered = boxes.every((box, index) => index === 0 || box.left > boxes[index - 1].left);
        const personality = document.querySelector('[aria-label="Inline discussion personality"], [aria-label="Inline discussion output style"]');

        return aligned && ordered && boxes[0].top > mode.bottom && !personality;
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "four custom options on one row below Answer using",
        layout_script,
        vec![],
        Duration::from_secs(5),
    )
    .await;
    world.screenshot(&client, "inline-model-options-row").await;
    client.refresh().await.unwrap();

    gui_acceptance::click_when_ready(
        &client,
        Locator::Css("[data-testid=settings-nav-code-editor]"),
        "restore code editor settings",
    )
    .await;

    let restored_model_script = r#"
        const picker = document.querySelector('[aria-label="Inline discussion model"]');

        const effort = document.querySelector('[aria-label="Inline discussion reasoning effort"]');
        const speed = document.querySelector('[aria-label="Inline discussion speed tier"]');
        return picker?.value === 'opus' && effort?.value === 'high' && speed?.value === 'fast';
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "dedicated inline model restored after reload",
        restored_model_script,
        vec![],
        Duration::from_secs(10),
    )
    .await;
}

#[then("inline requests use the dedicated model without routine labels")]
async fn dedicated_requests(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let disclosure_script = r#"
        const thread = document.querySelector('[data-testid=selection-mini-thread]');

        return thread && !/Next reply:|Reply:|Anthropic|Opus/.test(thread.textContent);
    "#;

    let disclosure = client.execute(disclosure_script, vec![]).await.unwrap();

    assert_eq!(disclosure, json!(true));

    let launches = harness_capture("invocations.jsonl");

    // Both turns ran in the one dedicated discussion runtime.
    assert_eq!(launches.len(), 1, "dedicated launches: {launches:?}");

    for launch in launches {
        let args = launch.as_array().unwrap();
        let uses_dedicated_model = args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "opus");

        assert!(uses_dedicated_model, "dedicated launch: {args:?}");
        let uses_effort = args
            .windows(2)
            .any(|pair| pair[0] == "--effort" && pair[1] == "high");
        let settings: Vec<Value> = args
            .iter()
            .filter_map(|arg| {
                arg.as_str()
                    .and_then(|text| serde_json::from_str(text).ok())
            })
            .collect();
        let uses_fast = settings.iter().any(|setting| setting["fastMode"] == true);
        let uses_custom_style = settings
            .iter()
            .any(|setting| setting.get("outputStyle").is_some());

        assert!(
            uses_effort && uses_fast && !uses_custom_style,
            "dedicated options missing: {args:?}"
        );
    }
}

#[then("the main conversation still uses its original model")]
async fn main_model_unchanged(_world: &mut GuiWorld) {
    gui_acceptance::wait_until(
        "main draft reaches the original runtime",
        Duration::from_secs(10),
        || async {
            let turns = captured_turns();
            let main_draft_delivered = turns
                .iter()
                .any(|turn| turn.contains(MAIN_DRAFT) && !turn.starts_with("Context: {"));

            Ok(main_draft_delivered)
        },
    )
    .await
    .unwrap();

    let launches = harness_capture("invocations.jsonl");

    // The original main runtime is already running when fixture capture resets.
    // Sending its next turn must not create a new runtime with the inline model.
    assert_eq!(launches.len(), 1, "main runtime was replaced: {launches:?}");
}

/// Claude stream-json records for one discussion turn: a Read of the selected
/// file, its result, and the answer. Synthetic; the session id is rewritten.
const READ_TOOL_TURN: &str = concat!(
    r#"{"type":"assistant","session_id":"fixture","message":{"id":"msg_read","role":"assistant","model":"claude-sonnet-4","usage":{"input_tokens":12,"output_tokens":3},"content":[{"type":"tool_use","id":"toolu_read_selection","name":"Read","input":{"file_path":"selection.ts"}}]}}"#,
    "\n",
    r#"{"type":"user","session_id":"fixture","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read_selection","content":"const first = 1;\nconst selected = 42;\nconst third = 3;\n"}]}}"#,
    "\n",
    r#"{"type":"assistant","session_id":"fixture","message":{"id":"msg_answer","role":"assistant","model":"claude-sonnet-4","usage":{"input_tokens":30,"output_tokens":9},"content":[{"type":"text","text":"The file declares three constants; the selected line sets selected to 42."}]}}"#,
    "\n",
    r#"{"type":"result","subtype":"success","session_id":"fixture","duration_ms":25,"total_cost_usd":0.0,"is_error":false,"result":"done","num_turns":1}"#,
    "\n",
);

#[given("the inline discussion agent reads the selected file with the Read tool")]
async fn read_tool_fixture(_world: &mut GuiWorld) {
    std::fs::write(gui_acceptance::MOCK_CHAT_TURN_FIXTURE_FILE, READ_TOOL_TURN).unwrap();
}

#[when("I ask the discussion to explain the selected file")]
async fn ask_to_explain(world: &mut GuiWorld) {
    open_comment_dialog(world).await;

    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let input = client
        .find(Locator::Css("[data-testid=diff-comment-draft-input]"))
        .await
        .unwrap();

    input
        .send_keys("Please explain what this file does")
        .await
        .unwrap();
    gui_acceptance::click_when_ready(
        &client,
        Locator::XPath("//button[normalize-space(.)='Discuss inline']"),
        "ask inline question",
    )
    .await;

    let answered = r#"
        const thread = document.querySelector("[data-testid=selection-mini-thread]");
        const status = thread?.querySelector('[role="status"]');

        return !!thread &&
          thread.textContent.includes("The file declares three constants") &&
          status?.textContent === "Reply complete.";
    "#;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);

    loop {
        if client.execute(answered, vec![]).await.unwrap() == json!(true) {
            break;
        }
        if std::time::Instant::now() > deadline {
            let thread = client
                .execute(
                    "return document.querySelector('[data-testid=selection-mini-thread]')?.innerText;",
                    vec![],
                )
                .await;

            panic!(
                "inline discussion did not answer after reading the file; thread: {thread:?}; turns: {:?}; launches: {:?}",
                captured_turns(),
                discussion_launches(),
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[then("the Read tool call renders in the inline thread like the main chat")]
async fn read_tool_rendered(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let rendered = r#"
        const thread = document.querySelector("[data-testid=selection-mini-thread]");
        const messages = thread.querySelector(".selection-mini-messages");
        const transcript = messages.querySelector(".evlog.evlog--bare .thread");
        const tools = messages.querySelectorAll(".tool-activity-group, .evtool");
        const agents = [...messages.querySelectorAll(".evrow--agent")];
        const prose = agents.map(row => row.textContent).join("\n");

        return {
          sharedRenderer: !!transcript,
          toolRows: tools.length,
          answer: prose.includes("The file declares three constants"),
          rawToolMarkup: /tool_use|<invoke|toolu_read_selection|"file_path"/.test(prose),
          askedForPaste: /paste/i.test(prose),
        };
    "#;
    let result = client.execute(rendered, vec![]).await.unwrap();

    assert_eq!(
        result,
        json!({
            "sharedRenderer": true,
            "toolRows": 1,
            "answer": true,
            "rawToolMarkup": false,
            "askedForPaste": false,
        }),
        "inline thread rendering: {result}"
    );
    world.screenshot(&client, "inline-read-tool").await;
}

#[then("the discussion launch exposes only read-only tools")]
async fn read_only_launch(_world: &mut GuiWorld) {
    let launches = discussion_launches();

    assert_eq!(launches.len(), 1, "discussion launches: {launches:#?}");

    let args = &launches[0];

    assert_eq!(flag_values(args, "--tools"), ["Read,Grep,Glob"], "{args:?}");
    assert_eq!(
        flag_values(args, "--mcp-config"),
        [r#"{"mcpServers":{}}"#],
        "{args:?}"
    );
    assert_eq!(
        flag_values(args, "--permission-mode"),
        ["default"],
        "{args:?}"
    );
    for absent in [
        "--plugin-dir",
        "--permission-prompt-tool",
        "--allow-dangerously-skip-permissions",
    ] {
        assert!(!args.iter().any(|arg| arg == absent), "{absent}: {args:?}");
    }
    for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] {
        let exposed = args
            .iter()
            .any(|arg| arg.split(',').any(|item| item == tool));

        assert!(!exposed, "read-only launch exposed {tool}: {args:?}");
    }
}

/// Control only the session transport so waiting, text takeover and failure have
/// explicit milestones. Selection, composers, Markdown, theme CSS and geometry
/// use the real renderer. No production fixture hook is needed.
#[then("inline discussion rows and pending feedback render correctly across themes and widths")]
async fn themed_layout(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;
    let setup_timeout = Duration::from_secs(5);
    let request_timeout = Duration::from_secs(10);

    client.set_window_rect(0, 0, 1280, 1024).await.unwrap();

    let widen_button = Locator::Css("[aria-label='Widen chat panel']");

    if let Ok(button) = client.find(widen_button).await {
        gui_acceptance::wait_actionable(&button).await;
        button.click().await.unwrap();
    }

    let hide_files_button = Locator::Css("[aria-label='Hide files']");

    if let Ok(button) = client.find(hide_files_button).await {
        gui_acceptance::wait_actionable(&button).await;
        button.click().await.unwrap();
    }

    let geometry_settled = r#"
        const panel = document.querySelector('.hc-panel');
        const bounds = panel.getBoundingClientRect();
        const animations = panel.getAnimations({ subtree: true });
        const moving = animations.some(animation => {
          const timing = animation.effect?.getComputedTiming();
          const finite = Number.isFinite(timing?.endTime);

          return animation.playState === 'running' && finite;
        });

        return bounds.width > 1000 && !moving;
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "expanded panel geometry settled",
        geometry_settled,
        vec![],
        setup_timeout,
    )
    .await;
    drop(client);

    gesture(world, false, false).await;
    open_comment_dialog(world).await;

    let client = wd.lock().await;
    let install = r#"
        const done = arguments[arguments.length - 1];
        const bindingsImport = import('/src/bindings.ts');
        const storeImport = import('/src/stores/uiStore.ts');

        Promise.all([bindingsImport, storeImport]).then(([{ commands }, { useUIStore }]) => {
          const uiState = useUIStore.getState();
          const state = {
            commands,
            uiStore: useUIStore,
            previousTheme: uiState.theme,
            create: commands.createLocalChatSession,
            send: commands.sendLocalChatMessage,
            interrupt: commands.interruptLocalChatTurn,
            close: commands.closeLocalChatSession,
            original: window.__TAURI_INTERNALS__.invoke,
            turns: [],
          };

          window.__inlineTransport = state;

          commands.createLocalChatSession = input => {
            if (!input.read_only) return state.create(input);

            return new Promise((resolve, reject) => {
              state.turns.push({ input, resolve, reject });
            });
          };

          const inline = id => state.turns.some(turn => turn.input.backend_session_id === id);

          // Follow-ups are turns sent into the live inline session.
          commands.sendLocalChatMessage = (id, content, settings) => {
            if (!inline(id)) return state.send(id, content, settings);

            return new Promise((resolve, reject) => {
              state.turns.push({ input: { backend_session_id: id, content }, resolve, reject });
            });
          };

          commands.interruptLocalChatTurn = id =>
            inline(id) ? Promise.resolve({ status: 'ok', data: null }) : state.interrupt(id);

          commands.closeLocalChatSession = id => {
            if (inline(id)) {
              return Promise.resolve({ status: 'ok', data: null });
            }

            return state.close(id);
          };

          const style = document.createElement('style');

          style.id = 'inline-freeze-animations';
          style.textContent = `
            .selection-mini-thread *,
            .selection-mini-thread *::before {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.append(style);
          done(true);
        }).catch(error => {
          const message = String(error);

          done(message);
        });
    "#;
    let installed = client.execute_async(install, vec![]).await.unwrap();

    assert_eq!(installed, json!(true));

    let questions = [
        "Initial question\nwith multiple lines",
        "Follow-up\nwithaverylongunbrokentokenthatmustwrapwithoutanyhorizontaloverflowinthecardatnarrowwidths123456789012345678901234567890",
    ];

    for (index, question) in questions.into_iter().enumerate() {
        let selector = if index == 0 {
            "[data-testid=diff-comment-draft-input]"
        } else {
            "[aria-label='Ask about selected code']"
        };
        let input_locator = Locator::Css(selector);
        let input = client.find(input_locator).await.unwrap();

        type_inline_question(&client, &input, question).await;

        let button = if index == 0 { "Discuss inline" } else { "Ask" };
        let xpath = format!("//button[normalize-space(.)='{button}']");
        let button_locator = Locator::XPath(&xpath);

        gui_acceptance::click_when_ready(&client, button_locator, "controlled inline ask").await;

        let waiting = r#"
            const thread = document.querySelector('[data-testid=selection-mini-thread]');
            const questions = thread?.querySelectorAll('.evrow--user .ev-text');
            const question = questions?.[arguments[0] - 1];
            const indicator = thread?.querySelector('[data-testid=thinking-indicator]');
            const turnCount = window.__inlineTransport.turns.length;
            const words = text => text.replace(/\s+/g, ' ').trim();

            return turnCount === arguments[0] && !!question &&
              words(question.textContent) === words(arguments[1]) && !!indicator;
        "#;
        let expected_question = vec![json!(index + 1), json!(question)];

        gui_acceptance::wait_for_js(
            &client,
            "visible pending turn",
            waiting,
            expected_question,
            request_timeout,
        )
        .await;

        let mut colors = Vec::new();

        for theme in ["dark", "light"] {
            for width in [440, 280] {
                let metrics = inline_layout_metrics(&client, theme, width, true).await;

                assert_eq!(metrics["pass"], json!(true), "{theme}/{width}: {metrics}");
                println!("Inline pending layout turn {index}, {theme}/{width}: {metrics}");

                if index == 1 {
                    assert_eq!(
                        metrics["historyScrollable"],
                        json!(true),
                        "follow-up must exercise scrollable history"
                    );
                }

                let background = metrics["background"].clone();
                let screenshot = format!("inline-{index}-{theme}-{width}-pending");

                colors.push(background);
                world.screenshot(&client, &screenshot).await;
            }
        }

        assert_ne!(
            colors[0], colors[2],
            "theme must change the computed transcript color"
        );

        let respond = r#"
            const done = arguments[arguments.length - 1];
            const turn = window.__inlineTransport.turns.at(-1);
            const history = '- Preserved history\n'.repeat(16);
            const text = '**Markdown answer**\n\n' + history;
            const backend_session_id = turn.input.backend_session_id;
            const turn_id = `inline-turn-${window.__inlineTransport.turns.length}`;
            const emit = (event, payload) =>
              window.__inlineTransport.original('plugin:event|emit', { event, payload });
            const payload = {
              backend_session_id,
              harness: 'claude',
              text,
              turn_id,
              // A completed item renders as Markdown, as in the main chat;
              // the turn stays in flight until it is cancelled below.
              is_partial: false,
              is_root: true,
              parent_tool_use_id: null,
            };

            window.__inlineTransport.turnId = turn_id;
            turn.resolve({ status: 'ok', data: null });

            emit('local-chat-turn-started-event', {
              backend_session_id,
              harness: 'claude',
              turn_id,
              is_root: true,
            })
              .then(() => emit('local-chat-text-event', payload))
              .then(() => done(true))
              .catch(error => {
                const message = String(error);

                done(message);
              });
        "#;
        let responded = client.execute_async(respond, vec![]).await.unwrap();

        assert_eq!(responded, json!(true));

        let text_takeover = r#"
            const thread = document.querySelector('[data-testid=selection-mini-thread]');
            const replies = thread.querySelectorAll('.evrow--agent strong');

            return replies.length === arguments[0];
        "#;
        let expected_replies = vec![json!(index + 1)];

        gui_acceptance::wait_for_js(
            &client,
            "Markdown reply renders in the thread",
            text_takeover,
            expected_replies,
            setup_timeout,
        )
        .await;

        // Cancelling a streamed turn permits the next controlled follow-up.
        let cancel_button = Locator::XPath("//button[normalize-space(.)='Cancel response']");

        gui_acceptance::click_when_ready(&client, cancel_button, "finish controlled turn").await;

        // The provider reports the interrupted turn, which settles it.
        let interrupted = r#"
            const done = arguments[arguments.length - 1];
            const state = window.__inlineTransport;
            const turn = state.turns.at(-1);
            const payload = {
              backend_session_id: turn.input.backend_session_id,
              harness: 'claude',
              turn_id: state.turnId,
              is_root: true,
              duration_ms: 1,
              cost_usd: 0,
              num_turns: 1,
              result: '',
              is_error: false,
              context_tokens: 0,
              context_window: 0,
              completion_status: 'interrupted',
            };
            const event = { event: 'local-chat-session-end-event', payload };

            state.original('plugin:event|emit', event)
              .then(() => done(true))
              .catch(error => done(String(error)));
        "#;
        let ended = client.execute_async(interrupted, vec![]).await.unwrap();

        assert_eq!(ended, json!(true));
        gui_acceptance::wait_for_js(
            &client,
            "interrupted turn settles",
            "return !document.querySelector('[data-testid=selection-mini-thread] [data-testid=thinking-indicator]');",
            vec![],
            setup_timeout,
        )
        .await;
    }

    // Measure completed history as well, including assistant alignment/Markdown.
    for theme in ["dark", "light"] {
        for width in [440, 280] {
            let metrics = inline_layout_metrics(&client, theme, width, false).await;

            assert_eq!(metrics["pass"], json!(true), "{theme}/{width}: {metrics}");
            println!("Inline history layout {theme}/{width}: {metrics}");

            let screenshot = format!("inline-{theme}-{width}-history");

            world.screenshot(&client, &screenshot).await;
        }
    }

    let input_locator = Locator::Css("[aria-label='Ask about selected code']");
    let input = client.find(input_locator).await.unwrap();

    type_inline_question(&client, &input, "Show an\nactionable error").await;

    let ask_button = Locator::XPath("//button[normalize-space(.)='Ask']");

    gui_acceptance::click_when_ready(&client, ask_button, "error fixture ask").await;
    gui_acceptance::wait_for_js(
        &client,
        "error turn setup",
        "return window.__inlineTransport.turns.length === 3;",
        vec![],
        setup_timeout,
    )
    .await;

    let reject_turn = r#"
        const turn = window.__inlineTransport.turns.at(-1);

        turn.reject('session unavailable');

        return true;
    "#;

    client.execute(reject_turn, vec![]).await.unwrap();

    let failure_visible = r#"
        const thread = document.querySelector('[data-testid=selection-mini-thread]');
        const alert = thread.querySelector('[role=alert]');
        const indicator = thread.querySelector('[data-testid=thinking-indicator]');

        return !!alert && !indicator;
    "#;

    gui_acceptance::wait_for_js(
        &client,
        "failure clears indicator",
        failure_visible,
        vec![],
        setup_timeout,
    )
    .await;

    for theme in ["dark", "light"] {
        let metrics = inline_layout_metrics(&client, theme, 280, false).await;

        assert_eq!(metrics["pass"], json!(true), "error {theme}: {metrics}");

        let screenshot = format!("inline-{theme}-error");

        world.screenshot(&client, &screenshot).await;
    }

    let cleanup = r#"
        const state = window.__inlineTransport;
        const uiState = state.uiStore.getState();
        const frozenAnimations = document.querySelector('#inline-freeze-animations');

        state.commands.createLocalChatSession = state.create;
        state.commands.sendLocalChatMessage = state.send;
        state.commands.interruptLocalChatTurn = state.interrupt;
        state.commands.closeLocalChatSession = state.close;
        uiState.setTheme(state.previousTheme);

        delete window.__inlineTransport;
        frozenAnimations.remove();

        return true;
    "#;

    client.execute(cleanup, vec![]).await.unwrap();
}

async fn inline_layout_metrics(
    client: &fantoccini::Client,
    theme: &str,
    width: u32,
    pending: bool,
) -> Value {
    let measurement_script = include_str!("selection_discussion_layout.js");
    let frame_script = r#"
        const done = arguments[arguments.length - 1];
        const [theme, width, pending] = arguments;
        const uiState = window.__inlineTransport.uiStore.getState();

        function afterTwoFrames(callback) {
          function afterFirstFrame() {
            requestAnimationFrame(callback);
          }

          requestAnimationFrame(afterFirstFrame);
        }

        function measureAfterThemePaint() {
          function readMetrics() {
            __MEASURE_LAYOUT__
          }

          const result = readMetrics(theme, width, pending);

          function finishAfterLayoutPaint() {
            done(result);
          }

          afterTwoFrames(finishAfterLayoutPaint);
        }

        uiState.setTheme(theme);
        afterTwoFrames(measureAfterThemePaint);
    "#;
    let script = frame_script.replace("__MEASURE_LAYOUT__", measurement_script);
    let arguments = vec![json!(theme), json!(width), json!(pending)];

    client.execute_async(&script, arguments).await.unwrap()
}

async fn type_inline_question(
    client: &fantoccini::Client,
    input: &fantoccini::elements::Element,
    text: &str,
) {
    let lines = text.split('\n');

    for (index, line) in lines.enumerate() {
        if index > 0 {
            let input_source = "inline-newline".to_owned();
            let keys = KeyActions::new(input_source)
                .then(KeyAction::Down { value: '\u{e008}' })
                .then(KeyAction::Down { value: '\u{e007}' })
                .then(KeyAction::Up { value: '\u{e007}' })
                .then(KeyAction::Up { value: '\u{e008}' });

            client.perform_actions(keys).await.unwrap();
            client.release_actions().await.unwrap();
        }

        input.send_keys(line).await.unwrap();
    }
}
