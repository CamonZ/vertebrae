//! Details view widget for displaying full task information.
//!
//! Provides a widget that renders comprehensive task details including
//! metadata, sections, code refs, and relationships.

use chrono::{DateTime, Utc};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use vertebrae_db::{CodeRef, Level, Priority, Progress, Section, SectionType, Status, Task};

/// Additional relationship data for a task
#[derive(Debug, Clone, Default)]
pub struct TaskRelationships {
    /// Parent task ID and title
    pub parent: Option<(String, String)>,
    /// Tasks this task depends on (blockers): (id, title)
    pub blocked_by: Vec<(String, String)>,
    /// Tasks that depend on this task: (id, title)
    pub blocks: Vec<(String, String)>,
}

/// Full task details including relationships
#[derive(Debug, Clone)]
pub struct TaskDetails {
    /// The core task data
    pub task: Task,
    /// The task ID (short form)
    pub id: String,
    /// Relationship information
    pub relationships: TaskRelationships,
    /// Progress information for tasks with children (optional)
    pub progress: Option<Progress>,
}

/// Render the details view for a task.
///
/// If `task` is `None`, displays "No task selected" message.
///
/// # Arguments
///
/// * `frame` - The frame to render to
/// * `area` - The area to render within
/// * `task` - The task details to display, or None
/// * `is_focused` - Whether this panel currently has focus
/// * `scroll_offset` - Vertical scroll offset for the content
pub fn render_details_view(
    frame: &mut Frame,
    area: Rect,
    task: Option<&TaskDetails>,
    is_focused: bool,
    scroll_offset: usize,
) {
    let border_color = if is_focused {
        Color::Yellow
    } else {
        Color::Cyan
    };

    let block = Block::default()
        .title(" Details ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));

    match task {
        Some(details) => {
            let lines = build_details_lines(details);
            let paragraph = Paragraph::new(lines)
                .block(block)
                .wrap(Wrap { trim: false })
                .scroll((scroll_offset as u16, 0));
            frame.render_widget(paragraph, area);
        }
        None => {
            let paragraph = Paragraph::new("No task selected")
                .block(block)
                .style(Style::default().fg(Color::DarkGray));
            frame.render_widget(paragraph, area);
        }
    }
}

/// Build all the lines for the details view.
fn build_details_lines(details: &TaskDetails) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let task = &details.task;

    // Header section
    lines.extend(build_header_section(details));
    lines.push(Line::from(""));

    // Progress section (if task has children)
    if let Some(progress) = &details.progress {
        lines.extend(build_progress_section(progress));
        lines.push(Line::from(""));
    }

    // Metadata section
    lines.extend(build_metadata_section(task));
    lines.push(Line::from(""));

    // Tags section (if any)
    if !task.tags.is_empty() {
        lines.extend(build_tags_section(&task.tags));
        lines.push(Line::from(""));
    }

    // Sections (goal, context, steps, constraints, testing criteria)
    if !task.sections.is_empty() {
        lines.extend(build_sections(&task.sections));
        lines.push(Line::from(""));
    }

    // Code refs section (if any)
    if !task.code_refs.is_empty() {
        lines.extend(build_code_refs_section(&task.code_refs));
        lines.push(Line::from(""));
    }

    // Relationships section
    lines.extend(build_relationships_section(&details.relationships));
    lines.push(Line::from(""));

    // Timestamps section
    lines.extend(build_timestamps_section(task));

    lines
}

