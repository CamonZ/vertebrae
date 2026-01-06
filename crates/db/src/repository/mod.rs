//! Repository modules for database operations
//!
//! Provides repository pattern implementations for task and relationship
//! operations, encapsulating database queries.

mod task;

pub use task::{TaskRepository, TaskUpdate};
