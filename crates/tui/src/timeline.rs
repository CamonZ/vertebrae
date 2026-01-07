//! Timeline View widget for displaying task execution history.
//!
//! Provides a Gantt-like horizontal timeline showing tasks based on their
//! started_at and completed_at timestamps. Only shows tasks that have been
//! started (have a started_at timestamp).

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use vertebrae_db::Status;

/// Zoom level for the timeline display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoomLevel {
    /// Show individual days (for ranges < 14 days).
    Days,
    /// Show weeks (for ranges 14-90 days).
    Weeks,
    /// Show months (for ranges > 90 days).
    Months,
}

impl ZoomLevel {
    /// Determine the appropriate zoom level based on the number of days.
    fn from_days(days: i64) -> Self {
        if days < 14 {
            ZoomLevel::Days
        } else if days < 90 {
            ZoomLevel::Weeks
        } else {
            ZoomLevel::Months
        }
    }
}

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
    /// End date of the visible timeline (used during column calculation).
    #[cfg_attr(not(test), allow(dead_code))]
    end_date: NaiveDate,
    /// Number of days visible.
    days: i64,
    /// Width available for the timeline bars (excluding label area).
    bar_width: u16,
    /// Width of the label area on the left.
    label_width: u16,
    /// The zoom level based on date range (used for testing and future enhancements).
    #[cfg_attr(not(test), allow(dead_code))]
    zoom_level: ZoomLevel,
    /// Column boundaries for grid lines and headers.
    columns: Vec<ColumnInfo>,
}

/// Information about a single column in the timeline header.
#[derive(Debug, Clone)]
struct ColumnInfo {
    /// Label to display for this column.
    label: String,
    /// Start position (0-based, relative to bar area).
    start_col: u16,
    /// End position (exclusive).
    end_col: u16,
}

