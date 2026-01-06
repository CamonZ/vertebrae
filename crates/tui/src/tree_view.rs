//! Tree View widget for displaying full task hierarchy.
//!
//! Shows a comprehensive tree view of all tasks (epics, tickets, tasks)
//! in a hierarchical format with proper indentation and visual indicators.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use vertebrae_db::{Level, Status};

use crate::navigation::TreeNode;

/// Visual prefix characters for tree structure.
mod tree_chars {
    /// Branch connector for intermediate items.
    pub const BRANCH: &str = "\u{251C}\u{2500}\u{2500}"; // ├──
    /// Last item connector.
    pub const LAST_BRANCH: &str = "\u{2514}\u{2500}\u{2500}"; // └──
    /// Vertical line for continuing structure.
    pub const VERTICAL: &str = "\u{2502}   "; // │
    /// Empty space for alignment.
    pub const SPACE: &str = "    ";
}

/// Level indicator characters.
mod level_icons {
    /// Epic icon.
    pub const EPIC: &str = "\u{25C6}"; // ◆
    /// Ticket icon.
    pub const TICKET: &str = "\u{25CF}"; // ●
    /// Task icon.
    pub const TASK: &str = "\u{25CB}"; // ○
}

/// Render the tree view panel showing the full task hierarchy.
///
/// This view shows all tasks in a comprehensive tree format, displaying
/// the complete epic -> ticket -> task hierarchy with visual connectors.
///
/// # Arguments
///
/// * `frame` - The frame to render to
/// * `area` - The area to render within
/// * `tree_roots` - The root nodes of the task tree
/// * `empty_message` - Message to show when no tasks exist
pub fn render_tree_view(
    frame: &mut Frame,
    area: Rect,
    tree_roots: &[TreeNode],
    empty_message: Option<&str>,
) {
    let block = Block::default()
        .title(" Tree ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    if tree_roots.is_empty() {
        let message = empty_message.unwrap_or("No tasks found");
        let paragraph = Paragraph::new(message)
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(paragraph, area);
        return;
    }

    // Build the tree lines
    let lines = build_tree_lines(tree_roots);

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, area);
}

/// Build all lines for the tree view.
fn build_tree_lines(roots: &[TreeNode]) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    for (i, root) in roots.iter().enumerate() {
        let is_last = i == roots.len() - 1;
        build_node_lines(&mut lines, root, Vec::new(), is_last);
    }

    lines
}

/// Recursively build lines for a node and its children.
///
/// # Arguments
///
/// * `lines` - The accumulator for output lines
/// * `node` - The current node to render
/// * `prefix_parts` - The prefix parts for indentation (each part is either VERTICAL or SPACE)
/// * `is_last` - Whether this node is the last sibling
fn build_node_lines(
    lines: &mut Vec<Line<'static>>,
    node: &TreeNode,
    prefix_parts: Vec<bool>,
    is_last: bool,
) {
    // Build the prefix string from parts
    let prefix = build_prefix(&prefix_parts, is_last);

    // Build the node line
    let line = build_node_line(&prefix, node);
    lines.push(line);

    // Process children
    if !node.children.is_empty() {
        let child_count = node.children.len();
        for (i, child) in node.children.iter().enumerate() {
            let child_is_last = i == child_count - 1;

            // Build new prefix parts for children
            let mut child_prefix_parts = prefix_parts.clone();
            // Add whether current node is NOT last (determines if we draw vertical line)
            child_prefix_parts.push(!is_last);

            build_node_lines(lines, child, child_prefix_parts, child_is_last);
        }
    }
}

/// Build the prefix string for a node.
fn build_prefix(prefix_parts: &[bool], is_last: bool) -> String {
    let mut prefix = String::new();

    // Add vertical lines or spaces for each ancestor level
    for &has_vertical in prefix_parts {
        if has_vertical {
            prefix.push_str(tree_chars::VERTICAL);
        } else {
            prefix.push_str(tree_chars::SPACE);
        }
    }

    // Add the branch connector
    if !prefix_parts.is_empty() || is_last {
        if is_last {
            prefix.push_str(tree_chars::LAST_BRANCH);
        } else {
            prefix.push_str(tree_chars::BRANCH);
        }
    } else {
        prefix.push_str(tree_chars::BRANCH);
    }

    prefix
}

