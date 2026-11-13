use cucumber::{then, when};
use fantoccini::{
    Locator,
    actions::{InputSource, KeyAction, KeyActions, MouseActions, PointerAction},
};

use crate::GuiWorld;

/// The committed three-option reference spec (named arrangements).
const THREE_OPTIONS: &str = include_str!(
    "../../../gui/src/components/MachineDiagram/flow/__fixtures__/burstOptions.flow.yaml"
);

const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

#[when("I configure the mock local chat reply as the three-option flow spec")]
async fn mock_reply_three_options(_world: &mut GuiWorld) {
    let reply = format!("Three ways to take a burst:\n\n```flow\n{THREE_OPTIONS}```\n");
    std::fs::write(gui_acceptance::MOCK_CHAT_RESPONSE_FILE, reply)
        .expect("write mock local chat response");
}

/// What the player shows: arrangement, beat, the selector's labels and the
/// checked one, the pinned part, and where each drawn part is.
const OBSERVE: &str = r#"
    const player = document.querySelector('[data-testid="flow-player"]');
    if (!player) return null;
    const group = player.querySelector('[role="radiogroup"][aria-label="Arrangement"]');
    const radios = group ? [...group.querySelectorAll('[role="radio"]')] : [];
    const inspector = document.querySelector('[data-testid="flow-part-inspector"]');
    const parts = {};
    for (const g of player.querySelectorAll('svg g.md-part[data-part-id]'))
        parts[g.getAttribute('data-part-id')] = g.getAttribute('transform');
    return JSON.stringify({
        arrangement: player.getAttribute('data-arrangement'),
        beat: player.getAttribute('data-beat'),
        labels: radios.map((r) => r.textContent.trim()),
        checked: radios.find((r) => r.getAttribute('aria-checked') === 'true')?.textContent.trim() ?? null,
        pinned: inspector && inspector.textContent.includes('pinned')
            ? inspector.getAttribute('data-part-id') : null,
        parts,
    });
"#;

async fn observe(client: &fantoccini::Client) -> serde_json::Value {
    let raw = client
        .execute(OBSERVE, vec![])
        .await
        .expect("observe player");
    serde_json::from_str(raw.as_str().expect("player is rendered")).unwrap()
}

/// Wait until the player shows `arrangement` at beat `beat`.
async fn wait_shows(client: &fantoccini::Client, arrangement: &str, beat: &str) {
    gui_acceptance::wait_for_js(
        client,
        &format!("the player on {arrangement} at beat {beat}"),
        r#"const [arrangement, beat] = arguments;
        const player = document.querySelector('[data-testid="flow-player"]');
        return player?.getAttribute('data-arrangement') === arrangement &&
            player?.getAttribute('data-beat') === beat &&
            !player.hasAttribute('data-morph');"#,
        vec![arrangement.into(), beat.into()],
        WAIT,
    )
    .await;
}

async fn click(client: &fantoccini::Client, css: &str, what: &str) {
    gui_acceptance::click_when_ready(client, Locator::Css(css), what).await;
}

/// Click a diagram part with the real pointer, at the middle of its hit area
/// once it has stopped moving and nothing covers it. (WebDriver's element
/// click does not reach SVG groups in WebKitGTK.) Nothing is scrolled: the
/// diagram frame clips its stage, so scrolling it would show what no user
/// can reach.
async fn click_part(client: &fantoccini::Client, id: &str) {
    let point = std::cell::Cell::new(None);
    gui_acceptance::wait_until(&format!("the {id} part, settled"), WAIT, || async {
        let at = client
            .execute(
                r#"const g = document.querySelector(
                    `[data-testid="flow-player"] svg g.md-part[data-part-id="${arguments[0]}"]`);
                const hit = g?.querySelector(':scope > .md-part-hit');
                if (!hit) return null;
                const r = hit.getBoundingClientRect();
                const [x, y] = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
                return g.contains(document.elementFromPoint(x, y)) ? [x, y] : null;"#,
                vec![id.into()],
            )
            .await
            .map_err(|e| e.to_string())?;
        let now = at
            .as_array()
            .map(|xy| (xy[0].as_i64().unwrap(), xy[1].as_i64().unwrap()));
        // Settled: the same point on two probes in a row.
        Ok(now.is_some() && point.replace(now) == now)
    })
    .await
    .unwrap_or_else(|error| panic!("{error}"));
    let (x, y) = point.get().unwrap();
    let pointer = MouseActions::new("flow-part".into())
        .then(PointerAction::MoveTo {
            duration: None,
            x,
            y,
        })
        .then(PointerAction::Down { button: 0 })
        .then(PointerAction::Up { button: 0 });
    client
        .perform_actions(pointer)
        .await
        .expect("click the part");
    client.release_actions().await.expect("release the pointer");
}

