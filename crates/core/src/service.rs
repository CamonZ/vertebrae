//! Task service trait and implementation
//!
//! Provides the main abstraction layer for task operations. The `TaskService` trait
//! defines the interface for all task management operations, enabling both CLI and GUI
//! to share the same business logic.

use crate::error::ServiceResult;
use crate::models::Task;
use crate::models::{BlockerNode, CodeRef, Level, Priority, Section, SectionType, TaskFilter};
use async_trait::async_trait;

use std::sync::Arc;

// Re-export commonly used types
pub use crate::models::{Level as TaskLevel, Priority as TaskPriority};

/// Event representing a task mutation for cache invalidation
#[derive(Debug, Clone)]
pub enum MutationEvent {
    /// Task was created
    TaskCreated { id: String },
    /// Task was updated (any field change)
    TaskUpdated { id: String },
    /// Task was deleted
    TaskDeleted { id: String },
}

/// Callback for mutation events - fires after each mutation completes
/// Used by consumers (CLI, GUI) to invalidate caches
pub type MutationCallback = Arc<dyn Fn(MutationEvent) + Send + Sync>;

/// Options for creating a new task
#[derive(Debug, Default)]
pub struct CreateTaskOptions {
    /// Title of the task (required)
    pub title: String,
    /// Optional description
    pub description: Option<String>,
    /// Task level (defaults to Task)
    pub level: Option<Level>,
    /// Task priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Parent task ID
    pub parent_id: Option<String>,
    /// Workflow ID to assign at creation time (skips the project default)
    pub workflow_id: Option<String>,
    /// IDs of tasks this task depends on
    pub depends_on: Vec<String>,
    /// Optional custom ID (for testing) - if not provided, ID is auto-generated
    pub id: Option<String>,
}

impl CreateTaskOptions {
    /// Create new options with a title
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..Default::default()
        }
    }

    /// Set the description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the level
    pub fn with_level(mut self, level: Level) -> Self {
        self.level = Some(level);
        self
    }

    /// Set the priority
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(priority);
        self
    }

    /// Add a tag
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Set the parent task ID
    pub fn with_parent(mut self, parent_id: impl Into<String>) -> Self {
        self.parent_id = Some(parent_id.into());
        self
    }

    /// Set the workflow ID to assign at creation time
    pub fn with_workflow(mut self, workflow_id: impl Into<String>) -> Self {
        self.workflow_id = Some(workflow_id.into());
        self
    }

    /// Add a dependency
    pub fn with_dependency(mut self, dep_id: impl Into<String>) -> Self {
        self.depends_on.push(dep_id.into());
        self
    }

    /// Set a custom ID (primarily for testing)
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
}

/// Options for updating a task
#[derive(Debug, Default)]
pub struct UpdateTaskOptions {
    /// New title (if Some)
    pub title: Option<String>,
    /// New description (Some(Some(x)) to set, Some(None) to clear)
    pub description: Option<Option<String>>,
    /// New priority (Some(Some(x)) to set, Some(None) to clear)
    pub priority: Option<Option<Priority>>,
    /// Tags to add
    pub add_tags: Vec<String>,
    /// Tags to remove
    pub remove_tags: Vec<String>,
    /// New parent ID (Some(Some(x)) to set, Some(None) to remove)
    pub parent_id: Option<Option<String>>,
    /// Whether the task is archived
    pub archived: Option<bool>,
    /// New task level (epic, ticket, task)
    pub level: Option<String>,
    /// Worktree path (Some(Some(x)) to set, Some(None) to clear)
    pub worktree: Option<Option<String>>,
}

