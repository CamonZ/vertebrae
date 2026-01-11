//! Vertebrae CLI Library
//!
//! This library exposes the CLI commands for use in integration tests.
//! The binary is in `main.rs` and uses this library.

pub mod commands;
pub mod error;
mod id;
pub mod notification;
pub mod output;

pub use commands::*;
pub use error::service_error_to_db_error;
