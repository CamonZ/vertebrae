//! Navigation panel with task hierarchy tree widget.
//!
//! Provides a tree widget for displaying and navigating task hierarchies
//! (epic -> ticket -> task) with expand/collapse functionality.

use std::collections::HashSet;

use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use vertebrae_db::{Level, Status};

/// A node in the task tree hierarchy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    /// Unique task ID.
    pub id: String,
    /// Task title for display.
    pub title: String,
    /// Hierarchy level (Epic, Ticket, Task).
    pub level: Level,
    /// Current task status.
    pub status: Status,
    /// Child nodes (subtasks/tickets under this node).
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    /// Create a new tree node.
    pub fn new(id: impl Into<String>, title: impl Into<String>, level: Level) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            level,
            status: Status::Todo,
            children: Vec::new(),
        }
    }

    /// Set the status of this node.
    pub fn with_status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    /// Add a child node.
    pub fn with_child(mut self, child: TreeNode) -> Self {
        self.children.push(child);
        self
    }

    /// Add multiple children.
    pub fn with_children(mut self, children: impl IntoIterator<Item = TreeNode>) -> Self {
        self.children.extend(children);
        self
    }

    /// Check if this node has children.
    pub fn has_children(&self) -> bool {
        !self.children.is_empty()
    }
}

/// A flattened representation of a tree node for display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatNode {
    /// The node ID.
    pub id: String,
    /// The node title.
    pub title: String,
    /// The node level.
    pub level: Level,
    /// The node status.
    pub status: Status,
    /// Depth in the tree (0 = root).
    pub depth: usize,
    /// Whether this node has children.
    pub has_children: bool,
    /// Whether this node is expanded (only relevant if has_children).
    pub is_expanded: bool,
}

/// State for managing expanded nodes in the tree.
#[derive(Debug, Clone, Default)]
pub struct TreeState {
    /// Set of expanded node IDs.
    expanded: HashSet<String>,
}

impl TreeState {
    /// Create a new tree state with no nodes expanded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if a node is expanded.
    pub fn is_expanded(&self, id: &str) -> bool {
        self.expanded.contains(id)
    }

    /// Expand a node.
    pub fn expand(&mut self, id: impl Into<String>) {
        self.expanded.insert(id.into());
    }

    /// Collapse a node.
    pub fn collapse(&mut self, id: &str) {
        self.expanded.remove(id);
    }

    /// Toggle the expanded state of a node.
    pub fn toggle(&mut self, id: &str) {
        if self.is_expanded(id) {
            self.collapse(id);
        } else {
            self.expand(id.to_string());
        }
    }

    /// Collapse all nodes.
    pub fn collapse_all(&mut self) {
        self.expanded.clear();
    }

    /// Expand all nodes in the given tree.
    pub fn expand_all(&mut self, roots: &[TreeNode]) {
        for node in roots {
            self.expand_node_recursive(node);
        }
    }

    /// Recursively expand a node and all its children.
    fn expand_node_recursive(&mut self, node: &TreeNode) {
        if node.has_children() {
            self.expand(node.id.clone());
            for child in &node.children {
                self.expand_node_recursive(child);
            }
        }
    }
}

/// Visual prefix characters for tree nodes.
mod prefix {
    /// Prefix for collapsed parent nodes.
    pub const COLLAPSED: &str = "\u{25B8}"; // ▸
    /// Prefix for expanded parent nodes.
    pub const EXPANDED: &str = "\u{25BE}"; // ▾
    /// Prefix for leaf nodes (no children).
    pub const LEAF: &str = "\u{2022}"; // •
}

/// Flatten a tree into a list of visible nodes based on expansion state.
///
/// Only includes children of nodes that are expanded.
pub fn flatten_tree(roots: &[TreeNode], state: &TreeState) -> Vec<FlatNode> {
    let mut result = Vec::new();
    for root in roots {
        flatten_node(&mut result, root, 0, state);
    }
    result
}

/// Recursively flatten a single node and its visible children.
fn flatten_node(result: &mut Vec<FlatNode>, node: &TreeNode, depth: usize, state: &TreeState) {
    let is_expanded = state.is_expanded(&node.id);

    result.push(FlatNode {
        id: node.id.clone(),
        title: node.title.clone(),
        level: node.level.clone(),
        status: node.status.clone(),
        depth,
        has_children: node.has_children(),
        is_expanded,
    });

    // Only include children if the node is expanded
    if is_expanded {
        for child in &node.children {
            flatten_node(result, child, depth + 1, state);
        }
    }
}

/// Render the navigation panel with task tree.
pub fn render_nav_panel(
    frame: &mut Frame,
    area: Rect,
    nodes: &[FlatNode],
    selected_index: usize,
    empty_message: Option<&str>,
) {
    let block = Block::default()
        .title(" Navigation ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    if nodes.is_empty() {
        // Show empty message
        let message = empty_message.unwrap_or("No tasks found");
        let paragraph = Paragraph::new(message)
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(paragraph, area);
        return;
    }

    let items: Vec<Line> = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| render_node_line(node, i == selected_index))
        .collect();

    let nav_list = Paragraph::new(items).block(block);
    frame.render_widget(nav_list, area);
}

