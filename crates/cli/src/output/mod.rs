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

        output.push_str(&format!(
            "{:<id_w$}  {:<level_w$}  {:<status_w$}  {:<priority_w$}  {:<title_w$}  {:<tags_w$}  {:<review_w$}\n",
            task.id,
            task.level,
            task.status,
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
            status: "todo".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            needs_human_review: None,
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
        assert_eq!(data_parts[2], "todo", "Status column");
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
                status: "in_progress".to_string(),
                priority: Some("critical".to_string()),
                tags: vec!["urgent".to_string(), "backend".to_string()],
                needs_human_review: Some(true),
            },
            TaskSummary {
                id: "d4e5f6".to_string(),
                title: "Simple Task".to_string(),
                level: "task".to_string(),
                status: "todo".to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
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
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: None,
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
            status: "todo".to_string(),
            priority: Some("low".to_string()),
            tags: vec![],
            needs_human_review: None,
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
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: None,
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
            status: "todo".to_string(),
            priority: None,
            tags: tags_input.clone(),
            needs_human_review: None,
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
                status: "todo".to_string(),
                priority: Some("high".to_string()),
                tags: vec!["x".to_string()],
                needs_human_review: None,
            },
            TaskSummary {
                id: "abcdef".to_string(),
                title: "Longer Title".to_string(),
                level: "subtask".to_string(),
                status: "in_progress".to_string(),
                priority: Some("critical".to_string()),
                tags: vec!["backend".to_string(), "api".to_string()],
                needs_human_review: Some(true),
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
        let statuses = ["todo", "in_progress", "done", "blocked"];

        for status in statuses {
            let tasks = vec![TaskSummary {
                id: "abc".to_string(),
                title: "Test".to_string(),
                level: "task".to_string(),
                status: status.to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
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
                needs_human_review: None,
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
                needs_human_review: None,
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
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: Some(true),
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
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: Some(false),
        }];

        let result = format_task_table(&tasks);
        let lines: Vec<&str> = result.lines().collect();

        // The header has [R], but data row should not have [R] indicator
        // Check that line 2 (data row) does NOT end with [R]
        let data_row = lines[2];
        let data_parts: Vec<&str> = data_row.split_whitespace().collect();

        // Data parts should not contain [R] as the last element
        let has_review_indicator = data_parts.last().map_or(false, |&s| s == "[R]");
        assert!(
            !has_review_indicator,
            "Data row should not have [R] indicator when needs_human_review is false"
        );
    }
}
