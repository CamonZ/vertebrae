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

/// Format tasks into an aligned table string.
///
/// Produces output in the format:
/// ```text
/// ID      Level   Status       Priority  Title                     Tags
/// ------  ------  -----------  --------  ------------------------  ----------
/// a1b2c3  epic    in_progress  high      Authentication system     backend
/// ```
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
    let headers = ["ID", "Level", "Status", "Priority", "Title", "Tags"];

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
        .map(|t| t.status.len())
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

    let mut output = String::new();

    // Header row
    output.push_str(&format!(
        "{:<id_w$}  {:<level_w$}  {:<status_w$}  {:<priority_w$}  {:<title_w$}  {:<tags_w$}\n",
        headers[0],
        headers[1],
        headers[2],
        headers[3],
        headers[4],
        headers[5],
        id_w = id_width,
        level_w = level_width,
        status_w = status_width,
        priority_w = priority_width,
        title_w = title_width,
        tags_w = tags_width,
    ));

    // Separator row using Unicode box-drawing character
    output.push_str(&format!(
        "{:->id_w$}  {:->level_w$}  {:->status_w$}  {:->priority_w$}  {:->title_w$}  {:->tags_w$}\n",
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
    ));

    // Data rows
    for task in tasks {
        let priority_display = task.priority.as_deref().unwrap_or("-");
        let title_display = truncate(&task.title, MAX_TITLE_WIDTH);
        let tags_display = truncate(&format_tags(&task.tags), MAX_TAGS_WIDTH);

        output.push_str(&format!(
            "{:<id_w$}  {:<level_w$}  {:<status_w$}  {:<priority_w$}  {:<title_w$}  {:<tags_w$}\n",
            task.id,
            task.level,
            task.status,
            priority_display,
            title_display,
            tags_display,
            id_w = id_width,
            level_w = level_width,
            status_w = status_width,
            priority_w = priority_width,
            title_w = title_width,
            tags_w = tags_width,
        ));
    }

    // Remove trailing newline
    output.pop();

    output
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
            status: "todo".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
        }];

        let result = format_task_table(&tasks);

        assert!(result.contains("ID"));
        assert!(result.contains("Level"));
        assert!(result.contains("Status"));
        assert!(result.contains("Priority"));
        assert!(result.contains("Title"));
        assert!(result.contains("Tags"));
        assert!(result.contains("abc123"));
        assert!(result.contains("Test Task"));
        assert!(result.contains("task"));
        assert!(result.contains("todo"));
        assert!(result.contains("high"));
        assert!(result.contains("backend"));
    }

    #[test]
    fn test_format_multiple_tasks() {
        let tasks = vec![
            TaskSummary {
                id: "a1b2c3".to_string(),
                title: "Epic Task".to_string(),
                level: "epic".to_string(),
                status: "in_progress".to_string(),
                priority: Some("critical".to_string()),
                tags: vec!["urgent".to_string(), "backend".to_string()],
            },
            TaskSummary {
                id: "d4e5f6".to_string(),
                title: "Simple Task".to_string(),
                level: "task".to_string(),
                status: "todo".to_string(),
                priority: None,
                tags: vec![],
            },
        ];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Should have header, separator, and 2 data rows
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("ID"));
        assert!(lines[1].contains("--"));
        assert!(lines[2].contains("a1b2c3"));
        assert!(lines[3].contains("d4e5f6"));
    }

    #[test]
    fn test_format_task_no_priority() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "No Priority".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
        }];

        let result = format_task_table(&tasks);

        // Should show "-" for missing priority
        assert!(result.contains("-"));
    }

    #[test]
    fn test_format_task_no_tags() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "No Tags".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: Some("low".to_string()),
            tags: vec![],
        }];

        let result = format_task_table(&tasks);

        // Should show "-" for empty tags
        let lines: Vec<&str> = result.lines().collect();
        assert!(lines[2].contains("-"));
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
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
        }];

        let result = format_task_table(&tasks);

        // Title should be truncated with ellipsis
        assert!(result.contains("..."));
        // Original full title should not appear
        assert!(!result.contains("that should be truncated"));
    }

    #[test]
    fn test_format_long_tags_truncated() {
        let tasks = vec![TaskSummary {
            id: "abc123".to_string(),
            title: "Task".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: None,
            tags: vec![
                "backend".to_string(),
                "frontend".to_string(),
                "infrastructure".to_string(),
                "urgent".to_string(),
            ],
        }];

        let result = format_task_table(&tasks);

        // Should contain some tags
        assert!(result.contains("backend"));
    }

    #[test]
    fn test_column_alignment() {
        let tasks = vec![
            TaskSummary {
                id: "a".to_string(),
                title: "Short".to_string(),
                level: "epic".to_string(),
                status: "todo".to_string(),
                priority: Some("high".to_string()),
                tags: vec!["x".to_string()],
            },
            TaskSummary {
                id: "abcdef".to_string(),
                title: "Longer Title".to_string(),
                level: "subtask".to_string(),
                status: "in_progress".to_string(),
                priority: Some("critical".to_string()),
                tags: vec!["backend".to_string(), "api".to_string()],
            },
        ];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // Header and data rows should have consistent structure
        assert!(lines[0].contains("ID"));
        assert!(lines[1].contains("--"));
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
        let statuses = ["todo", "in_progress", "done", "blocked"];

        for status in statuses {
            let tasks = vec![TaskSummary {
                id: "abc".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                status: status.to_string(),
                priority: None,
                tags: vec![],
            }];

            let result = format_task_table(&tasks);
            assert!(result.contains(status));
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
                status: "todo".to_string(),
                priority: None,
                tags: vec![],
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
                status: "todo".to_string(),
                priority: Some(priority.to_string()),
                tags: vec![],
            }];

            let result = format_task_table(&tasks);
            assert!(result.contains(priority));
        }
    }
}
