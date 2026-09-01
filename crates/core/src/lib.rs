//! Vertebrae Core - Shared service layer for task management
//!
//! This crate provides the business logic layer for Vertebrae, abstracting task
//! management operations for both CLI and GUI.
//!
//! # Architecture
//!
//! ```text
//! CLI Commands ──┐
//!                ├──► vertebrae-core (service traits)
//! GUI Commands ──┘
//! ```
//!
//! # Main Components
//!
//! - [`TaskService`] - Trait defining all task management operations
//! - [`ServiceError`] - Error types for service operations
//!
//! # Example
//!
//! ```rust,ignore
//! use vertebrae_core::{TaskService, CreateTaskOptions, VertebraeServices};
//!
//! async fn example(services: &VertebraeServices) -> Result<(), Box<dyn std::error::Error>> {
//!     let id = services.tasks().create_task(
//!         CreateTaskOptions::new("My Task")
//!             .with_description("A task description")
//!     ).await?;
//!
//!     println!("Created task: {}", id);
//!     Ok(())
//! }
//! ```

pub mod artifact_service;
pub mod error;
pub mod execution_service;
pub mod execution_settings;
pub mod id_generator;
pub mod model_catalog;
pub mod models;
pub mod orchestrator;
pub mod service;
pub mod services;
pub mod step_constraints;
pub mod step_service;
pub mod workflow_service;

// Re-export main types for convenience
pub use artifact_service::ArtifactService;
pub use error::{ServiceError, ServiceResult};
pub use execution_service::{
    ExecutionMutationCallback, ExecutionMutationEvent, ExecutionService, StopRunTarget,
    UpdateExecutionStatusParams,
};
pub use execution_settings::{OutputVerbosity, SpeedTier};
pub use model_catalog::{
    Provider, ProviderModelMismatch, ProviderPersonalityMismatch, ProviderReasoningEffortMismatch,
    ProviderVerbosityMismatch, SUPPORTED_OPENAI_REASONING_EFFORTS, classify_model,
    normalize_personality, normalize_provider_personality, normalize_provider_reasoning_effort,
    normalize_provider_verbosity, validate_provider_model,
    validate_provider_model_with_codex_provider, validate_provider_reasoning_effort,
};
pub use orchestrator::{
    ORCHESTRATOR_AGENT_PATH, ORCHESTRATOR_MODEL, ORCHESTRATOR_PROMPT_TEMPLATE, OrchestratorOutput,
    orchestrator_agent_config, orchestrator_output_schema, orchestrator_prompt,
};
pub use service::{
    CreateTaskOptions, MutationCallback, MutationEvent, TaskService, UpdateTaskOptions,
};
pub use services::VertebraeServices;
pub use step_constraints::{resulting_option, validate_route_fields, validate_route_update};
pub use step_service::StepService;
pub use workflow_service::{
    AssignResult, CreateWorkflowOptions, UpdateWorkflowOptions, WorkflowInfo,
    WorkflowMutationCallback, WorkflowMutationEvent, WorkflowService, WorkflowStepInput,
    WorkflowSummary,
};

// Re-export domain models for convenience
pub use models::{
    AgentConfig, Artifact, ArtifactLinkMetadata, BlockerNode, CodeRef, CreateArtifactInput,
    ExecutionStatus, GetArtifactByLogicalNameInput, Level, ListArtifactInput, PermissionMode,
    Priority, Section, SectionType, SessionLog, Step, StepExecution, StepType, StepUpdate, Task,
    TaskFilter, TaskRun, TaskRunControls, TaskRunStatus, TaskRunSummary, TaskRunTrace, TaskUpdate,
    Thing, TokenUsage, UpdateArtifactInput, Workflow, WorkflowTransition,
};
