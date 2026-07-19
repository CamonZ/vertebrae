//! Claude Code CLI provider adapter.
//!
//! This crate owns Claude-specific discovery, launch policy, live stream-json
//! decoding, and process lifetime. It deliberately has no GUI, daemon, actor,
//! persistence, or provider-settings dependencies.

mod config;
mod decoder;
mod runtime;

pub use config::*;
pub use decoder::*;
pub use runtime::*;