impl UpdateTaskOptions {
    /// Create new empty update options
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new title
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Set a new description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(Some(description.into()));
        self
    }

    /// Clear the description
    pub fn clear_description(mut self) -> Self {
        self.description = Some(None);
        self
    }

    /// Set a new priority
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(Some(priority));
        self
    }

    /// Clear the priority
    pub fn clear_priority(mut self) -> Self {
        self.priority = Some(None);
        self
    }

    /// Add a tag
    pub fn add_tag(mut self, tag: impl Into<String>) -> Self {
        self.add_tags.push(tag.into());
        self
    }

    /// Remove a tag
    pub fn remove_tag(mut self, tag: impl Into<String>) -> Self {
        self.remove_tags.push(tag.into());
        self
    }

    /// Set a new parent
    pub fn with_parent(mut self, parent_id: impl Into<String>) -> Self {
        self.parent_id = Some(Some(parent_id.into()));
        self
    }

    /// Remove the parent
    pub fn clear_parent(mut self) -> Self {
        self.parent_id = Some(None);
        self
    }

    /// Set the archived flag
    pub fn with_archived(mut self, value: bool) -> Self {
        self.archived = Some(value);
        self
    }

    /// Set a new worktree path
    pub fn with_worktree(mut self, worktree: impl Into<String>) -> Self {
        self.worktree = Some(Some(worktree.into()));
        self
    }

    /// Clear the worktree path
    pub fn clear_worktree(mut self) -> Self {
        self.worktree = Some(None);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.archived.is_some()
            || self.worktree.is_some()
    }
}

/// Service trait for task management operations
///
/// This trait defines the interface for all task-related business logic.
/// It abstracts over the database layer, allowing both CLI and GUI to
/// share the same operations while enabling easy testing through mocks.
///
/// # Object Safety
///
/// This trait is object-safe, enabling dynamic dispatch when needed.
#[async_trait]
pub trait TaskService: Send + Sync {
    // =========================================================================
    // Task CRUD Operations
    // =========================================================================

    /// Create a new task
    ///
    /// Returns the ID of the created task.
    async fn create_task(&self, options: CreateTaskOptions) -> ServiceResult<String>;

    /// Get a task by ID
    async fn get_task(&self, id: &str) -> ServiceResult<Task>;

    /// Get a task by ID using only fields needed for relationship summaries.
    async fn get_task_summary(&self, id: &str) -> ServiceResult<Task> {
        self.get_task(id).await
    }

    /// Get only a task's display title.
    async fn get_task_title(&self, id: &str) -> ServiceResult<String> {
        Ok(self.get_task(id).await?.title)
    }

    /// Resolve a short ID prefix (first 8 hex characters of UUID) to the full task ID.
    ///
    /// Returns the full UUID string if exactly one task matches the prefix.
    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String>;

    /// Update a task
    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()>;

    /// Set the current workflow step for a task
    ///
    /// This updates the task's `current_step_id` field to the specified step.
    /// Validates that a transition exists between the current step and target step.
    async fn set_current_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()>;

    /// Advance to a specific step, skipping transition validation
    ///
    /// Like `set_current_step` but does not require a StepTransition between
    /// the current and target steps. Only validates that the target step belongs
    /// to the task's workflow.
    async fn advance_to_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()>;

    /// Delete a task
    ///
    /// If `cascade` is true, also delete all children.
    async fn delete_task(&self, id: &str, cascade: bool) -> ServiceResult<()>;

    /// Check if a task exists
    async fn task_exists(&self, id: &str) -> ServiceResult<bool>;

    // =========================================================================
    // Listing and Filtering
    // =========================================================================

    /// List tasks with optional filters
    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<Task>>;

    /// List tasks with pre-fetched workflow and step name lookups.
    ///
    /// This is an optimization for callers who already have the workflow/step name
    /// mappings and want to avoid redundant HTTP calls. The default implementation
    /// ignores the lookups and calls `list_tasks`.
    ///
    /// # Arguments
    /// * `filter` - Task filter criteria
    /// * `workflow_names` - Optional map of workflow_id -> workflow_name
    /// * `step_names` - Optional map of step_id -> step_name
    async fn list_tasks_with_lookups(
        &self,
        filter: &TaskFilter,
        _workflow_names: Option<&std::collections::HashMap<String, String>>,
        _step_names: Option<&std::collections::HashMap<String, String>>,
    ) -> ServiceResult<Vec<Task>> {
        // Default: ignore the lookups and call list_tasks
        self.list_tasks(filter).await
    }

    /// Get tasks ready for work at a given status
    async fn list_ready(&self) -> ServiceResult<Vec<Task>>;

