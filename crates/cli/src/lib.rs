//! Vertebrae CLI Library
//!
//! This library exposes the CLI commands for use in integration tests.
//! The binary is in `main.rs` and uses this library.

pub mod cli_args;
pub mod commands;
pub mod error;
pub mod output;

pub use cli_args::CliArgs;
pub use commands::*;
