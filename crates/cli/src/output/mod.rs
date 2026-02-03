//! Output formatting module for Vertebrae
//!
//! Provides table formatting and display utilities for CLI output.

use crate::commands::list::TaskSummary;

/// Maximum width for the title column before truncation
const MAX_TITLE_WIDTH: usize = 30;

/// Maximum width for the tags column before truncation
const MAX_TAGS_WIDTH: usize = 20;

/// Truncate a string to the specified maximum width, adding ellipsis if needed.
fn truncate(s: &str, max_width: usize) -> String {
    if s.len() <= max_width {
        s.to_string()
    } else if max_width <= 3 {
        s.chars().take(max_width).collect()
    } else {
        format!("{}...", &s[..max_width - 3])
    }
}

/// Format the status display from workflow_name and step_name.
/// Returns "workflow_name:step_name" if both are present, otherwise "unassigned".
fn format_status_display(task: &TaskSummary) -> String {
    match (&task.workflow_name, &task.step_name) {
        (Some(wf), Some(step)) => format!("{}:{}", wf, step),
        _ => "unassigned".to_string(),
    }
}

/// Format tasks into an aligned table string.
///
/// Produces output in the format:
/// ```text
/// ID      Level   Status       Priority  Title                     Tags        [R]
/// ------  ------  -----------  --------  ------------------------  ----------  ---
/// a1b2c3  epic    in_progress  high      Authentication system     backend     [R]
/// ```
///
/// The [R] column indicates tasks that need human review.
///
/// # Arguments
///
/// * `tasks` - Slice of task summaries to format
///
/// # Returns
///
/// A formatted string containing the table, or an empty result message if no tasks.
pub fn format_task_table(tasks: &[TaskSummary]) -> String {
    if tasks.is_empty() {
        return "No tasks found.".to_string();
    }

    // Column headers
    let headers = ["ID", "Level", "Status", "Priority", "Title", "Tags", "[R]"];

    // Calculate column widths based on content
    let id_width = tasks
        .iter()
        .map(|t| t.id.len())
        .max()
        .unwrap_or(0)
        .max(headers[0].len());

    let level_width = tasks
        .iter()
        .map(|t| t.level.len())
        .max()
        .unwrap_or(0)
        .max(headers[1].len());

    let status_width = tasks
        .iter()
        .map(|t| format_status_display(t).len())
        .max()
        .unwrap_or(0)
        .max(headers[2].len());

    let priority_width = tasks
        .iter()
        .map(|t| t.priority.as_ref().map_or(1, |p| p.len()))
        .max()
        .unwrap_or(0)
        .max(headers[3].len());

    let title_width = tasks
        .iter()
        .map(|t| t.title.len().min(MAX_TITLE_WIDTH))
        .max()
        .unwrap_or(0)
        .max(headers[4].len());

    let tags_width = tasks
        .iter()
        .map(|t| format_tags(&t.tags).len().min(MAX_TAGS_WIDTH))
        .max()
        .unwrap_or(0)
        .max(headers[5].len());

    // Review column is fixed width (3 chars for "[R]")
    let review_width = headers[6].len();

    let mut output = String::new();

    // Header row
    output.push_str(&format!(
        "{:<id_w$}  {:<level_w$}  {:<status_w$}  {:<priority_w$}  {:<title_w$}  {:<tags_w$}  {:<review_w$}\n",
        headers[0],
        headers[1],
        headers[2],
        headers[3],
        headers[4],
        headers[5],
        headers[6],
        id_w = id_width,
        level_w = level_width,
        status_w = status_width,
        priority_w = priority_width,
        title_w = title_width,
        tags_w = tags_width,
        review_w = review_width,
    ));

    // Separator row using Unicode box-drawing character
    output.push_str(&format!(
        "{:->id_w$}  {:->level_w$}  {:->status_w$}  {:->priority_w$}  {:->title_w$}  {:->tags_w$}  {:->review_w$}\n",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        id_w = id_width,
        level_w = level_width,
        status_w = status_width,
        priority_w = priority_width,
        title_w = title_width,
        tags_w = tags_width,
        review_w = review_width,
    ));

    // Data rows
    for task in tasks {
        let priority_display = task.priority.as_deref().unwrap_or("-");
        let title_display = truncate(&task.title, MAX_TITLE_WIDTH);
        let tags_display = truncate(&format_tags(&task.tags), MAX_TAGS_WIDTH);
        let review_display = format_review_status(task.needs_human_review);
        let status_display = format_status_display(task);

        output.push_str(&format!(
            "{:<id_w$}  {:<level_w$}  {:<status_w$}  {:<priority_w$}  {:<title_w$}  {:<tags_w$}  {:<review_w$}\n",
            task.id,
            task.level,
            status_display,
            priority_display,
            title_display,
            tags_display,
            review_display,
            id_w = id_width,
            level_w = level_width,
            status_w = status_width,
            priority_w = priority_width,
            title_w = title_width,
            tags_w = tags_width,
            review_w = review_width,
        ));
    }

    // Remove trailing newline
    output.pop();

    output
}

