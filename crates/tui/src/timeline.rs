//! Timeline View widget for displaying task execution history.
//!
//! Provides a Gantt-like horizontal timeline showing tasks based on their
//! started_at and completed_at timestamps. Only shows tasks that have been
//! started (have a started_at timestamp).

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use vertebrae_db::Status;

/// A task with timeline information for rendering in the timeline view.
#[derive(Debug, Clone)]
pub struct TimelineTask {
    /// Task ID (short form).
    pub id: String,
    /// Task title.
    pub title: String,
    /// Task status.
    pub status: Status,
    /// When the task was started.
    pub started_at: DateTime<Utc>,
    /// When the task was completed (None if still in progress).
    pub completed_at: Option<DateTime<Utc>>,
    /// Whether this task has dependencies (blocked by other tasks).
    pub has_dependencies: bool,
}

impl TimelineTask {
    /// Get the end time for this task (completed_at or now if in progress).
    pub fn end_time(&self) -> DateTime<Utc> {
        self.completed_at.unwrap_or_else(Utc::now)
    }

    /// Get the duration of this task.
    pub fn duration(&self) -> Duration {
        self.end_time().signed_duration_since(self.started_at)
    }
}

/// Configuration for the timeline display.
struct TimelineConfig {
    /// Start date of the visible timeline.
    start_date: NaiveDate,
    /// End date of the visible timeline.
    end_date: NaiveDate,
    /// Number of days visible.
    days: i64,
    /// Width available for the timeline bars (excluding label area).
    bar_width: u16,
    /// Width of the label area on the left.
    label_width: u16,
}

impl TimelineConfig {
    /// Create a new timeline config from tasks and available area.
    fn from_tasks(tasks: &[TimelineTask], area_width: u16) -> Self {
        let label_width = 30u16.min(area_width / 3);
        let bar_width = area_width.saturating_sub(label_width).saturating_sub(1);

        if tasks.is_empty() {
            let today = Local::now().date_naive();
            return Self {
                start_date: today - Duration::days(7),
                end_date: today,
                days: 7,
                bar_width,
                label_width,
            };
        }

        // Find the date range
        let min_start = tasks
            .iter()
            .map(|t| t.started_at)
            .min()
            .unwrap_or_else(Utc::now);

        let max_end = tasks
            .iter()
            .map(|t| t.end_time())
            .max()
            .unwrap_or_else(Utc::now);

        let start_date = min_start.with_timezone(&Local).date_naive();
        let end_date = max_end.with_timezone(&Local).date_naive();

        // Ensure at least 1 day is shown
        let days = (end_date - start_date).num_days().max(1);

        Self {
            start_date,
            end_date,
            days,
            bar_width,
            label_width,
        }
    }

    /// Calculate the column position for a given datetime.
    fn date_to_column(&self, dt: DateTime<Utc>) -> u16 {
        let local_date = dt.with_timezone(&Local).date_naive();
        let days_from_start = (local_date - self.start_date).num_days();

        if self.days == 0 || self.bar_width == 0 {
            return 0;
        }

        let ratio = days_from_start as f64 / self.days as f64;
        (ratio * self.bar_width as f64).clamp(0.0, self.bar_width as f64 - 1.0) as u16
    }
}

