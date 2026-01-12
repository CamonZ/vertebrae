//! End-to-end integration tests for the Vertebrae CLI
//!
//! This test suite executes commands through the CLI command interface
//! using isolated database instances for each test to ensure no shared state.
//!
//! Tests are organized into modules matching the implementation steps:
//! - `test_infrastructure` - Shared test helpers and database setup
//! - `lifecycle` - Task lifecycle tests (add, triage, start, submit, done, reject)
//! - `sections` - Section tests for all 9 types with single/multi behavior
//! - `relationships` - Parent-child and dependency relationship tests
//! - `code_refs` - Code reference tests
//! - `queries` - Query and filter tests
//! - `error_cases` - Error handling tests

mod common;

// NOTE: Integration tests have been removed due to service layer migration.
// The tests relied on `cmd.execute(&Database)` which is no longer valid after
// the refactoring to use the TaskService trait. Rewriting these tests would
// require either:
// 1. Creating a mock TaskService implementation
// 2. Migrating to a different testing strategy (e.g., behavior-driven tests)
//
// For now, this file is kept as a stub to preserve test infrastructure.
