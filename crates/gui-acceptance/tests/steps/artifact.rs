use cucumber::{then, when};
use fantoccini::Locator;
use fantoccini::actions::{InputSource, MouseActions, PointerAction};

use crate::GuiWorld;

fn folder_test_id(folder: &str) -> String {
    format!("artifact-tree-folder-folder:{folder}")
}

fn xpath_literal(value: &str) -> String {
    if !value.contains('\'') {
        return format!("'{value}'");
    }
    if !value.contains('"') {
        return format!("\"{value}\"");
    }

    let parts = value
        .split('\'')
        .map(|part| format!("'{part}'"))
        .collect::<Vec<_>>()
        .join(", \"'\", ");
    format!("concat({parts})")
}

async fn toggle_artifact_folder(world: &mut GuiWorld, folder: &str, action: &str) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let folder_element = client
        .wait()
        .at_most(std::time::Duration::from_secs(10))
        .for_element(Locator::Css(&format!(
            "[data-testid=\"{}\"]",
            folder_test_id(folder)
        )))
        .await
        .unwrap_or_else(|_| panic!("artifact folder '{folder}' was not found"));
    let button = folder_element
        .find(Locator::Css(&format!("button[aria-label=\"{action}\"]")))
        .await
        .unwrap_or_else(|_| panic!("artifact folder '{folder}' is not {action}able"));
    gui_acceptance::wait_actionable(&button).await;
    button
        .click()
        .await
        .unwrap_or_else(|_| panic!("failed to {action} artifact folder '{folder}'"));
    gui_acceptance::wait_for_js(&client, &format!("{action} artifact folder {folder}"),
        "return document.querySelector('[data-testid=' + CSS.escape(arguments[0]) + ']')?.getAttribute('aria-expanded') === arguments[1];",
        vec![folder_test_id(folder).into(), (if action == "Expand" { "true" } else { "false" }).into()],
        std::time::Duration::from_secs(10)).await;
    world
        .screenshot(&client, &format!("after-{action}-artifact-folder-{folder}"))
        .await;
}

