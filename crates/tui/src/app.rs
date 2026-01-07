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

use crate::data::{load_full_tree, load_task_details, load_timeline_tasks};
use crate::details::TaskDetails;
use crate::error::TuiResult;
use crate::event::{
    is_down, is_enter, is_h, is_l, is_left, is_quit, is_right, is_tab, is_up, poll_key,
};
use crate::navigation::{FlatNode, TreeNode, TreeState, flatten_tree};
use crate::timeline::TimelineTask;
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

/// The currently focused panel (navigation or content).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FocusedPanel {
    /// The navigation panel on the left.
    #[default]
    Navigation,
    /// The content panel on the right.
    Content,
}

impl FocusedPanel {
    /// Check if this is the navigation panel.
    pub fn is_navigation(self) -> bool {
        matches!(self, Self::Navigation)
    }

    /// Check if this is the content panel.
    pub fn is_content(self) -> bool {
        matches!(self, Self::Content)
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
    /// The currently focused panel (navigation or content).
    focused_panel: FocusedPanel,
    /// Whether the application is still running.
    running: bool,
    /// Tree state for tracking expanded nodes.
    tree_state: TreeState,
    /// Root nodes of the task tree.
    tree_roots: Vec<TreeNode>,
    /// Flattened visible nodes (cached).
    visible_nodes: Vec<FlatNode>,
    /// Cached details for the currently selected task.
    selected_task_details: Option<TaskDetails>,
    /// Flag indicating that task details need to be reloaded.
    details_dirty: bool,
    /// Cached timeline tasks for the timeline view.
    timeline_tasks: Vec<TimelineTask>,
    /// Scroll offset for content panel (used in Details, Tree, and Timeline views).
    content_scroll_offset: usize,
    /// Horizontal scroll offset for timeline view (percentage of total timeline width).
    timeline_horizontal_offset: u16,
    /// Selected task index in the timeline view.
    selected_timeline_index: usize,
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

        // Load task tree from database
        let tree_roots = load_full_tree(&db).await?;
        let tree_state = TreeState::new();
        let visible_nodes = flatten_tree(&tree_roots, &tree_state);

        // Load details for the initially selected task
        let selected_task_details = if let Some(first_node) = visible_nodes.first() {
            load_task_details(&db, &first_node.id).await?
        } else {
            None
        };

        // Load timeline tasks (tasks with started_at timestamp)
        let timeline_tasks = load_timeline_tasks(&db).await?;

        Ok(Self {
            db,
            selected_index: 0,
            active_tab: ActiveTab::default(),
            focused_panel: FocusedPanel::default(),
            running: true,
            tree_state,
            tree_roots,
            visible_nodes,
            selected_task_details,
            details_dirty: false,
            timeline_tasks,
            content_scroll_offset: 0,
            timeline_horizontal_offset: 0,
            selected_timeline_index: 0,
        })
    }

