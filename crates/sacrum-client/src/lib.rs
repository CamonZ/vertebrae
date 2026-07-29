//! vertebrae-sacrum-client
//!
//! HTTP client for the Sacrum backend API.
//!
//! # Overview
//!
//! This crate provides a Rust client for communicating with the Sacrum HTTP API.
//! It handles:
//! - Bearer token authentication
//! - Automatic response envelope unwrapping
//! - Configuration management from ~/.config/vertebrae/config.toml
//! - Serialization/deserialization of API types
//!
//! # Configuration
//!
//! Configuration is loaded from `~/.config/vertebrae/config.toml`:
//!
//! ```toml
//! [sacrum]
//! token = "sac_your_token_here"
//! url = "https://vertebrae.dev"
//!
//! [projects.my-project]
//! id = "uuid-here"
//! path = "/path/to/project"
//! ```
//!
//! The CLI resolves the active project by matching CWD against project paths.
//! The GUI uses explicit project name lookup via `SacrumConfig::load_for_project()`.
//!
//! # Example Usage
//!
//! ```no_run
//! use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = SacrumConfig::load()?;
//!     let client = GraphqlClient::new(config);
//!
//!     // Make GraphQL queries via service layers
//!     // e.g., SacrumTaskService::new(client).get_task("id").await?;
//!
//!     Ok(())
//! }
//! ```

use async_trait::async_trait;
use vertebrae_core::artifact_service::ArtifactService;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{
    Artifact, CreateArtifactInput, ListArtifactInput, UpdateArtifactInput,
};

pub mod api_types;
pub mod client;
pub mod config;
pub mod error;
pub mod execution_service;
pub mod queries;
pub mod step_service;
pub mod task_service;
pub mod workflow_service;

pub use api_types::{
    ArtifactResponse, CodeRefResponse, CreateProjectRequest, ErrorResponse, PipelineStepResponse,
    PipelineStepTransitionResponse, PipelineTaskCountsResponse, PipelineWorkflowResponse,
    PipelineWorkflowTransitionResponse, ProjectListResponse, ProjectResponse, SectionResponse,
    SessionLogResponse, StepExecutionResponse, StepTransitionResponse, TaskResponse,
    TaskRunControlsResponse, TaskRunResponse, TaskRunTraceResponse, WorkflowResponse,
    WorkflowStepResponse, WorkflowTransitionResponse,
};
pub use client::{GraphqlClient, with_fragments};
pub use config::{
    GlobalSacrumSection, ProjectSection, SacrumConfig, VertebraeConfigFile, config_path,
    load_config_file, register_project, save_config_file, unregister_project,
};
pub use error::{SacrumClientError, SacrumClientResult};
pub use execution_service::SacrumExecutionService;
pub use step_service::SacrumStepService;
pub use task_service::SacrumTaskService;
pub use workflow_service::SacrumWorkflowService;

/// Temporary service used by the shared service container until the Sacrum
/// artifact client implementation is added.
///
/// The core service container requires every service at construction time, but
/// the concrete artifact client is delivered by the follow-up Sacrum ticket.
/// Keeping this explicit placeholder preserves that required dependency without
/// pretending that artifact operations are supported by the current client.
struct UnavailableArtifactService;

#[async_trait]
impl ArtifactService for UnavailableArtifactService {
    async fn create_artifact(&self, _input: CreateArtifactInput) -> ServiceResult<Artifact> {
        unavailable()
    }

    async fn list_artifacts(&self, _input: ListArtifactInput) -> ServiceResult<Vec<Artifact>> {
        unavailable()
    }

    async fn get_artifact(&self, _id: &str) -> ServiceResult<Artifact> {
        unavailable()
    }

    async fn update_artifact(
        &self,
        _id: &str,
        _input: UpdateArtifactInput,
    ) -> ServiceResult<Artifact> {
        unavailable()
    }

    async fn delete_artifact(&self, _id: &str) -> ServiceResult<Artifact> {
        unavailable()
    }
}

fn unavailable<T>() -> ServiceResult<T> {
    Err(ServiceError::invalid_input(
        "Artifact service is not available in this Sacrum client",
    ))
}

/// Create a new [`VertebraeServices`] container from a Sacrum GraphQL client.
///
/// Instantiates all service implementations ([`SacrumTaskService`], [`SacrumWorkflowService`],
/// [`SacrumExecutionService`], [`SacrumStepService`]) from the provided [`GraphqlClient`].
/// The artifact slot is populated by an explicit placeholder until the
/// SacrumArtifactService implementation is added.
pub fn from_sacrum(client: std::sync::Arc<GraphqlClient>) -> vertebrae_core::VertebraeServices {
    let task_service = SacrumTaskService::new((*client).clone());
    let workflow_service = SacrumWorkflowService::new((*client).clone());
    let execution_service = SacrumExecutionService::new((*client).clone());
    let step_service = SacrumStepService::new((*client).clone());

    vertebrae_core::VertebraeServices::from_services(
        std::sync::Arc::new(task_service),
        std::sync::Arc::new(workflow_service),
        std::sync::Arc::new(execution_service),
        std::sync::Arc::new(step_service),
        std::sync::Arc::new(UnavailableArtifactService),
    )
}

#[cfg(test)]
mod from_sacrum_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn creates_valid_services() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = Arc::new(GraphqlClient::new(config));
        let services = from_sacrum(client);

        let _ = services.tasks();
        let _ = services.workflows();
        let _ = services.executions();
        let _ = services.steps();
        let _ = services.artifacts();
    }

    #[test]
    fn arc_accessors_work() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = Arc::new(GraphqlClient::new(config));
        let services = from_sacrum(client);

        let _ = services.tasks_arc();
        let _ = services.workflows_arc();
        let _ = services.executions_arc();
        let _ = services.steps_arc();
        let _ = services.artifacts_arc();
    }

    #[test]
    fn independent_clients_produce_independent_services() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token1".to_string(),
            "project1".to_string(),
        );
        let config2 = SacrumConfig::new(
            "http://localhost:5000".to_string(),
            "token2".to_string(),
            "project2".to_string(),
        );

        let services1 = from_sacrum(Arc::new(GraphqlClient::new(config1)));
        let services2 = from_sacrum(Arc::new(GraphqlClient::new(config2)));

        let _ = services1.tasks();
        let _ = services2.tasks();
    }
}