/// Build a single node line with styling.
fn build_node_line(prefix: &str, node: &TreeNode) -> Line<'static> {
    let mut spans = Vec::new();

    // Prefix (tree structure)
    spans.push(Span::styled(
        prefix.to_string(),
        Style::default().fg(Color::DarkGray),
    ));

    // Level icon
    let (icon, level_color) = match node.level {
        Level::Epic => (level_icons::EPIC, Color::Magenta),
        Level::Ticket => (level_icons::TICKET, Color::Blue),
        Level::Task => (level_icons::TASK, Color::White),
    };

    spans.push(Span::styled(
        format!("{} ", icon),
        Style::default().fg(level_color),
    ));

    // Status indicator
    let (status_icon, status_color) = match node.status {
        Status::Done => ("[x]", Color::Green),
        Status::InProgress => ("[>]", Color::Yellow),
        Status::Blocked => ("[!]", Color::Red),
        Status::Todo => ("[ ]", Color::DarkGray),
    };

    spans.push(Span::styled(
        format!("{} ", status_icon),
        Style::default().fg(status_color),
    ));

    // Title with level-based styling
    let title_style = match node.level {
        Level::Epic => Style::default()
            .fg(Color::Magenta)
            .add_modifier(Modifier::BOLD),
        Level::Ticket => Style::default().fg(Color::Blue),
        Level::Task => Style::default().fg(Color::White),
    };

    spans.push(Span::styled(node.title.clone(), title_style));

    // Show children count for non-leaf nodes
    if !node.children.is_empty() {
        spans.push(Span::styled(
            format!(" ({})", node.children.len()),
            Style::default().fg(Color::DarkGray),
        ));
    }

    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================
    // build_prefix tests
    // ========================================

    #[test]
    fn test_build_prefix_root_only() {
        // For a single root node that is last
        let prefix = build_prefix(&[], true);
        assert_eq!(prefix, tree_chars::LAST_BRANCH);
    }

    #[test]
    fn test_build_prefix_root_not_last() {
        // For a root node that is not last
        let prefix = build_prefix(&[], false);
        assert_eq!(prefix, tree_chars::BRANCH);
    }

    #[test]
    fn test_build_prefix_child_with_vertical() {
        // Child with vertical line from parent
        let prefix = build_prefix(&[true], false);
        let expected = format!("{}{}", tree_chars::VERTICAL, tree_chars::BRANCH);
        assert_eq!(prefix, expected);
    }

    #[test]
    fn test_build_prefix_child_last_with_space() {
        // Last child with space (no vertical from parent)
        let prefix = build_prefix(&[false], true);
        let expected = format!("{}{}", tree_chars::SPACE, tree_chars::LAST_BRANCH);
        assert_eq!(prefix, expected);
    }

    #[test]
    fn test_build_prefix_deeply_nested() {
        // Deep nesting: has_vertical, no_vertical, has_vertical
        let prefix = build_prefix(&[true, false, true], true);
        let expected = format!(
            "{}{}{}{}",
            tree_chars::VERTICAL,
            tree_chars::SPACE,
            tree_chars::VERTICAL,
            tree_chars::LAST_BRANCH
        );
        assert_eq!(prefix, expected);
    }

    // ========================================
    // build_node_line tests
    // ========================================

    #[test]
    fn test_build_node_line_epic() {
        let node = TreeNode::new("epic1", "Epic Title", Level::Epic);
        let line = build_node_line("", &node);

        // Should have spans for: icon, status, title
        assert!(line.spans.len() >= 3);
    }

    #[test]
    fn test_build_node_line_with_children_count() {
        let node = TreeNode::new("parent", "Parent", Level::Epic)
            .with_child(TreeNode::new("child1", "Child 1", Level::Ticket))
            .with_child(TreeNode::new("child2", "Child 2", Level::Ticket));

        let line = build_node_line("", &node);

        // Should include child count
        let line_text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(line_text.contains("(2)"));
    }

    #[test]
    fn test_build_node_line_status_done() {
        let node = TreeNode::new("task1", "Task", Level::Task).with_status(Status::Done);
        let line = build_node_line("", &node);

        let line_text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(line_text.contains("[x]"));
    }

    #[test]
    fn test_build_node_line_status_in_progress() {
        let node = TreeNode::new("task1", "Task", Level::Task).with_status(Status::InProgress);
        let line = build_node_line("", &node);

        let line_text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(line_text.contains("[>]"));
    }

    #[test]
    fn test_build_node_line_status_blocked() {
        let node = TreeNode::new("task1", "Task", Level::Task).with_status(Status::Blocked);
        let line = build_node_line("", &node);

        let line_text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(line_text.contains("[!]"));
    }

    #[test]
    fn test_build_node_line_status_todo() {
        let node = TreeNode::new("task1", "Task", Level::Task).with_status(Status::Todo);
        let line = build_node_line("", &node);

        let line_text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(line_text.contains("[ ]"));
    }

    // ========================================
    // build_tree_lines tests
    // ========================================

    #[test]
    fn test_build_tree_lines_empty() {
        let lines = build_tree_lines(&[]);
        assert!(lines.is_empty());
    }

    #[test]
    fn test_build_tree_lines_single_root() {
        let roots = vec![TreeNode::new("epic1", "Epic 1", Level::Epic)];
        let lines = build_tree_lines(&roots);

        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn test_build_tree_lines_multiple_roots() {
        let roots = vec![
            TreeNode::new("epic1", "Epic 1", Level::Epic),
            TreeNode::new("epic2", "Epic 2", Level::Epic),
            TreeNode::new("epic3", "Epic 3", Level::Epic),
        ];
        let lines = build_tree_lines(&roots);

        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn test_build_tree_lines_with_children() {
        let roots = vec![
            TreeNode::new("epic1", "Epic", Level::Epic).with_children(vec![
                TreeNode::new("ticket1", "Ticket 1", Level::Ticket),
                TreeNode::new("ticket2", "Ticket 2", Level::Ticket),
            ]),
        ];

        let lines = build_tree_lines(&roots);

        // Should have: epic + 2 tickets = 3 lines
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn test_build_tree_lines_nested_hierarchy() {
        let roots = vec![TreeNode::new("epic", "Epic", Level::Epic).with_child(
            TreeNode::new("ticket", "Ticket", Level::Ticket).with_child(TreeNode::new(
                "task",
                "Task",
                Level::Task,
            )),
        )];

        let lines = build_tree_lines(&roots);

        // Should have: epic + ticket + task = 3 lines
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn test_tree_view_shows_all_statuses() {
        let roots = vec![
            TreeNode::new("epic", "Epic", Level::Epic)
                .with_status(Status::InProgress)
                .with_children(vec![
                    TreeNode::new("t1", "Done Task", Level::Ticket).with_status(Status::Done),
                    TreeNode::new("t2", "Todo Task", Level::Ticket).with_status(Status::Todo),
                    TreeNode::new("t3", "Blocked Task", Level::Ticket).with_status(Status::Blocked),
                ]),
        ];

        let lines = build_tree_lines(&roots);
        assert_eq!(lines.len(), 4);
    }

    // ========================================
    // Level icon tests
    // ========================================

    #[test]
    fn test_level_icons_are_distinct() {
        assert_ne!(level_icons::EPIC, level_icons::TICKET);
        assert_ne!(level_icons::TICKET, level_icons::TASK);
        assert_ne!(level_icons::EPIC, level_icons::TASK);
    }

    // ========================================
    // Tree chars tests
    // ========================================

    #[test]
    fn test_tree_chars_are_proper_length() {
        // All tree chars should be consistent width
        // BRANCH, LAST_BRANCH, VERTICAL, SPACE should all provide same visual width
        assert_eq!(tree_chars::BRANCH.chars().count(), 3); // ├──
        assert_eq!(tree_chars::LAST_BRANCH.chars().count(), 3); // └──
        assert_eq!(tree_chars::VERTICAL.chars().count(), 4); // │   (3 spaces)
        assert_eq!(tree_chars::SPACE.chars().count(), 4); // 4 spaces
    }
}
