//! Sacrum backend support for Vertebrae GUI
//!
//! This module provides factory methods for creating VertebraeServices
//! from a Sacrum HTTP client, enabling the GUI to work with the Sacrum backend.

use std::sync::Arc;
use vertebrae_core::VertebraeServices;
use vertebrae_sacrum_client::{
    GraphqlClient, SacrumExecutionService, SacrumStepService, SacrumTaskService,
    SacrumWorkflowService,
};

/// Create a new VertebraeServices container from a Sacrum GraphQL client.
///
/// Instantiates all service implementations (SacrumTaskService, SacrumWorkflowService,
/// SacrumExecutionService, SacrumStepService) from the provided GraphqlClient.
/// No mutation callbacks are installed.
///
/// # Arguments
///
/// * `client` - An Arc-wrapped GraphqlClient instance
///
/// # Returns
///
/// A new VertebraeServices container with all Sacrum services initialized
pub fn from_sacrum(client: Arc<GraphqlClient>) -> VertebraeServices {
    let task_service = SacrumTaskService::new((*client).clone());
    let workflow_service = SacrumWorkflowService::new((*client).clone());
    let execution_service = SacrumExecutionService::new((*client).clone());
    let step_service = SacrumStepService::new((*client).clone());

    VertebraeServices::from_services(
        Arc::new(task_service),
        Arc::new(workflow_service),
        Arc::new(execution_service),
        Arc::new(step_service),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_sacrum_client::SacrumConfig;

    #[test]
    fn test_from_sacrum_creates_valid_services() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);
        let client_arc = Arc::new(client);

        let services = from_sacrum(client_arc);

        // Verify services are accessible
        let _ = services.tasks();
        let _ = services.workflows();
        let _ = services.executions();
        let _ = services.steps();
    }

    #[test]
    fn test_from_sacrum_services_have_arc_accessors() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);
        let client_arc = Arc::new(client);

        let services = from_sacrum(client_arc);

        // Verify Arc accessors work
        let _ = services.tasks_arc();
        let _ = services.workflows_arc();
        let _ = services.executions_arc();
        let _ = services.steps_arc();
    }
}
