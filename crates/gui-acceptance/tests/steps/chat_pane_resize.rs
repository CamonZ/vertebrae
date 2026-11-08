use cucumber::then;
use fantoccini::Locator;
use fantoccini::actions::{InputSource, MouseActions, PointerAction};
use serde_json::{Value, json};
use std::time::Duration;

use crate::GuiWorld;

const GEOMETRY: &str = r#"
const slots = [...document.querySelectorAll('.hc-chat-pane-slot')];
const widths = slots.map(slot => {
    const bounds = slot.getBoundingClientRect();

    return bounds.width;
});

const separators = document.querySelectorAll('.hc-pane-resize-handle');
const separatorIndex = arguments[0] || 0;
const handle = separators[separatorIndex]?.getBoundingClientRect();
const panel = document.querySelector('.hc-panel').getBoundingClientRect();
const history = document.querySelector('.hc-mini-history')?.getBoundingClientRect();

return {
    widths,
    x: handle ? Math.round(handle.x + handle.width / 2) : 0,
    y: handle ? Math.round(handle.y + handle.height / 2) : 0,
    panel: panel.width,
    history: history?.width || 0
};
"#;

const MEASURED_PANES: &str = r#"
const panes = document.querySelectorAll('.hc-chat-pane-slot');
const hasExpectedCount = panes.length === arguments[0];
const hasUsableWidths = [...panes].every(pane => {
    const bounds = pane.getBoundingClientRect();

    return bounds.width > 400;
});

return hasExpectedCount && hasUsableWidths;
"#;

const SNAPSHOT_COMPOSERS: &str = r#"
const inputs = [...document.querySelectorAll('[data-testid="local-chat-composer"]')];

window.paneResizeSnapshot = {
    focus: document.activeElement,
    inputs,
    draft: document.activeElement.value
};
"#;

const COMPOSERS_PRESERVED: &str = r#"
const snapshot = window.paneResizeSnapshot;
const inputs = [...document.querySelectorAll('[data-testid="local-chat-composer"]')];
const focusPreserved = snapshot.focus === document.activeElement;
const draftPreserved = snapshot.draft === document.activeElement.value;
const instancesPreserved = inputs.every((input, index) => input === snapshot.inputs[index]);

return focusPreserved && draftPreserved && instancesPreserved;
"#;

fn widths(value: &Value) -> Vec<f64> {
    let values = value["widths"].as_array().unwrap();

    values.iter().map(|width| width.as_f64().unwrap()).collect()
}

#[then("split chat boundaries preserve real geometry and keyboard resizing")]
async fn split_chat_geometry(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    client.set_window_size(1600, 1000).await.unwrap();

    let expand_button = Locator::Css("button[title='Widen chat panel']");
    gui_acceptance::click_when_ready(&client, expand_button, "expand chat").await;

    for count in [2, 3] {
        let split_button = Locator::Css("button[aria-label='Split chat pane']");
        gui_acceptance::click_when_ready(&client, split_button, "split chat").await;

        let pane_count_args = vec![json!(count)];
        let measurement_timeout = Duration::from_secs(10);

        gui_acceptance::wait_for_js(
            &client,
            "measured split panes",
            MEASURED_PANES,
            pane_count_args,
            measurement_timeout,
        )
        .await;

        let composer_selector = Locator::Css("[data-testid='local-chat-composer']");
        let composer = client.find(composer_selector).await.unwrap();

        composer.send_keys("resize draft").await.unwrap();
        client.execute(SNAPSHOT_COMPOSERS, vec![]).await.unwrap();

        for boundary in 0..count - 1 {
            for delta in [32, -32] {
                let boundary_args = vec![json!(boundary)];
                let before = client.execute(GEOMETRY, boundary_args).await.unwrap();
                let x = before["x"].as_i64().unwrap();
                let y = before["y"].as_i64().unwrap();
                let drag_duration = Duration::from_millis(200);

                let actions = MouseActions::new("pane-boundary".into())
                    .then(PointerAction::MoveTo {
                        duration: None,
                        x,
                        y,
                    })
                    .then(PointerAction::Down { button: 0 })
                    .then(PointerAction::MoveTo {
                        duration: Some(drag_duration),
                        x: x + delta,
                        y: y + 40,
                    })
                    .then(PointerAction::Up { button: 0 });

                client.perform_actions(actions).await.unwrap();
                client.release_actions().await.unwrap();

                let boundary_args = vec![json!(boundary)];
                let after = client.execute(GEOMETRY, boundary_args).await.unwrap();
                let before_widths = widths(&before);
                let after_widths = widths(&after);
                let left_delta = after_widths[boundary] - before_widths[boundary];
                let right_delta = after_widths[boundary + 1] - before_widths[boundary + 1];
                let expected_delta = delta as f64;

                assert!(
                    (left_delta - expected_delta).abs() < 1.0,
                    "before={before}, after={after}"
                );
                assert!((right_delta + expected_delta).abs() < 1.0);

                for neighbor in 0..count {
                    if neighbor != boundary && neighbor != boundary + 1 {
                        let neighbor_delta = after_widths[neighbor] - before_widths[neighbor];

                        assert!(neighbor_delta.abs() < 1.0);
                    }
                }

                assert_eq!(before["panel"], after["panel"]);
                assert_eq!(before["history"], after["history"]);
                println!("pane boundary {boundary}, drag {delta}: before={before}, after={after}");

                let preserved = client.execute(COMPOSERS_PRESERVED, vec![]).await.unwrap();

                assert_eq!(
                    preserved,
                    json!(true),
                    "drag preserves composer instances, draft and focus"
                );
            }
        }

        let handle_selector = Locator::Css(".hc-pane-resize-handle");
        let handle = client.find(handle_selector).await.unwrap();
        let before = client.execute(GEOMETRY, vec![]).await.unwrap();
        let before_widths = widths(&before);

        handle.send_keys("\u{e014}").await.unwrap(); // Right arrow

        let after = client.execute(GEOMETRY, vec![]).await.unwrap();
        let after_widths = widths(&after);
        let keyboard_delta = after_widths[0] - before_widths[0];

        assert!((keyboard_delta - 16.0).abs() < 1.0);

        handle.send_keys("\u{e011}").await.unwrap(); // Home

        let home = client.execute(GEOMETRY, vec![]).await.unwrap();
        let home_widths = widths(&home);

        assert!((home_widths[0] - 360.0).abs() < 1.0);

        handle.send_keys("\u{e010}").await.unwrap(); // End

        let end = client.execute(GEOMETRY, vec![]).await.unwrap();
        let end_widths = widths(&end);

        assert!((end_widths[1] - 360.0).abs() < 1.0);

        let screenshot_name = format!("chat-pane-resize-{count}");

        world.screenshot(&client, &screenshot_name).await;
    }
}