/// Build the header section with ID, title, and badges.
fn build_header_section(details: &TaskDetails) -> Vec<Line<'static>> {
    let task = &details.task;

    // ID line
    let id_line = Line::from(vec![
        Span::styled("ID: ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            details.id.clone(),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
    ]);

    // Title line
    let title_line = Line::from(vec![Span::styled(
        task.title.clone(),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )]);

    // Badges line (level and status)
    let level_style = match task.level {
        Level::Epic => Style::default()
            .fg(Color::Magenta)
            .add_modifier(Modifier::BOLD),
        Level::Ticket => Style::default()
            .fg(Color::Blue)
            .add_modifier(Modifier::BOLD),
        Level::Task => Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    };

    let status_style = match task.status {
        Status::Todo => Style::default().fg(Color::White),
        Status::InProgress => Style::default().fg(Color::Yellow),
        Status::Done => Style::default().fg(Color::Green),
        Status::Blocked => Style::default().fg(Color::Red),
    };

    let badges_line = Line::from(vec![
        Span::styled(format!("[{}]", task.level), level_style),
        Span::raw(" "),
        Span::styled(format!("[{}]", task.status), status_style),
    ]);

    vec![id_line, title_line, badges_line]
}

/// Build the progress section with a visual progress bar.
fn build_progress_section(progress: &Progress) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    lines.push(section_header("Progress"));

    // Progress color based on completion
    let progress_color = if progress.is_complete() {
        Color::Green
    } else if progress.is_empty() {
        Color::DarkGray
    } else {
        Color::Yellow
    };

    // Progress text: "3/5 (60%)"
    let progress_text = format!(
        "{}/{} ({}%)",
        progress.done_count, progress.total_count, progress.percentage
    );

    lines.push(Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(progress_text, Style::default().fg(progress_color)),
    ]));

    // Progress bar: [████████░░░░░░░░░░░░]
    let bar_width = 20;
    let filled = (bar_width * progress.percentage as usize) / 100;
    let empty = bar_width - filled;

    let bar = format!(
        "[{}{}]",
        "\u{2588}".repeat(filled), // █ filled
        "\u{2591}".repeat(empty)   // ░ empty
    );

    lines.push(Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(bar, Style::default().fg(progress_color)),
    ]));

    lines
}

/// Build the metadata section (priority).
fn build_metadata_section(task: &Task) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    lines.push(section_header("Metadata"));

    // Priority
    let priority_value = match &task.priority {
        Some(p) => format_priority(p),
        None => Span::styled("-", Style::default().fg(Color::DarkGray)),
    };

    lines.push(Line::from(vec![
        Span::styled("  Priority: ", Style::default().fg(Color::DarkGray)),
        priority_value,
    ]));

    lines
}

/// Format priority with appropriate color.
fn format_priority(priority: &Priority) -> Span<'static> {
    let (text, color) = match priority {
        Priority::Low => ("low", Color::Gray),
        Priority::Medium => ("medium", Color::White),
        Priority::High => ("high", Color::Yellow),
        Priority::Critical => ("critical", Color::Red),
    };
    Span::styled(text.to_string(), Style::default().fg(color))
}

/// Build the tags section.
fn build_tags_section(tags: &[String]) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(section_header("Tags"));

    let tag_spans: Vec<Span> = tags
        .iter()
        .enumerate()
        .flat_map(|(i, tag)| {
            let mut spans = vec![Span::styled(
                format!("[{}]", tag),
                Style::default().fg(Color::Cyan),
            )];
            if i < tags.len() - 1 {
                spans.push(Span::raw(" "));
            }
            spans
        })
        .collect();

    let mut tag_line_spans = vec![Span::raw("  ")];
    tag_line_spans.extend(tag_spans);
    lines.push(Line::from(tag_line_spans));

    lines
}

