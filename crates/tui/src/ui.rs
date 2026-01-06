//! UI rendering for the TUI.
//!
//! Provides layout and widget rendering using ratatui.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Tabs},
};

use crate::app::{ActiveTab, App};

/// Tab titles for the right panel.
const TAB_TITLES: [&str; 3] = ["Details", "Tree", "Timeline"];

/// Legend text for keyboard shortcuts.
const LEGEND: &str = " [j/k] Navigate  [Tab] Switch view  [Enter] Select  [q] Quit ";

/// Draw the entire UI.
pub fn draw(frame: &mut Frame, app: &App) {
    let chunks = create_main_layout(frame.area());

    // Draw left navigation panel
    draw_nav_panel(frame, chunks[0], app);

    // Draw right content area
    draw_content_area(frame, chunks[1], app);

    // Draw legend at bottom
    draw_legend(frame, chunks[2]);
}

/// Create the main three-part layout: nav panel, content area, legend.
fn create_main_layout(area: Rect) -> Vec<Rect> {
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(0),    // Main content (nav + content panels)
            Constraint::Length(1), // Legend bar
        ])
        .split(area)
        .iter()
        .flat_map(|&chunk| {
            if chunk.height > 1 {
                // Split the main content area horizontally
                Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([
                        Constraint::Percentage(25), // Left nav panel
                        Constraint::Percentage(75), // Right content area
                    ])
                    .split(chunk)
                    .to_vec()
            } else {
                // Legend bar stays as single chunk
                vec![chunk]
            }
        })
        .collect()
}

/// Draw the left navigation panel.
fn draw_nav_panel(frame: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .title(" Navigation ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    // TODO: Populate with actual task list from database
    let items: Vec<Line> = (0..10)
        .map(|i| {
            let style = if i == app.selected_index() {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let prefix = if i == app.selected_index() {
                "> "
            } else {
                "  "
            };
            Line::from(Span::styled(format!("{}Task {}", prefix, i + 1), style))
        })
        .collect();

    let nav_list = Paragraph::new(items).block(block);
    frame.render_widget(nav_list, area);
}

/// Draw the right content area with tabs and content.
fn draw_content_area(frame: &mut Frame, area: Rect, app: &App) {
    // Split into tabs header and content
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Tab bar
            Constraint::Min(0),    // Content area
        ])
        .split(area);

    // Draw tabs
    draw_tabs(frame, chunks[0], app.active_tab());

    // Draw content based on active tab
    draw_tab_content(frame, chunks[1], app);
}

/// Draw the tab bar.
fn draw_tabs(frame: &mut Frame, area: Rect, active: ActiveTab) {
    let titles: Vec<Line> = TAB_TITLES.iter().map(|t| Line::from(*t)).collect();

    let tabs = Tabs::new(titles)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan)),
        )
        .select(active.index())
        .style(Style::default().fg(Color::White))
        .highlight_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_widget(tabs, area);
}

/// Draw the content for the active tab.
fn draw_tab_content(frame: &mut Frame, area: Rect, app: &App) {
    let (title, content) = match app.active_tab() {
        ActiveTab::Details => (" Details ", "Task details will be shown here."),
        ActiveTab::Tree => (" Tree ", "Task tree hierarchy will be shown here."),
        ActiveTab::Timeline => (" Timeline ", "Task timeline will be shown here."),
    };

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let paragraph = Paragraph::new(content).block(block);
    frame.render_widget(paragraph, area);
}

/// Draw the legend bar at the bottom.
fn draw_legend(frame: &mut Frame, area: Rect) {
    let legend = Paragraph::new(LEGEND).style(Style::default().fg(Color::Black).bg(Color::Cyan));

    frame.render_widget(legend, area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tab_titles_count() {
        assert_eq!(TAB_TITLES.len(), 3);
    }

    #[test]
    fn test_legend_not_empty() {
        assert!(!LEGEND.is_empty());
    }

    #[test]
    fn test_create_main_layout_produces_three_chunks() {
        // Create a reasonably sized test area
        let area = Rect::new(0, 0, 80, 24);
        let chunks = create_main_layout(area);
        assert_eq!(chunks.len(), 3, "Expected 3 chunks: nav, content, legend");
    }

    #[test]
    fn test_create_main_layout_small_terminal() {
        // Test with a small terminal size
        let area = Rect::new(0, 0, 40, 10);
        let chunks = create_main_layout(area);
        // Should still produce chunks without panicking
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_create_main_layout_wide_terminal() {
        // Test with a wide terminal
        let area = Rect::new(0, 0, 300, 50);
        let chunks = create_main_layout(area);
        assert!(!chunks.is_empty());
    }
}
