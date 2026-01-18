//! End-to-end integration tests for the Vertebrae CLI
//!
//! This test suite executes commands through the CLI command interface
//! using isolated database instances for each test to ensure no shared state.
//!
//! Tests are organized into modules:
//! - `lifecycle_tests` - Task creation and status transitions
//! - `relationship_tests` - Parent-child and dependency relationships
//! - `section_tests` - Sections and code references
//! - `query_tests` - List, show, blockers, ready, path commands
//! - `workflow_tests` - Workflow management
//! - `error_tests` - Error handling edge cases

mod common;

mod error_tests;
mod lifecycle_tests;
mod query_tests;
mod relationship_tests;
mod section_tests;
mod workflow_tests;