/// ⇧B on the focused player, with Shift really held (typing "B" through
/// send_keys reaches WebKitGTK without the Shift modifier).
async fn press_shift_b(client: &fantoccini::Client) {
    client
        .execute(
            "document.querySelector('[data-testid=\"flow-player\"]').focus(); return true;",
            vec![],
        )
        .await
        .expect("focus the player");
    let shift = '\u{e008}';
    let keys = KeyActions::new("flow-shift-b".into())
        .then(KeyAction::Down { value: shift })
        .then(KeyAction::Down { value: 'B' })
        .then(KeyAction::Up { value: 'B' })
        .then(KeyAction::Up { value: shift });
    client.perform_actions(keys).await.expect("press shift+B");
    client.release_actions().await.expect("release shift");
}

/// Send `keys` to the player itself (its own keyboard shortcuts).
async fn press_on_player(client: &fantoccini::Client, keys: &str) {
    client
        .execute(
            "document.querySelector('[data-testid=\"flow-player\"]').focus(); return true;",
            vec![],
        )
        .await
        .expect("focus the player");
    let player = client
        .find(Locator::Css("[data-testid='flow-player']"))
        .await
        .expect("flow player");
    player
        .send_keys(keys)
        .await
        .expect("send keys to the player");
}

#[then("the real chat flow player switches between the three options by pointer and key")]
async fn three_options_switch(world: &mut GuiWorld) {
    let wd = world.webdriver.as_ref().unwrap().clone();
    let client = wd.lock().await;

    client.set_window_size(1280, 1024).await.unwrap();
    if let Ok(widen) = client
        .find(Locator::Css("button[aria-label='Widen chat panel']"))
        .await
    {
        gui_acceptance::wait_actionable(&widen).await;
        widen.click().await.unwrap();
    }

    // The selector lists every arrangement by label and opens on the first option.
    wait_shows(&client, "A", "0").await;
    let first = observe(&client).await;
    assert_eq!(
        first["labels"],
        serde_json::json!(["Current", "A · limit + queue", "B · queue + journal"]),
        "{first}"
    );
    assert_eq!(first["checked"], "A · limit + queue", "{first}");
    world.screenshot(&client, "flow-options-a").await;

    // Beat 2, the api pinned.
    click(
        &client,
        "[data-testid='flow-player'] button[aria-label='Next beat']",
        "next beat",
    )
    .await;
    wait_shows(&client, "A", "1").await;
    click_part(&client, "api").await;
    gui_acceptance::wait_for_js(
        &client,
        "the api pinned",
        r#"const i = document.querySelector('[data-testid="flow-part-inspector"]');
        return i?.getAttribute('data-part-id') === 'api' && i.textContent.includes('pinned');"#,
        vec![],
        WAIT,
    )
    .await;
    let at_a = observe(&client).await;

    // By pointer: B keeps the beat, the pin and every shared part's place.
    click(
        &client,
        "[data-testid='flow-player'] [role='radiogroup'][aria-label='Arrangement'] [role='radio']:nth-child(3)",
        "the B option",
    )
    .await;
    wait_shows(&client, "B", "1").await;
    let at_b = observe(&client).await;
    assert_eq!(at_b["checked"], "B · queue + journal", "{at_b}");
    assert_eq!(at_b["pinned"], "api", "{at_b}");
    for id in ["client", "api", "buffer", "parked"] {
        assert_eq!(
            at_b["parts"][id], at_a["parts"][id],
            "{id} moved: {at_a} → {at_b}"
        );
    }
    world.screenshot(&client, "flow-options-b").await;

    // By key: b steps on to current, ⇧B back to B, each keeping beat and pin.
    press_on_player(&client, "b").await;
    wait_shows(&client, "current", "1").await;
    let at_current = observe(&client).await;
    assert_eq!(at_current["checked"], "Current", "{at_current}");
    assert_eq!(at_current["pinned"], "api", "{at_current}");
    assert_eq!(
        at_current["parts"]["api"], at_a["parts"]["api"],
        "{at_current}"
    );
    world.screenshot(&client, "flow-options-current").await;

    press_shift_b(&client).await;
    wait_shows(&client, "B", "1").await;
    assert_eq!(observe(&client).await["pinned"], "api");
}
