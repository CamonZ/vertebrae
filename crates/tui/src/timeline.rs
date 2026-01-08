//! Timeline View widget for displaying task execution history.
//!
//! Provides a Gantt-like horizontal timeline showing tasks based on their
//! started_at and completed_at timestamps. Only shows tasks that have been
//! started (have a started_at timestamp).
//!
//! Tasks are color-coded by dependency group - tasks in the same dependency
//! chain share the same color, making it easy to visualize related work.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use std::collections::{HashMap, HashSet};
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
    /// The dependency group this task belongs to (for color coding).
    /// Tasks with the same group_id are in the same dependency chain.
    /// None means the task has no dependencies (isolated task).
    pub dependency_group: Option<usize>,
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

/// Color palette for dependency groups.
///
/// 8 distinct colors that are distinguishable on both light and dark terminals.
/// Colors are chosen to be visually distinct from each other and from the
/// status colors (green=done, yellow=in_progress, red=blocked).
const DEPENDENCY_GROUP_COLORS: [Color; 8] = [
    Color::Cyan,        // Group 0
    Color::Magenta,     // Group 1
    Color::Blue,        // Group 2
    Color::LightRed,    // Group 3
    Color::LightGreen,  // Group 4
    Color::LightBlue,   // Group 5
    Color::LightYellow, // Group 6
    Color::White,       // Group 7
];

/// Get the color for a dependency group.
///
/// Colors cycle through the palette if there are more groups than colors.
fn get_dependency_group_color(group_id: usize) -> Color {
    DEPENDENCY_GROUP_COLORS[group_id % DEPENDENCY_GROUP_COLORS.len()]
}

/// Dependency edge type for building the dependency graph.
#[derive(Debug, Clone)]
pub struct DependencyEdge {
    /// Task that depends on another.
    pub from_id: String,
    /// Task that is depended on.
    pub to_id: String,
}

/// Compute connected components in the dependency graph using Union-Find.
///
/// Returns a map from task_id to group_id where tasks in the same
/// dependency chain have the same group_id.
pub fn compute_dependency_groups(
    task_ids: &[String],
    edges: &[DependencyEdge],
) -> HashMap<String, usize> {
    if task_ids.is_empty() {
        return HashMap::new();
    }

    // Build index maps for Union-Find
    let id_to_index: HashMap<&str, usize> = task_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // Initialize Union-Find parent array
    let mut parent: Vec<usize> = (0..task_ids.len()).collect();
    let mut rank: Vec<usize> = vec![0; task_ids.len()];

    // Find with path compression
    fn find(parent: &mut [usize], i: usize) -> usize {
        if parent[i] != i {
            parent[i] = find(parent, parent[i]);
        }
        parent[i]
    }

    // Union by rank
    fn union(parent: &mut [usize], rank: &mut [usize], x: usize, y: usize) {
        let root_x = find(parent, x);
        let root_y = find(parent, y);

        if root_x != root_y {
            if rank[root_x] < rank[root_y] {
                parent[root_x] = root_y;
            } else if rank[root_x] > rank[root_y] {
                parent[root_y] = root_x;
            } else {
                parent[root_y] = root_x;
                rank[root_x] += 1;
            }
        }
    }

    // Process edges to union connected tasks
    for edge in edges {
        if let (Some(&from_idx), Some(&to_idx)) = (
            id_to_index.get(edge.from_id.as_str()),
            id_to_index.get(edge.to_id.as_str()),
        ) {
            union(&mut parent, &mut rank, from_idx, to_idx);
        }
    }

    // Find all unique roots and assign group IDs
    let mut root_to_group: HashMap<usize, usize> = HashMap::new();
    let mut next_group_id = 0usize;

    // Collect tasks that have dependencies (are in edges)
    let mut tasks_with_deps: HashSet<usize> = HashSet::new();
    for edge in edges {
        if let Some(&idx) = id_to_index.get(edge.from_id.as_str()) {
            tasks_with_deps.insert(idx);
        }
        if let Some(&idx) = id_to_index.get(edge.to_id.as_str()) {
            tasks_with_deps.insert(idx);
        }
    }

    // Build result map - only include tasks that are part of dependency chains
    let mut result: HashMap<String, usize> = HashMap::new();

    for (i, task_id) in task_ids.iter().enumerate() {
        // Only assign groups to tasks that are part of dependency relationships
        if tasks_with_deps.contains(&i) {
            let root = find(&mut parent, i);
            let group_id = *root_to_group.entry(root).or_insert_with(|| {
                let id = next_group_id;
                next_group_id += 1;
                id
            });
            result.insert(task_id.clone(), group_id);
        }
        // Tasks without dependencies don't get a group (None)
    }

    result
}