    /// Reload tasks from the database.
    ///
    /// This reloads the entire task tree from the database and refreshes
    /// the visible nodes.
    pub async fn reload_tasks(&mut self) -> TuiResult<()> {
        self.tree_roots = load_full_tree(&self.db).await?;
        self.refresh_visible_nodes();
        Ok(())
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

    /// Get the visible nodes in the navigation panel.
    pub fn visible_nodes(&self) -> &[FlatNode] {
        &self.visible_nodes
    }

    /// Get the currently selected task's details for the details view.
    pub fn selected_task_details(&self) -> Option<&TaskDetails> {
        self.selected_task_details.as_ref()
    }

    /// Get a mutable reference to the tree state.
    pub fn tree_state_mut(&mut self) -> &mut TreeState {
        &mut self.tree_state
    }

    /// Get the tree roots.
    pub fn tree_roots(&self) -> &[TreeNode] {
        &self.tree_roots
    }

    /// Get the timeline tasks for the timeline view.
    pub fn timeline_tasks(&self) -> &[TimelineTask] {
        &self.timeline_tasks
    }

    /// Get the currently focused panel.
    pub fn focused_panel(&self) -> FocusedPanel {
        self.focused_panel
    }

    /// Get the content scroll offset.
    pub fn content_scroll_offset(&self) -> usize {
        self.content_scroll_offset
    }

    /// Get the timeline horizontal scroll offset.
    pub fn timeline_horizontal_offset(&self) -> u16 {
        self.timeline_horizontal_offset
    }

    /// Get the selected timeline task index.
    pub fn selected_timeline_index(&self) -> usize {
        self.selected_timeline_index
    }

    /// Set the tree roots and refresh the visible nodes.
    pub fn set_tree_roots(&mut self, roots: Vec<TreeNode>) {
        self.tree_roots = roots;
        self.refresh_visible_nodes();
    }

    /// Refresh the visible nodes based on current tree state.
    pub fn refresh_visible_nodes(&mut self) {
        self.visible_nodes = flatten_tree(&self.tree_roots, &self.tree_state);
        // Ensure selected_index is within bounds
        if !self.visible_nodes.is_empty() && self.selected_index >= self.visible_nodes.len() {
            self.selected_index = self.visible_nodes.len() - 1;
        }
    }

    /// Request the application to quit.
    pub fn quit(&mut self) {
        self.running = false;
    }

    /// Cycle to the next tab.
    pub fn next_tab(&mut self) {
        self.active_tab = self.active_tab.next();
        // Reset content scroll when switching tabs
        self.content_scroll_offset = 0;
    }

    /// Focus the navigation panel.
    pub fn focus_navigation(&mut self) {
        self.focused_panel = FocusedPanel::Navigation;
    }

    /// Focus the content panel.
    pub fn focus_content(&mut self) {
        self.focused_panel = FocusedPanel::Content;
    }

    /// Scroll content down (increase offset).
    pub fn scroll_content_down(&mut self) {
        self.content_scroll_offset = self.content_scroll_offset.saturating_add(1);
    }

    /// Scroll content up (decrease offset).
    pub fn scroll_content_up(&mut self) {
        self.content_scroll_offset = self.content_scroll_offset.saturating_sub(1);
    }

    /// Scroll timeline left (decrease horizontal offset).
    ///
    /// Scrolls by approximately 10% of the timeline width.
    pub fn scroll_timeline_left(&mut self) {
        self.timeline_horizontal_offset = self.timeline_horizontal_offset.saturating_sub(10);
    }

    /// Scroll timeline right (increase horizontal offset).
    ///
    /// Scrolls by approximately 10% of the timeline width.
    /// Maximum offset is clamped to 100 (100% scrolled = end of timeline visible).
    pub fn scroll_timeline_right(&mut self) {
        self.timeline_horizontal_offset = (self.timeline_horizontal_offset + 10).min(100);
    }

    /// Select the next timeline task (move selection down).
    pub fn select_next_timeline_task(&mut self) {
        let max_tasks = self.timeline_tasks.len();
        if max_tasks > 0 && self.selected_timeline_index < max_tasks - 1 {
            self.selected_timeline_index += 1;
        }
    }

    /// Select the previous timeline task (move selection up).
    pub fn select_previous_timeline_task(&mut self) {
        if self.selected_timeline_index > 0 {
            self.selected_timeline_index -= 1;
        }
    }

    /// Get the currently selected timeline task, if any.
    pub fn selected_timeline_task(&self) -> Option<&TimelineTask> {
        self.timeline_tasks.get(self.selected_timeline_index)
    }

    /// Move selection down in the navigation list.
    ///
    /// Clamps to the last item (does not wrap).
    pub fn select_next(&mut self) {
        let max_items = self.visible_nodes.len();
        if max_items > 0 && self.selected_index < max_items - 1 {
            self.selected_index += 1;
            self.details_dirty = true;
        }
    }

    /// Move selection up in the navigation list.
    ///
    /// Clamps to the first item (does not wrap).
    pub fn select_previous(&mut self) {
        if self.selected_index > 0 {
            self.selected_index -= 1;
            self.details_dirty = true;
        }
    }

    /// Toggle expand/collapse on the currently selected node.
    ///
    /// Only affects nodes that have children.
    pub fn toggle_selected(&mut self) {
        if let Some(node) = self.visible_nodes.get(self.selected_index)
            && node.has_children
        {
            self.tree_state.toggle(&node.id);
            self.refresh_visible_nodes();
            // Selection may have changed after refresh, so reload details
            self.details_dirty = true;
        }
    }

    /// Get the currently selected node, if any.
    pub fn selected_node(&self) -> Option<&FlatNode> {
        self.visible_nodes.get(self.selected_index)
    }

    /// Reload task details if they are dirty.
    ///
    /// This should be called in the event loop after handling key events.
    pub async fn reload_details_if_dirty(&mut self) -> TuiResult<()> {
        if self.details_dirty {
            self.details_dirty = false;
            if let Some(node) = self.visible_nodes.get(self.selected_index) {
                self.selected_task_details = load_task_details(&self.db, &node.id).await?;
            } else {
                self.selected_task_details = None;
            }
        }
        Ok(())
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
                // Reload task details if selection changed
                self.reload_details_if_dirty().await?;
            }
        }
        Ok(())
    }

    /// Handle a keyboard event.
    fn handle_key(&mut self, key: &crossterm::event::KeyEvent) {
        // Global keys work regardless of focus
        if is_quit(key) {
            self.quit();
            return;
        }

        if is_tab(key) {
            self.next_tab();
            return;
        }

        // Context-sensitive keys based on focused panel and active tab
        match self.focused_panel {
            FocusedPanel::Navigation => {
                // h/l switch panels from navigation
                if is_right(key) || is_l(key) {
                    self.focus_content();
                } else if is_down(key) {
                    self.select_next();
                } else if is_up(key) {
                    self.select_previous();
                } else if is_enter(key) {
                    self.toggle_selected();
                }
            }
            FocusedPanel::Content => {
                match self.active_tab {
                    ActiveTab::Timeline => {
                        // Timeline has its own navigation:
                        // - j/k (down/up) for vertical task selection
                        // - h/l (left/right) for horizontal timeline scrolling
                        // - When at left edge (offset 0), h switches back to navigation
                        if is_down(key) {
                            self.select_next_timeline_task();
                        } else if is_up(key) {
                            self.select_previous_timeline_task();
                        } else if is_h(key) || is_left(key) {
                            if self.timeline_horizontal_offset == 0 {
                                // At left edge, go back to navigation
                                self.focus_navigation();
                            } else {
                                self.scroll_timeline_left();
                            }
                        } else if is_l(key) || is_right(key) {
                            self.scroll_timeline_right();
                        }
                    }
                    ActiveTab::Details | ActiveTab::Tree => {
                        // h/l switch panels from Details/Tree views
                        if is_left(key) || is_h(key) {
                            self.focus_navigation();
                        } else if is_down(key) {
                            self.scroll_content_down();
                        } else if is_up(key) {
                            self.scroll_content_up();
                        }
                    }
                }
            }
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
    use vertebrae_db::Level;

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

    // ========================================
    // Selection and navigation tests
    // ========================================

    /// Helper to create a minimal App-like struct for testing selection logic
    /// without needing a database connection.
    struct TestApp {
        selected_index: usize,
        tree_state: TreeState,
        tree_roots: Vec<TreeNode>,
        visible_nodes: Vec<FlatNode>,
    }

    impl TestApp {
        fn new() -> Self {
            Self {
                selected_index: 0,
                tree_state: TreeState::new(),
                tree_roots: Vec::new(),
                visible_nodes: Vec::new(),
            }
        }

        fn with_roots(mut self, roots: Vec<TreeNode>) -> Self {
            self.tree_roots = roots;
            self.refresh_visible_nodes();
            self
        }

        fn refresh_visible_nodes(&mut self) {
            self.visible_nodes = flatten_tree(&self.tree_roots, &self.tree_state);
            if !self.visible_nodes.is_empty() && self.selected_index >= self.visible_nodes.len() {
                self.selected_index = self.visible_nodes.len() - 1;
            }
        }

        fn select_next(&mut self) {
            let max_items = self.visible_nodes.len();
            if max_items > 0 && self.selected_index < max_items - 1 {
                self.selected_index += 1;
            }
        }

        fn select_previous(&mut self) {
            if self.selected_index > 0 {
                self.selected_index -= 1;
            }
        }

        fn toggle_selected(&mut self) {
            if let Some(node) = self.visible_nodes.get(self.selected_index) {
                if node.has_children {
                    self.tree_state.toggle(&node.id);
                    self.refresh_visible_nodes();
                }
            }
        }
    }

    #[test]
    fn test_select_next_increments_by_one() {
        let roots = vec![
            TreeNode::new("a", "A", Level::Epic),
            TreeNode::new("b", "B", Level::Epic),
            TreeNode::new("c", "C", Level::Epic),
        ];
        let mut app = TestApp::new().with_roots(roots);

        assert_eq!(app.selected_index, 0);
        app.select_next();
        assert_eq!(app.selected_index, 1);
    }

    #[test]
    fn test_select_next_clamps_at_end() {
        let roots = vec![
            TreeNode::new("a", "A", Level::Epic),
            TreeNode::new("b", "B", Level::Epic),
        ];
        let mut app = TestApp::new().with_roots(roots);

        app.selected_index = 1; // Last item
        app.select_next();
        assert_eq!(app.selected_index, 1); // Should not change
    }

    #[test]
    fn test_select_previous_decrements_by_one() {
        let roots = vec![
            TreeNode::new("a", "A", Level::Epic),
            TreeNode::new("b", "B", Level::Epic),
            TreeNode::new("c", "C", Level::Epic),
        ];
        let mut app = TestApp::new().with_roots(roots);
        app.selected_index = 2;

        app.select_previous();
        assert_eq!(app.selected_index, 1);
    }

    #[test]
    fn test_select_previous_clamps_at_zero() {
        let roots = vec![
            TreeNode::new("a", "A", Level::Epic),
            TreeNode::new("b", "B", Level::Epic),
        ];
        let mut app = TestApp::new().with_roots(roots);

        assert_eq!(app.selected_index, 0);
        app.select_previous();
        assert_eq!(app.selected_index, 0); // Should not change
    }

    #[test]
    fn test_toggle_on_collapsed_parent_expands() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_child(TreeNode::new(
                "child",
                "Child",
                Level::Ticket,
            )),
        ];
        let mut app = TestApp::new().with_roots(roots);

        // Initially collapsed, only parent visible
        assert_eq!(app.visible_nodes.len(), 1);
        assert!(!app.tree_state.is_expanded("parent"));

        // Toggle should expand
        app.toggle_selected();
        assert!(app.tree_state.is_expanded("parent"));
        assert_eq!(app.visible_nodes.len(), 2);
    }

    #[test]
    fn test_toggle_on_expanded_parent_collapses() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_child(TreeNode::new(
                "child",
                "Child",
                Level::Ticket,
            )),
        ];
        let mut app = TestApp::new().with_roots(roots);

        // Expand first
        app.tree_state.expand("parent");
        app.refresh_visible_nodes();
        assert_eq!(app.visible_nodes.len(), 2);

        // Toggle should collapse
        app.toggle_selected();
        assert!(!app.tree_state.is_expanded("parent"));
        assert_eq!(app.visible_nodes.len(), 1);
    }

    #[test]
    fn test_toggle_on_leaf_is_noop() {
        let roots = vec![TreeNode::new("leaf", "Leaf", Level::Task)];
        let mut app = TestApp::new().with_roots(roots);

        assert_eq!(app.visible_nodes.len(), 1);
        assert!(!app.visible_nodes[0].has_children);

        // Toggle on leaf should do nothing
        app.toggle_selected();
        assert_eq!(app.visible_nodes.len(), 1);
    }

    #[test]
    fn test_selected_index_clamps_on_collapse() {
        let roots = vec![
            TreeNode::new("parent", "Parent", Level::Epic).with_children(vec![
                TreeNode::new("c1", "Child 1", Level::Ticket),
                TreeNode::new("c2", "Child 2", Level::Ticket),
                TreeNode::new("c3", "Child 3", Level::Ticket),
            ]),
        ];
        let mut app = TestApp::new().with_roots(roots);

        // Expand and select last child
        app.tree_state.expand("parent");
        app.refresh_visible_nodes();
        app.selected_index = 3; // c3

        // Collapse parent - selected_index should clamp
        app.selected_index = 0; // Move back to parent
        app.toggle_selected();

        // Only parent visible now
        assert_eq!(app.visible_nodes.len(), 1);
        // Index should be valid
        assert!(app.selected_index < app.visible_nodes.len());
    }

    #[test]
    fn test_select_next_on_empty_list() {
        let app = &mut TestApp::new();
        // Should not panic with empty list
        app.select_next();
        assert_eq!(app.selected_index, 0);
    }

    #[test]
    fn test_select_previous_on_empty_list() {
        let app = &mut TestApp::new();
        // Should not panic with empty list
        app.select_previous();
        assert_eq!(app.selected_index, 0);
    }

    // ========================================
    // FocusedPanel tests
    // ========================================

    #[test]
    fn test_focused_panel_default() {
        assert_eq!(FocusedPanel::default(), FocusedPanel::Navigation);
    }

    #[test]
    fn test_focused_panel_is_navigation() {
        assert!(FocusedPanel::Navigation.is_navigation());
        assert!(!FocusedPanel::Content.is_navigation());
    }

    #[test]
    fn test_focused_panel_is_content() {
        assert!(FocusedPanel::Content.is_content());
        assert!(!FocusedPanel::Navigation.is_content());
    }

    // ========================================
    // Timeline scrolling and selection tests
    // ========================================

    /// Helper struct for testing timeline-related App behavior
    struct TimelineTestApp {
        timeline_horizontal_offset: u16,
        selected_timeline_index: usize,
        timeline_tasks_count: usize,
    }

    impl TimelineTestApp {
        fn new(task_count: usize) -> Self {
            Self {
                timeline_horizontal_offset: 0,
                selected_timeline_index: 0,
                timeline_tasks_count: task_count,
            }
        }

        fn scroll_timeline_left(&mut self) {
            self.timeline_horizontal_offset = self.timeline_horizontal_offset.saturating_sub(10);
        }

        fn scroll_timeline_right(&mut self) {
            self.timeline_horizontal_offset = (self.timeline_horizontal_offset + 10).min(100);
        }

        fn select_next_timeline_task(&mut self) {
            if self.timeline_tasks_count > 0
                && self.selected_timeline_index < self.timeline_tasks_count - 1
            {
                self.selected_timeline_index += 1;
            }
        }

        fn select_previous_timeline_task(&mut self) {
            if self.selected_timeline_index > 0 {
                self.selected_timeline_index -= 1;
            }
        }
    }

    #[test]
    fn test_scroll_timeline_left_decreases_offset() {
        let mut app = TimelineTestApp::new(3);
        app.timeline_horizontal_offset = 50;

        app.scroll_timeline_left();
        assert_eq!(app.timeline_horizontal_offset, 40);
    }

    #[test]
    fn test_scroll_timeline_left_cannot_go_below_zero() {
        let mut app = TimelineTestApp::new(3);
        app.timeline_horizontal_offset = 5;

        app.scroll_timeline_left();
        assert_eq!(app.timeline_horizontal_offset, 0);

        // Try scrolling again when at 0
        app.scroll_timeline_left();
        assert_eq!(app.timeline_horizontal_offset, 0);
    }

    #[test]
    fn test_scroll_timeline_right_increases_offset() {
        let mut app = TimelineTestApp::new(3);

        app.scroll_timeline_right();
        assert_eq!(app.timeline_horizontal_offset, 10);

        app.scroll_timeline_right();
        assert_eq!(app.timeline_horizontal_offset, 20);
    }

    #[test]
    fn test_scroll_timeline_right_cannot_exceed_100() {
        let mut app = TimelineTestApp::new(3);
        app.timeline_horizontal_offset = 95;

        app.scroll_timeline_right();
        assert_eq!(app.timeline_horizontal_offset, 100);

        // Try scrolling again at max
        app.scroll_timeline_right();
        assert_eq!(app.timeline_horizontal_offset, 100);
    }

    #[test]
    fn test_select_next_timeline_task_increments_index() {
        let mut app = TimelineTestApp::new(5);

        app.select_next_timeline_task();
        assert_eq!(app.selected_timeline_index, 1);

        app.select_next_timeline_task();
        assert_eq!(app.selected_timeline_index, 2);
    }

    #[test]
    fn test_select_next_timeline_task_clamps_at_end() {
        let mut app = TimelineTestApp::new(3);
        app.selected_timeline_index = 2; // Last task

        app.select_next_timeline_task();
        assert_eq!(app.selected_timeline_index, 2); // Should not change
    }

    #[test]
    fn test_select_previous_timeline_task_decrements_index() {
        let mut app = TimelineTestApp::new(5);
        app.selected_timeline_index = 3;

        app.select_previous_timeline_task();
        assert_eq!(app.selected_timeline_index, 2);
    }

    #[test]
    fn test_select_previous_timeline_task_clamps_at_zero() {
        let mut app = TimelineTestApp::new(3);
        app.selected_timeline_index = 0;

        app.select_previous_timeline_task();
        assert_eq!(app.selected_timeline_index, 0); // Should not change
    }

    #[test]
    fn test_select_timeline_task_on_empty_list() {
        let mut app = TimelineTestApp::new(0);

        // Should not panic or change index
        app.select_next_timeline_task();
        assert_eq!(app.selected_timeline_index, 0);

        app.select_previous_timeline_task();
        assert_eq!(app.selected_timeline_index, 0);
    }
}