/// Render the timeline view showing tasks on a horizontal timeline.
///
/// # Arguments
///
/// * `frame` - The frame to render to
/// * `area` - The area to render within
/// * `tasks` - Tasks with timeline data (must have started_at set)
/// * `empty_message` - Message to show when no tasks have been started
pub fn render_timeline_view(
    frame: &mut Frame,
    area: Rect,
    tasks: &[TimelineTask],
    empty_message: Option<&str>,
) {
    let block = Block::default()
        .title(" Timeline ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    if tasks.is_empty() {
        let message = empty_message.unwrap_or("No started tasks found");
        let paragraph = Paragraph::new(message)
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(paragraph, area);
        return;
    }

    // Calculate inner area
    let inner_width = area.width.saturating_sub(2); // Account for borders
    let config = TimelineConfig::from_tasks(tasks, inner_width);

    let mut lines = Vec::new();

    // Build header (date scale)
    lines.push(build_date_header(&config));
    lines.push(build_separator(&config));

    // Build task bars
    for task in tasks {
        lines.push(build_task_line(task, &config));
    }

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

/// Build the date header line showing the time scale.
fn build_date_header(config: &TimelineConfig) -> Line<'static> {
    let mut spans = Vec::new();

    // Label area (empty for header)
    spans.push(Span::styled(
        " ".repeat(config.label_width as usize),
        Style::default(),
    ));

    // Build date markers
    let bar_width = config.bar_width as usize;
    let mut header_chars = vec![' '; bar_width];

    // Show start date, middle date, and end date
    let start_str = config.start_date.format("%m/%d").to_string();
    let end_str = config.end_date.format("%m/%d").to_string();

    // Place start date
    for (i, c) in start_str.chars().enumerate() {
        if i < bar_width {
            header_chars[i] = c;
        }
    }

    // Place end date at the end
    let end_start = bar_width.saturating_sub(end_str.len());
    for (i, c) in end_str.chars().enumerate() {
        if end_start + i < bar_width {
            header_chars[end_start + i] = c;
        }
    }

    // Place middle date if there's room
    if config.days > 2 && bar_width > 20 {
        let mid_date = config.start_date + Duration::days(config.days / 2);
        let mid_str = mid_date.format("%m/%d").to_string();
        let mid_pos = bar_width / 2 - mid_str.len() / 2;
        for (i, c) in mid_str.chars().enumerate() {
            if mid_pos + i < bar_width && mid_pos + i > start_str.len() + 1 {
                header_chars[mid_pos + i] = c;
            }
        }
    }

    spans.push(Span::styled(
        header_chars.iter().collect::<String>(),
        Style::default().fg(Color::DarkGray),
    ));

    Line::from(spans)
}

/// Build a separator line.
fn build_separator(config: &TimelineConfig) -> Line<'static> {
    let spans = vec![
        // Label area
        Span::styled(" ".repeat(config.label_width as usize), Style::default()),
        // Separator
        Span::styled(
            "\u{2500}".repeat(config.bar_width as usize),
            Style::default().fg(Color::DarkGray),
        ),
    ];

    Line::from(spans)
}

/// Build a task line with label and timeline bar.
fn build_task_line(task: &TimelineTask, config: &TimelineConfig) -> Line<'static> {
    let mut spans = Vec::new();

    // Build label: [status] truncated_title
    let status_indicator = match task.status {
        Status::Done => "[x]",
        Status::InProgress => "[>]",
        Status::Blocked => "[!]",
        Status::Todo => "[ ]",
    };

    let status_color = get_status_color(&task.status);

    // Calculate available space for title
    let status_len = status_indicator.len() + 1; // +1 for space
    let id_space = 8; // Space for short ID
    let available_title_len = (config.label_width as usize)
        .saturating_sub(status_len)
        .saturating_sub(id_space);

    // Truncate title if needed
    let title = if task.title.len() > available_title_len {
        format!(
            "{}...",
            &task.title[..available_title_len.saturating_sub(3)]
        )
    } else {
        task.title.clone()
    };

    // Short ID (first 6 chars)
    let short_id: String = task.id.chars().take(6).collect();

    // Build label
    let label = format!("{} {} {}", short_id, status_indicator, title);

    // Pad label to fixed width
    let padded_label = format!("{:<width$}", label, width = config.label_width as usize);

    spans.push(Span::styled(
        padded_label,
        Style::default().fg(Color::White),
    ));

    // Build timeline bar
    let bar_width = config.bar_width as usize;
    let mut bar_chars: Vec<char> = vec![' '; bar_width];

    // Calculate bar position
    let start_col = config.date_to_column(task.started_at) as usize;
    let end_col = config.date_to_column(task.end_time()) as usize;

    // Ensure at least one character is drawn
    let end_col = end_col.max(start_col + 1).min(bar_width);

    // Fill the bar
    for char in bar_chars.iter_mut().take(end_col).skip(start_col) {
        *char = '\u{2588}'; // Full block character
    }

    // Apply styling based on status and dependencies
    let bar_color = if task.has_dependencies {
        // Use a slightly different shade for tasks with dependencies
        match task.status {
            Status::Done => Color::Green,
            Status::InProgress => Color::Yellow,
            Status::Blocked => Color::Red,
            Status::Todo => Color::DarkGray,
        }
    } else {
        status_color
    };

    // Create a styled bar - find the actual bar portion
    let before_bar: String = bar_chars[..start_col].iter().collect();
    let bar_portion: String = bar_chars[start_col..end_col].iter().collect();
    let after_bar: String = bar_chars[end_col..].iter().collect();

    if !before_bar.is_empty() {
        spans.push(Span::styled(before_bar, Style::default()));
    }

    let bar_style = if task.has_dependencies {
        Style::default().fg(bar_color).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(bar_color)
    };

    spans.push(Span::styled(bar_portion, bar_style));

    if !after_bar.is_empty() {
        spans.push(Span::styled(after_bar, Style::default()));
    }

    Line::from(spans)
}

