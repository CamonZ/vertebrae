use cucumber::given;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::DaemonWorld;

#[given("a configured daemon test environment")]
pub async fn configured_daemon_environment(world: &mut DaemonWorld) {
    assert!(
        !world.sacrum_token.is_empty(),
        "VTB_TOKEN must be set for daemon acceptance tests"
    );

    let slug = format!("daemon-acc-{}", uuid::Uuid::new_v4());
    let name = slug.clone();

    // CREATE_PROJECT belongs to no project, so it needs a project-less client.
    let bootstrap_client = GraphqlClient::new(SacrumConfig::new(
        world.sacrum_url.clone(),
        world.sacrum_token.clone(),
        String::new(),
    ));

    let project: vertebrae_sacrum_client::ProjectResponse = bootstrap_client
        .execute(
            vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
            serde_json::json!({ "name": name, "slug": slug }),
            "create_project",
        )
        .await
        .expect("failed to create sacrum project");

    let project_id = project.id.clone();
    world.project_id = Some(project_id.clone());
    world.created_project_ids.push(project_id.clone());

    world.graphql_client = Some(crate::graphql_client_for(
        &world.sacrum_url,
        &world.sacrum_token,
        &project_id,
    ));

    world.env.insert("VTB_URL".into(), world.sacrum_url.clone());
    world
        .env
        .insert("VTB_TOKEN".into(), world.sacrum_token.clone());
    world
        .env
        .insert("VTB_PROJECT_ID".into(), project_id.clone());

    world.start_daemon_for_project(&project_id, "/app").await;
}
