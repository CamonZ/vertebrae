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

pub mod error;
pub mod execution_service;
pub mod id_generator;
pub mod models;
pub mod orchestrator;
pub mod service;
pub mod services;
pub mod step_service;
pub mod workflow_service;

// Re-export main types for convenience
pub use error::{ServiceError, ServiceResult};
pub use execution_service::{ExecutionMutationCallback, ExecutionMutationEvent, ExecutionService};
pub use orchestrator::{
    ORCHESTRATOR_AGENT_PATH, ORCHESTRATOR_MODEL, ORCHESTRATOR_PROMPT_TEMPLATE, OrchestratorOutput,
    orchestrator_agent_config, orchestrator_output_schema, orchestrator_prompt,
};
pub use service::{
    CreateTaskOptions, MutationCallback, MutationEvent, TaskService, TaskTreeNode,
    TaskWithRelations, TransitionResult, TreeFilterOptions, UnblockedTask, UpdateTaskOptions,
};
pub use services::VertebraeServices;
pub use step_service::StepService;
pub use workflow_service::{
    AssignResult, CreateWorkflowOptions, MigrationResult, RejectResult, StepTransitionResult,
    UpdateWorkflowOptions, WorkflowInfo, WorkflowMutationCallback, WorkflowMutationEvent,
    WorkflowService, WorkflowStepInput, WorkflowSummary,
};

// Re-export domain models for convenience
pub use models::{
    AgentConfig, BlockerNode, CodeRef, ExecutionStatus, Level, PermissionMode, Priority, Section,
    SectionType, SessionLog, Step, StepExecution, StepUpdate, Task, TaskFilter, TaskSummary,
    TaskUpdate, Thing, TokenUsage, Workflow, WorkflowTransition,
};
