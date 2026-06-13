//! End-to-end integration tests for the Vertebrae CLI
//!
//! Integration tests using mock implementations of service traits, providing
//! basic coverage without requiring a live Sacrum backend.

mod mock;
mod basic_tests;
// Temporary disable: mod criterion_ref_tests;
// Temporary disable: mod refs_tests;
// Temporary disable: mod unref_tests;
mod ready_tests;
mod review_tests;
mod step_done_tests;
// Temporary disable: mod run_tests;
// Temporary disable: mod sections_tests;
// Temporary disable: mod unsection_tests;
// Temporary disable: mod workflow_cmd_tests;
