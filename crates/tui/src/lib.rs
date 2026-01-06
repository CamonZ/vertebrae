//! TUI module for Vertebrae
//!
//! Provides a terminal user interface for viewing and navigating
//! Vertebrae tasks using ratatui and crossterm.

pub mod app;
pub mod data;
pub mod error;
pub mod event;
pub mod navigation;
pub mod ui;

pub use app::App;
pub use data::{load_full_tree, load_node_children, load_root_epics_lazy};
pub use error::{TuiError, TuiResult};
pub use navigation::{FlatNode, TreeNode, TreeState, flatten_tree, render_nav_panel};
