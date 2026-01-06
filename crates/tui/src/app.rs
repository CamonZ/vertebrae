//! Main application state and event loop.

use std::io::{self, Stdout};
use std::path::Path;
use std::time::Duration;

use crossterm::{
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::Terminal;
use ratatui::prelude::*;

use vertebrae_db::Database;

use crate::error::TuiResult;
use crate::event::{is_down, is_enter, is_quit, is_tab, is_up, poll_key};
use crate::ui;

/// The active tab in the right panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ActiveTab {
    #[default]
    Details,
    Tree,
    Timeline,
}

impl ActiveTab {
    /// Cycle to the next tab.
    pub fn next(self) -> Self {
        match self {
            Self::Details => Self::Tree,
            Self::Tree => Self::Timeline,
            Self::Timeline => Self::Details,
        }
    }

    /// Get the index of the current tab (0, 1, or 2).
    pub fn index(self) -> usize {
        match self {
            Self::Details => 0,
            Self::Tree => 1,
            Self::Timeline => 2,
        }
    }
}

/// Main application state.
pub struct App {
    /// Database connection.
    db: Database,
    /// Index of the currently selected task in the navigation list.
    selected_index: usize,
    /// The active tab in the right panel.
    active_tab: ActiveTab,
    /// Whether the application is still running.
    running: bool,
}

impl App {
    /// Create a new App instance connected to the database.
    ///
    /// # Arguments
    ///
    /// * `db_path` - Optional path to the database. If `None`, uses the default path.
    ///
    /// # Errors
    ///
    /// Returns `TuiError::Database` if the database connection fails.
    pub async fn new(db_path: Option<&Path>) -> TuiResult<Self> {
        let path = match db_path {
            Some(p) => p.to_path_buf(),
            None => Database::default_path()?,
        };

        let db = Database::connect(&path).await?;
        db.init().await?;

        Ok(Self {
            db,
            selected_index: 0,
            active_tab: ActiveTab::default(),
            running: true,
        })
    }

    /// Get a reference to the database.
    pub fn db(&self) -> &Database {
        &self.db
    }

    /// Get the currently selected task index.
    pub fn selected_index(&self) -> usize {
        self.selected_index
    }

    /// Get the active tab.
    pub fn active_tab(&self) -> ActiveTab {
        self.active_tab
    }

    /// Check if the application is still running.
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// Request the application to quit.
    pub fn quit(&mut self) {
        self.running = false;
    }

    /// Cycle to the next tab.
    pub fn next_tab(&mut self) {
        self.active_tab = self.active_tab.next();
    }

    /// Move selection down in the navigation list.
    pub fn select_next(&mut self, max_items: usize) {
        if max_items > 0 {
            self.selected_index = (self.selected_index + 1) % max_items;
        }
    }

    /// Move selection up in the navigation list.
    pub fn select_previous(&mut self, max_items: usize) {
        if max_items > 0 {
            self.selected_index = self.selected_index.checked_sub(1).unwrap_or(max_items - 1);
        }
    }

    /// Run the main application loop.
    ///
    /// This initializes the terminal, runs the event loop, and ensures
    /// the terminal is restored on exit (even on panic).
    pub async fn run(&mut self) -> TuiResult<()> {
        // Initialize terminal
        let mut terminal = init_terminal()?;

        // Use scopeguard to ensure terminal cleanup on panic
        // The guard will run restore_terminal() even if we panic
        let _guard = scopeguard::guard((), |()| {
            let _ = restore_terminal();
        });

        let result = self.event_loop(&mut terminal).await;

        // Explicitly drop guard before returning (runs cleanup)
        drop(_guard);

        result
    }

    /// The main event loop.
    async fn event_loop(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    ) -> TuiResult<()> {
        while self.running {
            // Draw the UI
            terminal.draw(|frame| ui::draw(frame, self))?;

            // Poll for keyboard events
            if let Some(key) = poll_key(Duration::from_millis(100))? {
                self.handle_key(&key);
            }
        }
        Ok(())
    }

    /// Handle a keyboard event.
    fn handle_key(&mut self, key: &crossterm::event::KeyEvent) {
        if is_quit(key) {
            self.quit();
        } else if is_tab(key) {
            self.next_tab();
        } else if is_down(key) {
            // TODO: Get actual item count from database
            self.select_next(10);
        } else if is_up(key) {
            // TODO: Get actual item count from database
            self.select_previous(10);
        } else if is_enter(key) {
            // TODO: Handle selection
        }
    }
}

/// Initialize the terminal for TUI rendering.
fn init_terminal() -> TuiResult<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let terminal = Terminal::new(backend)?;
    Ok(terminal)
}

/// Restore the terminal to its original state.
fn restore_terminal() -> TuiResult<()> {
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_active_tab_next() {
        assert_eq!(ActiveTab::Details.next(), ActiveTab::Tree);
        assert_eq!(ActiveTab::Tree.next(), ActiveTab::Timeline);
        assert_eq!(ActiveTab::Timeline.next(), ActiveTab::Details);
    }

    #[test]
    fn test_active_tab_index() {
        assert_eq!(ActiveTab::Details.index(), 0);
        assert_eq!(ActiveTab::Tree.index(), 1);
        assert_eq!(ActiveTab::Timeline.index(), 2);
    }

    #[test]
    fn test_active_tab_default() {
        assert_eq!(ActiveTab::default(), ActiveTab::Details);
    }
}