/// Build all sections (goal, context, steps, constraints, testing criteria).
fn build_sections(sections: &[Section]) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    // Group sections by type
    let goals: Vec<_> = sections
        .iter()
        .filter(|s| s.section_type == SectionType::Goal)
        .collect();
    let contexts: Vec<_> = sections
        .iter()
        .filter(|s| s.section_type == SectionType::Context)
        .collect();
    let steps: Vec<_> = sections
        .iter()
        .filter(|s| s.section_type == SectionType::Step)
        .collect();
    let constraints: Vec<_> = sections
        .iter()
        .filter(|s| s.section_type == SectionType::Constraint)
        .collect();
    let testing_criteria: Vec<_> = sections
        .iter()
        .filter(|s| s.section_type == SectionType::TestingCriterion)
        .collect();

    // Goal
    if !goals.is_empty() {
        lines.push(section_header("Goal"));
        for goal in goals {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(goal.content.clone(), Style::default().fg(Color::White)),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Context
    if !contexts.is_empty() {
        lines.push(section_header("Context"));
        for context in contexts {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(context.content.clone(), Style::default().fg(Color::White)),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Steps (with checkboxes)
    if !steps.is_empty() {
        lines.push(section_header("Steps"));
        let mut sorted_steps = steps.clone();
        sorted_steps.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

        for (i, step) in sorted_steps.iter().enumerate() {
            let checkbox = if step.done.unwrap_or(false) {
                "[x]"
            } else {
                "[ ]"
            };
            let checkbox_style = if step.done.unwrap_or(false) {
                Style::default().fg(Color::Green)
            } else {
                Style::default().fg(Color::DarkGray)
            };

            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(format!("{}. ", i + 1), Style::default().fg(Color::DarkGray)),
                Span::styled(checkbox.to_string(), checkbox_style),
                Span::raw(" "),
                Span::styled(step.content.clone(), Style::default().fg(Color::White)),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Constraints
    if !constraints.is_empty() {
        lines.push(section_header("Constraints"));
        for constraint in constraints {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled("- ", Style::default().fg(Color::DarkGray)),
                Span::styled(
                    constraint.content.clone(),
                    Style::default().fg(Color::White),
                ),
            ]));
        }
        lines.push(Line::from(""));
    }

    // Testing Criteria
    if !testing_criteria.is_empty() {
        lines.push(section_header("Testing Criteria"));
        for (i, criterion) in testing_criteria.iter().enumerate() {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(format!("{}. ", i + 1), Style::default().fg(Color::DarkGray)),
                Span::styled(criterion.content.clone(), Style::default().fg(Color::White)),
            ]));
        }
    }

    lines
}

/// Build the code refs section.
fn build_code_refs_section(code_refs: &[CodeRef]) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(section_header("Code References"));

    for code_ref in code_refs {
        let mut path_str = code_ref.path.clone();

        // Add line numbers if present
        if let Some(start) = code_ref.line_start {
            if let Some(end) = code_ref.line_end {
                path_str = format!("{}:L{}-L{}", path_str, start, end);
            } else {
                path_str = format!("{}:L{}", path_str, start);
            }
        }

        let mut spans = vec![
            Span::raw("  "),
            Span::styled(path_str, Style::default().fg(Color::Cyan)),
        ];

        // Add name if present
        if let Some(name) = &code_ref.name {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                format!("({})", name),
                Style::default().fg(Color::DarkGray),
            ));
        }

        lines.push(Line::from(spans));

        // Add description on next line if present
        if let Some(desc) = &code_ref.description {
            lines.push(Line::from(vec![
                Span::raw("    "),
                Span::styled(desc.clone(), Style::default().fg(Color::DarkGray)),
            ]));
        }
    }

    lines
}

