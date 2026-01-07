//! TUI module for Vertebrae
//!
//! Provides a terminal user interface for viewing and navigating
//! Vertebrae tasks using ratatui and crossterm.

pub mod app;
pub mod data;
pub mod details;
pub mod error;
pub mod event;
pub mod navigation;
pub mod timeline;
pub mod tree_view;
pub mod ui;

pub use app::App;
pub use data::{
    load_full_tree, load_node_children, load_root_epics_lazy, load_task_details,
    load_timeline_tasks,
};
pub use details::{TaskDetails, TaskRelationships, render_details_view};
pub use error::{TuiError, TuiResult};
pub use navigation::{FlatNode, TreeNode, TreeState, flatten_tree, render_nav_panel};
pub use timeline::{
    DependencyEdge, TimelineTask, TimelineViewState, compute_dependency_groups,
    render_timeline_view,
};
pub use tree_view::render_tree_view;
