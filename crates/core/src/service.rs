//! Task service trait and implementation
//!
//! Provides the main abstraction layer for task operations. The `TaskService` trait
//! defines the interface for all task management operations, enabling both CLI and GUI
//! to share the same business logic.

use crate::error::{ServiceError, ServiceResult};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use vertebrae_db::{
    BlockerNode, CodeRef, Database, Level, Priority, Section, Task, TaskFilter, TaskSummary,
    TaskUpdate, Thing,
};

// Re-export commonly used types
pub use vertebrae_db::{Level as TaskLevel, Priority as TaskPriority};

/// Event representing a task mutation for cache invalidation
#[derive(Debug, Clone)]
pub enum MutationEvent {
    /// Task was created
    TaskCreated { id: String },
    /// Task was updated (any field change)
    TaskUpdated { id: String },
    /// Task was deleted
    TaskDeleted { id: String },
    /// Task status changed (for explicit status-only updates)
    TaskStatusChanged {
        id: String,
        old_status: String,
        new_status: String,
    },
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
    /// Task status (defaults to "backlog") - workflow step name
    pub status: Option<String>,
    /// Task priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Parent task ID
    pub parent_id: Option<String>,
    /// IDs of tasks this task depends on
    pub depends_on: Vec<String>,
    /// Whether task needs human review
    pub needs_review: bool,
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

    /// Set the status
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = Some(status.into());
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

    /// Add a dependency
    pub fn with_dependency(mut self, dep_id: impl Into<String>) -> Self {
        self.depends_on.push(dep_id.into());
        self
    }

    /// Set the needs review flag
    pub fn with_needs_review(mut self, needs_review: bool) -> Self {
        self.needs_review = needs_review;
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
    /// Human review flag
    pub needs_human_review: Option<bool>,
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

    /// Set the needs human review flag
    pub fn with_needs_human_review(mut self, value: bool) -> Self {
        self.needs_human_review = Some(value);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.parent_id.is_some()
            || self.needs_human_review.is_some()
    }
}

/// Task with its relationships
#[derive(Debug)]
pub struct TaskWithRelations {
    /// The task itself
    pub task: Task,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// Children task IDs
    pub children_ids: Vec<String>,
    /// IDs of tasks this task depends on
    pub depends_on_ids: Vec<String>,
    /// IDs of tasks that depend on this task
    pub dependent_ids: Vec<String>,
}

/// Summary of an unblocked task
#[derive(Debug, Clone)]
pub struct UnblockedTask {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
}

/// Result of a status transition
#[derive(Debug)]
pub struct TransitionResult {
    /// The task ID that was transitioned
    pub task_id: String,
    /// The previous status
    pub from_status: String,
    /// The new status
    pub to_status: String,
    /// Tasks that are now unblocked (for statuses with unblocks_dependents=true)
    pub unblocked_tasks: Vec<UnblockedTask>,
}

/// A node in the hierarchical task tree
///
/// Represents a task with its children nested hierarchically.
/// Used for displaying tasks in a tree structure.
#[derive(Debug, Clone)]
pub struct TaskTreeNode {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level (epic, ticket, task)
    pub level: Level,
    /// Current status (derived from workflow step name)
    pub status: String,
    /// Optional priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Whether this task has incomplete dependencies (blockers)
    pub has_blockers: bool,
    /// Number of incomplete dependencies
    pub blocker_count: usize,
    /// When the task was created
    pub created_at: DateTime<Utc>,
    /// Child nodes in the hierarchy
    pub children: Vec<TaskTreeNode>,
    /// Workflow name (if task is assigned to a workflow)
    pub workflow_name: Option<String>,
    /// Current step name (if task has a current step in workflow)
    pub step_name: Option<String>,
}

impl TaskTreeNode {
    /// Create a new TaskTreeNode from a TaskSummary
    fn from_summary(summary: &TaskSummary, has_blockers: bool, blocker_count: usize) -> Self {
        Self {
            id: summary.id.clone(),
            title: summary.title.clone(),
            level: summary.level.clone(),
            status: summary.status.clone(),
            priority: summary.priority.clone(),
            tags: summary.tags.clone(),
            needs_human_review: summary.needs_human_review,
            has_blockers,
            blocker_count,
            created_at: summary.created_at,
            children: Vec::new(),
            workflow_name: summary.workflow_name.clone(),
            step_name: summary.step_name.clone(),
        }
    }

    /// Check if this is a leaf node (no children)
    pub fn is_leaf(&self) -> bool {
        self.children.is_empty()
    }

    /// Get the total number of descendants
    pub fn descendant_count(&self) -> usize {
        self.children.iter().map(|c| 1 + c.descendant_count()).sum()
    }
}

/// Options for tree filtering
#[derive(Debug, Clone, Default)]
pub struct TreeFilterOptions {
    /// Base task filter (levels, statuses, etc.)
    pub filter: TaskFilter,
    /// Whether to preserve ancestor chain for matching nodes
    pub preserve_ancestors: bool,
}

impl TreeFilterOptions {
    /// Create new tree filter options with a base filter
    pub fn new(filter: TaskFilter) -> Self {
        Self {
            filter,
            preserve_ancestors: true,
        }
    }

    /// Set whether to preserve ancestors
    pub fn with_preserve_ancestors(mut self, preserve: bool) -> Self {
        self.preserve_ancestors = preserve;
        self
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
    // Database Access (DEPRECATED - DO NOT USE)
    // =========================================================================

    /// Get a reference to the underlying database
    ///
    /// **DEPRECATED**: This method is a bypass that avoids the service layer.
    /// It should NOT be used and will be removed.
    ///
    /// Using this method prevents:
    /// - Mutations from being captured by MutationCallback
    /// - Notifications being triggered for GUI cache invalidation
    /// - Proper transaction handling and atomicity
    ///
    /// All code must be refactored to use proper service methods instead.
    #[deprecated(
        since = "0.1.0",
        note = "this database bypass will be removed; use service methods instead"
    )]
    fn database(&self) -> &Database;

    // =========================================================================
    // Task CRUD Operations
    // =========================================================================

    /// Create a new task
    ///
    /// Returns the ID of the created task.
    async fn create_task(&self, options: CreateTaskOptions) -> ServiceResult<String>;

    /// Get a task by ID
    async fn get_task(&self, id: &str) -> ServiceResult<Task>;

    /// Get a task with all its relationships
    async fn get_task_with_relations(&self, id: &str) -> ServiceResult<TaskWithRelations>;

    /// Update a task
    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()>;

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
    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<TaskSummary>>;

    /// Get tasks ready for work at a given status
    async fn list_ready(&self, status: &str) -> ServiceResult<Vec<TaskSummary>>;

    /// Get tasks as a hierarchical tree structure
    ///
    /// Returns root-level tasks (orphans) with their children nested recursively.
    /// Each node includes dependency indicators (has_blockers, blocker_count).
    ///
    /// When `options.preserve_ancestors` is true and filters are applied,
    /// matching nodes will have their ancestor chain included even if
    /// ancestors don't match the filter criteria.
    ///
    /// # Arguments
    ///
    /// * `options` - Tree filter options including base filters and ancestor preservation
    ///
    /// # Returns
    ///
    /// A vector of root-level TaskTreeNode items, each with children populated.
    async fn get_task_tree(&self, options: &TreeFilterOptions) -> ServiceResult<Vec<TaskTreeNode>>;

    // =========================================================================
    // Status Transitions
    // =========================================================================

