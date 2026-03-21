use cucumber::when;

use crate::SmokeWorld;

#[when(expr = "I add a ref {string}")]
async fn add_ref(world: &mut SmokeWorld, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["ref", &task_id, &file_spec]).await;
}

#[when(expr = "I add a ref {string} with:")]
async fn add_ref_with_table(
    world: &mut SmokeWorld,
    file_spec: String,
    step: &cucumber::gherkin::Step,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let table = step.table.as_ref().expect("expected a data table");

    let mut args: Vec<String> = vec!["ref".to_string(), task_id, file_spec];

    for row in &table.rows {
        let key = row[0].as_str();
        let value = row[1].as_str();
        match key {
            "name" => {
                args.push("--name".to_string());
                args.push(value.to_string());
            }
            "description" => {
                args.push("--description".to_string());
                args.push(value.to_string());
            }
            other => panic!("unsupported table key in add ref: '{}'", other),
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;
}

#[when("I list refs")]
async fn list_refs(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["refs", &task_id]).await;
}

#[when(expr = "I unref {string}")]
async fn unref_by_file(world: &mut SmokeWorld, file: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["unref", &task_id, &file]).await;
}

#[when("I unref --all")]
async fn unref_all(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["unref", &task_id, "--all"]).await;
}

#[when(expr = "I add a criterion-ref {int} {string}")]
async fn add_criterion_ref(world: &mut SmokeWorld, index: i32, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let index_str = index.to_string();
    world
        .run_vtb(&["criterion-ref", &task_id, &index_str, &file_spec])
        .await;
}

#[when(expr = "I add a criterion-ref {int} {string} with:")]
async fn add_criterion_ref_with_table(
    world: &mut SmokeWorld,
    index: i32,
    file_spec: String,
    step: &cucumber::gherkin::Step,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let index_str = index.to_string();
    let table = step.table.as_ref().expect("expected a data table");

    let mut args: Vec<String> = vec!["criterion-ref".to_string(), task_id, index_str, file_spec];

    for row in &table.rows {
        let key = row[0].as_str();
        let value = row[1].as_str();
        match key {
            "name" => {
                args.push("--name".to_string());
                args.push(value.to_string());
            }
            other => panic!("unsupported table key in criterion-ref: '{}'", other),
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;
}
