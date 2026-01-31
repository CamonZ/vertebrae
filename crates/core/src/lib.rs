//! Vertebrae Core - Shared service layer for task management
//!
//! This crate provides the business logic layer for Vertebrae, abstracting task
//! management operations for both CLI and GUI. It sits between the presentation
//! layer (CLI commands, Tauri commands) and the data layer (vertebrae-db).
//!
//! # Architecture
//!
//! ```text
//! CLI Commands ──┐
//!                ├──► vertebrae-core ──► vertebrae-db ──► SurrealDB
//! GUI Commands ──┘
//! ```
//!
//! # Main Components
//!
//! - [`TaskService`] - Trait defining all task management operations
//! - [`DefaultTaskService`] - Database-backed implementation of TaskService
//! - [`ServiceError`] - Error types for service operations
//!
//! # Example
//!
//! ```rust,ignore
//! use vertebrae_core::{DefaultTaskService, TaskService, CreateTaskOptions};
//! use vertebrae_db::Database;
//!
//! async fn example() -> Result<(), Box<dyn std::error::Error>> {
//!     let db = Database::connect(&std::path::PathBuf::from(".vtb/data")).await?;
//!     db.init().await?;
//!
//!     let service = DefaultTaskService::new(db);
//!
//!     let id = service.create_task(
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
pub use execution_service::{
    DefaultExecutionService, ExecutionMutationCallback, ExecutionMutationEvent, ExecutionService,
};
pub use orchestrator::{
    ORCHESTRATOR_AGENT_PATH, ORCHESTRATOR_MODEL, ORCHESTRATOR_PROMPT_TEMPLATE, OrchestratorOutput,
    orchestrator_agent_config, orchestrator_output_schema, orchestrator_prompt,
};
pub use service::{
    CreateTaskOptions, DefaultTaskService, MutationCallback, MutationEvent, TaskService,
    TaskTreeNode, TaskWithRelations, TransitionResult, TreeFilterOptions, UnblockedTask,
    UpdateTaskOptions,
};
pub use services::VertebraeServices;
pub use step_service::{DefaultStepService, StepService};
pub use workflow_service::{
    AssignResult, CreateWorkflowOptions, DefaultWorkflowService, MigrationResult, RejectResult,
    StepTransitionResult, UpdateWorkflowOptions, WorkflowInfo, WorkflowMutationCallback,
    WorkflowMutationEvent, WorkflowService, WorkflowStepInput, WorkflowSummary,
};

// Re-export domain models for convenience
pub use models::{
    AgentConfig, BlockerNode, CodeRef, ExecutionStatus, Level, PermissionMode, Priority, Section,
    SectionType, SessionLog, Step, StepExecution, StepUpdate, Task, TaskFilter, TaskSummary,
    TaskUpdate, TokenUsage, Workflow, WorkflowTransition,
};

// Re-export Database and Thing for convenience
pub use vertebrae_db::{Database, Thing};