use std::collections::{HashMap, HashSet};

/// A node in the task tree for hierarchical display.
#[derive(Debug, Clone)]
pub struct TreeNode {
    /// The task summary
    pub task: TaskSummary,
    /// Children of this task (direct child_of relationships)
    pub children: Vec<TreeNode>,
}

/// Format tasks as a hierarchical tree showing parent-child relationships.
///
/// Produces output in the format:
/// ```text
/// abc123  epic    todo  Epic Task
/// |-- def456  ticket  in_progress  Ticket 1
/// |   |-- ghi789  task  todo  Task 1
/// |   `-- jkl012  task  done  Task 2
/// `-- mno345  ticket  backlog  Ticket 2
/// ```
///
/// Tasks without parents appear at root level, and children are indented
/// below their parents with box-drawing characters.
///
/// # Arguments
///
/// * `tasks` - Slice of task summaries to format
/// * `parent_map` - Map from task ID to its parent task ID (if any)
///
/// # Returns
///
/// A formatted string containing the tree, or an empty result message if no tasks.
pub fn format_task_tree(tasks: &[TaskSummary], parent_map: &HashMap<String, String>) -> String {
    if tasks.is_empty() {
        return "No tasks found.".to_string();
    }

    // Build lookup maps
    let task_map: HashMap<&str, &TaskSummary> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();

    // Find all task IDs in the result set
    let task_ids: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();

    // Build children map (inverted from parent_map)
    let mut children_map: HashMap<&str, Vec<&str>> = HashMap::new();
    for (child_id, parent_id) in parent_map {
        // Only include relationships where both tasks are in the result set
        if task_ids.contains(child_id.as_str()) && task_ids.contains(parent_id.as_str()) {
            children_map
                .entry(parent_id.as_str())
                .or_default()
                .push(child_id.as_str());
        }
    }

    // Find root tasks (tasks that either have no parent or whose parent is not in the result set)
    let mut root_ids: Vec<&str> = tasks
        .iter()
        .filter(|t| {
            match parent_map.get(&t.id) {
                None => true,                                              // No parent at all
                Some(parent_id) => !task_ids.contains(parent_id.as_str()), // Parent not in results
            }
        })
        .map(|t| t.id.as_str())
        .collect();

    // Sort roots by level priority (epic > ticket > task), then by ID for stability
    root_ids.sort_by(|a, b| {
        let level_a = task_map
            .get(a)
            .map(|t| level_priority(&t.level))
            .unwrap_or(3);
        let level_b = task_map
            .get(b)
            .map(|t| level_priority(&t.level))
            .unwrap_or(3);
        level_a.cmp(&level_b).then_with(|| a.cmp(b))
    });

    // Sort children for each parent
    for children in children_map.values_mut() {
        children.sort_by(|a, b| {
            let level_a = task_map
                .get(*a)
                .map(|t| level_priority(&t.level))
                .unwrap_or(3);
            let level_b = task_map
                .get(*b)
                .map(|t| level_priority(&t.level))
                .unwrap_or(3);
            level_a.cmp(&level_b).then_with(|| a.cmp(b))
        });
    }

    let mut output = String::new();

    // Render each root and its subtree
    for (i, root_id) in root_ids.iter().enumerate() {
        let is_last = i == root_ids.len() - 1;
        render_node(
            &mut output,
            root_id,
            &task_map,
            &children_map,
            "",
            is_last,
            true, // is_root
        );
    }

    // Remove trailing newline
    if output.ends_with('\n') {
        output.pop();
    }

    output
}

/// Get sorting priority for hierarchy levels (lower is higher priority).
fn level_priority(level: &str) -> u8 {
    match level {
        "epic" => 0,
        "ticket" => 1,
        "task" => 2,
        _ => 3,
    }
}