    // =========================================================================
    // Relationships
    // =========================================================================

    /// Add a parent-child relationship
    async fn set_parent(&self, child_id: &str, parent_id: &str) -> ServiceResult<()>;

    /// Remove a parent-child relationship
    async fn remove_parent(&self, child_id: &str) -> ServiceResult<()>;

    /// Add a dependency relationship
    async fn add_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()>;

    /// Remove a dependency relationship
    async fn remove_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()>;

    /// Get the dependency chain (blockers) for a task
    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>>;

    /// Get incomplete blockers for a task with full details
    ///
    /// Returns `Task` information for all tasks that block this task
    /// and are not yet done. This is a read-only query that doesn't fire
    /// mutation callbacks.
    async fn get_incomplete_blockers_with_details(&self, id: &str) -> ServiceResult<Vec<Task>>;

    /// Find the shortest path between two tasks through their dependencies
    ///
    /// Uses BFS to find the shortest path of task IDs that connects the source
    /// task to the target task by following dependency edges (depends_on).
    ///
    /// # Arguments
    ///
    /// * `from_id` - The source task ID (starting point)
    /// * `to_id` - The target task ID (ending point)
    ///
    /// # Returns
    ///
    /// * `Ok(Some(path))` - Path found as a vector of task IDs ordered from source
    ///   to target, including both endpoints. If `from_id == to_id` (after normalization),
    ///   returns `Some(vec![from_id])`.
    /// * `Ok(None)` - No path exists between the two tasks
    /// * `Err(ServiceError::TaskNotFound)` - If either `from_id` or `to_id` doesn't exist
    ///
    /// # Behavior
    ///
    /// - Task IDs are normalized to lowercase before lookup
    /// - Traverses `depends_on` edges only (not hierarchy edges)
    /// - Uses breadth-first search for shortest path
    /// - Returns None if the target is unreachable from the source
    ///
    /// # Examples
    ///
    /// ```ignore
    /// // Direct dependency: A depends on B
    /// let path = service.find_path("a", "b").await?;
    /// assert_eq!(path, Some(vec!["a".to_string(), "b".to_string()]));
    ///
    /// // Same task
    /// let path = service.find_path("a", "a").await?;
    /// assert_eq!(path, Some(vec!["a".to_string()]));
    ///
    /// // No path exists
    /// let path = service.find_path("x", "y").await?;
    /// assert_eq!(path, None);
    ///
    /// // Non-existent task
    /// let result = service.find_path("a", "nonexistent").await;
    /// assert!(matches!(result, Err(ServiceError::TaskNotFound(_))));
    /// ```
    async fn find_path(&self, from_id: &str, to_id: &str) -> ServiceResult<Option<Vec<String>>>;

    /// Get the parent task ID of a task
    ///
    /// Returns `Some(parent_id)` if the task has a parent, `None` otherwise.
    /// This is a read-only query operation.
    async fn get_parent(&self, task_id: &str) -> ServiceResult<Option<String>>;

    /// Get all child task IDs of a task
    ///
    /// Returns a vector of direct child task IDs. Returns an empty vector
    /// if the task has no children. This is a read-only query operation.
    async fn get_children(&self, task_id: &str) -> ServiceResult<Vec<String>>;

    /// Get all task IDs that this task depends on (its blockers)
    ///
    /// Returns a vector of task IDs that this task has dependencies on.
    /// Returns an empty vector if there are no dependencies.
    /// This is a read-only query operation.
    async fn get_dependencies(&self, task_id: &str) -> ServiceResult<Vec<String>>;

    /// Get all task IDs that depend on this task (reverse dependencies)
    ///
    /// Returns a vector of task IDs that depend on this task (tasks that would
    /// be unblocked when this task is completed). Returns an empty vector if
    /// no tasks depend on this one. This is a read-only query operation.
    async fn get_dependents(&self, task_id: &str) -> ServiceResult<Vec<String>>;

    // =========================================================================
    // Sections and Code References
    // =========================================================================

    /// Add a section to a task and return the created section.
    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<Section>;