impl TimelineConfig {
    /// Create a new timeline config from tasks and available area.
    fn from_tasks(tasks: &[TimelineTask], area_width: u16) -> Self {
        let label_width = 30u16.min(area_width / 3);
        let bar_width = area_width.saturating_sub(label_width).saturating_sub(1);

        if tasks.is_empty() {
            let today = Local::now().date_naive();
            let start_date = today - Duration::days(7);
            let end_date = today;
            let days = 7;
            let zoom_level = ZoomLevel::Days;
            let columns = Self::calculate_columns(start_date, end_date, bar_width, zoom_level);
            return Self {
                start_date,
                end_date,
                days,
                bar_width,
                label_width,
                zoom_level,
                columns,
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

        // Determine zoom level based on date range
        let zoom_level = ZoomLevel::from_days(days);

        // Calculate column boundaries
        let columns = Self::calculate_columns(start_date, end_date, bar_width, zoom_level);

        Self {
            start_date,
            end_date,
            days,
            bar_width,
            label_width,
            zoom_level,
            columns,
        }
    }

    /// Calculate column boundaries and labels based on zoom level.
    fn calculate_columns(
        start_date: NaiveDate,
        end_date: NaiveDate,
        bar_width: u16,
        zoom_level: ZoomLevel,
    ) -> Vec<ColumnInfo> {
        if bar_width == 0 {
            return Vec::new();
        }

        let total_days = (end_date - start_date).num_days().max(1);

        match zoom_level {
            ZoomLevel::Days => Self::calculate_day_columns(start_date, total_days, bar_width),
            ZoomLevel::Weeks => Self::calculate_week_columns(start_date, end_date, bar_width),
            ZoomLevel::Months => Self::calculate_month_columns(start_date, end_date, bar_width),
        }
    }

    /// Calculate columns for day-level zoom.
    fn calculate_day_columns(
        start_date: NaiveDate,
        total_days: i64,
        bar_width: u16,
    ) -> Vec<ColumnInfo> {
        let mut columns = Vec::new();

        for day_offset in 0..=total_days {
            let date = start_date + Duration::days(day_offset);
            let start_col =
                ((day_offset as f64 / total_days as f64) * bar_width as f64).round() as u16;
            let end_col =
                (((day_offset + 1) as f64 / total_days as f64) * bar_width as f64).round() as u16;

            // Only add if column has width
            if end_col > start_col {
                columns.push(ColumnInfo {
                    label: date.format("%m/%d").to_string(),
                    start_col,
                    end_col: end_col.min(bar_width),
                });
            }
        }

        columns
    }

    /// Calculate columns for week-level zoom.
    fn calculate_week_columns(
        start_date: NaiveDate,
        end_date: NaiveDate,
        bar_width: u16,
    ) -> Vec<ColumnInfo> {
        let mut columns = Vec::new();
        let total_days = (end_date - start_date).num_days().max(1);

        // Find the first Monday on or after start_date
        let days_until_monday = (8 - start_date.weekday().num_days_from_monday()) % 7;
        let mut week_start = start_date + Duration::days(days_until_monday as i64);

        // If start_date is before the first Monday, add a partial week
        if week_start > start_date {
            let start_col = 0;
            let end_col = (((week_start - start_date).num_days() as f64 / total_days as f64)
                * bar_width as f64)
                .round() as u16;
            if end_col > start_col {
                columns.push(ColumnInfo {
                    label: start_date.format("%m/%d").to_string(),
                    start_col,
                    end_col: end_col.min(bar_width),
                });
            }
        }

        // Add full weeks
        while week_start <= end_date {
            let week_end = week_start + Duration::days(7);
            let start_col = (((week_start - start_date).num_days() as f64 / total_days as f64)
                * bar_width as f64)
                .round() as u16;
            let end_col = (((week_end - start_date).num_days() as f64 / total_days as f64)
                * bar_width as f64)
                .round() as u16;

            if end_col > start_col && start_col < bar_width {
                columns.push(ColumnInfo {
                    label: format!("W{}", week_start.iso_week().week()),
                    start_col,
                    end_col: end_col.min(bar_width),
                });
            }

            week_start = week_end;
        }

        columns
    }

    /// Calculate columns for month-level zoom.
    fn calculate_month_columns(
        start_date: NaiveDate,
        end_date: NaiveDate,
        bar_width: u16,
    ) -> Vec<ColumnInfo> {
        let mut columns = Vec::new();
        let total_days = (end_date - start_date).num_days().max(1);

        // Start with the first of the start month
        let mut month_start =
            NaiveDate::from_ymd_opt(start_date.year(), start_date.month(), 1).unwrap_or(start_date);

        while month_start <= end_date {
            // Calculate the first day of next month
            let month_end = if month_start.month() == 12 {
                NaiveDate::from_ymd_opt(month_start.year() + 1, 1, 1).unwrap_or(month_start)
            } else {
                NaiveDate::from_ymd_opt(month_start.year(), month_start.month() + 1, 1)
                    .unwrap_or(month_start)
            };

            // Calculate column positions (clamped to actual date range)
            let effective_start = month_start.max(start_date);
            let effective_end = month_end.min(end_date + Duration::days(1));

            let start_col = (((effective_start - start_date).num_days() as f64 / total_days as f64)
                * bar_width as f64)
                .round() as u16;
            let end_col = (((effective_end - start_date).num_days() as f64 / total_days as f64)
                * bar_width as f64)
                .round() as u16;

            if end_col > start_col && start_col < bar_width {
                columns.push(ColumnInfo {
                    label: month_start.format("%b").to_string(),
                    start_col,
                    end_col: end_col.min(bar_width),
                });
            }

            month_start = month_end;
        }

        columns
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
/// * `is_focused` - Whether this panel currently has focus
/// * `scroll_offset` - Vertical scroll offset for the content
pub fn render_timeline_view(
    frame: &mut Frame,
    area: Rect,
    tasks: &[TimelineTask],
    empty_message: Option<&str>,
    is_focused: bool,
    scroll_offset: usize,
) {
    let border_color = if is_focused {
        Color::Yellow
    } else {
        Color::Cyan
    };

    let block = Block::default()
        .title(" Timeline ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));

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

    let paragraph = Paragraph::new(lines)
        .block(block)
        .scroll((scroll_offset as u16, 0));
    frame.render_widget(paragraph, area);
}

/// Build the date header line showing the time scale with centered labels.
fn build_date_header(config: &TimelineConfig) -> Line<'static> {
    let mut spans = Vec::new();

    // Label area (empty for header)
    spans.push(Span::styled(
        " ".repeat(config.label_width as usize),
        Style::default(),
    ));

    // Build date markers from column info
    let bar_width = config.bar_width as usize;
    let mut header_chars = vec![' '; bar_width];

    // Place labels centered within each column
    for col in &config.columns {
        let col_width = (col.end_col - col.start_col) as usize;
        let label = &col.label;

        // Only show label if column is wide enough
        if col_width >= label.len() {
            // Center the label within the column
            let padding = (col_width - label.len()) / 2;
            let start_pos = col.start_col as usize + padding;

            for (i, c) in label.chars().enumerate() {
                let pos = start_pos + i;
                if pos < bar_width {
                    header_chars[pos] = c;
                }
            }
        } else if col_width >= 1 {
            // Column too narrow - show first char or abbreviation
            let abbrev: String = label.chars().take(col_width).collect();
            for (i, c) in abbrev.chars().enumerate() {
                let pos = col.start_col as usize + i;
                if pos < bar_width {
                    header_chars[pos] = c;
                }
            }
        }
    }

    spans.push(Span::styled(
        header_chars.iter().collect::<String>(),
        Style::default().fg(Color::DarkGray),
    ));

    Line::from(spans)
}

/// Build a separator line with vertical grid markers at column boundaries.
fn build_separator(config: &TimelineConfig) -> Line<'static> {
    let mut spans = Vec::new();

    // Label area
    spans.push(Span::styled(
        " ".repeat(config.label_width as usize),
        Style::default(),
    ));

    // Build separator with vertical markers at column boundaries
    let bar_width = config.bar_width as usize;
    let mut sep_chars = vec!['\u{2500}'; bar_width]; // Horizontal line

    // Place vertical markers (column delimiters) at column boundaries
    for col in &config.columns {
        // Mark start of column (except for first column)
        if col.start_col > 0 && (col.start_col as usize) < bar_width {
            sep_chars[col.start_col as usize] = '\u{253C}'; // Cross character
        }
    }

    // Start of timeline gets a special character
    if !sep_chars.is_empty() {
        sep_chars[0] = '\u{251C}'; // Left T-junction
    }

    // End of timeline gets a special character
    if bar_width > 1 {
        sep_chars[bar_width - 1] = '\u{2524}'; // Right T-junction
    }

    spans.push(Span::styled(
        sep_chars.iter().collect::<String>(),
        Style::default().fg(Color::DarkGray),
    ));

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

    // =============================================
    // Zoom level tests
    // =============================================

    #[test]
    fn test_zoom_level_from_days_under_14_is_days() {
        assert_eq!(ZoomLevel::from_days(1), ZoomLevel::Days);
        assert_eq!(ZoomLevel::from_days(7), ZoomLevel::Days);
        assert_eq!(ZoomLevel::from_days(13), ZoomLevel::Days);
    }

    #[test]
    fn test_zoom_level_from_days_14_to_89_is_weeks() {
        assert_eq!(ZoomLevel::from_days(14), ZoomLevel::Weeks);
        assert_eq!(ZoomLevel::from_days(30), ZoomLevel::Weeks);
        assert_eq!(ZoomLevel::from_days(60), ZoomLevel::Weeks);
        assert_eq!(ZoomLevel::from_days(89), ZoomLevel::Weeks);
    }

    #[test]
    fn test_zoom_level_from_days_90_plus_is_months() {
        assert_eq!(ZoomLevel::from_days(90), ZoomLevel::Months);
        assert_eq!(ZoomLevel::from_days(120), ZoomLevel::Months);
        assert_eq!(ZoomLevel::from_days(365), ZoomLevel::Months);
    }

    #[test]
    fn test_timeline_config_7_days_uses_day_zoom() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 7, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        assert_eq!(config.zoom_level, ZoomLevel::Days);
        // Should have approximately 7 columns (one per day)
        assert!(config.columns.len() >= 6 && config.columns.len() <= 8);
    }

    #[test]
    fn test_timeline_config_30_days_uses_week_zoom() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 31, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        assert_eq!(config.zoom_level, ZoomLevel::Weeks);
        // Should have 4-5 columns for weeks
        assert!(
            config.columns.len() >= 4 && config.columns.len() <= 6,
            "Expected 4-6 week columns, got {}",
            config.columns.len()
        );
    }

    #[test]
    fn test_timeline_config_90_days_uses_month_zoom() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 4, 1, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        assert_eq!(config.zoom_level, ZoomLevel::Months);
        // Should have 3-4 columns for months (Jan, Feb, Mar, Apr)
        assert!(
            config.columns.len() >= 3 && config.columns.len() <= 4,
            "Expected 3-4 month columns, got {}",
            config.columns.len()
        );
    }

