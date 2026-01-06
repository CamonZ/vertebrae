//! TUI module for Vertebrae
//!
//! Provides a terminal user interface for viewing and navigating
//! Vertebrae tasks using ratatui and crossterm.

pub mod app;
pub mod error;
pub mod event;
pub mod ui;

pub use app::App;
pub use error::{TuiError, TuiResult};
