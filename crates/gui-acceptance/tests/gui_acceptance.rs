mod steps;

use std::path::PathBuf;
use std::sync::Arc;

use cucumber::World;
use fantoccini::Client;
use tokio::sync::Mutex;
use vertebrae_sacrum_client::GraphqlClient;

#[derive(World)]
#[world(init = Self::new)]
pub struct GuiWorld {
    /// Shared WebDriver session (persists across scenarios).
    webdriver: Option<Arc<Mutex<Client>>>,

    /// GraphQL client for Sacrum — used to create/cleanup test projects.
    graphql_client: Option<GraphqlClient>,

    /// The project slug registered for this scenario (unique per run).
    project_slug: Option<String>,

    /// Sacrum project ID returned after creation.
    project_id: Option<String>,

    /// Temporary directory used as the project path in config.toml.
    temp_dir: Option<PathBuf>,
}

impl std::fmt::Debug for GuiWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuiWorld")
            .field("project_slug", &self.project_slug)
            .field("project_id", &self.project_id)
            .field("temp_dir", &self.temp_dir)
            .finish()
    }
}

impl GuiWorld {
    fn new() -> Self {
        Self {
            webdriver: None,
            graphql_client: None,
            project_slug: None,
            project_id: None,
            temp_dir: None,
        }
    }
}

#[tokio::main]
async fn main() {
    GuiWorld::cucumber()
        .max_concurrent_scenarios(Some(1))
        .before(|_feature, _rule, _scenario, world| {
            Box::pin(async move {
                steps::setup::before_scenario(world).await;
            })
        })
        .after(|_feature, _rule, _scenario, _ev, world| {
            Box::pin(async move {
                if let Some(world) = world {
                    steps::setup::after_scenario(world).await;
                }
            })
        })
        .run("tests/features")
        .await;

    gui_acceptance::close_webdriver().await;
}
