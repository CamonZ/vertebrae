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
//! 2. `.vtb/config.toml` for base URL and project ID
//!
//! Example .vtb/config.toml:
//! ```toml
//! [sacrum]
//! url = "http://localhost:4000"
//! project_id = "my-project"
//! ```
//!
//! # Example Usage
//!
//! ```no_run
//! use vertebrae_sacrum_client::{SacrumClient, SacrumConfig};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = SacrumConfig::load()?;
//!     let client = SacrumClient::new(config);
//!
//!     // Make API calls
//!     // let task = client.get::<TaskResponse>("/projects/tasks/123").await?;
//!
//!     Ok(())
//! }
//! ```

pub mod api_types;
pub mod client;
pub mod config;
pub mod error;

pub use api_types::{
    DataEnvelope, ErrorResponse, StepResponse, TaskListResponse, TaskResponse, WorkflowResponse,
};
pub use client::SacrumClient;
pub use config::SacrumConfig;
pub use error::{SacrumClientError, SacrumClientResult};