    /// Transition a task to a new status
    ///
    /// Validates the transition and performs any associated actions.
    async fn transition_to(&self, id: &str, target: &str) -> ServiceResult<TransitionResult>;

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
    /// Returns `TaskSummary` information for all tasks that block this task
    /// and are not yet done. This is a read-only query that doesn't fire
    /// mutation callbacks.
    async fn get_incomplete_blockers_with_details(
        &self,
        id: &str,
    ) -> ServiceResult<Vec<TaskSummary>>;

    // =========================================================================
    // Sections and Code References
    // =========================================================================

    /// Add a section to a task
    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<()>;

    /// Remove sections from a task by type
    async fn remove_sections(
        &self,
        id: &str,
        section_type: vertebrae_db::SectionType,
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
        section_type: vertebrae_db::SectionType,
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
        section_type: vertebrae_db::SectionType,
        ordinal: u32,
    ) -> ServiceResult<()>;

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
    async fn assign_workflow(&self, task_id: &str, workflow_id: &Thing) -> ServiceResult<()>;

    /// Remove workflow assignment from a task
    ///
    /// Clears both workflow_id and current_step_id fields.
    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()>;
}

/// Default implementation of TaskService backed by Database
pub struct DefaultTaskService {
    db: Database,
    /// Optional callback for mutations (cache invalidation, notifications, etc.)
    mutation_callback: Option<MutationCallback>,
}

impl DefaultTaskService {
    /// Create a new DefaultTaskService with the given database
    pub fn new(db: Database) -> Self {
        Self {
            db,
            mutation_callback: None,
        }
    }

    /// Create a new DefaultTaskService with a mutation callback
    ///
    /// The callback fires after each mutation completes, enabling cache invalidation
    /// or other side effects in consumers (CLI, GUI, etc.).
    pub fn with_callback(db: Database, callback: MutationCallback) -> Self {
        Self {
            db,
            mutation_callback: Some(callback),
        }
    }

    /// Fire the mutation callback if registered
    fn on_mutation(&self, event: MutationEvent) {
        if let Some(callback) = &self.mutation_callback {
            callback(event);
        }
    }

    /// Get a reference to the underlying database
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Generate a unique task ID
    async fn generate_unique_id(&self, title: &str) -> ServiceResult<String> {
        let db = &self.db;
        crate::id_generator::generate_unique_id(title, "task", |id| async move {
            db.tasks().exists(&id).await.map_err(ServiceError::from)
        })
        .await
    }

    /// Build a TaskUpdate from UpdateTaskOptions
    fn build_task_update(&self, options: &UpdateTaskOptions) -> TaskUpdate {
        let mut update = TaskUpdate::new();

        if let Some(title) = &options.title {
            update = update.with_title(title);
        }

        match &options.description {
            Some(Some(desc)) => {
                update = update.with_description(desc);
            }
            Some(None) => {
                update = update.clear_description();
            }
            None => {}
        }

        match &options.priority {
            Some(Some(p)) => {
                update = update.with_priority(p.clone());
            }
            Some(None) => {
                update = update.clear_priority();
            }
            None => {}
        }

        for tag in &options.add_tags {
            update = update.add_tag(tag);
        }

        for tag in &options.remove_tags {
            update = update.remove_tag(tag);
        }

        if let Some(needs_review) = options.needs_human_review {
            update = update.with_needs_human_review(needs_review);
        }

        update
    }

    /// Check if a task matches the given filter criteria
    fn task_matches_filter(&self, task: &TaskSummary, filter: &TaskFilter) -> bool {
        // Default: exclude done status unless include_done is set or statuses are specified
        if !filter.include_done && filter.statuses.is_empty() && task.status == "done" {
            return false;
        }

        // Level filter (OR within type)
        if !filter.levels.is_empty() && !filter.levels.contains(&task.level) {
            return false;
        }

        // Status filter (OR within type)
        if !filter.statuses.is_empty() && !filter.statuses.contains(&task.status) {
            return false;
        }

        // Priority filter (OR within type)
        if !filter.priorities.is_empty() {
            match &task.priority {
                Some(p) => {
                    if !filter.priorities.contains(p) {
                        return false;
                    }
                }
                None => return false,
            }
        }

        // Tag filter (OR within type - task must have at least one matching tag)
        if !filter.tags.is_empty() && !filter.tags.iter().any(|t| task.tags.contains(t)) {
            return false;
        }

        // Note: root_only and children_of are structural filters handled separately
        // Note: search filter would require description which isn't in TaskSummary

        true
    }
}

#[async_trait]
impl TaskService for DefaultTaskService {
    fn database(&self) -> &Database {
        &self.db
    }

    async fn create_task(&self, options: CreateTaskOptions) -> ServiceResult<String> {
        // Validate title
        if options.title.trim().is_empty() {
            return Err(ServiceError::validation_failed("Title cannot be empty"));
        }

        // Validate parent exists if specified
        if let Some(parent_id) = &options.parent_id
            && !self.db.tasks().exists(parent_id).await?
        {
            return Err(ServiceError::parent_not_found(parent_id));
        }

        // Validate dependencies exist
        for dep_id in &options.depends_on {
            if !self.db.tasks().exists(dep_id).await? {
                return Err(ServiceError::dependency_not_found(dep_id));
            }
        }

        // Generate unique ID
        let id = self.generate_unique_id(&options.title).await?;

        // Build task
        let level = options.level.unwrap_or(Level::Task);
        let target_status = options
            .status
            .clone()
            .unwrap_or_else(|| "backlog".to_string());

        let mut task = Task::new(options.title, level);

        if let Some(desc) = options.description {
            task = task.with_description(desc);
        }

        if let Some(priority) = options.priority {
            task = task.with_priority(priority);
        }

        if !options.tags.is_empty() {
            task = task.with_tags(options.tags);
        }

        if options.needs_review {
            task = task.with_needs_human_review(true);
        }

        // Find the root workflow (no incoming transitions) and its initial step
        // Every task MUST have both workflow_id and current_step_id
        let root_workflow = self
            .db
            .workflows()
            .get_root_workflow()
            .await?
            .ok_or_else(|| {
                ServiceError::InvalidInput("No workflows exist in the database".to_string())
            })?;

        let workflow_id = root_workflow
            .id
            .clone()
            .ok_or_else(|| ServiceError::InvalidInput("Root workflow has no ID".to_string()))?;

        // Get the initial step for this workflow
        let initial_step_id = if let Some(ref initial_step) = root_workflow.initial_step {
            initial_step.clone()
        } else {
            // Fallback: get the first step (lowest order) for this workflow
            let steps = self.db.steps().list_by_workflow(&workflow_id).await?;
            steps
                .into_iter()
                .min_by_key(|s| s.order)
                .and_then(|s| s.id)
                .ok_or_else(|| {
                    ServiceError::InvalidInput(format!(
                        "Workflow '{}' has no steps",
                        workflow_id.id.to_raw()
                    ))
                })?
        };

        // Set workflow and initial step on task
        task.workflow_id = Some(workflow_id.clone());
        task.current_step_id = Some(initial_step_id.clone());

        // Create in database with workflow and step already set
        self.db.tasks().create(&id, &task).await?;

        // If a different status was specified, transition to that step
        if target_status != "backlog" {
            let steps = self.db.steps().list_by_workflow(&workflow_id).await?;

            // Find the step that matches the target status name
            if let Some(step) = steps
                .iter()
                .find(|s| s.name.to_lowercase() == target_status)
            {
                // Update current_step_id if the step has an ID
                if let Some(ref step_id) = step.id {
                    self.db.tasks().update_current_step_id(&id, step_id).await?;
                }
            }
        }

        // Create parent relationship if specified
        if let Some(parent_id) = &options.parent_id {
            self.db
                .relationships()
                .create_child_of(&id, parent_id)
                .await?;
        }

        // Create dependency relationships
        for dep_id in &options.depends_on {
            self.db
                .relationships()
                .create_depends_on(&id, dep_id)
                .await?;
        }

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskCreated { id: id.clone() });

