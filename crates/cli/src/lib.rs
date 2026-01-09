//! Vertebrae CLI Library
//!
//! This library exposes the CLI commands for use in integration tests.
//! The binary is in `main.rs` and uses this library.

pub mod commands;
mod id;
pub mod output;

pub use commands::*;