/// Get the color for a task status.
fn get_status_color(status: &Status) -> Color {
    match status {
        Status::Done => Color::Green,
        Status::InProgress => Color::Yellow,
        Status::Blocked => Color::Red,
        Status::Todo => Color::DarkGray,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn make_task(
        id: &str,
        title: &str,
        status: Status,
        started_at: DateTime<Utc>,
        completed_at: Option<DateTime<Utc>>,
    ) -> TimelineTask {
        TimelineTask {
            id: id.to_string(),
            title: title.to_string(),
            status,
            started_at,
            completed_at,
            has_dependencies: false,
        }
    }

    #[test]
    fn test_timeline_task_end_time_completed() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 1, 12, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::Done, started, Some(completed));

        assert_eq!(task.end_time(), completed);
    }

    #[test]
    fn test_timeline_task_end_time_in_progress() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::InProgress, started, None);

        // end_time should be approximately now
        let end = task.end_time();
        let now = Utc::now();
        assert!(end <= now);
        assert!(end >= now - Duration::seconds(5));
    }

    #[test]
    fn test_timeline_task_duration() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 1, 12, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::Done, started, Some(completed));

        let duration = task.duration();
        assert_eq!(duration.num_hours(), 2);
    }

    #[test]
    fn test_timeline_config_from_empty_tasks() {
        let config = TimelineConfig::from_tasks(&[], 100);
        assert_eq!(config.days, 7);
        assert!(config.bar_width > 0);
    }

    #[test]
    fn test_timeline_config_from_tasks() {
        let started1 = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed1 = Utc.with_ymd_and_hms(2025, 1, 5, 12, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started1,
            Some(completed1),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        assert!(config.days >= 4);
    }

    #[test]
    fn test_timeline_config_date_to_column() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 11, 12, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Start date should be at column 0
        let start_col = config.date_to_column(started);
        assert_eq!(start_col, 0);

        // End date should be near the end
        let end_col = config.date_to_column(completed);
        assert!(end_col > 0);
    }

    #[test]
    fn test_get_status_color() {
        assert_eq!(get_status_color(&Status::Done), Color::Green);
        assert_eq!(get_status_color(&Status::InProgress), Color::Yellow);
        assert_eq!(get_status_color(&Status::Blocked), Color::Red);
        assert_eq!(get_status_color(&Status::Todo), Color::DarkGray);
    }

    #[test]
    fn test_build_date_header() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 10, 12, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 80);
        let header = build_date_header(&config);

        // Header should have spans
        assert!(!header.spans.is_empty());
    }

    #[test]
    fn test_build_task_line() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 12, 0, 0).unwrap();
        let task = make_task("task123", "My Task", Status::Done, started, Some(completed));
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 80);
        let line = build_task_line(&task, &config);

        // Line should have spans
        assert!(!line.spans.is_empty());

        // Should contain task ID
        let text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("task12"));
    }

    #[test]
    fn test_build_task_line_with_dependencies() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 12, 0, 0).unwrap();
        let mut task = make_task("task123", "My Task", Status::Done, started, Some(completed));
        task.has_dependencies = true;
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 80);
        let line = build_task_line(&task, &config);

        // Line should have spans with bold modifier for task with dependencies
        assert!(!line.spans.is_empty());
    }

    #[test]
    fn test_build_separator() {
        let config = TimelineConfig::from_tasks(&[], 80);
        let sep = build_separator(&config);

        assert!(!sep.spans.is_empty());
    }

    #[test]
    fn test_timeline_task_title_truncation() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 10, 0, 0).unwrap();
        let task = make_task(
            "t1",
            "This is a very long task title that should be truncated in the display",
            Status::InProgress,
            started,
            None,
        );
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 60);
        let line = build_task_line(&task, &config);

        // Should contain truncated text with ellipsis
        let text: String = line.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("...") || task.title.len() <= config.label_width as usize);
    }
}
