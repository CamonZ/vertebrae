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
//! - Configuration management from .vtb/config.toml and environment variables
//! - Serialization/deserialization of API types
//!
//! # Configuration
//!
//! Configuration is loaded from:
//! 1. `SACRUM_API_TOKEN` environment variable (required for API token)
//! 2. `.vtb/config.toml` in the project directory or parent directories (found by walking up from CWD)
//!
//! Example .vtb/config.toml:
//! ```toml
//! [project]
//! id = "uuid-here"
//! slug = "my-project"
//!
//! [sacrum]
//! url = "http://localhost:4000"
//! ```
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
    CodeRefResponse, CreateProjectRequest, ErrorResponse, ProjectListResponse, ProjectResponse,
    SectionResponse, SessionLogResponse, StepExecutionResponse, StepTransitionResponse,
    TaskResponse, WorkflowResponse, WorkflowStepResponse, WorkflowTransitionResponse,
};
pub use client::{GraphqlClient, with_fragments};
pub use config::{
    GlobalSacrumSection, LocalProjectConfig, LocalSacrumSection, ProjectSection, ProjectSettings,
    SacrumConfig, VertebraeConfigFile, config_path, find_and_load_local_config, load_config_file,
    load_local_config_file, save_config_file, save_local_config,
};
pub use error::{SacrumClientError, SacrumClientResult};
pub use execution_service::SacrumExecutionService;
pub use step_service::SacrumStepService;
pub use task_service::SacrumTaskService;
pub use workflow_service::SacrumWorkflowService;