#[then(expr = "the artifact tree folder {string} should be expanded within {int} seconds")]
async fn artifact_tree_folder_should_be_expanded(
    world: &mut GuiWorld,
    folder: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let locator = Locator::Css(&format!("[data-testid=\"{}\"]", folder_test_id(&folder)));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    loop {
        if let Ok(element) = client.find(locator).await
            && element
                .attr("aria-expanded")
                .await
                .ok()
                .flatten()
                .as_deref()
                == Some("true")
        {
            world
                .screenshot(
                    &client,
                    &format!("after-assert-expanded-artifact-folder-{folder}"),
                )
                .await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-expanded-artifact-folder-{folder}"))
                .await;
            panic!("artifact folder '{folder}' was not expanded within {timeout} seconds");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[when(expr = "I collapse the artifact tree folder {string}")]
async fn collapse_artifact_tree_folder(world: &mut GuiWorld, folder: String) {
    toggle_artifact_folder(world, &folder, "Collapse").await;
}

#[when(expr = "I expand the artifact tree folder {string}")]
async fn expand_artifact_tree_folder(world: &mut GuiWorld, folder: String) {
    toggle_artifact_folder(world, &folder, "Expand").await;
}

#[then(
    expr = "the artifact tree leaf {string} should show type badge {string} within {int} seconds"
)]
async fn artifact_tree_leaf_should_show_type_badge(
    world: &mut GuiWorld,
    label: String,
    badge: String,
    timeout: u64,
) {
    let wd = world
        .webdriver
        .as_ref()
        .expect("WebDriver session not initialized")
        .clone();
    let client = wd.lock().await;
    let row_locator = Locator::XPath(&format!(
        "//*[@role='treeitem'][.//*[normalize-space(.)={}]]",
        xpath_literal(&label)
    ));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    loop {
        if let Ok(row) = client.find(row_locator).await {
            let row_json = serde_json::to_value(&row).expect("serialize artifact tree row");
            let actual_badge = client
                .execute(
                    "const badge = arguments[0].querySelector('[data-testid^=\"artifact-tree-type-\"]'); return badge?.textContent?.trim() || '';",
                    vec![row_json],
                )
                .await
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned));
            if actual_badge.as_deref() == Some(badge.as_str()) {
                world
                    .screenshot(&client, &format!("after-assert-artifact-type-{label}"))
                    .await;
                return;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            world
                .screenshot(&client, &format!("fail-artifact-type-{label}"))
                .await;
            panic!(
                "artifact tree leaf '{label}' did not show type badge '{badge}' within {timeout} seconds"
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

const STATECHART_GUIDE: &str = include_str!("../../../../docs/agent-context/statecharts.md");
const STATECHART_EXAMPLE: &str =
    include_str!("../../../../docs/agent-context/statecharts-example.md");

/// Execute the published command tokens, replacing only fixture variables.
/// No shell expansion: the only substitutions are the actual ticket/artifact IDs.
fn statechart_command(prefix: &str, ticket: &str, artifact: &str) -> Vec<String> {
    let command = STATECHART_GUIDE
        .lines()
        .find(|line| line.starts_with(prefix))
        .expect("published statechart command");

    command
        .split_whitespace()
        .skip(1)
        .map(|token| match token {
            "\"$TICKET_ID\"" => ticket.to_string(),
            "\"$ARTIFACT_ID\"" => artifact.to_string(),
            value => value.to_string(),
        })
        .collect()
}

async fn run_statechart_command(world: &mut GuiWorld, args: &[String]) {
    let project = world.temp_dir.as_ref().expect("isolated project");
    let output = tokio::process::Command::new(&world.vtb_binary)
        .args(args)
        .current_dir(project)
        .envs(&world.env)
        .output()
        .await
        .expect("execute documented statechart command");

    world.last_stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    world.last_stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    world.last_exit_code = output.status.code().unwrap_or(-1);
}

#[when("I save and attach the published statechart example and configure its chat link")]
async fn published_statechart(world: &mut GuiWorld) {
    let blocks: Vec<&str> = STATECHART_EXAMPLE
        .split("```json\n")
        .skip(1)
        .map(|part| {
            let mut lines = part.split("\n```");

            lines.next().expect("closed JSON fence")
        })
        .collect();

    assert_eq!(blocks.len(), 2);

    let body = blocks[0];
    let metadata = blocks[1];
    let project = world.temp_dir.as_ref().expect("isolated project");
    let body_path = project.join("workflow.statechart.json");
    let metadata_path = project.join("workflow.metadata.json");

    std::fs::write(body_path, body).unwrap();
    std::fs::write(metadata_path, metadata).unwrap();

    let ticket = world.task_id.as_ref().expect("fixture ticket").clone();
    let args = statechart_command("vtb --json artifact add", &ticket, "");

    run_statechart_command(world, &args).await;

    assert_eq!(
        world.last_exit_code, 0,
        "{}{}",
        world.last_stdout, world.last_stderr
    );

    let created: serde_json::Value = serde_json::from_str(&world.last_stdout).unwrap();
    let id = created["artifact_id"]
        .as_str()
        .expect("returned artifact ID")
        .to_string();
    let tracked_id = id.clone();
    let expected_metadata: serde_json::Value = serde_json::from_str(metadata).unwrap();

    world.track_artifact(tracked_id);

    for prefix in ["vtb --json artifact lookup", "vtb --json artifact show"] {
        let args = statechart_command(prefix, &ticket, &id);

        run_statechart_command(world, &args).await;

        assert_eq!(
            world.last_exit_code, 0,
            "{}{}",
            world.last_stdout, world.last_stderr
        );

        let stored: serde_json::Value = serde_json::from_str(&world.last_stdout).unwrap();

        assert_eq!(stored["id"], id);
        assert_eq!(stored["body"], body);

        if prefix.ends_with("lookup") {
            assert_eq!(stored["metadata"], expected_metadata);
        }
    }

    world
        .run_vtb(&["--json", "artifact", "list", "--task-id", &ticket])
        .await;

    assert_eq!(world.last_exit_code, 0);

    let attached: serde_json::Value = serde_json::from_str(&world.last_stdout).unwrap();
    let attachments = attached.as_array().unwrap();
    let has_ticket_attachment = attachments
        .iter()
        .any(|artifact| artifact["id"] == id && artifact["logical_name"] == "workflow-statechart");

    assert!(has_ticket_attachment);

    let response = format!("[Ticket delivery](vtb://artifact/{id})");

    std::fs::write(gui_acceptance::MOCK_CHAT_RESPONSE_FILE, response).unwrap();
}

#[then("the real chat statechart shows its hierarchy and transitions")]
async fn chat_statechart(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    client.set_window_size(1280, 1024).await.unwrap();

    let widen_selector = Locator::Css("button[aria-label='Widen chat panel']");

    if let Ok(widen) = client.find(widen_selector).await {
        gui_acceptance::wait_actionable(&widen).await;
        widen.click().await.unwrap();
    }

    let ready_probe = r#"
        const viewer = document.querySelector('[data-testid="statechart-viewer"]');

        return !!viewer?.querySelector('svg[data-testid="native-statechart-svg"]');
    "#;
    let timeout = std::time::Duration::from_secs(20);

    gui_acceptance::wait_for_js(
        &client,
        "native XState viewer in chat",
        ready_probe,
        vec![],
        timeout,
    )
    .await;

    let fit_selector = Locator::Css("button[aria-label='Fit statechart']");
    gui_acceptance::click_when_ready(&client, fit_selector, "fit native statechart").await;

    let inspect_svg = r#"
        const viewer = document.querySelector('[data-testid="statechart-viewer"]');
        const svg = viewer.querySelector('svg');
        const textNodes = [...svg.querySelectorAll('text')];
        const textValues = textNodes.map(node => node.textContent);
        const text = textValues.join(' ');
        const labels = [
            'Work', 'Implement', 'Verify', 'Tests', 'Running', 'Passed',
            'Review', 'Pending', 'Approved', 'Ready', 'Done',
            'ACCEPT', 'READY', 'RETRY', 'CHANGES', 'done', 'PASS', 'APPROVE'
        ];
        const nodes = [...svg.querySelectorAll('[data-state-id]')];
        const edges = [...svg.querySelectorAll('[data-transition-id]')];
        const state = id => nodes.find(node => node.getAttribute('data-state-id') === id);
        const bounds = id => state(id)?.querySelector('[data-state-boundary]')?.getBoundingClientRect();
        const work = bounds('delivery.Work');
        const implement = bounds('delivery.Work.Implement');
        const verify = bounds('delivery.Work.Verify');
        const tests = bounds('delivery.Work.Verify.Tests');
        const review = bounds('delivery.Work.Verify.Review');
        const done = bounds('delivery.Done');
        const rectangles = [work, implement, verify, tests, review, done];
        const valid = rectangles.every(rectangle => rectangle && rectangle.width > 0 && rectangle.height > 0);
        const inside = (child, parent) =>
            !!child && !!parent && child.left >= parent.left - 1 && child.right <= parent.right + 1 &&
            child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
        const containment = valid && inside(implement, work) && inside(verify, work) &&
            inside(tests, verify) && inside(review, verify) && !inside(done, work);

        const semanticEdges = edges.filter(edge => !edge.hasAttribute('data-initial'));
        const colors = semanticEdges.map(edge => getComputedStyle(edge.querySelector('path')).stroke);
        const colorCount = new Set(colors).size;
        const matchingArrows = semanticEdges.every(edge => {
            const path = edge.querySelector('path');
            const reference = path.getAttribute('marker-end');
            const marker = document.getElementById(reference.slice(5, -1));
            const arrow = marker.querySelector('path');

            return getComputedStyle(path).stroke === getComputedStyle(arrow).stroke;
        });
        const transitions = semanticEdges.map(edge => [
            edge.getAttribute('data-source'), edge.getAttribute('data-event'), edge.getAttribute('data-target')
        ].join('/')).sort();
        const initialCount = edges.filter(edge => edge.hasAttribute('data-initial')).length;
        const visibleLabels = labels.filter(label => text.includes(label));
        const parallel = state('delivery.Work.Verify')?.getAttribute('data-state-type');
        const final = state('delivery.Done')?.getAttribute('data-state-type');
        const finalMarkers = svg.querySelectorAll('[aria-label="Final state marker"]').length;

        const endpoints = edges.every(edge => {
            const path = edge.querySelector('path');
            const length = path.getTotalLength();
            const point = path.getPointAtLength(length);
            const local = svg.createSVGPoint();
            local.x = point.x;
            local.y = point.y;
            const screen = local.matrixTransform(path.getScreenCTM());
            const target = bounds(edge.getAttribute('data-target'));

            return target && screen.x >= target.left - 3 && screen.x <= target.right + 3 &&
                screen.y >= target.top - 3 && screen.y <= target.bottom + 3;
        });

        return {
            labels: visibleLabels, transitions, initialCount, containment,
            parallel, final, finalMarkers, endpoints, colorCount, matchingArrows,
            iframeCount: viewer.querySelectorAll('iframe').length,
            svg: svg.outerHTML
        };
    "#;
    let observed = client.execute(inspect_svg, vec![]).await.unwrap();
    let observed_json = serde_json::to_string_pretty(&observed).unwrap();
    let svg = observed["svg"].as_str().unwrap();

    std::fs::write("/app/test-output/statechart-rendered.svg", svg).unwrap();
    std::fs::write("/app/test-output/statechart-observed.json", observed_json).unwrap();

    let verify_label = Locator::Css("[data-state-id='delivery.Work.Verify'] text");
    gui_acceptance::click_when_ready(&client, verify_label, "inspect parallel state").await;
    let selection_probe = r#"
        const inspector = document.querySelector('[data-testid="statechart-inspection"]');

        return inspector?.textContent.includes('delivery.Work.Verify') &&
            inspector.textContent.includes('All child regions are active together.');
    "#;
    gui_acceptance::wait_for_js(
        &client,
        "parallel state inspection",
        selection_probe,
        vec![],
        timeout,
    )
    .await;

    let zoom_probe = r#"
        return document.querySelector('[data-testid="statechart-viewer"] svg').getAttribute('width');
    "#;
    let selection_style = r#"
        const node = document.querySelector('[data-state-id="delivery.Work.Verify"]');
        const boundary = node.querySelector('[data-state-boundary]');

        return { stroke: boundary.getAttribute('stroke'), width: boundary.getAttribute('stroke-width') };
    "#;
    let selected_style = client.execute(selection_style, vec![]).await.unwrap();

    assert_eq!(selected_style["stroke"], "var(--color-fg-soft)");
    assert_eq!(selected_style["width"], "2");

    let before_zoom = client.execute(zoom_probe, vec![]).await.unwrap();
    let zoom_selector = Locator::Css("button[aria-label='Zoom in statechart']");
    gui_acceptance::click_when_ready(&client, zoom_selector, "zoom native statechart").await;
    let after_zoom = client.execute(zoom_probe, vec![]).await.unwrap();

    assert_ne!(before_zoom, after_zoom);

    let fit_selector = Locator::Css("button[aria-label='Fit statechart']");
    gui_acceptance::click_when_ready(&client, fit_selector, "restore statechart overview").await;
    exercise_statechart_viewport(&client).await;
    world.screenshot(&client, "statechart-real-chat").await;

    let expected_labels = serde_json::json!([
        "Work",
        "Implement",
        "Verify",
        "Tests",
        "Running",
        "Passed",
        "Review",
        "Pending",
        "Approved",
        "Ready",
        "Done",
        "ACCEPT",
        "READY",
        "RETRY",
        "CHANGES",
        "done",
        "PASS",
        "APPROVE"
    ]);
    let mut expected_edges = vec![
        "delivery.Work/ACCEPT/delivery.Done",
        "delivery.Work.Implement/READY/delivery.Work.Verify",
        "delivery.Work.Implement/RETRY/delivery.Work.Implement",
        "delivery.Work.Verify/CHANGES/delivery.Work.Implement",
        "delivery.Work.Verify/done/delivery.Work.Ready",
        "delivery.Work.Verify.Tests.Running/PASS/delivery.Work.Verify.Tests.Passed",
        "delivery.Work.Verify.Review.Pending/APPROVE/delivery.Work.Verify.Review.Approved",
    ];
    expected_edges.sort_unstable();
    let expected_transitions = serde_json::json!(expected_edges);

    assert_eq!(
        observed["labels"], expected_labels,
        "visible native statechart labels: {observed}"
    );
    assert_eq!(
        observed["transitions"], expected_transitions,
        "native edge endpoints: {observed}"
    );
    assert_eq!(observed["initialCount"], 4);
    assert_eq!(observed["parallel"], "parallel");
    assert_eq!(observed["final"], "final");
    assert_eq!(observed["finalMarkers"], 3);
    assert_eq!(observed["iframeCount"], 0);
    assert_eq!(observed["colorCount"], 7);
    assert_eq!(observed["matchingArrows"], true);
    assert_eq!(
        observed["containment"], true,
        "compound and parallel containment: {observed}"
    );
    assert_eq!(
        observed["endpoints"], true,
        "visible paths reach their actual target states: {observed}"
    );
}

async fn drag_statechart(client: &fantoccini::Client, selector: &str, dx: i64, dy: i64) {
    let point_script = r#"
        const element = document.querySelector(arguments[0]);
        const bounds = element.getBoundingClientRect();

        return [Math.round(bounds.left + bounds.width / 2), Math.round(bounds.top + bounds.height / 2)];
    "#;
    let selector_value = serde_json::json!(selector);
    let point = client
        .execute(point_script, vec![selector_value])
        .await
        .unwrap();
    let x = point[0].as_i64().unwrap();
    let y = point[1].as_i64().unwrap();
    let duration = std::time::Duration::from_millis(200);
    let actions = MouseActions::new("statechart-viewport".into())
        .then(PointerAction::MoveTo {
            duration: None,
            x,
            y,
        })
        .then(PointerAction::Down { button: 0 })
        .then(PointerAction::MoveTo {
            duration: Some(duration),
            x: x + dx,
            y: y + dy,
        })
        .then(PointerAction::Up { button: 0 });

    client.perform_actions(actions).await.unwrap();
    client.release_actions().await.unwrap();
}

async fn exercise_statechart_viewport(client: &fantoccini::Client) {
    let viewport_probe = r#"
        const viewer = document.querySelector('[data-testid="statechart-viewer"]');
        const canvas = viewer.querySelector('[aria-label="Scrollable statechart canvas"]');
        const bounds = viewer.getBoundingClientRect();
        const parent = viewer.parentElement.getBoundingClientRect();
        const svg = viewer.querySelector('svg').getBoundingClientRect();
        const inspector = viewer.querySelector('[data-testid="statechart-inspection"]');
        const handle = viewer.querySelector('[aria-label="Resize statechart"]');

        return { width: bounds.width, height: bounds.height,
            centered: Math.abs(bounds.left + bounds.right - parent.left - parent.right) < 2,
            widthRatio: bounds.width / parent.width,
            noHorizontalOverflow: canvas.scrollWidth <= canvas.clientWidth + 1,
            left: svg.left, top: svg.top, selection: inspector.textContent,
            sharedGrip: handle.classList.contains('evdiff-handle') &&
                getComputedStyle(handle, '::after').width === '32px' };
    "#;
    let before_resize = client.execute(viewport_probe, vec![]).await.unwrap();
    let ratio = before_resize["widthRatio"].as_f64().unwrap();

    assert!(
        ratio <= 0.901 && ratio >= 0.899,
        "90% width: {before_resize}"
    );
    assert_eq!(before_resize["centered"], true);
    assert_eq!(before_resize["sharedGrip"], true);

    let handle = "[role='separator'][aria-label='Resize statechart']";
    drag_statechart(client, handle, 0, 60).await;
    let after_resize = client.execute(viewport_probe, vec![]).await.unwrap();
    let width_delta =
        after_resize["width"].as_f64().unwrap() - before_resize["width"].as_f64().unwrap();
    let height_delta =
        after_resize["height"].as_f64().unwrap() - before_resize["height"].as_f64().unwrap();

    assert!(
        width_delta.abs() < 2.0,
        "fixed centered width: {before_resize} -> {after_resize}"
    );
    assert!(
        (height_delta - 60.0).abs() < 2.0,
        "vertical resize: {before_resize} -> {after_resize}"
    );

    let fit = Locator::Css("button[aria-label='Fit statechart']");
    gui_acceptance::click_when_ready(client, fit, "fit chart before panning without overflow")
        .await;
    let fitted = client.execute(viewport_probe, vec![]).await.unwrap();

    assert_eq!(
        fitted["noHorizontalOverflow"], true,
        "regression requires a fitted chart: {fitted}"
    );

    // Cross the origin in both directions while no horizontal scrollbar exists.
    for (dx, dy) in [(-80, -80), (160, 160), (-80, -80)] {
        let before_pan = client.execute(viewport_probe, vec![]).await.unwrap();
        let canvas = "[aria-label='Scrollable statechart canvas']";
        drag_statechart(client, canvas, dx, dy).await;
        let after_pan = client.execute(viewport_probe, vec![]).await.unwrap();
        let left_delta = after_pan["left"].as_f64().unwrap() - before_pan["left"].as_f64().unwrap();
        let top_delta = after_pan["top"].as_f64().unwrap() - before_pan["top"].as_f64().unwrap();

        assert!(
            (left_delta - dx as f64).abs() < 2.0,
            "horizontal pan: {before_pan} -> {after_pan}"
        );
        assert!(
            (top_delta - dy as f64).abs() < 2.0,
            "vertical pan: {before_pan} -> {after_pan}"
        );
        assert_eq!(
            before_pan["selection"], after_pan["selection"],
            "drag must not select another state"
        );
    }

    gui_acceptance::click_when_ready(client, fit, "reset panning and fit resized chart").await;
}