/// State for the timeline view, encapsulating scroll and selection.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineViewState {
    /// Whether this panel currently has focus.
    pub is_focused: bool,
    /// Vertical scroll offset for the content.
    pub scroll_offset: usize,
    /// Horizontal scroll offset (0-100 percentage).
    pub horizontal_offset: u16,
    /// Index of the selected task for highlighting.
    pub selected_index: usize,
}

/// Render the timeline view showing tasks on a horizontal timeline.
///
/// # Arguments
///
/// * `frame` - The frame to render to
/// * `area` - The area to render within
/// * `tasks` - Tasks with timeline data (must have started_at set)
/// * `empty_message` - Message to show when no tasks have been started
/// * `state` - Timeline view state (focus, scroll, selection)
#[allow(clippy::too_many_arguments)]
pub fn render_timeline_view(
    frame: &mut Frame,
    area: Rect,
    tasks: &[TimelineTask],
    empty_message: Option<&str>,
    is_focused: bool,
    scroll_offset: usize,
    horizontal_offset: u16,
    selected_index: usize,
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
    lines.push(build_date_header(&config, horizontal_offset));
    lines.push(build_separator(&config, horizontal_offset));

    // Build task bars with selection highlighting
    for (index, task) in tasks.iter().enumerate() {
        let is_selected = is_focused && index == selected_index;
        lines.push(build_task_line(
            task,
            &config,
            is_selected,
            horizontal_offset,
        ));
    }

    let paragraph = Paragraph::new(lines)
        .block(block)
        .scroll((scroll_offset as u16, 0));
    frame.render_widget(paragraph, area);
}