/// Build the relationships section.
fn build_relationships_section(relationships: &TaskRelationships) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(section_header("Relationships"));

    // Parent
    match &relationships.parent {
        Some((id, title)) => {
            lines.push(Line::from(vec![
                Span::styled("  Parent: ", Style::default().fg(Color::DarkGray)),
                Span::styled(id.clone(), Style::default().fg(Color::Yellow)),
                Span::raw(" - "),
                Span::styled(title.clone(), Style::default().fg(Color::White)),
            ]));
        }
        None => {
            lines.push(Line::from(vec![
                Span::styled("  Parent: ", Style::default().fg(Color::DarkGray)),
                Span::styled("-", Style::default().fg(Color::DarkGray)),
            ]));
        }
    }

    // Blocked by
    lines.push(Line::from(vec![Span::styled(
        "  Blocked by:",
        Style::default().fg(Color::DarkGray),
    )]));
    if relationships.blocked_by.is_empty() {
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::styled("-", Style::default().fg(Color::DarkGray)),
        ]));
    } else {
        for (id, title) in &relationships.blocked_by {
            lines.push(Line::from(vec![
                Span::raw("    "),
                Span::styled(id.clone(), Style::default().fg(Color::Yellow)),
                Span::raw(" - "),
                Span::styled(title.clone(), Style::default().fg(Color::White)),
            ]));
        }
    }

    // Blocks
    lines.push(Line::from(vec![Span::styled(
        "  Blocks:",
        Style::default().fg(Color::DarkGray),
    )]));
    if relationships.blocks.is_empty() {
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::styled("-", Style::default().fg(Color::DarkGray)),
        ]));
    } else {
        for (id, title) in &relationships.blocks {
            lines.push(Line::from(vec![
                Span::raw("    "),
                Span::styled(id.clone(), Style::default().fg(Color::Yellow)),
                Span::raw(" - "),
                Span::styled(title.clone(), Style::default().fg(Color::White)),
            ]));
        }
    }

    lines
}

/// Build the timestamps section.
fn build_timestamps_section(task: &Task) -> Vec<Line<'static>> {
    vec![
        section_header("Timestamps"),
        Line::from(vec![
            Span::styled("  Created:   ", Style::default().fg(Color::DarkGray)),
            format_timestamp(&task.created_at),
        ]),
        Line::from(vec![
            Span::styled("  Updated:   ", Style::default().fg(Color::DarkGray)),
            format_timestamp(&task.updated_at),
        ]),
        Line::from(vec![
            Span::styled("  Started:   ", Style::default().fg(Color::DarkGray)),
            format_timestamp(&task.started_at),
        ]),
        Line::from(vec![
            Span::styled("  Completed: ", Style::default().fg(Color::DarkGray)),
            format_timestamp(&task.completed_at),
        ]),
    ]
}

/// Format a timestamp as "YYYY-MM-DD HH:MM" or "-" if None.
fn format_timestamp(timestamp: &Option<DateTime<Utc>>) -> Span<'static> {
    match timestamp {
        Some(dt) => Span::styled(
            dt.format("%Y-%m-%d %H:%M").to_string(),
            Style::default().fg(Color::White),
        ),
        None => Span::styled("-", Style::default().fg(Color::DarkGray)),
    }
}

