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
//! - Configuration management from ~/.config/vertebrae/config.toml and environment variables
//! - Serialization/deserialization of API types
//!
//! # Configuration
//!
//! Configuration is loaded from:
//! 1. `SACRUM_API_TOKEN` environment variable (required for API token)
//! 2. `~/.config/vertebrae/config.toml` for base URL and project settings
//!
//! Example ~/.config/vertebrae/config.toml:
//! ```toml
//! [sacrum]
//! url = "http://localhost:4000"
//!
//! [projects.my-project]
//! project_id = "uuid-here"
//! ```
//!
//! # Example Usage
//!
//! ```no_run
//! use vertebrae_sacrum_client::{SacrumClient, SacrumConfig};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = SacrumConfig::load("my-project")?;
//!     let client = SacrumClient::new(config);
//!
//!     // Make API calls
//!     // let task = client.get::<TaskResponse>("/api/tasks/123", &()).await?;
//!
//!     Ok(())
//! }
//! ```

pub mod api_types;
pub mod client;
pub mod config;
pub mod error;
pub mod execution_service;
pub mod step_service;
pub mod task_service;
pub mod workflow_service;

pub use api_types::{
    CodeRefResponse, CreateProjectRequest, DataEnvelope, ErrorResponse, MoveToRequest,
    ProjectListResponse, ProjectResponse, SectionResponse, SessionLogResponse,
    StepExecutionResponse, StepTransitionResponse, TaskResponse, WorkflowResponse,
    WorkflowStepResponse, WorkflowTransitionResponse,
};
pub use client::SacrumClient;
pub use config::{
    GlobalSacrumSection, ProjectSection, SacrumConfig, VertebraeConfigFile, config_path,
    load_config_file, save_config_file,
};
pub use error::{SacrumClientError, SacrumClientResult};
pub use execution_service::SacrumExecutionService;
pub use step_service::SacrumStepService;
pub use task_service::SacrumTaskService;
pub use workflow_service::SacrumWorkflowService;