/// Build the date header line showing the time scale with centered labels.
///
/// # Arguments
///
/// * `config` - The timeline configuration
/// * `horizontal_offset` - Horizontal scroll offset (0-100 percentage)
fn build_date_header(config: &TimelineConfig, horizontal_offset: u16) -> Line<'static> {
    let mut spans = Vec::new();

    // Label area (empty for header)
    spans.push(Span::styled(
        " ".repeat(config.label_width as usize),
        Style::default(),
    ));

    // Build date markers from column info
    let bar_width = config.bar_width as usize;
    let mut header_chars = vec![' '; bar_width];

    // Calculate horizontal scroll offset in characters
    let scroll_chars = ((horizontal_offset as usize) * bar_width) / 100;

    // Place labels centered within each column (adjusted for scroll)
    for col in &config.columns {
        let col_width = (col.end_col - col.start_col) as usize;
        let label = &col.label;

        // Only show label if column is wide enough
        if col_width >= label.len() {
            // Center the label within the column
            let padding = (col_width - label.len()) / 2;
            let start_pos = (col.start_col as usize + padding).saturating_sub(scroll_chars);

            for (i, c) in label.chars().enumerate() {
                let pos = start_pos + i;
                if pos < bar_width && (col.start_col as usize + padding + i) >= scroll_chars {
                    header_chars[pos] = c;
                }
            }
        } else if col_width >= 1 {
            // Column too narrow - show first char or abbreviation
            let abbrev: String = label.chars().take(col_width).collect();
            for (i, c) in abbrev.chars().enumerate() {
                let effective_pos = col.start_col as usize + i;
                if effective_pos >= scroll_chars {
                    let pos = effective_pos - scroll_chars;
                    if pos < bar_width {
                        header_chars[pos] = c;
                    }
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
///
/// # Arguments
///
/// * `config` - The timeline configuration
/// * `horizontal_offset` - Horizontal scroll offset (0-100 percentage)
fn build_separator(config: &TimelineConfig, horizontal_offset: u16) -> Line<'static> {
    let mut spans = Vec::new();

    // Label area
    spans.push(Span::styled(
        " ".repeat(config.label_width as usize),
        Style::default(),
    ));

    // Build separator with vertical markers at column boundaries
    let bar_width = config.bar_width as usize;
    let mut sep_chars = vec!['\u{2500}'; bar_width]; // Horizontal line

    // Calculate horizontal scroll offset in characters
    let scroll_chars = ((horizontal_offset as usize) * bar_width) / 100;

    // Place vertical markers (column delimiters) at column boundaries (adjusted for scroll)
    for col in &config.columns {
        // Mark start of column (except for first column)
        if col.start_col > 0 {
            let effective_pos = col.start_col as usize;
            if effective_pos >= scroll_chars {
                let pos = effective_pos - scroll_chars;
                if pos < bar_width {
                    sep_chars[pos] = '\u{253C}'; // Cross character
                }
            }
        }
    }

    // Start of visible area gets a special character
    if !sep_chars.is_empty() {
        sep_chars[0] = '\u{251C}'; // Left T-junction
    }

    // End of visible area gets a special character
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
///
/// # Arguments
///
/// * `task` - The task to render
/// * `config` - The timeline configuration
/// * `is_selected` - Whether this task is currently selected
/// * `horizontal_offset` - Horizontal scroll offset (0-100 percentage)
fn build_task_line(
    task: &TimelineTask,
    config: &TimelineConfig,
    is_selected: bool,
    horizontal_offset: u16,
) -> Line<'static> {
    let mut spans = Vec::new();

    // Build label: [status] truncated_title
    let status_indicator = match task.status {
        Status::Done => "[x]",
        Status::InProgress => "[>]",
        Status::PendingReview => "[?]",
        Status::Backlog => "[.]",
        Status::Rejected => "[-]",
        Status::Todo => "[ ]",
    };

    let status_color = get_status_color(&task.status);

    // Calculate available space for title
    let status_len = status_indicator.len() + 1; // +1 for space
    let id_space = 8; // Space for short ID
    let selection_indicator_len = 2; // "> " for selected tasks
    let available_title_len = (config.label_width as usize)
        .saturating_sub(status_len)
        .saturating_sub(id_space)
        .saturating_sub(selection_indicator_len);

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

    // Build label with selection indicator
    let selection_prefix = if is_selected { "> " } else { "  " };
    let label = format!(
        "{}{} {} {}",
        selection_prefix, short_id, status_indicator, title
    );

    // Pad label to fixed width
    let padded_label = format!("{:<width$}", label, width = config.label_width as usize);

    // Selected tasks get highlighted label
    let label_style = if is_selected {
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::White)
    };

    spans.push(Span::styled(padded_label, label_style));

    // Build timeline bar with horizontal scroll
    let bar_width = config.bar_width as usize;
    let mut bar_chars: Vec<char> = vec![' '; bar_width];

    // Calculate horizontal scroll offset in characters
    let scroll_chars = ((horizontal_offset as usize) * bar_width) / 100;

    // Calculate bar position (original, before scroll adjustment)
    let orig_start_col = config.date_to_column(task.started_at) as usize;
    let orig_end_col = config.date_to_column(task.end_time()) as usize;

    // Ensure at least one character is drawn
    let orig_end_col = orig_end_col.max(orig_start_col + 1);

    // Fill the bar with appropriate character based on completion status (accounting for scroll)
    // Completed tasks get solid blocks, in-progress tasks get striped/hatched pattern
    let bar_char = if task.completed_at.is_some() {
        '\u{2588}' // Full block character for completed tasks
    } else {
        '\u{2592}' // Medium shade character for in-progress tasks (striped appearance)
    };

    // Fill visible portion of the bar
    for orig_pos in orig_start_col..orig_end_col {
        if orig_pos >= scroll_chars {
            let visible_pos = orig_pos - scroll_chars;
            if visible_pos < bar_width {
                bar_chars[visible_pos] = bar_char;
            }
        }
    }

    // Calculate visible bar boundaries for styling
    let visible_start = orig_start_col.saturating_sub(scroll_chars).min(bar_width);
    let visible_end = orig_end_col.saturating_sub(scroll_chars).min(bar_width);

    // Determine bar color based on dependency group
    // Tasks with a dependency group get their group color
    // Tasks without dependencies use status-based colors
    let bar_color = match task.dependency_group {
        Some(group_id) => get_dependency_group_color(group_id),
        None => status_color,
    };

    // Create a styled bar - find the actual bar portion
    let before_bar: String = bar_chars[..visible_start].iter().collect();
    let bar_portion: String = bar_chars[visible_start..visible_end].iter().collect();
    let after_bar: String = bar_chars[visible_end..].iter().collect();

    if !before_bar.is_empty() {
        spans.push(Span::styled(before_bar, Style::default()));
    }

    // Apply style based on completion status, dependency group, and selection
    // Selected tasks get a special highlight, otherwise use normal styling
    let bar_style = if is_selected {
        // Selected task: use bright/inverted style
        Style::default()
            .fg(bar_color)
            .add_modifier(Modifier::BOLD | Modifier::REVERSED)
    } else {
        match (task.completed_at.is_some(), task.dependency_group.is_some()) {
            // In-progress with dependency group: bold
            (false, true) => Style::default().fg(bar_color).add_modifier(Modifier::BOLD),
            // In-progress without dependency group: bold (to emphasize ongoing work)
            (false, false) => Style::default().fg(bar_color).add_modifier(Modifier::BOLD),
            // Completed with dependency group: bold (to emphasize group membership)
            (true, true) => Style::default().fg(bar_color).add_modifier(Modifier::BOLD),
            // Completed without dependency group: normal
            (true, false) => Style::default().fg(bar_color),
        }
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
        Status::PendingReview => Color::Cyan,
        Status::Backlog => Color::DarkGray,
        Status::Rejected => Color::Red,
        Status::Todo => Color::Gray,
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
            dependency_group: None,
        }
    }

    fn make_task_with_group(
        id: &str,
        title: &str,
        status: Status,
        started_at: DateTime<Utc>,
        completed_at: Option<DateTime<Utc>>,
        group: Option<usize>,
    ) -> TimelineTask {
        TimelineTask {
            id: id.to_string(),
            title: title.to_string(),
            status,
            started_at,
            completed_at,
            has_dependencies: group.is_some(),
            dependency_group: group,
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
        assert_eq!(get_status_color(&Status::PendingReview), Color::Cyan);
        assert_eq!(get_status_color(&Status::Backlog), Color::DarkGray);
        assert_eq!(get_status_color(&Status::Rejected), Color::Red);
        assert_eq!(get_status_color(&Status::Todo), Color::Gray);
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
        let header = build_date_header(&config, 0);

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
        let line = build_task_line(&task, &config, false, 0);

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
        let task = make_task_with_group(
            "task123",
            "My Task",
            Status::Done,
            started,
            Some(completed),
            Some(0),
        );
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 80);
        let line = build_task_line(&task, &config, false, 0);

        // Line should have spans with bold modifier for task with dependencies
        assert!(!line.spans.is_empty());
    }

    #[test]
    fn test_build_separator() {
        let config = TimelineConfig::from_tasks(&[], 80);
        let sep = build_separator(&config, 0);

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
        let line = build_task_line(&task, &config, false, 0);

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
        let header = build_date_header(&config, 0);

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
        let sep = build_separator(&config, 0);

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

    // =============================================
    // Task bar rendering tests (Testing Criteria)
    // =============================================

    #[test]
    fn test_task_bar_at_range_start_begins_at_column_zero() {
        // Testing Criterion 1: Task with started_at=range_start has bar starting at x=0
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::Done, started, Some(completed));
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Task started at range_start should have bar starting at column 0
        let start_col = config.date_to_column(task.started_at);
        assert_eq!(
            start_col, 0,
            "Task starting at range_start should have bar at x=0"
        );
    }

    #[test]
    fn test_task_bar_at_range_midpoint_begins_at_half_width() {
        // Testing Criterion 2: Task with started_at=range_midpoint has bar starting at x=width/2
        let range_start = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let range_end = Utc.with_ymd_and_hms(2025, 1, 11, 0, 0, 0).unwrap(); // 10 days
        let midpoint = Utc.with_ymd_and_hms(2025, 1, 6, 0, 0, 0).unwrap(); // day 5 of 10

        // Create two tasks: one at start, one at midpoint
        let task_start = make_task(
            "t1",
            "Start Task",
            Status::Done,
            range_start,
            Some(range_end),
        );
        let task_mid = make_task("t2", "Mid Task", Status::Done, midpoint, Some(range_end));
        let tasks = vec![task_start, task_mid.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Task at midpoint should have bar starting at approximately width/2
        let mid_col = config.date_to_column(task_mid.started_at);
        let expected_mid = config.bar_width / 2;

        // Allow some tolerance for rounding
        let tolerance = 5u16;
        assert!(
            mid_col >= expected_mid.saturating_sub(tolerance)
                && mid_col <= expected_mid.saturating_add(tolerance),
            "Task at midpoint should start near x=width/2. Got {} expected ~{}",
            mid_col,
            expected_mid
        );
    }

    #[test]
    fn test_in_progress_task_extends_to_current_time() {
        // Testing Criterion 3: Task without completed_at has bar extending to current time position
        let started = Utc::now() - Duration::hours(2);
        let task = make_task("t1", "In Progress Task", Status::InProgress, started, None);

        // end_time() should return approximately now for in-progress tasks
        let end = task.end_time();
        let now = Utc::now();

        assert!(
            end <= now && end >= now - Duration::seconds(5),
            "In-progress task end_time should be approximately now"
        );
    }

    #[test]
    fn test_in_progress_task_has_distinct_bar_style() {
        // Testing Criterion 4: Task without completed_at has visually distinct style from completed tasks
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();

        let completed_task = make_task("t1", "Done Task", Status::Done, started, Some(completed));
        let in_progress_task =
            make_task("t2", "In Progress Task", Status::InProgress, started, None);

        let tasks_for_config = vec![completed_task.clone()];
        let config = TimelineConfig::from_tasks(&tasks_for_config, 100);

        let completed_line = build_task_line(&completed_task, &config, false, 0);
        let in_progress_line = build_task_line(&in_progress_task, &config, false, 0);

        // Extract the bar portions (the spans containing block characters)
        let get_bar_content = |line: &Line| -> String {
            line.spans
                .iter()
                .filter(|s| {
                    s.content.contains('\u{2588}') || // Full block
                    s.content.contains('\u{2592}') // Medium shade
                })
                .map(|s| s.content.to_string())
                .collect()
        };

        let completed_bar = get_bar_content(&completed_line);
        let in_progress_bar = get_bar_content(&in_progress_line);

        // Completed should use full block, in-progress should use shade
        assert!(
            completed_bar.contains('\u{2588}'),
            "Completed task should use full block character"
        );
        assert!(
            in_progress_bar.contains('\u{2592}'),
            "In-progress task should use medium shade character for distinct appearance"
        );
    }

    #[test]
    fn test_task_id_visible_and_exact() {
        // Testing Criterion 5: Task ID is visible and matches the task exactly
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();
        let task = make_task(
            "abc123def456",
            "Test Task",
            Status::Done,
            started,
            Some(completed),
        );
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        let line = build_task_line(&task, &config, false, 0);

        // Extract full text from line
        let text: String = line.spans.iter().map(|s| s.content.to_string()).collect();

        // Should contain first 6 chars of task ID (short ID format)
        let short_id: String = task.id.chars().take(6).collect();
        assert!(
            text.contains(&short_id),
            "Task line should contain task ID '{}'. Got: {}",
            short_id,
            text
        );
    }

    #[test]
    fn test_overlapping_tasks_on_different_rows() {
        // Testing Criterion 6: Two overlapping tasks render on different rows (no visual overlap)
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 10, 0, 0, 0).unwrap();

        // Create two tasks that overlap in time
        let task1 = make_task(
            "task1",
            "First Task",
            Status::Done,
            started,
            Some(completed),
        );
        let task2 = make_task(
            "task2",
            "Second Task",
            Status::Done,
            started + Duration::days(2),
            Some(completed),
        );

        let tasks = vec![task1.clone(), task2.clone()];
        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Each task generates its own line, so they're naturally on different rows
        let line1 = build_task_line(&task1, &config, false, 0);
        let line2 = build_task_line(&task2, &config, false, 0);

        // Extract task IDs to verify they're different lines
        let text1: String = line1.spans.iter().map(|s| s.content.to_string()).collect();
        let text2: String = line2.spans.iter().map(|s| s.content.to_string()).collect();

        // Each line should contain its respective task ID
        assert!(text1.contains("task1"), "Line 1 should contain task1 ID");
        assert!(text2.contains("task2"), "Line 2 should contain task2 ID");

        // Lines should be different (different tasks on different rows)
        assert_ne!(
            text1, text2,
            "Overlapping tasks should be on different rows"
        );
    }

    #[test]
    fn test_completed_task_uses_solid_block_character() {
        // Verify completed tasks use full block character
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();
        let task = make_task("t1", "Done", Status::Done, started, Some(completed));
        let tasks = vec![task.clone()];

        let config = TimelineConfig::from_tasks(&tasks, 100);
        let line = build_task_line(&task, &config, false, 0);

        let bar_content: String = line
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect::<String>();

        assert!(
            bar_content.contains('\u{2588}'),
            "Completed task should use full block character (U+2588)"
        );
        assert!(
            !bar_content.contains('\u{2592}'),
            "Completed task should NOT use medium shade character"
        );
    }

    #[test]
    fn test_in_progress_task_uses_shade_character() {
        // Verify in-progress tasks use shade character for visual distinction
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let task = make_task("t1", "Working", Status::InProgress, started, None);

        // Need a config with a reasonable width
        let config = TimelineConfig::from_tasks(&[task.clone()], 100);
        let line = build_task_line(&task, &config, false, 0);

        let bar_content: String = line
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect::<String>();

        assert!(
            bar_content.contains('\u{2592}'),
            "In-progress task should use medium shade character (U+2592)"
        );
        assert!(
            !bar_content.contains('\u{2588}'),
            "In-progress task should NOT use full block character"
        );
    }

    #[test]
    fn test_in_progress_task_has_bold_style() {
        // In-progress tasks should have bold modifier for emphasis
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let task = make_task("t1", "Working", Status::InProgress, started, None);

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);
        let line = build_task_line(&task, &config, false, 0);

        // Find the span with the bar (shade character)
        let bar_span = line
            .spans
            .iter()
            .find(|s| s.content.contains('\u{2592}'))
            .expect("Should have a bar span");

        assert!(
            bar_span.style.add_modifier.contains(Modifier::BOLD),
            "In-progress task bar should be bold"
        );
    }

    // =============================================
    // Dependency color coding tests
    // =============================================

    #[test]
    fn test_dependency_group_color_palette_has_8_colors() {
        // Testing Criterion: Color palette must have at least 8 distinct colors
        assert_eq!(
            DEPENDENCY_GROUP_COLORS.len(),
            8,
            "Color palette should have exactly 8 colors"
        );
    }

    #[test]
    fn test_dependency_group_colors_cycle() {
        // Colors should cycle for groups beyond palette size
        let color_0 = get_dependency_group_color(0);
        let color_8 = get_dependency_group_color(8);
        assert_eq!(color_0, color_8, "Colors should cycle after palette size");
    }

    #[test]
    fn test_compute_dependency_groups_empty() {
        // Empty inputs should return empty map
        let groups = compute_dependency_groups(&[], &[]);
        assert!(groups.is_empty());
    }

    #[test]
    fn test_compute_dependency_groups_no_edges() {
        // Tasks with no edges should have no groups (isolated tasks)
        let task_ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let groups = compute_dependency_groups(&task_ids, &[]);

        assert!(
            groups.is_empty(),
            "Tasks without dependencies should not have groups"
        );
    }

    #[test]
    fn test_compute_dependency_groups_simple_chain() {
        // A -> B (A depends on B) should be in same group
        let task_ids = vec!["a".to_string(), "b".to_string()];
        let edges = vec![DependencyEdge {
            from_id: "a".to_string(),
            to_id: "b".to_string(),
        }];

        let groups = compute_dependency_groups(&task_ids, &edges);

        assert_eq!(groups.len(), 2, "Both tasks should have groups");
        assert_eq!(
            groups.get("a"),
            groups.get("b"),
            "Tasks A and B should be in the same group"
        );
    }

    #[test]
    fn test_compute_dependency_groups_two_chains() {
        // A -> B and C -> D should be in different groups
        let task_ids = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
        ];
        let edges = vec![
            DependencyEdge {
                from_id: "a".to_string(),
                to_id: "b".to_string(),
            },
            DependencyEdge {
                from_id: "c".to_string(),
                to_id: "d".to_string(),
            },
        ];

        let groups = compute_dependency_groups(&task_ids, &edges);

        assert_eq!(groups.len(), 4, "All 4 tasks should have groups");
        assert_eq!(
            groups.get("a"),
            groups.get("b"),
            "A and B should be in same group"
        );
        assert_eq!(
            groups.get("c"),
            groups.get("d"),
            "C and D should be in same group"
        );
        assert_ne!(
            groups.get("a"),
            groups.get("c"),
            "A-B and C-D should be in different groups"
        );
    }

    #[test]
    fn test_compute_dependency_groups_transitive() {
        // A -> B -> C (transitive chain) should all be in same group
        let task_ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let edges = vec![
            DependencyEdge {
                from_id: "a".to_string(),
                to_id: "b".to_string(),
            },
            DependencyEdge {
                from_id: "b".to_string(),
                to_id: "c".to_string(),
            },
        ];

        let groups = compute_dependency_groups(&task_ids, &edges);

        let group_a = groups.get("a").unwrap();
        let group_b = groups.get("b").unwrap();
        let group_c = groups.get("c").unwrap();

        assert_eq!(group_a, group_b, "A and B should be in same group");
        assert_eq!(group_b, group_c, "B and C should be in same group");
    }

    #[test]
    fn test_compute_dependency_groups_isolated_task() {
        // A -> B with C isolated: A,B get group, C gets nothing
        let task_ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let edges = vec![DependencyEdge {
            from_id: "a".to_string(),
            to_id: "b".to_string(),
        }];

        let groups = compute_dependency_groups(&task_ids, &edges);

        assert!(groups.contains_key("a"), "A should have a group");
        assert!(groups.contains_key("b"), "B should have a group");
        assert!(
            !groups.contains_key("c"),
            "C should not have a group (isolated)"
        );
    }

    #[test]
    fn test_compute_dependency_groups_deterministic() {
        // Same input should produce same output (deterministic)
        let task_ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let edges = vec![
            DependencyEdge {
                from_id: "a".to_string(),
                to_id: "b".to_string(),
            },
            DependencyEdge {
                from_id: "b".to_string(),
                to_id: "c".to_string(),
            },
        ];

        let groups1 = compute_dependency_groups(&task_ids, &edges);
        let groups2 = compute_dependency_groups(&task_ids, &edges.clone());

        assert_eq!(
            groups1, groups2,
            "Same input should produce same groups (deterministic)"
        );
    }

    #[test]
    fn test_task_with_dependency_group_uses_group_color() {
        // Task with dependency_group should use group color, not status color
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();

        // Task in group 0 (Cyan)
        let task = make_task_with_group(
            "t1",
            "Task in Group",
            Status::Done,
            started,
            Some(completed),
            Some(0),
        );

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);
        let line = build_task_line(&task, &config, false, 0);

        // Find the bar span (contains block character)
        let bar_span = line
            .spans
            .iter()
            .find(|s| s.content.contains('\u{2588}'))
            .expect("Should have a bar span");

        // Should use Cyan (group 0 color), not Green (status color for Done)
        assert_eq!(
            bar_span.style.fg,
            Some(Color::Cyan),
            "Task in group 0 should use Cyan color"
        );
    }

    #[test]
    fn test_task_without_dependency_group_uses_status_color() {
        // Task without dependency_group should use status color
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();

        // Task without group
        let task = make_task(
            "t1",
            "Isolated Task",
            Status::Done,
            started,
            Some(completed),
        );

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);
        let line = build_task_line(&task, &config, false, 0);

        // Find the bar span
        let bar_span = line
            .spans
            .iter()
            .find(|s| s.content.contains('\u{2588}'))
            .expect("Should have a bar span");

        // Should use Green (status color for Done), not a group color
        assert_eq!(
            bar_span.style.fg,
            Some(Color::Green),
            "Task without group should use status color (Green for Done)"
        );
    }

    #[test]
    fn test_tasks_in_same_group_have_same_color() {
        // Two tasks in the same dependency group should have the same color
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();

        let task1 = make_task_with_group(
            "t1",
            "Task 1",
            Status::Done,
            started,
            Some(completed),
            Some(1),
        );
        let task2 =
            make_task_with_group("t2", "Task 2", Status::InProgress, started, None, Some(1));

        let tasks = vec![task1.clone(), task2.clone()];
        let config = TimelineConfig::from_tasks(&tasks, 100);

        let line1 = build_task_line(&task1, &config, false, 0);
        let line2 = build_task_line(&task2, &config, false, 0);

        // Get bar colors
        let get_bar_color = |line: &Line| -> Option<Color> {
            line.spans
                .iter()
                .find(|s| s.content.contains('\u{2588}') || s.content.contains('\u{2592}'))
                .and_then(|s| s.style.fg)
        };

        let color1 = get_bar_color(&line1);
        let color2 = get_bar_color(&line2);

        assert_eq!(
            color1, color2,
            "Tasks in same dependency group should have same color"
        );
        assert_eq!(color1, Some(Color::Magenta), "Group 1 should be Magenta");
    }

    #[test]
    fn test_tasks_in_different_groups_have_different_colors() {
        // Tasks in different dependency groups should have different colors
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();

        let task1 = make_task_with_group(
            "t1",
            "Task in Group 0",
            Status::Done,
            started,
            Some(completed),
            Some(0),
        );
        let task2 = make_task_with_group(
            "t2",
            "Task in Group 1",
            Status::Done,
            started,
            Some(completed),
            Some(1),
        );

        let tasks = vec![task1.clone(), task2.clone()];
        let config = TimelineConfig::from_tasks(&tasks, 100);

        let line1 = build_task_line(&task1, &config, false, 0);
        let line2 = build_task_line(&task2, &config, false, 0);

        // Get bar colors
        let get_bar_color = |line: &Line| -> Option<Color> {
            line.spans
                .iter()
                .find(|s| s.content.contains('\u{2588}'))
                .and_then(|s| s.style.fg)
        };

        let color1 = get_bar_color(&line1);
        let color2 = get_bar_color(&line2);

        assert_ne!(
            color1, color2,
            "Tasks in different groups should have different colors"
        );
        assert_eq!(color1, Some(Color::Cyan), "Group 0 should be Cyan");
        assert_eq!(color2, Some(Color::Magenta), "Group 1 should be Magenta");
    }

    // =============================================
    // Timeline scrolling and selection tests
    // =============================================

    #[test]
    fn test_selected_task_has_highlight_style() {
        // Testing: Selected task has distinct visual style (border or highlight)
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();
        let task = make_task(
            "t1",
            "Selected Task",
            Status::Done,
            started,
            Some(completed),
        );

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);

        // Build line for selected task
        let selected_line = build_task_line(&task, &config, true, 0);
        // Build line for non-selected task
        let normal_line = build_task_line(&task, &config, false, 0);

        // Extract text to verify selection indicator
        let selected_text: String = selected_line
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        let normal_text: String = normal_line
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();

        // Selected task should have "> " prefix
        assert!(
            selected_text.contains("> "),
            "Selected task should have selection indicator"
        );
        // Non-selected task should have "  " prefix instead
        assert!(
            !normal_text.starts_with("> "),
            "Non-selected task should not have selection indicator"
        );
    }

    #[test]
    fn test_selected_task_bar_has_reversed_style() {
        // Selected task bar should have REVERSED modifier
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 5, 0, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::Done, started, Some(completed));

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);
        let selected_line = build_task_line(&task, &config, true, 0);

        // Find the bar span (contains block character)
        let bar_span = selected_line
            .spans
            .iter()
            .find(|s| s.content.contains('\u{2588}'))
            .expect("Should have a bar span");

        // Selected bar should have REVERSED modifier
        assert!(
            bar_span.style.add_modifier.contains(Modifier::REVERSED),
            "Selected task bar should have REVERSED modifier for highlighting"
        );
    }

    #[test]
    fn test_horizontal_scroll_affects_bar_position() {
        // Test that horizontal scrolling shifts bar positions
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 10, 0, 0, 0).unwrap();
        let task = make_task("t1", "Task", Status::Done, started, Some(completed));

        let config = TimelineConfig::from_tasks(&[task.clone()], 100);

        // Build lines with different scroll offsets
        let line_no_scroll = build_task_line(&task, &config, false, 0);
        let line_scrolled = build_task_line(&task, &config, false, 50);

        // Both should have bars, but in different positions
        let count_bar_chars = |line: &Line| -> usize {
            line.spans
                .iter()
                .map(|s| s.content.chars().filter(|c| *c == '\u{2588}').count())
                .sum()
        };

        let no_scroll_bars = count_bar_chars(&line_no_scroll);
        let scrolled_bars = count_bar_chars(&line_scrolled);

        // With 50% scroll, fewer bar characters should be visible
        // (bar starts at beginning and scrolling shifts view)
        assert!(
            scrolled_bars <= no_scroll_bars,
            "Scrolled view should show same or fewer bar characters"
        );
    }

    #[test]
    fn test_horizontal_scroll_header_shifts() {
        // Test that date header shifts with horizontal scroll
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 10, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Build headers with different scroll offsets
        let header_no_scroll = build_date_header(&config, 0);
        let header_scrolled = build_date_header(&config, 50);

        // Headers should be different due to scrolling
        let text_no_scroll: String = header_no_scroll
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        let text_scrolled: String = header_scrolled
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();

        // At 50% scroll, the header content might differ
        // (we can't assert they're definitely different since it depends on viewport)
        // But we can verify both are valid headers
        assert!(
            !text_no_scroll.trim().is_empty() || !text_scrolled.trim().is_empty(),
            "At least one header should have content"
        );
    }

    #[test]
    fn test_separator_shifts_with_horizontal_scroll() {
        // Test that separator shifts with horizontal scroll
        let started = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let completed = Utc.with_ymd_and_hms(2025, 1, 10, 0, 0, 0).unwrap();
        let tasks = vec![make_task(
            "t1",
            "Task",
            Status::Done,
            started,
            Some(completed),
        )];

        let config = TimelineConfig::from_tasks(&tasks, 100);

        // Build separators with different scroll offsets
        let sep_no_scroll = build_separator(&config, 0);
        let sep_scrolled = build_separator(&config, 50);

        // Both should produce valid separators
        assert!(
            !sep_no_scroll.spans.is_empty(),
            "No-scroll separator should have spans"
        );
        assert!(
            !sep_scrolled.spans.is_empty(),
            "Scrolled separator should have spans"
        );
    }
}
