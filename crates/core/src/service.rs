//! Task service trait and implementation
//!
//! Provides the main abstraction layer for task operations. The `TaskService` trait
//! defines the interface for all task management operations, enabling both CLI and GUI
//! to share the same business logic.

use crate::error::{ServiceError, ServiceResult};
use async_trait::async_trait;
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
}

// Add hex encoding utility
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

#[async_trait]
impl TaskService for DefaultTaskService {
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
}
