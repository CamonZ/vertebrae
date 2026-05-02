//! End-to-end integration tests for the Vertebrae CLI
//!
//! Integration tests using mock implementations of service traits, providing
//! basic coverage without requiring a live Sacrum backend.

mod basic_tests;
mod check_item_tests;
mod criterion_ref_tests;
mod delete_tests;
mod execution_tests;
mod mock;
mod ready_tests;
mod refs_tests;
mod review_tests;
mod run_tests;
mod run_workflow_tests;
mod sections_tests;
mod show_tests;
mod step_tests;
mod uncheck_item_tests;
mod unref_tests;
mod unsection_tests;
mod update_tests;
mod workflow_cmd_tests;
