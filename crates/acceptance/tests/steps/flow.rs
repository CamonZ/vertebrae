use std::io::Write;

use cucumber::given;

use crate::SmokeWorld;
use crate::steps::setup::vtb_binary;

/// The committed three-option reference spec (named arrangements).
const THREE_OPTIONS: &str = include_str!(
    "../../../gui/src/components/MachineDiagram/flow/__fixtures__/burstOptions.flow.yaml"
);

/// The committed migration reference spec (phases).
const MIGRATION: &str = include_str!(
    "../../../gui/src/components/MachineDiagram/flow/__fixtures__/sessionMigration.flow.yaml"
);

/// Writes `body` to a temporary `.yaml` file and stores its path as `<name>`.
fn write_spec(world: &mut SmokeWorld, name: String, body: &str) {
    let mut file = tempfile::Builder::new()
        .suffix(".yaml")
        .tempfile()
        .expect("failed to create flow spec file");
    file.write_all(body.as_bytes())
        .expect("failed to write flow spec file");
    let path = file.path().to_string_lossy().to_string();
    world.stored_ids.insert(name, path);
    world.temp_files.push(file);
}

/// Flow validation is offline: point vtb at a backend that is not there, so
/// any request it made would fail the scenario.
#[given("the vtb CLI with no project or reachable backend")]
async fn given_offline_cli(world: &mut SmokeWorld) {
    world.vtb_binary = vtb_binary();
    world
        .env
        .insert("VTB_URL".to_string(), "http://127.0.0.1:9".to_string());
    world
        .env
        .insert("VTB_TOKEN".to_string(), "unused".to_string());
    world
        .env
        .insert("VTB_PROJECT_ID".to_string(), String::new());
}

#[given(expr = "a flow spec file {word} holding the three-option reference spec")]
async fn given_three_options(world: &mut SmokeWorld, name: String) {
    write_spec(world, name, THREE_OPTIONS);
}

#[given(
    expr = "a flow spec file {word} holding the three-option reference spec with {string} replaced by {string}"
)]
async fn given_three_options_edited(
    world: &mut SmokeWorld,
    name: String,
    from: String,
    to: String,
) {
    assert!(
        THREE_OPTIONS.contains(&from),
        "the three-option spec has no {from:?} to replace"
    );
    let body = THREE_OPTIONS.replacen(&from, &to, 1);
    write_spec(world, name, &body);
}

#[given(expr = "a flow spec file {word} holding the migration reference spec")]
async fn given_migration(world: &mut SmokeWorld, name: String) {
    write_spec(world, name, MIGRATION);
}

#[given(
    expr = "a flow spec file {word} holding the migration reference spec with {string} replaced by {string}"
)]
async fn given_migration_edited(world: &mut SmokeWorld, name: String, from: String, to: String) {
    assert!(
        MIGRATION.contains(&from),
        "the migration spec has no {from:?} to replace"
    );
    let body = MIGRATION.replacen(&from, &to, 1);
    write_spec(world, name, &body);
}
