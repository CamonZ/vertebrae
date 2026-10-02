//! Rhai content and relationship edit steps for `execute_task_edits.feature`:
//! fixtures only the CLI can build, such as a removed section, and the
//! checklist sample from the execute agent docs.

use cucumber::given;

use super::execute::fenced_block;
use super::host_reads::{id, install_rhai_step, vtb_ok};
use crate::DaemonWorld;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-edits.md");

/// Sacrum numbers checklist items 0, 1 and 2; removing item 0 leaves the
/// others at 1 and 2, which is what Rhai edits must keep addressing.
#[given(expr = "{word} has checklist items one, two and three, and the CLI removed the first")]
async fn removed_first_item(world: &mut DaemonWorld, role: String) {
    let task_id = id(world, &role);
    for content in ["one", "two", "three"] {
        vtb_ok(
            world,
            "section add",
            &["section", &task_id, "checklist_item", content],
        )
        .await;
    }
    vtb_ok(
        world,
        "remove section",
        &[
            "update",
            &task_id,
            "--remove-section",
            "checklist_item",
            "0",
        ],
    )
    .await;
}

/// The doc's first `rhai` block, run twice in one script so the second run
/// sees what the first wrote.
#[given("the documented checklist sample running twice on SELF")]
async fn documented_checklist_twice(world: &mut DaemonWorld) {
    let sample = fenced_block(DOC, "host-edits.md", "rhai");
    let script = format!(
        "let first = {{\n{sample}\n}};\nlet second = {{\n{sample}\n}};\n#{{ first: first, second: second }}"
    );
    install_rhai_step(world, &script).await;
}