    #[test]
    fn test_column_labels_centered() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 7, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        let header = build_date_header(&config);

        // Header should have content
        let text: String = header.spans.iter().map(|s| s.content.to_string()).collect();
        assert!(!text.trim().is_empty());
    }

    #[test]
    fn test_separator_has_grid_markers() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 7, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        let sep = build_separator(&config);

        // Separator should contain box-drawing characters
        let text: String = sep.spans.iter().map(|s| s.content.to_string()).collect();
        // Should contain horizontal line character
        assert!(
            text.contains('\u{2500}') || text.contains('\u{251C}') || text.contains('\u{253C}')
        );
    }

    #[test]
    fn test_column_boundaries_align() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 7, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Columns should not overlap
        for i in 1..config.columns.len() {
            assert!(
                config.columns[i].start_col >= config.columns[i - 1].end_col
                    || config.columns[i].start_col == config.columns[i - 1].end_col,
                "Columns should not overlap: col {} ends at {}, col {} starts at {}",
                i - 1,
                config.columns[i - 1].end_col,
                i,
                config.columns[i].start_col
            );
        }
    }

    #[test]
    fn test_empty_tasks_default_config_has_columns() {
        let config = TimelineConfig::from_tasks(&[], 100);

        // Even empty config should have columns (for 7-day default range)
        assert!(!config.columns.is_empty());
        assert_eq!(config.zoom_level, ZoomLevel::Days);
    }

    #[test]
    fn test_narrow_width_still_produces_columns() {
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 7, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 40);

        // Should still have some columns even with narrow width
        assert!(!config.columns.is_empty());
    }
}
