//! Task service trait and implementation
//!
//! Provides the main abstraction layer for task operations. The `TaskService` trait
//! defines the interface for all task management operations, enabling both CLI and GUI
//! to share the same business logic.

use crate::error::{ServiceError, ServiceResult};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use vertebrae_db::{
    BlockerNode, CodeRef, Database, Level, Priority, Section, Status, Task, TaskFilter,
    TaskSummary, TaskUpdate,
};

// Re-export commonly used types
pub use vertebrae_db::{Level as TaskLevel, Priority as TaskPriority, Status as TaskStatus};

/// Options for creating a new task
#[derive(Debug, Default)]
pub struct CreateTaskOptions {
    /// Title of the task (required)
    pub title: String,
    /// Optional description
    pub description: Option<String>,
    /// Task level (defaults to Task)
    pub level: Option<Level>,
    /// Task status (defaults to Backlog)
    pub status: Option<Status>,
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
    pub fn with_status(mut self, status: Status) -> Self {
        self.status = Some(status);
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
    pub from_status: Status,
    /// The new status
    pub to_status: Status,
    /// Tasks that are now unblocked (for done transitions)
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
    /// Current status
    pub status: Status,
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
    /// Child nodes in the hierarchy
    pub children: Vec<TaskTreeNode>,
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
            children: Vec::new(),
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
    // Database Access
    // =========================================================================

    /// Get a reference to the underlying database
    ///
    /// This is provided during the migration period to allow CLI commands
    /// to access database functionality not yet exposed through the service.
    /// New code should prefer using service methods when available.
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
    async fn list_ready(&self, status: Status) -> ServiceResult<Vec<TaskSummary>>;

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
    async fn transition_to(&self, id: &str, target: Status) -> ServiceResult<TransitionResult>;

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

    /// Add a code reference to a task
    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()>;

    /// Remove code references from a task
    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()>;
}

/// Default implementation of TaskService backed by Database
pub struct DefaultTaskService {
    db: Database,
}

impl DefaultTaskService {
    /// Create a new DefaultTaskService with the given database
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Get a reference to the underlying database
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Generate a unique task ID
    async fn generate_unique_id(&self, title: &str) -> ServiceResult<String> {
        use sha2::{Digest, Sha256};

        // Generate base ID from title hash
        let mut hasher = Sha256::new();
        hasher.update(title.as_bytes());
        let hash = hasher.finalize();
        let base_id = hex::encode(&hash[..3]); // 6 hex chars

        // Check for collisions
        if !self.db.tasks().exists(&base_id).await? {
            return Ok(base_id);
        }

        // If collision, add random suffix
        for _ in 0..100 {
            use rand::Rng;
            let suffix: u16 = rand::rng().random();
            let id = format!("{}{:04x}", &base_id[..4], suffix);
            if !self.db.tasks().exists(&id).await? {
                return Ok(id);
            }
        }

        Err(ServiceError::validation_failed(
            "Failed to generate unique ID after maximum retries",
        ))
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
        if !filter.include_done && filter.statuses.is_empty() && task.status == Status::Done {
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

// Add hex encoding utility
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
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
        let status = options.status.unwrap_or(Status::Backlog);

        let mut task = Task::new(options.title, level).with_status(status);

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

        // Create in database
        self.db.tasks().create(&id, &task).await?;

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

        Ok(())
    }

    async fn task_exists(&self, id: &str) -> ServiceResult<bool> {
        let id = id.to_lowercase();
        Ok(self.db.tasks().exists(&id).await?)
    }

    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<TaskSummary>> {
        Ok(self.db.list_tasks().list(filter).await?)
    }

    async fn list_ready(&self, status: Status) -> ServiceResult<Vec<TaskSummary>> {
        Ok(self.db.list_ready_items(status).await?)
    }

    async fn get_task_tree(&self, options: &TreeFilterOptions) -> ServiceResult<Vec<TaskTreeNode>> {
        // Step 1: Get all tasks (include_done based on filter)
        let all_filter = TaskFilter::new().include_done();
        let all_tasks = self.db.list_tasks().list(&all_filter).await?;

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
                && blocker_task.status != Status::Done
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

        // Step 6: Find root tasks (orphans - no parent)
        let root_ids: Vec<String> = all_tasks
            .iter()
            .filter(|t| !parent_map.contains_key(&t.id) && ids_to_include.contains(&t.id))
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

    async fn transition_to(&self, id: &str, target: Status) -> ServiceResult<TransitionResult> {
        let id = id.to_lowercase();

        // Get current task
        let task = self.get_task(&id).await?;
        let from_status = task.status.clone();

        // Validate transition
        let valid_targets = from_status.valid_transitions();
        if !valid_targets.contains(&target) {
            return Err(ServiceError::invalid_transition(
                from_status.as_str(),
                target.as_str(),
            ));
        }

        // Build update
        let mut update = TaskUpdate::new().with_status(target.clone());

        // Set timestamps based on transition
        if target == Status::InProgress {
            update = update.set_started_at_if_null();
        } else if target == Status::Done {
            // Set completed_at handled in repository
        }

        // Apply update
        self.db.tasks().update(&id, &update).await?;

        // Get unblocked tasks if transitioning to done
        let unblocked_tasks = if target == Status::Done {
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
        Ok(())
    }

    async fn remove_parent(&self, child_id: &str) -> ServiceResult<()> {
        let child_id = child_id.to_lowercase();

        if !self.db.tasks().exists(&child_id).await? {
            return Err(ServiceError::task_not_found(&child_id));
        }

        self.db.relationships().remove_child_of(&child_id).await?;
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
        Ok(())
    }

    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>> {
        let id = id.to_lowercase();

        if !self.db.tasks().exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        Ok(self.db.graph().get_blockers(&id, None).await?)
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

        assert_eq!(id.len(), 6);

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.title, "My Task");
        assert_eq!(task.level, Level::Task);
        assert_eq!(task.status, Status::Backlog);
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

        let id = service
            .create_task(CreateTaskOptions::new("Task").with_status(Status::Todo))
            .await
            .unwrap();

        let result = service
            .transition_to(&id, Status::InProgress)
            .await
            .unwrap();

        assert_eq!(result.from_status, Status::Todo);
        assert_eq!(result.to_status, Status::InProgress);

        let task = service.get_task(&id).await.unwrap();
        assert_eq!(task.status, Status::InProgress);
    }

    #[tokio::test]
    async fn test_transition_invalid() {
        let service = setup_test_service().await;

        let id = service
            .create_task(CreateTaskOptions::new("Task"))
            .await
            .unwrap();

        // Task is in Backlog, cannot go directly to Done
        let result = service.transition_to(&id, Status::Done).await;

        assert!(matches!(
            result,
            Err(ServiceError::InvalidTransition { .. })
        ));
    }

    #[tokio::test]
    async fn test_add_dependency() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
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
            .create_task(CreateTaskOptions::new("Blocker").with_status(Status::Todo))
            .await
            .unwrap();

        // Create dependent task
        let dependent_id = service
            .create_task(CreateTaskOptions::new("Dependent").with_dependency(&blocker_id))
            .await
            .unwrap();

        // Mark blocker as done (must go through full workflow)
        service
            .transition_to(&blocker_id, Status::InProgress)
            .await
            .unwrap();
        service
            .transition_to(&blocker_id, Status::PendingReview)
            .await
            .unwrap();
        service
            .transition_to(&blocker_id, Status::Done)
            .await
            .unwrap();

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
            .create_task(CreateTaskOptions::new("Done Task").with_status(Status::Todo))
            .await
            .unwrap();

        // Mark task as done (must go through full workflow)
        service
            .transition_to(&done_id, Status::InProgress)
            .await
            .unwrap();
        service
            .transition_to(&done_id, Status::PendingReview)
            .await
            .unwrap();
        service.transition_to(&done_id, Status::Done).await.unwrap();

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
        assert!(tree[0].children.is_empty()); // Ticket doesn't match filter
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
            .create_task(CreateTaskOptions::new("Todo Task").with_status(Status::Todo))
            .await
            .unwrap();

        // Filter for todo status only
        let filter = TaskFilter::new().with_status(Status::Todo);
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

        // Create epic with children
        let epic_id = service
            .create_task(CreateTaskOptions::new("Epic").with_level(Level::Epic))
            .await
            .unwrap();

        let _child1 = service
            .create_task(CreateTaskOptions::new("Child1").with_parent(&epic_id))
            .await
            .unwrap();

        let child2 = service
            .create_task(CreateTaskOptions::new("Child2").with_parent(&epic_id))
            .await
            .unwrap();

        let _grandchild = service
            .create_task(CreateTaskOptions::new("Grandchild").with_parent(&child2))
            .await
            .unwrap();

        let options = TreeFilterOptions::default();
        let tree = service.get_task_tree(&options).await.unwrap();

        let epic_node = &tree[0];
        assert!(!epic_node.is_leaf());
        assert_eq!(epic_node.descendant_count(), 3); // 2 children + 1 grandchild

        // Find grandchild node
        let grandchild_node = &epic_node
            .children
            .iter()
            .find(|n| n.id == child2)
            .unwrap()
            .children[0];
        assert!(grandchild_node.is_leaf());
        assert_eq!(grandchild_node.descendant_count(), 0);
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
}