        Ok(id)
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let id = id.to_lowercase();
        self.db
            .tasks()
            .get(&id)
            .await?
            .ok_or_else(|| ServiceError::task_not_found(&id))
    }

    async fn get_task_with_relations(&self, id: &str) -> ServiceResult<TaskWithRelations> {
        let id = id.to_lowercase();
        let task = self.get_task(&id).await?;

        let parent_id = self.db.relationships().get_parent(&id).await?;
        let children_ids = self.db.relationships().get_children(&id).await?;
        let depends_on_ids = self.db.relationships().get_dependencies(&id).await?;
        let dependent_ids = self.db.relationships().get_dependents(&id).await?;

        Ok(TaskWithRelations {
            task,
            parent_id,
            children_ids,
            depends_on_ids,
            dependent_ids,
        })
    }

    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        // Handle parent relationship changes
        if let Some(parent_opt) = &options.parent_id {
            match parent_opt {
                Some(parent_id) => {
                    // Validate parent exists
                    if !self.db.tasks().exists(parent_id).await? {
                        return Err(ServiceError::parent_not_found(parent_id));
                    }
                    // Remove existing parent first, then set new one
                    self.db.relationships().remove_child_of(&id).await?;
                    self.db
                        .relationships()
                        .create_child_of(&id, parent_id)
                        .await?;
                }
                None => {
                    self.db.relationships().remove_child_of(&id).await?;
                }
            }
        }

        // Build and apply task update
        let update = self.build_task_update(&options);
        if update.has_updates() {
            self.db.tasks().update(&id, &update).await?;
        }

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });

        Ok(())
    }

    async fn delete_task(&self, id: &str, cascade: bool) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        if cascade {
            // Delete children recursively
            let children = self.db.relationships().get_children(&id).await?;
            for child_id in children {
                // Use Box::pin to allow recursive async call
                Box::pin(self.delete_task(&child_id, true)).await?;
            }
        }

        // Remove all relationships first
        self.db
            .relationships()
            .remove_all_relationships(&id)
            .await?;

        // Delete the task itself
        self.db.tasks().delete(&id).await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskDeleted { id: id.clone() });

        Ok(())
    }

    async fn task_exists(&self, id: &str) -> ServiceResult<bool> {
        let id = id.to_lowercase();
        Ok(self.db.tasks().exists(&id).await?)
    }

    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<TaskSummary>> {
        Ok(self.db.list_tasks().list(filter).await?)
    }

    async fn list_ready(&self, status: &str) -> ServiceResult<Vec<TaskSummary>> {
        Ok(self.db.list_ready_items(status).await?)
    }

    async fn get_task_tree(&self, options: &TreeFilterOptions) -> ServiceResult<Vec<TaskTreeNode>> {
        // Step 1: Fetch tasks with workflow_id filter applied at DB level
        // Other filters (level, status, etc.) are applied in memory since they
        // might need ancestor tasks for preserve_ancestors to work correctly.
        let mut fetch_filter = TaskFilter::new().include_done();
        if let Some(ref workflow_id) = options.filter.workflow_id {
            fetch_filter = fetch_filter.with_workflow_id(workflow_id.clone());
        }
        let all_tasks = self.db.list_tasks().list(&fetch_filter).await?;

        if all_tasks.is_empty() {
            return Ok(vec![]);
        }

        // Step 2: Get all parent-child relationships
        let child_of_relations = self.db.relationships().export_all_child_of().await?;

        // Step 3: Get all incomplete blockers for each task
        let depends_on_relations = self.db.relationships().export_all_depends_on().await?;

        // Build lookup maps
        let task_map: HashMap<String, &TaskSummary> =
            all_tasks.iter().map(|t| (t.id.clone(), t)).collect();

        // child_id -> parent_id
        let parent_map: HashMap<String, String> = child_of_relations.into_iter().collect();

        // parent_id -> [child_ids]
        let mut children_map: HashMap<String, Vec<String>> = HashMap::new();
        for (child_id, parent_id) in &parent_map {
            children_map
                .entry(parent_id.clone())
                .or_default()
                .push(child_id.clone());
        }

        // task_id -> [blocker_ids] (for incomplete blockers only)
        let mut blocker_map: HashMap<String, Vec<String>> = HashMap::new();
        for (dependent_id, blocker_id) in depends_on_relations {
            // Only count as blocker if the blocker is not done
            if let Some(blocker_task) = task_map.get(&blocker_id)
                && blocker_task.status != "done"
            {
                blocker_map
                    .entry(dependent_id)
                    .or_default()
                    .push(blocker_id);
            }
        }

        // Step 4: Apply filtering
        let filter = &options.filter;

        // Get IDs of tasks that match the filter criteria
        let matching_ids: HashSet<String> = all_tasks
            .iter()
            .filter(|t| self.task_matches_filter(t, filter))
            .map(|t| t.id.clone())
            .collect();

        // If preserve_ancestors is true, collect all ancestors of matching tasks
        let ids_to_include: HashSet<String> =
            if options.preserve_ancestors && !matching_ids.is_empty() {
                let mut to_include = matching_ids.clone();
                for id in &matching_ids {
                    // Walk up the parent chain
                    let mut current = id.clone();
                    while let Some(parent_id) = parent_map.get(&current) {
                        to_include.insert(parent_id.clone());
                        current = parent_id.clone();
                    }
                }
                to_include
            } else {
                matching_ids
            };

        // Step 5: Build tree nodes for included tasks
        fn build_node(
            id: &str,
            task_map: &HashMap<String, &TaskSummary>,
            children_map: &HashMap<String, Vec<String>>,
            blocker_map: &HashMap<String, Vec<String>>,
            ids_to_include: &HashSet<String>,
        ) -> Option<TaskTreeNode> {
            if !ids_to_include.contains(id) {
                return None;
            }

            let task = task_map.get(id)?;

            let blockers = blocker_map.get(id);
            let has_blockers = blockers.is_some_and(|b| !b.is_empty());
            let blocker_count = blockers.map_or(0, |b| b.len());

            let mut node = TaskTreeNode::from_summary(task, has_blockers, blocker_count);

            // Recursively build children
            if let Some(child_ids) = children_map.get(id) {
                for child_id in child_ids {
                    if let Some(child_node) = build_node(
                        child_id,
                        task_map,
                        children_map,
                        blocker_map,
                        ids_to_include,
                    ) {
                        node.children.push(child_node);
                    }
                }
                // Sort children by level priority (epic > ticket > task), then by title
                node.children.sort_by(|a, b| {
                    let level_priority = |level: &Level| match level {
                        Level::Epic => 0,
                        Level::Ticket => 1,
                        Level::Task => 2,
                    };
                    level_priority(&a.level)
                        .cmp(&level_priority(&b.level))
                        .then_with(|| a.title.cmp(&b.title))
                });
            }

            Some(node)
        }

        // Step 6: Find root tasks (orphans - no parent, or parent not in result set)
        let root_ids: Vec<String> = all_tasks
            .iter()
            .filter(|t| {
                let is_included = ids_to_include.contains(&t.id);
                let has_no_parent = !parent_map.contains_key(&t.id);
                let parent_not_in_results = parent_map
                    .get(&t.id)
                    .is_some_and(|parent_id| !ids_to_include.contains(parent_id));
                is_included && (has_no_parent || parent_not_in_results)
            })
            .map(|t| t.id.clone())
            .collect();

        // Build tree starting from roots
        let mut tree: Vec<TaskTreeNode> = root_ids
            .iter()
            .filter_map(|id| {
                build_node(id, &task_map, &children_map, &blocker_map, &ids_to_include)
            })
            .collect();

        // Sort roots by level priority, then by title
        tree.sort_by(|a, b| {
            let level_priority = |level: &Level| match level {
                Level::Epic => 0,
                Level::Ticket => 1,
                Level::Task => 2,
            };
            level_priority(&a.level)
                .cmp(&level_priority(&b.level))
                .then_with(|| a.title.cmp(&b.title))
        });

        Ok(tree)
    }

    async fn transition_to(&self, id: &str, target: &str) -> ServiceResult<TransitionResult> {
        let id = id.to_lowercase();
        let target = target.to_lowercase();

        // Get current task
        let task = self.get_task(&id).await?;

        // Invariant: task always has workflow_id and current_step_id
        let workflow_thing = task.workflow_id.clone().ok_or_else(|| {
            ServiceError::InvalidInput(format!(
                "Task {} is missing workflow_id (invariant violation)",
                id
            ))
        })?;
        let current_step_id = task.current_step_id.as_ref().ok_or_else(|| {
            ServiceError::InvalidInput(format!(
                "Task {} is missing current_step_id (invariant violation)",
                id
            ))
        })?;
        let workflow_id = workflow_thing.id.to_raw();

        // Get workflow steps to validate the transition
        let steps = self.db.steps().list_by_workflow(&workflow_thing).await?;

        // Find the current step by ID
        let current_step = steps
            .iter()
            .find(|s| s.id.as_ref() == Some(current_step_id))
            .ok_or_else(|| {
                ServiceError::InvalidInput(format!(
                    "Current step not found: {}",
                    current_step_id.id.to_raw()
                ))
            })?;
        let from_status = current_step.name.clone();

        // Find the target step
        let target_step = steps.iter().find(|s| s.name.to_lowercase() == target);

        // Validate target step exists
        let target_step = target_step.ok_or_else(|| {
            let valid_steps: Vec<&str> = steps.iter().map(|s| s.name.as_str()).collect();
            ServiceError::InvalidInput(format!(
                "Unknown step '{}' in workflow '{}'. Valid steps: {}",
                target,
                workflow_id,
                valid_steps.join(", ")
            ))
        })?;

        // Validate transition from current step to target step
        let target_id = target_step.id.as_ref();
        let is_valid_transition = target_id.is_some()
            && current_step
                .transitions_to
                .iter()
                .any(|t| Some(t) == target_id);
        let is_same_step = current_step.name.to_lowercase() == target;

        if !is_valid_transition && !is_same_step {
            // Get valid transition names for the error message
            let valid_transitions: Vec<String> = current_step
                .transitions_to
                .iter()
                .filter_map(|t| steps.iter().find(|s| s.id.as_ref() == Some(t)))
                .map(|s| s.name.clone())
                .collect();

            return Err(ServiceError::invalid_transition_with_valid(
                &from_status,
                &target,
                valid_transitions,
            ));
        }

        // Build update - status is now derived from workflow step
        let mut update = TaskUpdate::new();

        // Set timestamps based on transition (using step name conventions)
        if target == "in_progress" {
            update = update.set_started_at_if_null();
        }
        // completed_at is handled in repository for terminal steps

        // Update current_step_id if the step has an ID
        if let Some(ref step_id) = target_step.id {
            self.db.tasks().update_current_step_id(&id, step_id).await?;
        }

        // Apply any other updates (timestamps)
        if update.has_updates() {
            self.db.tasks().update(&id, &update).await?;
        }

        // Determine if this step unblocks dependents
        // Only "done" status unblocks dependents - "rejected" and other terminal steps do not
        let should_unblock = target == "done";

        let unblocked_tasks = if should_unblock {
            self.db
                .graph()
                .get_unblocked_tasks(&id)
                .await?
                .into_iter()
                .map(|(id, title)| UnblockedTask { id, title })
                .collect()
        } else {
            vec![]
        };

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskStatusChanged {
            id: id.clone(),
            old_status: from_status.clone(),
            new_status: target.clone(),
        });

        Ok(TransitionResult {
            task_id: id,
            from_status,
            to_status: target,
            unblocked_tasks,
        })
    }

    async fn set_parent(&self, child_id: &str, parent_id: &str) -> ServiceResult<()> {
        let child_id = child_id.to_lowercase();
        let parent_id = parent_id.to_lowercase();

        // Validate both tasks exist
        if !self.db.tasks().exists(&child_id).await? {
            return Err(ServiceError::task_not_found(&child_id));
        }
        if !self.db.tasks().exists(&parent_id).await? {
            return Err(ServiceError::parent_not_found(&parent_id));
        }

        // Remove existing parent first
        self.db.relationships().remove_child_of(&child_id).await?;
        // Create new parent relationship
        self.db
            .relationships()
            .create_child_of(&child_id, &parent_id)
            .await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated {
            id: child_id.clone(),
        });

        Ok(())
    }

    async fn remove_parent(&self, child_id: &str) -> ServiceResult<()> {
        let child_id = child_id.to_lowercase();

        if !self.db.tasks().exists(&child_id).await? {
            return Err(ServiceError::task_not_found(&child_id));
        }

        self.db.relationships().remove_child_of(&child_id).await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated {
            id: child_id.clone(),
        });

        Ok(())
    }

    async fn add_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let task_id = task_id.to_lowercase();
        let depends_on_id = depends_on_id.to_lowercase();

        // Validate both tasks exist
        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }
        if !self.db.tasks().exists(&depends_on_id).await? {
            return Err(ServiceError::dependency_not_found(&depends_on_id));
        }

        // Check for cycles
        let would_cycle = self
            .db
            .graph()
            .would_create_cycle(&task_id, &depends_on_id)
            .await?;
        if would_cycle {
            return Err(ServiceError::CyclicDependency);
        }

        self.db
            .relationships()
            .create_depends_on(&task_id, &depends_on_id)
            .await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated {
            id: task_id.clone(),
        });

        Ok(())
    }

    async fn remove_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let task_id = task_id.to_lowercase();
        let depends_on_id = depends_on_id.to_lowercase();

        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }

        self.db
            .relationships()
            .remove_depends_on(&task_id, &depends_on_id)
            .await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated {
            id: task_id.clone(),
        });

        Ok(())
    }

    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>> {
        let id = id.to_lowercase();

        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        Ok(self.db.graph().get_blockers(&id, None).await?)
    }

    async fn get_incomplete_blockers_with_details(
        &self,
        id: &str,
    ) -> ServiceResult<Vec<TaskSummary>> {
        let id = id.to_lowercase();

        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        Ok(self
            .db
            .graph()
            .get_incomplete_blockers_with_details(&id)
            .await?)
    }

    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        let task = self.get_task(&id).await?;

        // Get current sections and add new one
        let mut sections = task.sections.clone();
        sections.push(section);

        // Update task
        let update = TaskUpdate::new().with_sections(sections);
        self.db.tasks().update(&id, &update).await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });

        Ok(())
    }

    async fn remove_sections(
        &self,
        id: &str,
        section_type: vertebrae_db::SectionType,
        indices: Option<Vec<usize>>,
    ) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        let task = self.get_task(&id).await?;

        let mut sections = task.sections.clone();

        match indices {
            Some(idx_list) => {
                // Remove specific indices (in reverse to maintain indices)
                let mut idx_list = idx_list;
                idx_list.sort_unstable();
                idx_list.reverse();
                for idx in idx_list {
                    if idx < sections.len() && sections[idx].section_type == section_type {
                        sections.remove(idx);
                    }
                }
            }
            None => {
                // Remove all sections of this type
                sections.retain(|s| s.section_type != section_type);
            }
        }

        let update = TaskUpdate::new().with_sections(sections);
        self.db.tasks().update(&id, &update).await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });

        Ok(())
    }

    async fn edit_section_by_ordinal(
        &self,
        id: &str,
        section_type: vertebrae_db::SectionType,
        ordinal: u32,
        new_content: &str,
    ) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        let task = self.get_task(&id).await?;

        // Find the section with the matching type and ordinal
        let section_index = task
            .sections
            .iter()
            .position(|s| s.section_type == section_type && s.order == Some(ordinal))
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "No section of type '{}' with ordinal {} found",
                    section_type, ordinal
                ))
            })?;

        // Build the new sections array with the edited section
        let mut new_sections = task.sections.clone();
        let edited_section = &mut new_sections[section_index];
        edited_section.content = new_content.to_string();

        // Update task with new sections
        let update = TaskUpdate::new().with_sections(new_sections);
        self.db.tasks().update(&id, &update).await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });

        Ok(())
    }

    async fn remove_section_by_ordinal(
        &self,
        id: &str,
        section_type: vertebrae_db::SectionType,
        ordinal: u32,
    ) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Use repository method which handles finding by ordinal and renumbering
        self.db
            .tasks()
            .remove_section(&id, section_type, ordinal)
            .await?;

        // Fire mutation callback
        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });

        Ok(())
    }

    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        let task = self.get_task(&id).await?;

        // Get current refs and add new one
        let mut code_refs = task.code_refs.clone();
        code_refs.push(code_ref);

        // Update task
        let update = TaskUpdate::new().with_refs(code_refs);
        self.db.tasks().update(&id, &update).await?;

        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });
        Ok(())
    }

    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        let task = self.get_task(&id).await?;

        let mut code_refs = task.code_refs.clone();

        match indices {
            Some(idx_list) => {
                // Remove specific indices (in reverse to maintain indices)
                let mut idx_list = idx_list;
                idx_list.sort_unstable();
                idx_list.reverse();
                for idx in idx_list {
                    if idx < code_refs.len() {
                        code_refs.remove(idx);
                    }
                }
            }
            None => {
                // Clear all refs
                code_refs.clear();
            }
        }

        let update = TaskUpdate::new().with_refs(code_refs);
        self.db.tasks().update(&id, &update).await?;

        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });
        Ok(())
    }

    async fn append_ref(&self, id: &str, code_ref: &CodeRef) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        self.db.tasks().append_ref(&id, code_ref).await?;

        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });
        Ok(())
    }

    async fn append_section_ref(
        &self,
        id: &str,
        section_index: usize,
        code_ref: &CodeRef,
    ) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        self.db
            .tasks()
            .append_section_ref(&id, section_index, code_ref)
            .await?;

        self.on_mutation(MutationEvent::TaskUpdated { id: id.clone() });
        Ok(())
    }

    async fn assign_workflow(&self, task_id: &str, workflow_id: &Thing) -> ServiceResult<()> {
        let task_id = task_id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }

        // Assign the workflow
        self.db
            .tasks()
            .assign_workflow(&task_id, workflow_id)
            .await?;

        // Set current_step_id to the first step of the workflow (order 0)
        let steps = self.db.steps().list_by_workflow(workflow_id).await?;
        if let Some(first_step) = steps.into_iter().find(|s| s.order == 0)
            && let Some(step_id) = &first_step.id
        {
            self.db
                .tasks()
                .update_current_step_id(&task_id, step_id)
                .await?;
        }

        self.on_mutation(MutationEvent::TaskUpdated {
            id: task_id.clone(),
        });
        Ok(())
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let task_id = task_id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }

        self.db.tasks().unassign_workflow(&task_id).await?;

        self.on_mutation(MutationEvent::TaskUpdated {
            id: task_id.clone(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    #[tokio::test]
    async fn test_create_task_simple() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("My Task"))
            .await
            .unwrap();

        assert_eq!(id.len(), 7); // 'x' prefix + 6 hex chars

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.title, "My Task");
        assert_eq!(task.level, Level::Task);
        // Tasks always have workflow_id and current_step_id set to the root workflow's initial step
        assert!(
            task.workflow_id.is_some(),
            "Task must have workflow_id assigned"
        );
        assert!(
            task.current_step_id.is_some(),
            "Task must have current_step_id assigned"
        );
    }

    #[tokio::test]
    async fn test_create_task_with_options() {
        let service = setup_test_service().await;

        let options = CreateTaskOptions::new("Epic Task")
            .with_level(Level::Epic)
            .with_priority(Priority::High)
            .with_tag("backend")
            .with_description("An epic task");

        let id = service.create_task(options).await.unwrap();
        let task = service.get_task(&id).await.unwrap();

        assert_eq!(task.title, "Epic Task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.priority, Some(Priority::High));
        assert!(task.tags.contains(&"backend".to_string()));
    }

    #[tokio::test]
    async fn test_create_task_empty_title_fails() {
        let service = setup_test_service().await;

        let result = service.create_task(CreateTaskOptions::new("   ")).await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_create_task_with_nonexistent_parent_fails() {
        let service = setup_test_service().await;

        let options = CreateTaskOptions::new("Child").with_parent("nonexistent");
        let result = service.create_task(options).await;

        assert!(matches!(result, Err(ServiceError::ParentNotFound { .. })));
    }

    #[tokio::test]
    async fn test_create_task_with_parent() {
        let service = setup_test_service().await;

        // Create parent
        let parent_id = service
            .create_task(CreateTaskOptions::new("Parent").with_level(Level::Epic))
            .await
            .unwrap();

        // Create child with parent
        let options = CreateTaskOptions::new("Child").with_parent(&parent_id);
        let child_id = service.create_task(options).await.unwrap();

        // Verify relationship
        let with_relations = service.get_task_with_relations(&child_id).await.unwrap();
        assert_eq!(with_relations.parent_id, Some(parent_id));
    }

    #[tokio::test]
    async fn test_update_task() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Original"))
            .await
            .unwrap();

        let options = UpdateTaskOptions::new()
            .with_title("Updated")
            .with_priority(Priority::Critical)
            .add_tag("urgent");

        service.update_task(&id, options).await.unwrap();

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.title, "Updated");
        assert_eq!(task.priority, Some(Priority::Critical));
        assert!(task.tags.contains(&"urgent".to_string()));
    }

    #[tokio::test]
    async fn test_delete_task() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("To Delete"))
            .await
            .unwrap();

        assert!(service.task_exists(&id).await.unwrap());

        service.delete_task(&id, false).await.unwrap();

        assert!(!service.task_exists(&id).await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_task_cascade() {
        let service = setup_test_service().await;

        // Create parent and child
        let parent_id = service
            .create_task(CreateTaskOptions::new("Parent").with_level(Level::Epic))
            .await
            .unwrap();

        let child_id = service
            .create_task(CreateTaskOptions::new("Child").with_parent(&parent_id))
            .await
            .unwrap();

        // Delete parent with cascade
        service.delete_task(&parent_id, true).await.unwrap();

        // Both should be gone
        assert!(!service.task_exists(&parent_id).await.unwrap());
        assert!(!service.task_exists(&child_id).await.unwrap());
    }

    #[tokio::test]
    async fn test_transition_valid() {
        let service = setup_test_service().await;

        // Create a task and transition to in_progress first
        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Transition from backlog to in_progress
        let result = service.transition_to(&id, "in_progress").await.unwrap();

        assert_eq!(result.from_status, "backlog");
        assert_eq!(result.to_status, "in_progress");

        // Verify that the task's current_step_id is now set
        let task = service.get_task(&id).await.unwrap();
        assert!(task.current_step_id.is_some());
    }

    #[tokio::test]
    async fn test_transition_invalid() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Task is in Backlog, cannot go directly to Done
        let result = service.transition_to(&id, "done").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_dependency() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A").with_status("in_progress"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B").with_status("in_progress"))
            .await
            .unwrap();

        service.add_dependency(&task_b, &task_a).await.unwrap();

        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(with_relations.depends_on_ids.contains(&task_a));
    }

    #[tokio::test]
    async fn test_add_section() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        let section = Section::new(vertebrae_db::SectionType::Step, "Do this first");
        service.add_section(&id, section).await.unwrap();

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Do this first");
    }

    #[tokio::test]
    async fn test_add_code_ref() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        let code_ref = CodeRef::line("src/main.rs", 42);
        service.add_code_ref(&id, code_ref).await.unwrap();

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
    }

    #[tokio::test]
    async fn test_case_insensitive_id() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Should work with uppercase
        let upper_id = id.to_uppercase();
        let task = service.get_task(&upper_id).await.unwrap();
        assert_eq!(task.title, "Task");
    }

    // =========================================================================
    // get_task_tree tests
    // =========================================================================

    #[tokio::test]
    async fn test_get_task_tree_empty() {
        let service = setup_test_service().await;

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        assert!(tree.is_empty());
    }

    #[tokio::test]
    async fn test_get_task_tree_orphan_at_root() {
        let service = setup_test_service().await;

        // Create an orphan task (no parent)
        let task_id = service
            .create_task(CreateTaskOptions::new("Orphan Task"))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, task_id);
        assert!(tree[0].children.is_empty());
    }

    #[tokio::test]
    async fn test_get_task_tree_hierarchy_preserved() {
        let service = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let ticket_id = service
            .create_task(
                CreateTaskOptions::new("Ticket")
                    .with_level(Level::Ticket)
                    .with_parent(&epic_id),
            )
            .await
            .unwrap();

        let task_id = service
            .create_task(CreateTaskOptions::new("Task").with_parent(&ticket_id))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        // Epic at root
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, epic_id);
        assert_eq!(tree[0].level, Level::Epic);

        // Ticket as child of epic
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].id, ticket_id);
        assert_eq!(tree[0].children[0].level, Level::Ticket);

        // Task as child of ticket
        assert_eq!(tree[0].children[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].id, task_id);
        assert_eq!(tree[0].children[0].children[0].level, Level::Task);
    }

    #[tokio::test]
    async fn test_get_task_tree_multiple_roots() {
        let service = setup_test_service().await;

        // Create two independent epics
        let epic1_id = service
            .create_task(CreateTaskOptions::new("Alpha Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let epic2_id = service
            .create_task(CreateTaskOptions::new("Beta Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        // Both epics at root level, sorted alphabetically
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].id, epic1_id); // "Alpha Epic" first
        assert_eq!(tree[1].id, epic2_id); // "Beta Epic" second
    }

    #[tokio::test]
    async fn test_get_task_tree_with_blockers() {
        let service = setup_test_service().await;

        // Create blocker task
        let blocker_id = service
            .create_task(CreateTaskOptions::new("Blocker"))
            .await
            .unwrap();

        // Create dependent task
        let dependent_id = service
            .create_task(CreateTaskOptions::new("Dependent").with_dependency(&blocker_id))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        // Both tasks at root (no parent-child relationship)
        assert_eq!(tree.len(), 2);

        // Find the dependent task
        let dependent_node = tree.iter().find(|n| n.id == dependent_id).unwrap();
        assert!(dependent_node.has_blockers);
        assert_eq!(dependent_node.blocker_count, 1);

        // Blocker task should have no blockers
        let blocker_node = tree.iter().find(|n| n.id == blocker_id).unwrap();
        assert!(!blocker_node.has_blockers);
        assert_eq!(blocker_node.blocker_count, 0);
    }

    #[tokio::test]
    async fn test_get_task_tree_completed_blocker_not_counted() {
        let service = setup_test_service().await;

        // Create blocker task and mark it done
        let blocker_id = service
            .create_task(CreateTaskOptions::new("Blocker").with_status("in_progress"))
            .await
            .unwrap();

        // Create dependent task
        let dependent_id = service
            .create_task(CreateTaskOptions::new("Dependent").with_dependency(&blocker_id))
            .await
            .unwrap();

        // Mark blocker as done (must go through full workflow)
        service
            .transition_to(&blocker_id, "in_progress")
            .await
            .unwrap();
        service
            .transition_to(&blocker_id, "pending_review")
            .await
            .unwrap();
        service.transition_to(&blocker_id, "done").await.unwrap();

        let options = TreeFilterOptions::new(TaskFilter::new().include_done());
        let tree = service.get_task_tree(&options).await.unwrap();

        // Find the dependent task
        let dependent_node = tree.iter().find(|n| n.id == dependent_id).unwrap();

        // Blocker is done, so it shouldn't count as a blocker
        assert!(!dependent_node.has_blockers);
        assert_eq!(dependent_node.blocker_count, 0);
    }

    #[tokio::test]
    async fn test_get_task_tree_excludes_done_by_default() {
        let service = setup_test_service().await;

        // Create a done task
        let done_id = service
            .create_task(CreateTaskOptions::new("Done Task").with_status("in_progress"))
            .await
            .unwrap();

        // Mark task as done (must go through full workflow)
        service
            .transition_to(&done_id, "in_progress")
            .await
            .unwrap();
        service
            .transition_to(&done_id, "pending_review")
            .await
            .unwrap();
        service.transition_to(&done_id, "done").await.unwrap();

        // Create an active task
        let _active_id = service
            .create_task(CreateTaskOptions::new("Active Task"))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        // Only the active task should appear
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].title, "Active Task");
    }

    #[tokio::test]
    async fn test_get_task_tree_filter_by_level() {
        let service = setup_test_service().await;

        // Create epic with ticket child
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let _ticket_id = service
            .create_task(
                CreateTaskOptions::new("Ticket")
                    .with_level(Level::Ticket)
                    .with_parent(&epic_id),
            )
            .await
            .unwrap();

        // Filter for epics only
        let filter = TaskFilter::new().with_level(Level::Epic);
        let options = TreeFilterOptions::new(filter).with_preserve_ancestors(false);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Only epic should appear (without preserve_ancestors)
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, epic_id);
        assert!(!tree.iter().any(|n| n.id == _ticket_id));
    }

    #[tokio::test]
    async fn test_get_task_tree_filter_preserves_ancestors() {
        let service = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let ticket_id = service
            .create_task(
                CreateTaskOptions::new("Ticket")
                    .with_level(Level::Ticket)
                    .with_parent(&epic_id),
            )
            .await
            .unwrap();

        let task_id = service
            .create_task(CreateTaskOptions::new("Task").with_parent(&ticket_id))
            .await
            .unwrap();

        // Filter for tasks only but preserve ancestors
        let filter = TaskFilter::new().with_level(Level::Task);
        let options = TreeFilterOptions::new(filter).with_preserve_ancestors(true);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Epic should appear as root (ancestor preserved)
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, epic_id);

        // Ticket should appear as child (ancestor preserved)
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].id, ticket_id);

        // Task should appear (matches filter)
        assert_eq!(tree[0].children[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].id, task_id);
    }

    #[tokio::test]
    async fn test_get_task_tree_filter_by_status() {
        let service = setup_test_service().await;

        // Create tasks with different statuses
        let backlog_id = service
            .create_task(CreateTaskOptions::new("Backlog Task"))
            .await
            .unwrap();

        let todo_id = service
            .create_task(CreateTaskOptions::new("Todo Task").with_status("in_progress"))
            .await
            .unwrap();

        // Filter for todo status only
        let filter = TaskFilter::new().with_status("in_progress");
        let options = TreeFilterOptions::new(filter).with_preserve_ancestors(false);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Only todo task should appear
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].id, todo_id);
        assert!(!tree.iter().any(|n| n.id == backlog_id));
    }

    #[tokio::test]
    async fn test_get_task_tree_node_methods() {
        let service = setup_test_service().await;

        // Create parent with mixed children
        let parent_id = service
            .create_task(CreateTaskOptions::new("Parent").with_level(Level::Epic))
            .await
            .unwrap();

        // Create children in random order
        let _task1 = service
            .create_task(CreateTaskOptions::new("Zebra Task").with_parent(&parent_id))
            .await
            .unwrap();

        let _ticket1 = service
            .create_task(
                CreateTaskOptions::new("Alpha Ticket")
                    .with_level(Level::Ticket)
                    .with_parent(&parent_id),
            )
            .await
            .unwrap();

        let _task2 = service
            .create_task(CreateTaskOptions::new("Alpha Task").with_parent(&parent_id))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        let children = &tree[0].children;

        // Ticket should come before tasks (level priority)
        assert_eq!(children[0].level, Level::Ticket);
        assert_eq!(children[0].title, "Alpha Ticket");

        // Tasks should be sorted by title
        assert_eq!(children[1].level, Level::Task);
        assert_eq!(children[1].title, "Alpha Task");
        assert_eq!(children[2].level, Level::Task);
        assert_eq!(children[2].title, "Zebra Task");
    }

    #[tokio::test]
    async fn test_get_task_tree_sorted_by_level_and_title() {
        let service = setup_test_service().await;

        // Create parent with mixed children
        let parent_id = service
            .create_task(CreateTaskOptions::new("Parent").with_level(Level::Epic))
            .await
            .unwrap();

        // Create children in random order
        let _task1 = service
            .create_task(CreateTaskOptions::new("Zebra Task").with_parent(&parent_id))
            .await
            .unwrap();

        let _ticket1 = service
            .create_task(
                CreateTaskOptions::new("Alpha Ticket")
                    .with_level(Level::Ticket)
                    .with_parent(&parent_id),
            )
            .await
            .unwrap();

        let _task2 = service
            .create_task(CreateTaskOptions::new("Alpha Task").with_parent(&parent_id))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        let children = &tree[0].children;

        // Ticket should come before tasks (level priority)
        assert_eq!(children[0].level, Level::Ticket);
        assert_eq!(children[0].title, "Alpha Ticket");

        // Tasks should be sorted by title
        assert_eq!(children[1].level, Level::Task);
        assert_eq!(children[1].title, "Alpha Task");
        assert_eq!(children[2].level, Level::Task);
        assert_eq!(children[2].title, "Zebra Task");
    }

    // =========================================================================
    // edit_section_by_ordinal tests
    // =========================================================================

    #[tokio::test]
    async fn test_edit_section_by_ordinal() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add a section with ordinal
        let section = Section::with_order(vertebrae_db::SectionType::Step, "Original content", 0);
        service.add_section(&id, section).await.unwrap();

        // Edit the section
        service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Step, 0, "Updated content")
            .await
            .unwrap();

        // Verify the section was updated
        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Updated content");
        assert_eq!(task.sections[0].order, Some(0));
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_preserves_other_sections() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add multiple sections with ordinals
        let section1 = Section::with_order(vertebrae_db::SectionType::Step, "Step 1", 0);
        service.add_section(&id, section1).await.unwrap();

        let section2 = Section::with_order(vertebrae_db::SectionType::Goal, "Original goal", 0);
        service.add_section(&id, section2).await.unwrap();

        let section3 = Section::with_order(vertebrae_db::SectionType::Step, "Step 2", 1);
        service.add_section(&id, section3).await.unwrap();

        // Edit the goal section
        service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Goal, 0, "Updated goal")
            .await
            .unwrap();

        // Verify the goal was updated and other sections preserved
        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 3);

        let goal_section = task
            .sections
            .iter()
            .find(|s| s.section_type == vertebrae_db::SectionType::Goal)
            .unwrap();
        assert_eq!(goal_section.content, "Updated goal");

        // Verify steps are unchanged
        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == vertebrae_db::SectionType::Step)
            .collect();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content, "Step 1");
        assert_eq!(steps[1].content, "Step 2");
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_multiple_of_same_type() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add multiple sections of the same type with ordinals
        let section1 = Section::with_order(vertebrae_db::SectionType::Step, "Step 0", 0);
        service.add_section(&id, section1).await.unwrap();

        let section2 = Section::with_order(vertebrae_db::SectionType::Step, "Step 1", 1);
        service.add_section(&id, section2).await.unwrap();

        let section3 = Section::with_order(vertebrae_db::SectionType::Step, "Step 2", 2);
        service.add_section(&id, section3).await.unwrap();

        // Edit the middle section
        service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Step, 1, "Updated Step 1")
            .await
            .unwrap();

        // Verify only the targeted section was updated
        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 3);

        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == vertebrae_db::SectionType::Step)
            .collect();
        assert_eq!(steps[0].content, "Step 0");
        assert_eq!(steps[1].content, "Updated Step 1");
        assert_eq!(steps[2].content, "Step 2");
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_task_not_found() {
        let service = setup_test_service().await;

        let result = service
            .edit_section_by_ordinal("nonexistent", vertebrae_db::SectionType::Step, 0, "content")
            .await;

        assert!(matches!(result, Err(ServiceError::TaskNotFound { .. })));
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_section_not_found() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        let result = service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Step, 0, "content")
            .await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_wrong_ordinal() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add a section with ordinal 0
        let section = Section::with_order(vertebrae_db::SectionType::Step, "Original", 0);
        service.add_section(&id, section).await.unwrap();

        // Try to edit with wrong ordinal
        let result = service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Step, 5, "new content")
            .await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_fires_mutation_callback() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add a section with ordinal
        let section = Section::with_order(vertebrae_db::SectionType::Step, "Original", 0);
        service.add_section(&id, section).await.unwrap();

        // Edit the section (if callback is set, it will be called, but we can't easily
        // verify it here without more infrastructure; this test mainly ensures no panic)
        let result = service
            .edit_section_by_ordinal(&id, vertebrae_db::SectionType::Step, 0, "Updated")
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_case_insensitive_id() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Add a section with ordinal
        let section = Section::with_order(vertebrae_db::SectionType::Step, "Original", 0);
        service.add_section(&id, section).await.unwrap();

        // Edit using uppercase ID
        service
            .edit_section_by_ordinal(
                &id.to_uppercase(),
                vertebrae_db::SectionType::Step,
                0,
                "Updated",
            )
            .await
            .unwrap();

        // Verify the section was updated
        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.sections[0].content, "Updated");
    }

    // =========================================================================
    // get_task_tree workflow_id filter tests
    // =========================================================================

    #[tokio::test]
    async fn test_get_task_tree_filter_by_workflow_id() {
        let service = setup_test_service().await;

        // Create tasks for workflow 1
        let w1_task1 = service
            .create_task(CreateTaskOptions::new("Workflow 1 Task A"))
            .await
            .unwrap();

        let w1_task2 = service
            .create_task(CreateTaskOptions::new("Workflow 1 Task B"))
            .await
            .unwrap();

        // Create tasks for workflow 2
        let w2_task1 = service
            .create_task(CreateTaskOptions::new("Workflow 2 Task A"))
            .await
            .unwrap();

        // Create task not assigned to any workflow
        let no_wf_task = service
            .create_task(CreateTaskOptions::new("No Workflow Task"))
            .await
            .unwrap();

        // Create workflow IDs (simulating workflow records)
        let workflow1_id = Thing::from(("workflow", "workflow1"));
        let workflow2_id = Thing::from(("workflow", "workflow2"));

        // Assign tasks to workflows
        service
            .assign_workflow(&w1_task1, &workflow1_id)
            .await
            .unwrap();
        service
            .assign_workflow(&w1_task2, &workflow1_id)
            .await
            .unwrap();
        service
            .assign_workflow(&w2_task1, &workflow2_id)
            .await
            .unwrap();

        // Test 1: Filter by workflow1 - should only return tasks for workflow1
        let filter = TaskFilter::new().with_workflow_id("workflow1");
        let options = TreeFilterOptions::new(filter);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should have only the tasks from workflow1 at root
        assert_eq!(tree.len(), 2, "Should return 2 tasks for workflow1");
        let ids: std::collections::HashSet<_> = tree.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(w1_task1.as_str()), "Should contain w1_task1");
        assert!(ids.contains(w1_task2.as_str()), "Should contain w1_task2");
        assert!(
            !ids.contains(w2_task1.as_str()),
            "Should not contain w2_task1"
        );
        assert!(
            !ids.contains(no_wf_task.as_str()),
            "Should not contain no_wf_task"
        );

        // Test 2: Filter by workflow2 - should only return tasks for workflow2
        let filter = TaskFilter::new().with_workflow_id("workflow2");
        let options = TreeFilterOptions::new(filter);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should have only the task from workflow2 at root
        assert_eq!(tree.len(), 1, "Should return 1 task for workflow2");
        assert_eq!(tree[0].id, w2_task1);

        // Test 3: Filter by non-existent workflow - should return empty
        let filter = TaskFilter::new().with_workflow_id("nonexistent");
        let options = TreeFilterOptions::new(filter);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should return empty for nonexistent workflow
        assert!(
            tree.is_empty(),
            "Should return empty for nonexistent workflow"
        );

        // Test 4: No filter - should return all tasks
        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should return all 4 tasks without filter
        assert_eq!(tree.len(), 4, "Should return all 4 tasks without filter");
    }

    #[tokio::test]
    async fn test_get_task_tree_workflow_filter_with_hierarchy() {
        let service = setup_test_service().await;

        // Create a hierarchy: epic -> ticket -> task, all in workflow1
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic in WF1").with_level(Level::Epic))
            .await
            .unwrap();

        let ticket_id = service
            .create_task(
                CreateTaskOptions::new("Ticket in WF1")
                    .with_level(Level::Ticket)
                    .with_parent(&epic_id),
            )
            .await
            .unwrap();

        let task_id = service
            .create_task(CreateTaskOptions::new("Task in WF1").with_parent(&ticket_id))
            .await
            .unwrap();

        // Create another epic NOT in any workflow
        let _other_epic = service
            .create_task(CreateTaskOptions::new("Epic without workflow").with_level(Level::Epic))
            .await
            .unwrap();

        // Assign only the first hierarchy to workflow1
        let workflow1_id = Thing::from(("workflow", "workflow1"));
        service
            .assign_workflow(&epic_id, &workflow1_id)
            .await
            .unwrap();
        service
            .assign_workflow(&ticket_id, &workflow1_id)
            .await
            .unwrap();
        service
            .assign_workflow(&task_id, &workflow1_id)
            .await
            .unwrap();

        // Filter by workflow - epic should NOT appear (not assigned)
        let filter = TaskFilter::new().with_workflow_id("workflow1");
        let options = TreeFilterOptions::new(filter).with_preserve_ancestors(false);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should have only the epic from workflow1 at root (epic IS assigned)
        assert_eq!(tree.len(), 1, "Should return 1 root for workflow1");
        assert_eq!(tree[0].id, epic_id);
        assert_eq!(tree[0].title, "Epic in WF1");

        // Verify the other epic is not included
        assert!(
            !tree.iter().any(|n| n.id == _other_epic),
            "Should not include epic without workflow"
        );

        // Verify hierarchy is preserved within workflow
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].id, ticket_id);
        assert_eq!(tree[0].children[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].id, task_id);
    }

    #[tokio::test]
    async fn test_get_task_tree_workflow_filter_partial_hierarchy() {
        let service = setup_test_service().await;

        // Create a hierarchy: epic -> ticket -> task
        // Only assign ticket and task to workflow, NOT epic
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic NOT in WF").with_level(Level::Epic))
            .await
            .unwrap();

        let ticket_id = service
            .create_task(
                CreateTaskOptions::new("Ticket in WF")
                    .with_level(Level::Ticket)
                    .with_parent(&epic_id),
            )
            .await
            .unwrap();

        let task_id = service
            .create_task(CreateTaskOptions::new("Task in WF").with_parent(&ticket_id))
            .await
            .unwrap();

        // Assign only ticket and task to workflow, leaving epic unassigned
        let workflow_id = Thing::from(("workflow", "partial_wf"));
        service
            .assign_workflow(&ticket_id, &workflow_id)
            .await
            .unwrap();
        service
            .assign_workflow(&task_id, &workflow_id)
            .await
            .unwrap();

        // Filter by workflow - should only have ticket and task
        let filter = TaskFilter::new().with_workflow_id("partial_wf");
        let options = TreeFilterOptions::new(filter).with_preserve_ancestors(false);
        let tree = service.get_task_tree(&options).await.unwrap();

        // Should only have ticket and task (epic not in workflow)
        // Ticket becomes root since its parent (epic) is not in the result
        assert_eq!(tree.len(), 1, "Should return 1 root (ticket)");
        assert_eq!(tree[0].id, ticket_id);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].id, task_id);
    }

    #[tokio::test]
    async fn test_transition_unblocks_with_unblocks_dependents_status() {
        let service = setup_test_service().await;

        // Create task A (dependency)
        let task_a = service
            .create_task(CreateTaskOptions::new("Task A").with_status("in_progress"))
            .await
            .unwrap();

        // Create task B that depends on A
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B").with_status("in_progress"))
            .await
            .unwrap();

        service.add_dependency(&task_b, &task_a).await.unwrap();

        // Move A to in_progress, then pending_review, then done
        service.transition_to(&task_a, "in_progress").await.unwrap();
        service
            .transition_to(&task_a, "pending_review")
            .await
            .unwrap();
        let result = service.transition_to(&task_a, "done").await.unwrap();

        // Should unblock task B (done has unblocks_dependents=true in default schema)
        assert_eq!(result.unblocked_tasks.len(), 1);
        assert_eq!(result.unblocked_tasks[0].id, task_b);
    }

    #[tokio::test]
    async fn test_transition_no_unblock_with_rejected_status() {
        let service = setup_test_service().await;

        // Create task A (dependency)
        let task_a = service
            .create_task(CreateTaskOptions::new("Task A").with_status("in_progress"))
            .await
            .unwrap();

        // Create task B that depends on A
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B").with_status("in_progress"))
            .await
            .unwrap();

        service.add_dependency(&task_b, &task_a).await.unwrap();

        // Reject task A (rejected has unblocks_dependents=false in default schema)
        let result = service.transition_to(&task_a, "rejected").await.unwrap();

        // Should NOT unblock task B (rejected does not unblock dependents)
        assert!(
            result.unblocked_tasks.is_empty(),
            "Rejected should not unblock dependents"
        );

        // Verify task B is still blocked
        let blockers = service.get_blockers(&task_b).await.unwrap();
        // task_a should still be in blockers even though rejected
        assert!(!blockers.is_empty(), "Task B should still have blockers");
    }
}