/// Create a section header line.
fn section_header(title: &str) -> Line<'static> {
    Line::from(vec![Span::styled(
        title.to_string(),
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_timestamp_none() {
        let span = format_timestamp(&None);
        assert_eq!(span.content, "-");
    }

    #[test]
    fn test_format_timestamp_some() {
        use chrono::TimeZone;
        let dt = Utc.with_ymd_and_hms(2025, 1, 6, 12, 30, 0).unwrap();
        let span = format_timestamp(&Some(dt));
        assert_eq!(span.content, "2025-01-06 12:30");
    }

    #[test]
    fn test_format_priority_low() {
        let span = format_priority(&Priority::Low);
        assert_eq!(span.content, "low");
    }

    #[test]
    fn test_format_priority_critical() {
        let span = format_priority(&Priority::Critical);
        assert_eq!(span.content, "critical");
    }

    #[test]
    fn test_section_header() {
        let line = section_header("Test Header");
        assert_eq!(line.spans.len(), 1);
        assert_eq!(line.spans[0].content, "Test Header");
    }

    #[test]
    fn test_build_header_section() {
        let task = Task::new("Test Task", Level::Epic).with_status(Status::InProgress);
        let details = TaskDetails {
            task,
            id: "abc123".to_string(),
            relationships: TaskRelationships::default(),
            progress: None,
        };

        let lines = build_header_section(&details);
        assert_eq!(lines.len(), 3); // ID, title, badges
    }

    #[test]
    fn test_build_metadata_section() {
        let task = Task::new("Test", Level::Task).with_priority(Priority::High);
        let lines = build_metadata_section(&task);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_build_metadata_section_no_priority() {
        let task = Task::new("Test", Level::Task);
        let lines = build_metadata_section(&task);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_build_tags_section() {
        let tags = vec!["backend".to_string(), "api".to_string()];
        let lines = build_tags_section(&tags);
        assert_eq!(lines.len(), 2); // header + tags line
    }

    #[test]
    fn test_build_code_refs_section() {
        let refs = vec![
            CodeRef::file("src/main.rs"),
            CodeRef::line("src/lib.rs", 42).with_name("function"),
            CodeRef::range("src/app.rs", 10, 20).with_description("App logic"),
        ];
        let lines = build_code_refs_section(&refs);
        assert!(lines.len() >= 4); // header + at least 3 ref lines
    }

    #[test]
    fn test_build_relationships_section_empty() {
        let relationships = TaskRelationships::default();
        let lines = build_relationships_section(&relationships);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_build_relationships_section_with_data() {
        let relationships = TaskRelationships {
            parent: Some(("parent1".to_string(), "Parent Task".to_string())),
            blocked_by: vec![("blocker1".to_string(), "Blocker".to_string())],
            blocks: vec![
                ("dep1".to_string(), "Dependent 1".to_string()),
                ("dep2".to_string(), "Dependent 2".to_string()),
            ],
        };
        let lines = build_relationships_section(&relationships);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_build_timestamps_section() {
        let task = Task::new("Test", Level::Task);
        let lines = build_timestamps_section(&task);
        assert_eq!(lines.len(), 5); // header + 4 timestamp lines
    }

    #[test]
    fn test_build_sections_with_steps() {
        use vertebrae_db::Section as DbSection;
        let sections = vec![
            DbSection::new(SectionType::Goal, "Complete the feature"),
            DbSection::with_order(SectionType::Step, "First step", 1),
            DbSection::with_order(SectionType::Step, "Second step", 2).with_done(true),
        ];
        let lines = build_sections(&sections);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_task_details_default_relationships() {
        let relationships = TaskRelationships::default();
        assert!(relationships.parent.is_none());
        assert!(relationships.blocked_by.is_empty());
        assert!(relationships.blocks.is_empty());
    }

    #[test]
    fn test_build_details_lines() {
        let task = Task::new("Full Test Task", Level::Ticket)
            .with_status(Status::InProgress)
            .with_priority(Priority::High)
            .with_tag("test");

        let details = TaskDetails {
            task,
            id: "test123".to_string(),
            relationships: TaskRelationships::default(),
            progress: None,
        };

        let lines = build_details_lines(&details);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_build_progress_section() {
        let progress = Progress::new(3, 5);
        let lines = build_progress_section(&progress);

        // Should have header + percentage line + progress bar = 3 lines
        assert_eq!(lines.len(), 3);

        // Check for percentage in the output
        let all_text: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.to_string()))
            .collect();
        assert!(all_text.contains("3/5"));
        assert!(all_text.contains("60%"));
    }

    #[test]
    fn test_build_progress_section_complete() {
        let progress = Progress::new(5, 5);
        let lines = build_progress_section(&progress);

        let all_text: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.to_string()))
            .collect();
        assert!(all_text.contains("100%"));
    }

    #[test]
    fn test_build_details_lines_with_progress() {
        let task = Task::new("Epic Task", Level::Epic).with_status(Status::InProgress);

        let details = TaskDetails {
            task,
            id: "epic123".to_string(),
            relationships: TaskRelationships::default(),
            progress: Some(Progress::new(2, 4)),
        };

        let lines = build_details_lines(&details);

        // Should include progress section
        let all_text: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.to_string()))
            .collect();
        assert!(all_text.contains("Progress"));
        assert!(all_text.contains("2/4"));
    }
}
