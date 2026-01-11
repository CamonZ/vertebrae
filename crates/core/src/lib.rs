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
pub mod service;

// Re-export main types for convenience
pub use error::{ServiceError, ServiceResult};
pub use service::{
    CreateTaskOptions, DefaultTaskService, TaskService, TaskTreeNode, TaskWithRelations,
    TransitionResult, TreeFilterOptions, UnblockedTask, UpdateTaskOptions,
};

// Re-export commonly used types from vertebrae-db
pub use vertebrae_db::{
    BlockerNode, CodeRef, Database, Level, Priority, Section, SectionType, Status, Task,
    TaskFilter, TaskSummary, TaskUpdate,
};