/// Render a single node as a styled line.
fn render_node_line(node: &FlatNode, is_selected: bool) -> Line<'static> {
    // Calculate indentation (2 spaces per depth level)
    let indent = "  ".repeat(node.depth);

    // Determine prefix based on children and expansion state
    let prefix = if node.has_children {
        if node.is_expanded {
            prefix::EXPANDED
        } else {
            prefix::COLLAPSED
        }
    } else {
        prefix::LEAF
    };

    // Status indicator
    let status_indicator = match node.status {
        Status::Done => "[x]",
        Status::InProgress => "[>]",
        Status::Blocked => "[!]",
        Status::Todo => "[ ]",
    };

    // Build the display text
    let text = format!("{}{} {} {}", indent, prefix, status_indicator, node.title);

    // Apply styling
    let style = if is_selected {
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
            .bg(Color::DarkGray)
    } else {
        // Color based on level
        match node.level {
            Level::Epic => Style::default().fg(Color::Magenta),
            Level::Ticket => Style::default().fg(Color::Blue),
            Level::Task => Style::default().fg(Color::White),
        }
    };

    Line::from(Span::styled(text, style))
}

/// Get the status color for a task.
#[allow(dead_code)] // May be used for status-based coloring in future
fn status_color(status: &Status) -> Color {
    match status {
        Status::Done => Color::Green,
        Status::InProgress => Color::Yellow,
        Status::Blocked => Color::Red,
        Status::Todo => Color::White,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================
    // TreeNode tests
    // ========================================

    #[test]
    fn test_tree_node_new() {
        let node = TreeNode::new("abc123", "Test Task", Level::Task);
        assert_eq!(node.id, "abc123");
        assert_eq!(node.title, "Test Task");
        assert_eq!(node.level, Level::Task);
        assert_eq!(node.status, Status::Todo);
        assert!(node.children.is_empty());
    }

    #[test]
    fn test_tree_node_with_status() {
        let node = TreeNode::new("id1", "Task", Level::Task).with_status(Status::InProgress);
        assert_eq!(node.status, Status::InProgress);
    }

    #[test]
    fn test_tree_node_with_child() {
        let child = TreeNode::new("child1", "Child", Level::Task);
        let parent = TreeNode::new("parent1", "Parent", Level::Ticket).with_child(child);
        assert_eq!(parent.children.len(), 1);
        assert_eq!(parent.children[0].id, "child1");
    }

    #[test]
    fn test_tree_node_with_children() {
        let children = vec![
            TreeNode::new("c1", "Child 1", Level::Task),
            TreeNode::new("c2", "Child 2", Level::Task),
        ];
        let parent = TreeNode::new("p1", "Parent", Level::Ticket).with_children(children);
        assert_eq!(parent.children.len(), 2);
    }

    #[test]
    fn test_tree_node_has_children() {
        let leaf = TreeNode::new("leaf", "Leaf", Level::Task);
        assert!(!leaf.has_children());

        let parent = TreeNode::new("parent", "Parent", Level::Ticket).with_child(leaf.clone());
        assert!(parent.has_children());
    }

    // ========================================
    // TreeState tests
    // ========================================

    #[test]
    fn test_tree_state_new() {
        let state = TreeState::new();
        assert!(!state.is_expanded("any"));
    }

    #[test]
    fn test_tree_state_expand() {
        let mut state = TreeState::new();
        state.expand("node1");
        assert!(state.is_expanded("node1"));
        assert!(!state.is_expanded("node2"));
    }

    #[test]
    fn test_tree_state_collapse() {
        let mut state = TreeState::new();
        state.expand("node1");
        assert!(state.is_expanded("node1"));
        state.collapse("node1");
        assert!(!state.is_expanded("node1"));
    }

    #[test]
    fn test_tree_state_toggle() {
        let mut state = TreeState::new();

        // Toggle to expand
        state.toggle("node1");
        assert!(state.is_expanded("node1"));

        // Toggle to collapse
        state.toggle("node1");
        assert!(!state.is_expanded("node1"));
    }

    #[test]
    fn test_tree_state_collapse_all() {
        let mut state = TreeState::new();
        state.expand("node1");
        state.expand("node2");
        state.collapse_all();
        assert!(!state.is_expanded("node1"));
        assert!(!state.is_expanded("node2"));
    }

    #[test]
    fn test_tree_state_expand_all() {
        let mut state = TreeState::new();
        let roots = vec![TreeNode::new("epic1", "Epic", Level::Epic).with_child(
            TreeNode::new("ticket1", "Ticket", Level::Ticket).with_child(TreeNode::new(
                "task1",
                "Task",
                Level::Task,
            )),
        )];

        state.expand_all(&roots);

        assert!(state.is_expanded("epic1"));
        assert!(state.is_expanded("ticket1"));
        // task1 has no children, so it should not be in expanded set
        assert!(!state.is_expanded("task1"));
    }

    // ========================================
    // flatten_tree tests
    // ========================================

    #[test]
    fn test_flatten_tree_empty() {
        let state = TreeState::new();
        let result = flatten_tree(&[], &state);
        assert!(result.is_empty());
    }

    #[test]
    fn test_flatten_tree_single_node() {
        let roots = vec![TreeNode::new("root", "Root", Level::Epic)];
        let state = TreeState::new();
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "root");
        assert_eq!(result[0].depth, 0);
        assert!(!result[0].has_children);
    }

    #[test]
    fn test_flatten_tree_collapsed_hides_children() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_child(TreeNode::new(
                "child",
                "Child",
                Level::Ticket,
            )),
        ];

        let state = TreeState::new(); // All collapsed
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "parent");
        assert!(result[0].has_children);
        assert!(!result[0].is_expanded);
    }

    #[test]
    fn test_flatten_tree_expanded_shows_children() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_child(TreeNode::new(
                "child",
                "Child",
                Level::Ticket,
            )),
        ];

        let mut state = TreeState::new();
        state.expand("parent");
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "parent");
        assert!(result[0].is_expanded);
        assert_eq!(result[1].id, "child");
        assert_eq!(result[1].depth, 1);
    }

    #[test]
    fn test_flatten_tree_depth_levels() {
        let roots = vec![TreeNode::new("epic", "Epic", Level::Epic).with_child(
            TreeNode::new("ticket", "Ticket", Level::Ticket).with_child(TreeNode::new(
                "task",
                "Task",
                Level::Task,
            )),
        )];

        let mut state = TreeState::new();
        state.expand("epic");
        state.expand("ticket");
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].depth, 0); // epic
        assert_eq!(result[1].depth, 1); // ticket
        assert_eq!(result[2].depth, 2); // task
    }

    #[test]
    fn test_flatten_tree_returns_only_root_when_all_collapsed() {
        let roots = vec![
            TreeNode::new("epic1", "Epic 1", Level::Epic).with_child(TreeNode::new(
                "ticket1",
                "Ticket 1",
                Level::Ticket,
            )),
            TreeNode::new("epic2", "Epic 2", Level::Epic).with_child(TreeNode::new(
                "ticket2",
                "Ticket 2",
                Level::Ticket,
            )),
        ];

        let state = TreeState::new(); // All collapsed
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "epic1");
        assert_eq!(result[1].id, "epic2");
    }

    #[test]
    fn test_flatten_tree_includes_children_of_expanded_in_order() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_children(vec![
                TreeNode::new("c1", "Child 1", Level::Ticket),
                TreeNode::new("c2", "Child 2", Level::Ticket),
                TreeNode::new("c3", "Child 3", Level::Ticket),
            ]),
        ];

        let mut state = TreeState::new();
        state.expand("parent");
        let result = flatten_tree(&roots, &state);

        assert_eq!(result.len(), 4);
        assert_eq!(result[0].id, "parent");
        assert_eq!(result[1].id, "c1");
        assert_eq!(result[2].id, "c2");
        assert_eq!(result[3].id, "c3");
    }

    // ========================================
    // FlatNode tests
    // ========================================

    #[test]
    fn test_flat_node_with_children_collapsed_prefix() {
        let node = FlatNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: Level::Epic,
            status: Status::Todo,
            depth: 0,
            has_children: true,
            is_expanded: false,
        };

        // When collapsed with children, should use collapsed prefix
        assert!(node.has_children);
        assert!(!node.is_expanded);
    }

    #[test]
    fn test_flat_node_with_children_expanded_prefix() {
        let node = FlatNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: Level::Epic,
            status: Status::Todo,
            depth: 0,
            has_children: true,
            is_expanded: true,
        };

        assert!(node.has_children);
        assert!(node.is_expanded);
    }

    #[test]
    fn test_flat_node_leaf_prefix() {
        let node = FlatNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: Status::Todo,
            depth: 0,
            has_children: false,
            is_expanded: false,
        };

        assert!(!node.has_children);
    }

    #[test]
    fn test_child_indented_two_spaces_per_depth() {
        let flat = FlatNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: Status::Todo,
            depth: 2,
            has_children: false,
            is_expanded: false,
        };

        // Depth of 2 should result in 4 spaces of indentation
        let indent = "  ".repeat(flat.depth);
        assert_eq!(indent.len(), 4);
    }

    // ========================================
    // Prefix constants tests
    // ========================================

    #[test]
    fn test_prefix_constants() {
        // Verify the prefix characters are as specified
        assert_eq!(prefix::COLLAPSED, "\u{25B8}"); // ▸
        assert_eq!(prefix::EXPANDED, "\u{25BE}"); // ▾
        assert_eq!(prefix::LEAF, "\u{2022}"); // •
    }

    // ========================================
    // status_color tests
    // ========================================

    #[test]
    fn test_status_color() {
        assert_eq!(status_color(&Status::Done), Color::Green);
        assert_eq!(status_color(&Status::InProgress), Color::Yellow);
        assert_eq!(status_color(&Status::Blocked), Color::Red);
        assert_eq!(status_color(&Status::Todo), Color::White);
    }
}