/// Render a node and its children recursively.
fn render_node(
    output: &mut String,
    task_id: &str,
    task_map: &HashMap<&str, &TaskSummary>,
    children_map: &HashMap<&str, Vec<&str>>,
    prefix: &str,
    is_last: bool,
    is_root: bool,
) {
    let Some(task) = task_map.get(task_id) else {
        return;
    };

    // Build the line prefix with tree characters
    let connector = if is_root {
        ""
    } else if is_last {
        "`-- "
    } else {
        "|-- "
    };

    // Format task fields
    let level_display = format!("{:8}", task.level);
    let status_display = format!("{:14}", format_status_display(task));
    let title_display = truncate(&task.title, MAX_TITLE_WIDTH);
    let review_display = if task.needs_human_review == Some(true) {
        " [R]"
    } else {
        ""
    };

    // Write the line
    output.push_str(&format!(
        "{}{}{:<8} {} {} {}{}",
        prefix, connector, task.id, level_display, status_display, title_display, review_display
    ));
    output.push('\n');

    // Get children
    let children = children_map.get(task_id).cloned().unwrap_or_default();

    // Calculate prefix for children
    let child_prefix = if is_root {
        "".to_string()
    } else if is_last {
        format!("{}    ", prefix)
    } else {
        format!("{}|   ", prefix)
    };

    // For root nodes, we need to add initial indentation for children
    let actual_child_prefix = if is_root && !children.is_empty() {
        "".to_string()
    } else {
        child_prefix
    };

    // Render children
    for (i, child_id) in children.iter().enumerate() {
        let child_is_last = i == children.len() - 1;
        render_node(
            output,
            child_id,
            task_map,
            children_map,
            &actual_child_prefix,
            child_is_last,
            false,
        );
    }
}

/// Format the review status indicator.
///
/// Returns "[R]" if needs_human_review is true, otherwise returns an empty string.
fn format_review_status(needs_human_review: Option<bool>) -> &'static str {
    match needs_human_review {
        Some(true) => "[R]",
        _ => "",
    }
}