    /// Remove sections from a task by type
    async fn remove_sections(
        &self,
        id: &str,
        section_type: SectionType,
        indices: Option<Vec<usize>>,
    ) -> ServiceResult<()>;

    /// Edit a section by its ordinal (order field value)
    ///
    /// This method edits a specific section identified by its ordinal and section type,
    /// replacing its content with the provided text. Does not renumber sections.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Task not found
    /// - Section of the given type and ordinal not found
    async fn edit_section_by_ordinal(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
        new_content: &str,
    ) -> ServiceResult<()>;

    /// Remove a section by its ordinal (order field value)
    ///
    /// This method removes a specific section identified by its ordinal and
    /// renumbers remaining sections of the same type.
    async fn remove_section_by_ordinal(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> ServiceResult<()>;

    /// Mark a checklist item section as done by section_order
    ///
    /// Updates the section's done flag to true and sets done_at to current time.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID
    /// * `section_order` - The section_order value of the checklist item to mark as done
    async fn mark_checklist_item_done(&self, id: &str, section_order: u32) -> ServiceResult<()>;

    /// Toggle the done status of a checklist item section by section_order
    ///
    /// Finds the checklist item section matching the given section_order and toggles its done status.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID
    /// * `section_order` - The section_order value of the checklist item to toggle
    async fn toggle_checklist_item_done(&self, id: &str, section_order: u32) -> ServiceResult<()>;

    /// Add a code reference to a task
    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()>;

    /// Remove code references from a task
    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()>;

    /// Atomically append a code reference to a task
    ///
    /// Uses database-level append operation for atomic updates without
    /// read-modify-write race conditions.
    async fn append_ref(&self, id: &str, code_ref: &CodeRef) -> ServiceResult<()>;

    /// Atomically append a code reference to a section within a task
    ///
    /// Uses database-level append operation for atomic updates without
    /// read-modify-write race conditions.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID
    /// * `section_index` - The 0-based index of the section to add the ref to
    /// * `code_ref` - The code reference to append
    async fn append_section_ref(
        &self,
        id: &str,
        section_index: usize,
        code_ref: &CodeRef,
    ) -> ServiceResult<()>;

    // =========================================================================
    // Workflow Operations
    // =========================================================================

    /// Assign a workflow to a task
    ///
    /// Sets the task's workflow_id and initializes current_step to 0.
    async fn assign_workflow(&self, task_id: &str, workflow_id: &str) -> ServiceResult<()>;

    /// Remove workflow assignment from a task
    ///
    /// Clears both workflow_id and current_step_id fields.
    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_task_options_with_archived() {
        let opts = UpdateTaskOptions::new().with_archived(true);
        assert_eq!(opts.archived, Some(true));
    }

    #[test]
    fn update_task_options_with_archived_false() {
        let opts = UpdateTaskOptions::new().with_archived(false);
        assert_eq!(opts.archived, Some(false));
    }

    #[test]
    fn update_task_options_archived_default_is_none() {
        let opts = UpdateTaskOptions::new();
        assert!(opts.archived.is_none());
    }

    #[test]
    fn update_task_options_has_updates_includes_archived() {
        let opts = UpdateTaskOptions::new().with_archived(true);
        assert!(opts.has_updates());
    }

    #[test]
    fn update_task_options_has_updates_empty() {
        let opts = UpdateTaskOptions::new();
        assert!(!opts.has_updates());
    }

    #[test]
    fn update_task_options_with_worktree() {
        let opts = UpdateTaskOptions::new().with_worktree("/path/to/worktree");
        assert_eq!(opts.worktree, Some(Some("/path/to/worktree".to_string())));
    }

    #[test]
    fn update_task_options_clear_worktree() {
        let opts = UpdateTaskOptions::new().clear_worktree();
        assert_eq!(opts.worktree, Some(None));
    }

    #[test]
    fn update_task_options_worktree_default_is_none() {
        let opts = UpdateTaskOptions::new();
        assert!(opts.worktree.is_none());
    }

    #[test]
    fn update_task_options_has_updates_includes_worktree() {
        let opts = UpdateTaskOptions::new().with_worktree("/path");
        assert!(opts.has_updates());
    }
}
