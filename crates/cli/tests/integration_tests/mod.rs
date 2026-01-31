//! End-to-end integration tests for the Vertebrae CLI
//!
//! These tests require the `db-tests` feature flag as they use direct database access.
//! Since the CLI migrated to Sacrum HTTP backend, these are disabled by default.
//!
//! Run with: `cargo test -p vertebrae-cli --features db-tests`

#[cfg(feature = "db-tests")]
mod common;

#[cfg(feature = "db-tests")]
mod error_tests;
#[cfg(feature = "db-tests")]
mod lifecycle_tests;
#[cfg(feature = "db-tests")]
mod query_tests;
#[cfg(feature = "db-tests")]
mod relationship_tests;
#[cfg(feature = "db-tests")]
mod section_tests;
#[cfg(feature = "db-tests")]
mod workflow_tests;