/// Format tags as a comma-separated string.
fn format_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        "-".to_string()
    } else {
        tags.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_empty_tasks() {
        let tasks: Vec<TaskSummary> = vec![];
        let result = format_task_table(&tasks);
        assert_eq!(result, "No tasks found.");
    }

    #[test]
    fn test_format_single_task() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            needs_human_review: None,
            parent_id: None,
        }];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Should have header, separator, and 1 data row
        assert_eq!(lines.len(), 3, "Expected 3 lines: header, separator, data");

        // Verify header columns
        let header_parts: Vec<&str> = lines[0].split_whitespace().collect();
        assert_eq!(
            header_parts,
            vec!["ID", "Level", "Status", "Priority", "Title", "Tags", "[R]"]
        );

        // Verify separator line contains dashes
        assert!(lines[1].chars().all(|c| c == '-' || c == ' '));

        // Verify data row columns
        let data_parts: Vec<&str> = lines[2].split_whitespace().collect();
        assert_eq!(data_parts[0], "abc123", "ID column");
        assert_eq!(data_parts[1], "task", "Level column");
        assert_eq!(data_parts[2], "default:in_progress", "Status column");
        assert_eq!(data_parts[3], "high", "Priority column");
        assert_eq!(data_parts[4], "Test", "Title column (first word)");
        assert_eq!(data_parts[5], "Task", "Title column (second word)");
        assert_eq!(data_parts[6], "backend", "Tags column");
    }

    #[test]
    fn test_format_multiple_tasks() {
        let tasks = vec![
            TaskSummary {
                id: "a1b2c3".to_string(),
                title: "Epic Task".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: Some("critical".to_string()),
                tags: vec!["urgent".to_string(), "backend".to_string()],
                needs_human_review: Some(true),
                parent_id: None,
            },
            TaskSummary {
                id: "d4e5f6".to_string(),
                title: "Simple Task".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
        ];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Should have header, separator, and 2 data rows
        assert_eq!(lines.len(), 4);

        // Verify header
        let header_parts: Vec<&str> = lines[0].split_whitespace().collect();
        assert_eq!(header_parts[0], "ID");

        // Verify separator contains dashes
        assert!(lines[1].chars().all(|c| c == '-' || c == ' '));

        // Verify first data row
        let row1_parts: Vec<&str> = lines[2].split_whitespace().collect();
        assert_eq!(row1_parts[0], "a1b2c3", "First row ID");

        // Verify second data row
        let row2_parts: Vec<&str> = lines[3].split_whitespace().collect();
        assert_eq!(row2_parts[0], "d4e5f6", "Second row ID");
    }

    #[test]
    fn test_format_task_no_priority() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "No Priority".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            parent_id: None,
        }];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Verify data row - priority column (4th column, index 3) should be "-"
        let data_parts: Vec<&str> = lines[2].split_whitespace().collect();
        assert_eq!(data_parts[3], "-", "Priority column should be '-' for None");
    }

    #[test]
    fn test_format_task_no_tags() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "No Tags".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: Some("low".to_string()),
            tags: vec![],
            needs_human_review: None,
            parent_id: None,
        }];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Verify data row - tags column (last column) should be "-"
        let data_parts: Vec<&str> = lines[2].split_whitespace().collect();
        // Data parts: abc123, task, todo, low, No, Tags, -
        let last_part = data_parts.last().unwrap();
        assert_eq!(*last_part, "-", "Tags column should be '-' for empty tags");
    }

    #[test]
    fn test_format_tags_empty() {
        let tags: Vec<String> = vec![];
        assert_eq!(format_tags(&tags), "-");
    }

    #[test]
    fn test_format_tags_single() {
        let tags = vec!["backend".to_string()];
        assert_eq!(format_tags(&tags), "backend");
    }

    #[test]
    fn test_format_tags_multiple() {
        let tags = vec!["backend".to_string(), "api".to_string(), "v2".to_string()];
        assert_eq!(format_tags(&tags), "backend, api, v2");
    }

    #[test]
    fn test_truncate_short_string() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_exact_length() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_long_string() {
        assert_eq!(truncate("hello world", 8), "hello...");
    }

    #[test]
    fn test_truncate_very_short_max() {
        assert_eq!(truncate("hello", 3), "hel");
        assert_eq!(truncate("hello", 2), "he");
        assert_eq!(truncate("hello", 1), "h");
    }

    #[test]
    fn test_truncate_empty() {
        assert_eq!(truncate("", 10), "");
    }

    #[test]
    fn test_format_long_title_truncated() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "This is a very long task title that should be truncated".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            parent_id: None,
        }];
        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Verify the truncated title appears with ellipsis
        // MAX_TITLE_WIDTH is 30, so the title should be truncated to 27 chars + "..."
        let expected_truncated = truncate(
            "This is a very long task title that should be truncated",
            MAX_TITLE_WIDTH,
        );
        // Verify truncation function produces expected result
        assert_eq!(expected_truncated, "This is a very long task ti...");
        assert!(
            lines[2].contains(&expected_truncated),
            "Data row should contain truncated title"
        );

        // Original full title should not appear
        assert!(
            !result.contains("that should be truncated"),
            "Full title should not appear in output"
        );
    }

    #[test]
    fn test_format_long_tags_truncated() {
        let tags_input = vec![
            "backend".to_string(),
            "frontend".to_string(),
            "infrastructure".to_string(),
            "urgent".to_string(),
        ];
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "Task".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: tags_input.clone(),
            needs_human_review: None,
            parent_id: None,
        }];
        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // The tags should be truncated to MAX_TAGS_WIDTH (20)
        let full_tags = format_tags(&tags_input);
        let expected_truncated = truncate(&full_tags, MAX_TAGS_WIDTH);
        assert_eq!(expected_truncated, "backend, frontend...");
        assert!(
            lines[2].contains(&expected_truncated),
            "Data row should contain truncated tags"
        );
    }

    #[test]
    fn test_column_alignment() {
        let tasks = vec![
            TaskSummary {
                id: "a".to_string(),
                title: "Short".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: Some("high".to_string()),
                tags: vec!["x".to_string()],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "abcdef".to_string(),
                title: "Longer Title".to_string(),
                level: "subtask".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: Some("critical".to_string()),
                tags: vec!["backend".to_string(), "api".to_string()],
                needs_human_review: Some(true),
                parent_id: None,
            },
        ];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Verify header row
        let header_parts: Vec<&str> = lines[0].split_whitespace().collect();
        assert_eq!(header_parts[0], "ID");

        // Verify separator contains only dashes and spaces
        assert!(lines[1].chars().all(|c| c == '-' || c == ' '));

        // Verify column alignment by checking that columns have consistent spacing
        // All lines should have the same length (properly aligned)
        let header_len = lines[0].len();
        let sep_len = lines[1].len();
        assert_eq!(
            header_len, sep_len,
            "Header and separator should have same length"
        );
    }

    #[test]
    fn test_max_title_width_constant() {
        assert_eq!(MAX_TITLE_WIDTH, 30);
    }

    #[test]
    fn test_max_tags_width_constant() {
        assert_eq!(MAX_TAGS_WIDTH, 20);
    }

    #[test]
    fn test_format_all_statuses() {
        let step_names = ["backlog", "in_progress", "done", "rejected"];

        for step_name in step_names {
            let tasks = vec![TaskSummary {
                id: "abc".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some(step_name.to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            }];
            let result = format_task_table(&tasks);
            assert!(result.contains(step_name));
        }
    }

    #[test]
    fn test_format_all_levels() {
        let levels = ["epic", "ticket", "task", "subtask"];

        for level in levels {
            let tasks = vec![TaskSummary {
                id: "abc".to_string(),
                title: "Test".to_string(),
                level: level.to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            }];
            let result = format_task_table(&tasks);
            assert!(result.contains(level));
        }
    }

    #[test]
    fn test_format_all_priorities() {
        let priorities = ["low", "medium", "high", "critical"];

        for priority in priorities {
            let tasks = vec![TaskSummary {
                id: "abc".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: Some(priority.to_string()),
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            }];
            let result = format_task_table(&tasks);
            assert!(result.contains(priority));
        }
    }

    #[test]
    fn test_format_review_status() {
        // Test the format_review_status function
        assert_eq!(format_review_status(Some(true)), "[R]");
        assert_eq!(format_review_status(Some(false)), "");
        assert_eq!(format_review_status(None), "");
    }

    #[test]
    fn test_format_task_with_review_indicator() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "Needs Review".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: Some(true),
            parent_id: None,
        }];

        let result = format_task_table(&tasks);

        // Verify [R] indicator appears in data row
        assert!(
            result.contains("[R]"),
            "Output should contain [R] indicator for task needing review"
        );
    }

    #[test]
    fn test_format_task_without_review_indicator() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "No Review".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: Some(false),
            parent_id: None,
        }];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // The header has [R], but data row should not have [R] indicator
        // Check that line 2 (data row) does NOT end with [R]
        let data_row = lines[2];
        let data_parts: Vec<&str> = data_row.split_whitespace().collect();

        // Data parts should not contain [R] as the last element
        let has_review_indicator = data_parts.last().is_some_and(|&s| s == "[R]");
        assert!(
            !has_review_indicator,
            "Data row should not have [R] indicator when needs_human_review is false"
        );
    }

    // ========================================
    // Tree format tests
    // ========================================

    #[test]
    fn test_format_task_tree_empty() {
        let tasks: Vec<TaskSummary> = vec![];
        let parent_map = HashMap::new();
        let result = format_task_tree(&tasks, &parent_map);
        assert_eq!(result, "No tasks found.");
    }

    #[test]
    fn test_format_task_tree_single_root() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "Epic Task".to_string(),
            level: "epic".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            parent_id: None,
        }];
        let parent_map = HashMap::new();

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("abc123"));
        assert!(lines[0].contains("epic"));
        assert!(lines[0].contains("in_progress"));
        assert!(lines[0].contains("Epic Task"));
    }

    #[test]
    fn test_format_task_tree_parent_child() {
        let tasks = vec![
            TaskSummary {
                id: "epic1".to_string(),
                title: "Epic Task".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "ticket1".to_string(),
                title: "Ticket Task".to_string(),
                level: "ticket".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
        ];

        let mut parent_map = HashMap::new();
        parent_map.insert("ticket1".to_string(), "epic1".to_string());

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        assert_eq!(lines.len(), 2);
        // First line should be the epic (root)
        assert!(lines[0].contains("epic1"));
        // Second line should be the ticket (child) with tree connector
        assert!(
            lines[1].contains("`-- ") || lines[1].contains("|-- "),
            "Child should have tree connector"
        );
        assert!(lines[1].contains("ticket1"));
    }

    #[test]
    fn test_format_task_tree_multiple_children() {
        let tasks = vec![
            TaskSummary {
                id: "epic1".to_string(),
                title: "Epic".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "ticket1".to_string(),
                title: "Ticket 1".to_string(),
                level: "ticket".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "ticket2".to_string(),
                title: "Ticket 2".to_string(),
                level: "ticket".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
        ];

        let mut parent_map = HashMap::new();
        parent_map.insert("ticket1".to_string(), "epic1".to_string());
        parent_map.insert("ticket2".to_string(), "epic1".to_string());

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        assert_eq!(lines.len(), 3);
        // Epic should be first (root)
        assert!(lines[0].contains("epic1"));
        // First child should use |--
        assert!(lines[1].contains("|-- ") || lines[1].contains("`-- "));
        // Last child should use `--
        assert!(lines[2].contains("`-- "));
    }

    #[test]
    fn test_format_task_tree_nested_hierarchy() {
        let tasks = vec![
            TaskSummary {
                id: "epic1".to_string(),
                title: "Epic".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "ticket1".to_string(),
                title: "Ticket".to_string(),
                level: "ticket".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "task1".to_string(),
                title: "Task".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
        ];

        let mut parent_map = HashMap::new();
        parent_map.insert("ticket1".to_string(), "epic1".to_string());
        parent_map.insert("task1".to_string(), "ticket1".to_string());

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("epic1"), "Epic should be at root");
        assert!(lines[1].contains("ticket1"), "Ticket should be second");
        assert!(lines[2].contains("task1"), "Task should be third");
    }

    #[test]
    fn test_format_task_tree_orphan_tasks() {
        // Test that tasks without parents in the map appear at root level
        let tasks = vec![
            TaskSummary {
                id: "task1".to_string(),
                title: "Orphan Task".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            TaskSummary {
                id: "epic1".to_string(),
                title: "Epic".to_string(),
                level: "epic".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
        ];

        let parent_map = HashMap::new();

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        // Both should be at root level (no tree connectors at start)
        assert_eq!(lines.len(), 2);
        // Epic should come first (sorted by level priority)
        assert!(lines[0].contains("epic1"));
        assert!(lines[1].contains("task1"));
    }

    #[test]
    fn test_format_task_tree_parent_not_in_results() {
        // When parent is not in the results, child should appear as root
        let tasks = vec![TaskSummary {
            id: "ticket1".to_string(),
            title: "Orphan Ticket".to_string(),
            level: "ticket".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            parent_id: None,
        }];

        let mut parent_map = HashMap::new();
        parent_map.insert("ticket1".to_string(), "epic_not_in_results".to_string());

        let result = format_task_tree(&tasks, &parent_map);
        let lines: Vec<&str> = result.lines().collect();

        assert_eq!(lines.len(), 1);
        // No tree connector since parent is not in results
        assert!(!lines[0].starts_with("|"));
        assert!(!lines[0].starts_with("`"));
        assert!(lines[0].contains("ticket1"));
    }

    #[test]
    fn test_format_task_tree_with_review_indicator() {
        let tasks = vec![TaskSummary {
            id: "task1".to_string(),
            title: "Needs Review".to_string(),
            level: "task".to_string(),
            workflow_name: Some("default".to_string()),
            step_name: Some("pending_review".to_string()),
            priority: None,
            tags: vec![],
            needs_human_review: Some(true),
            parent_id: None,
        }];

        let parent_map = HashMap::new();

        let result = format_task_tree(&tasks, &parent_map);
        assert!(result.contains("[R]"), "Should show review indicator");
    }

    #[test]
    fn test_level_priority() {
        assert_eq!(level_priority("epic"), 0);
        assert_eq!(level_priority("ticket"), 1);
        assert_eq!(level_priority("task"), 2);
        assert_eq!(level_priority("unknown"), 3);
    }

    #[test]
    fn test_tree_node_clone() {
        let node = TreeNode {
            task: TaskSummary {
                id: "test".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            children: vec![],
        };

        let cloned = node.clone();
        assert_eq!(cloned.task.id, "test");
        assert!(cloned.children.is_empty());
    }

    #[test]
    fn test_tree_node_debug() {
        let node = TreeNode {
            task: TaskSummary {
                id: "test".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                workflow_name: Some("default".to_string()),
                step_name: Some("in_progress".to_string()),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                parent_id: None,
            },
            children: vec![],
        };

        let debug_str = format!("{:?}", node);
        assert!(debug_str.contains("TreeNode"));
        assert!(debug_str.contains("test"));
    }
}
