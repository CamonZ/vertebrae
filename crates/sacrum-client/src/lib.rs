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
//! url = "http://localhost:4000"
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
    GlobalSacrumSection, ProjectSection, SacrumConfig, VertebraeConfigFile, config_path,
    load_config_file, register_project, save_config_file, unregister_project,
};
pub use error::{SacrumClientError, SacrumClientResult};
pub use execution_service::SacrumExecutionService;
pub use step_service::SacrumStepService;
pub use task_service::SacrumTaskService;
pub use workflow_service::SacrumWorkflowService;
