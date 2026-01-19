//! Task repository for CRUD operations on tasks
//!
//! Provides a repository pattern implementation for task operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::{CodeRef, Priority, Section, SectionType, Task};
use serde::Deserialize;
use serde_json;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use tracing::{debug, trace};

/// Repository for task CRUD operations
///
/// Encapsulates database queries for tasks, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct TaskRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial task updates
#[derive(Debug, Default)]
pub struct TaskUpdate {
    /// New title (if Some)
    pub title: Option<String>,
    /// New description (if Some(Some(desc)), clear if Some(None))
    pub description: Option<Option<String>>,
    /// New priority (if Some)
    pub priority: Option<Option<Priority>>,
    /// Tags to add
    pub add_tags: Vec<String>,
    /// Tags to remove
    pub remove_tags: Vec<String>,
    /// Code references to set (replaces entire refs array)
    pub refs: Option<Vec<CodeRef>>,
    /// Whether to clear refs
    pub clear_refs: bool,
    /// Human review flag (if Some)
    pub needs_human_review: Option<bool>,
    /// Sections to set (replaces entire sections array)
    pub sections: Option<Vec<Section>>,
    /// Whether to clear sections
    pub clear_sections: bool,
    /// Whether to set started_at to current time
    pub set_started_at: bool,
    /// Whether to conditionally set started_at only if currently NULL (null-coalescing)
    pub set_started_at_if_null: bool,
    /// New status (if Some) - references StatusDefinition.name from StatusSchema
    pub status: Option<String>,
    /// Workflow ID to assign (if Some)
    pub workflow_id: Option<Option<surrealdb::sql::Thing>>,
    /// Current step in the workflow (if Some)
    pub current_step: Option<Option<usize>>,
}

impl TaskUpdate {
    /// Create a new empty update
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

    /// Set code references
    pub fn with_refs(mut self, refs: Vec<CodeRef>) -> Self {
        self.refs = Some(refs);
        self
    }

    /// Clear code references
    pub fn clear_refs(mut self) -> Self {
        self.clear_refs = true;
        self
    }

    /// Set the human review flag
    pub fn with_needs_human_review(mut self, value: bool) -> Self {
        self.needs_human_review = Some(value);
        self
    }

    /// Set sections
    pub fn with_sections(mut self, sections: Vec<Section>) -> Self {
        self.sections = Some(sections);
        self
    }

    /// Clear sections
    pub fn clear_sections(mut self) -> Self {
        self.clear_sections = true;
        self
    }

    /// Set started_at to current time
    pub fn set_started_at(mut self) -> Self {
        self.set_started_at = true;
        self
    }

    /// Set started_at to current time only if currently NULL (null-coalescing)
    /// This preserves existing start times when re-starting a task
    pub fn set_started_at_if_null(mut self) -> Self {
        self.set_started_at_if_null = true;
        self
    }

    /// Set the task status
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = Some(status.into());
        self
    }

    /// Assign the task to a workflow at a specific step
    pub fn with_workflow(
        mut self,
        workflow_id: surrealdb::sql::Thing,
        current_step: usize,
    ) -> Self {
        self.workflow_id = Some(Some(workflow_id));
        self.current_step = Some(Some(current_step));
        self
    }

    /// Remove workflow assignment from the task
    pub fn clear_workflow(mut self) -> Self {
        self.workflow_id = Some(None);
        self.current_step = Some(None);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.refs.is_some()
            || self.clear_refs
            || self.needs_human_review.is_some()
            || self.sections.is_some()
            || self.clear_sections
            || self.set_started_at
            || self.set_started_at_if_null
            || self.status.is_some()
            || self.workflow_id.is_some()
            || self.current_step.is_some()
    }
}

/// Minimal row for checking task existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

/// Row for fetching task with tags
#[derive(Debug, Deserialize)]
struct TaskTagsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default)]
    tags: Vec<String>,
}

impl<'a> TaskRepository<'a> {
    /// Create a new TaskRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Check if a task with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to check
    ///
    /// # Returns
    ///
    /// `true` if the task exists, `false` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        // Use raw query instead of .select() to handle both numeric and string IDs.
        // .select(("task", id)) creates a string ID, but tasks created with
        // CREATE task:123 have numeric IDs, causing a mismatch.
        let query = format!("SELECT id FROM task:{}", id);
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let task: Option<IdOnly> = result.take(0)?;
        Ok(task.is_some())
    }

    /// Create a new task with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique task ID
    /// * `task` - The task data to create
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create(&self, id: &str, task: &Task) -> DbResult<()> {
        debug!("Creating task: {} with title: {}", id, task.title);
        trace!("Task data: {:?}", task);
        let priority_str = match &task.priority {
            Some(p) => format!("\"{}\"", p.as_str()),
            None => "NONE".to_string(),
        };

        let tags_str = if task.tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                task.tags
                    .iter()
                    .map(|t| format!("\"{}\"", t.replace('\"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let title = task.title.clone();
        let description = task.description.clone();

        let description_clause = if description.is_some() {
            ", description = $description"
        } else {
            ""
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = $title,
                level = "{}",
                status = "{}",
                priority = {},
                tags = {}{}"#,
            id,
            task.level.as_str(),
            task.status.as_str(),
            priority_str,
            tags_str,
            description_clause
        );

        let mut query_builder = self.client.query(&query).bind(("title", title));
        if let Some(desc) = description {
            query_builder = query_builder.bind(("description", desc));
        }
        query_builder.await?;
        Ok(())
    }

    /// Get a task by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(Task)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<Task>> {
        debug!("Fetching task: {}", id);
        // Use raw query instead of .select() to handle both numeric and string IDs
        // .select(("task", id)) creates a string ID, but tasks created with
        // CREATE task:123 have numeric IDs, causing a mismatch.
        let query = format!("SELECT * FROM task:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch task: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let task: Option<Task> = result.take(0)?;
        if task.is_some() {
            debug!("Successfully fetched task: {}", id);
        } else {
            debug!("Task not found: {}", id);
        }
        Ok(task)
    }

    /// Update the status of a task.
    ///
    /// This method directly updates the status without validation.
    /// Callers are responsible for validating transitions before calling this method.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `status` - The new status
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_status(&self, id: &str, status: impl AsRef<str>) -> DbResult<()> {
        self.update_status_unchecked(id, status).await
    }

    /// Update the status of a task without workflow validation.
    ///
    /// This should only be used for internal operations where validation
    /// has already been performed or is not needed.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `status` - The new status
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_status_unchecked(&self, id: &str, status: impl AsRef<str>) -> DbResult<()> {
        let query = format!(
            "UPDATE task:{} SET status = '{}', updated_at = time::now()",
            id,
            status.as_ref()
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Mark a task as done with completed_at timestamp.
    ///
    /// Updates the status to 'done' and sets both updated_at and completed_at timestamps.
    /// Callers are responsible for validating transitions before calling this method.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to mark as done
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn mark_done(&self, id: &str) -> DbResult<()> {
        self.mark_done_unchecked(id).await
    }

    /// Mark a task as done without workflow validation.
    ///
    /// This should only be used for internal operations where validation
    /// has already been performed or is not needed.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to mark as done
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn mark_done_unchecked(&self, id: &str) -> DbResult<()> {
        let query = format!(
            "UPDATE task:{} SET status = 'done', updated_at = time::now(), completed_at = time::now()",
            id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Update the updated_at timestamp of a task.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_timestamp(&self, id: &str) -> DbResult<()> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Add a section to a task without replacing existing sections.
    ///
    /// Appends a new section to the task's sections array.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `section_type` - The type of section to add
    /// * `content` - The content of the section
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn add_section(
        &self,
        id: &str,
        section_type: crate::models::SectionType,
        content: &str,
    ) -> DbResult<()> {
        let escaped_content = content.replace('"', "\\\"");
        let query = format!(
            r#"UPDATE task:{} SET sections = array::concat(sections, [{{ type: "{}", content: "{}" }}]), updated_at = time::now()"#,
            id,
            section_type.as_str(),
            escaped_content
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Apply partial updates to a task.
    ///
    /// Callers are responsible for validating status transitions before calling this method.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update(&self, id: &str, updates: &TaskUpdate) -> DbResult<()> {
        debug!("Updating task: {}", id);
        trace!("Updates: {:?}", updates);

        if !updates.has_updates() {
            debug!("No updates specified for task: {}", id);
            return Ok(());
        }

        // Apply field updates (title, priority, refs, needs_human_review, started_at)
        let mut field_updates = Vec::new();

        if let Some(title) = &updates.title {
            let escaped_title = title.replace('\"', "\\\"");
            field_updates.push(format!("title = \"{}\"", escaped_title));
        }

        if let Some(description_opt) = &updates.description {
            match description_opt {
                Some(desc) => {
                    let escaped_desc = desc.replace('\"', "\\\"");
                    field_updates.push(format!("description = \"{}\"", escaped_desc));
                }
                None => field_updates.push("description = NONE".to_string()),
            }
        }

        if let Some(priority_opt) = &updates.priority {
            match priority_opt {
                Some(p) => field_updates.push(format!("priority = \"{}\"", p.as_str())),
                None => field_updates.push("priority = NONE".to_string()),
            }
        }

        if updates.clear_refs {
            field_updates.push("refs = []".to_string());
        } else if let Some(refs) = &updates.refs {
            let refs_json = serde_json::to_string(refs).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!("Failed to serialize refs: {}", e),
            })?;
            field_updates.push(format!("refs = {}", refs_json));
        }

        if let Some(needs_review) = updates.needs_human_review {
            field_updates.push(format!("needs_human_review = {}", needs_review));
        }

        if updates.set_started_at {
            field_updates.push("started_at = time::now()".to_string());
        }

        if updates.set_started_at_if_null {
            field_updates.push("started_at = started_at ?? time::now()".to_string());
        }

        if let Some(status) = &updates.status {
            field_updates.push(format!("status = '{}'", status));
        }

        if updates.clear_sections {
            field_updates.push("sections = []".to_string());
        } else if let Some(sections) = &updates.sections {
            let sections_json =
                serde_json::to_string(sections).map_err(|e| DbError::InvalidPath {
                    path: std::path::PathBuf::from(id),
                    reason: format!("Failed to serialize sections: {}", e),
                })?;
            field_updates.push(format!("sections = {}", sections_json));
        }

        // Handle workflow assignment updates
        if let Some(workflow_id_opt) = &updates.workflow_id {
            match workflow_id_opt {
                Some(wf_id) => {
                    field_updates.push(format!("workflow_id = {}", wf_id));
                }
                None => field_updates.push("workflow_id = NONE".to_string()),
            }
        }

        if let Some(current_step_opt) = &updates.current_step {
            match current_step_opt {
                Some(step) => field_updates.push(format!("current_step = {}", step)),
                None => field_updates.push("current_step = NONE".to_string()),
            }
        }

        if !field_updates.is_empty() {
            field_updates.push("updated_at = time::now()".to_string());
            let query = format!("UPDATE task:{} SET {}", id, field_updates.join(", "));
            debug!("Executing field updates for task: {}", id);
            trace!("Query: {}", query);
            match self.client.query(&query).await {
                Ok(_) => debug!("Field updates succeeded for task: {}", id),
                Err(e) => {
                    debug!("Field updates failed for task: {}: {}", id, e);
                    return Err(DbError::Query(Box::new(e)));
                }
            }
        }

        // Handle tag updates
        if !updates.add_tags.is_empty() || !updates.remove_tags.is_empty() {
            self.apply_tag_updates(id, &updates.add_tags, &updates.remove_tags)
                .await?;
        }

        Ok(())
    }

    /// Apply tag updates (add and remove tags).
    async fn apply_tag_updates(
        &self,
        id: &str,
        add_tags: &[String],
        remove_tags: &[String],
    ) -> DbResult<()> {
        debug!("Applying tag updates to task: {}", id);
        trace!(
            "Adding tags: {:?}, Removing tags: {:?}",
            add_tags, remove_tags
        );

        // Fetch current tags
        let query = format!("SELECT id, tags FROM task:{}", id);
        let mut result = match self.client.query(&query).await {
            Ok(r) => r,
            Err(e) => {
                debug!("Failed to fetch tags for task: {}: {}", id, e);
                return Err(DbError::Query(Box::new(e)));
            }
        };
        let task: Option<TaskTagsRow> = result.take(0)?;

        let mut current_tags: Vec<String> = task.map(|t| t.tags).unwrap_or_default();

        // Remove tags
        for tag in remove_tags {
            current_tags.retain(|t| t != tag);
        }

        // Add tags (avoiding duplicates)
        for tag in add_tags {
            if !current_tags.contains(tag) {
                current_tags.push(tag.clone());
            }
        }

        // Update tags in database
        let tags_str = if current_tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                current_tags
                    .iter()
                    .map(|t| format!("\"{}\"", t.replace('\"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let update_query = format!("UPDATE task:{} SET tags = {}", id, tags_str);
        self.client.query(&update_query).await?;

        Ok(())
    }

    /// Assign a task to a workflow at the first step (step 0).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID to assign
    /// * `workflow_id` - The workflow ID to assign to
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &surrealdb::sql::Thing,
    ) -> DbResult<()> {
        debug!(
            "Assigning task {} to workflow {}",
            task_id,
            workflow_id.id.to_raw()
        );
        // Use parameter binding for the workflow_id to ensure proper serialization
        let query = format!(
            "UPDATE task:{} SET workflow_id = $workflow_id, current_step = 0, updated_at = time::now()",
            task_id
        );
        trace!("Assign workflow query: {}", query);
        self.client
            .query(&query)
            .bind(("workflow_id", workflow_id.clone()))
            .await?;
        Ok(())
    }

    /// Remove workflow assignment from a task.
    ///
    /// Clears both workflow_id and current_step fields.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID to unassign
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn unassign_workflow(&self, task_id: &str) -> DbResult<()> {
        debug!("Unassigning workflow from task {}", task_id);
        let query = format!(
            "UPDATE task:{} SET workflow_id = NONE, current_step = NONE, updated_at = time::now()",
            task_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Update the current step of a task in its workflow.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID to update
    /// * `step` - The new step index (0-based)
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_current_step(&self, task_id: &str, step: usize) -> DbResult<()> {
        debug!("Updating task {} to step {}", task_id, step);
        let query = format!(
            "UPDATE task:{} SET current_step = {}, updated_at = time::now()",
            task_id, step
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Delete a task by ID.
    ///
    /// This only deletes the task record itself. Edges (child_of, depends_on)
    /// must be cleaned up separately using RelationshipRepository.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to delete
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, id: &str) -> DbResult<()> {
        debug!("Deleting task: {}", id);
        let query = format!("DELETE task:{}", id);
        match self.client.query(&query).await {
            Ok(_) => {
                debug!("Successfully deleted task: {}", id);
                Ok(())
            }
            Err(e) => {
                debug!("Failed to delete task: {}: {}", id, e);
                Err(DbError::Query(Box::new(e)))
            }
        }
    }

    /// Export all tasks from the database.
    ///
    /// Returns all tasks with their IDs for backup or migration purposes.
    ///
    /// # Returns
    ///
    /// A vector of (task_id, Task) tuples.
    pub async fn export_all(&self) -> DbResult<Vec<(String, Task)>> {
        debug!("Exporting all tasks");

        #[derive(Debug, Deserialize)]
        struct TaskWithId {
            id: surrealdb::sql::Thing,
            #[serde(flatten)]
            task: Task,
        }

        let mut result = self.client.query("SELECT * FROM task").await?;
        let tasks: Vec<TaskWithId> = result.take(0)?;

        debug!("Exported {} tasks", tasks.len());
        Ok(tasks
            .into_iter()
            .map(|t| (t.id.id.to_raw(), t.task))
            .collect())
    }

    /// Atomically append a code reference to a task's refs array.
    ///
    /// This method uses SurrealDB's array::append function to atomically
    /// add a new code reference without requiring a get-modify-set pattern.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `code_ref` - The code reference to append
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let code_ref = CodeRef::file("src/main.rs");
    /// repo.append_ref("task1", &code_ref).await?;
    /// ```
    pub async fn append_ref(&self, id: &str, code_ref: &CodeRef) -> DbResult<()> {
        debug!("Appending ref to task: {}", id);
        trace!("CodeRef: {:?}", code_ref);

        // Serialize the code ref to JSON for the query
        let ref_json = serde_json::to_string(code_ref).map_err(|e| DbError::InvalidPath {
            path: std::path::PathBuf::from(id),
            reason: format!("Failed to serialize code ref: {}", e),
        })?;

        // Use array::append with null coalescing to handle empty/null refs array
        // This is atomic - no get-modify-set pattern
        let query = format!(
            "UPDATE task:{} SET refs = array::append(refs ?? [], {}), updated_at = time::now()",
            id, ref_json
        );

        trace!("Query: {}", query);
        self.client.query(&query).await?;

        debug!("Successfully appended ref to task: {}", id);
        Ok(())
    }

    /// Atomically append a code reference to a section's refs array.
    ///
    /// This method uses SurrealDB's array::append function to atomically
    /// add a new code reference to a specific section without requiring
    /// a get-modify-set pattern.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `section_index` - The index of the section to append to (0-based)
    /// * `code_ref` - The code reference to append
    ///
    /// # Errors
    ///
    /// Returns `DbError::TaskNotFound` if the task doesn't exist.
    /// Returns `DbError::ValidationError` if the section index is out of bounds.
    /// Returns `DbError::Query` if the database operation fails.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let code_ref = CodeRef::file("src/main.rs");
    /// repo.append_section_ref("task1", 0, &code_ref).await?;
    /// ```
    pub async fn append_section_ref(
        &self,
        id: &str,
        section_index: usize,
        code_ref: &CodeRef,
    ) -> DbResult<()> {
        debug!("Appending ref to task {} section {}", id, section_index);
        trace!("CodeRef: {:?}", code_ref);

        // First, validate the task exists and get the sections count
        #[derive(Debug, Deserialize)]
        struct SectionCount {
            count: usize,
        }

        let count_query = format!("SELECT array::len(sections) AS count FROM task:{}", id);

        let mut result = self.client.query(&count_query).await?;
        let counts: Vec<SectionCount> = result.take(0)?;

        if counts.is_empty() {
            return Err(DbError::TaskNotFound {
                task_id: id.to_string(),
            });
        }

        let section_count = counts[0].count;
        if section_index >= section_count {
            return Err(DbError::ValidationError {
                message: format!(
                    "Section index {} is out of bounds (task has {} sections)",
                    section_index, section_count
                ),
            });
        }

        // Serialize the code ref to JSON for the query
        let ref_json = serde_json::to_string(code_ref).map_err(|e| DbError::InvalidPath {
            path: std::path::PathBuf::from(id),
            reason: format!("Failed to serialize code ref: {}", e),
        })?;

        // Use array::append with null coalescing to handle empty/null refs array
        // This is atomic - no get-modify-set pattern
        let query = format!(
            "UPDATE task:{} SET sections[{}].refs = array::append(sections[{}].refs ?? [], {}), updated_at = time::now()",
            id, section_index, section_index, ref_json
        );

        trace!("Query: {}", query);
        self.client.query(&query).await?;

        debug!(
            "Successfully appended ref to task {} section {}",
            id, section_index
        );
        Ok(())
    }

    /// Remove a section by type and ordinal, renumbering remaining sections.
    ///
    /// This method removes a specific section from a task, identified by its
    /// type and ordinal (order field). After removal, remaining sections of
    /// the same type are renumbered to maintain contiguous ordinals starting
    /// from 1.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `section_type` - The type of section to remove
    /// * `ordinal` - The ordinal (order) of the section to remove (1-based)
    ///
    /// # Errors
    ///
    /// Returns `DbError::TaskNotFound` if the task doesn't exist.
    /// Returns `DbError::ValidationError` if no section matches the type/ordinal.
    /// Returns `DbError::Query` if the database operation fails.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Remove the second step from a task
    /// repo.remove_section("task1", SectionType::Step, 2).await?;
    /// ```
    pub async fn remove_section(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> DbResult<()> {
        debug!(
            "Removing section type={:?} ordinal={} from task {}",
            section_type, ordinal, id
        );

        // First, get the task and its sections
        let task = self.get(id).await?.ok_or_else(|| DbError::TaskNotFound {
            task_id: id.to_string(),
        })?;

        // Find the index of the section to remove
        let section_index = task
            .sections
            .iter()
            .position(|s| s.section_type == section_type && s.order == Some(ordinal));

        let section_index = match section_index {
            Some(idx) => idx,
            None => {
                return Err(DbError::ValidationError {
                    message: format!(
                        "No section of type '{}' with ordinal {} found",
                        section_type.as_str(),
                        ordinal
                    ),
                });
            }
        };

        // Build the new sections array:
        // 1. Remove the target section
        // 2. Renumber remaining sections of the same type
        let mut new_sections: Vec<Section> = Vec::with_capacity(task.sections.len() - 1);
        let mut next_ordinal = 1u32;

        for (i, section) in task.sections.iter().enumerate() {
            if i == section_index {
                // Skip the section being removed
                continue;
            }

            if section.section_type == section_type {
                // Renumber sections of the same type
                let mut renumbered = section.clone();
                renumbered.order = Some(next_ordinal);
                next_ordinal += 1;
                new_sections.push(renumbered);
            } else {
                // Keep other sections unchanged
                new_sections.push(section.clone());
            }
        }

        // Serialize sections to JSON for the query
        let sections_json =
            serde_json::to_string(&new_sections).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!("Failed to serialize sections: {}", e),
            })?;

        // Update the task with the new sections array
        let query = format!(
            "UPDATE task:{} SET sections = {}, updated_at = time::now()",
            id, sections_json
        );

        trace!("Query: {}", query);
        self.client.query(&query).await?;

        debug!(
            "Successfully removed section type={:?} ordinal={} from task {}",
            section_type, ordinal, id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use crate::models::Level;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-task-repo-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_exists_returns_false_for_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let exists = repo.exists("nonexistent").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_and_exists() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Test Task", Level::Task);
        repo.create("test1", &task).await.unwrap();

        let exists = repo.exists("test1").await.unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_with_all_fields() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Full Task", Level::Epic)
            .with_status("in_progress")
            .with_priority(Priority::High)
            .with_tags(["backend", "urgent"]);

        repo.create("full1", &task).await.unwrap();

        // Verify by querying directly
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            title: String,
            level: String,
            status: String,
            priority: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
        }

        let query = "SELECT title, level, status, priority, tags FROM task:full1";
        let mut result = db.client().query(query).await.unwrap();
        let row: Option<TaskRow> = result.take(0).unwrap();
        let row = row.unwrap();

        assert_eq!(row.title, "Full Task");
        assert_eq!(row.level, "epic");
        assert_eq!(row.status, "in_progress");
        assert_eq!(row.priority, Some("high".to_string()));
        assert!(row.tags.contains(&"backend".to_string()));
        assert!(row.tags.contains(&"urgent".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_existing_task() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Get Test", Level::Ticket)
            .with_status("in_progress")
            .with_priority(Priority::Medium);

        repo.create("get1", &task).await.unwrap();

        let retrieved = repo.get("get1").await.unwrap();
        assert!(retrieved.is_some());

        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.title, "Get Test");
        assert_eq!(retrieved.level, Level::Ticket);
        assert_eq!(retrieved.status, "in_progress");
        assert_eq!(retrieved.priority, Some(Priority::Medium));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let retrieved = repo.get("nonexistent").await.unwrap();
        assert!(retrieved.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_status() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Status Test", Level::Task);
        repo.create("status1", &task).await.unwrap();

        // Update status
        repo.update_status("status1", "in_progress").await.unwrap();

        // Verify
        let retrieved = repo.get("status1").await.unwrap().unwrap();
        assert_eq!(retrieved.status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_timestamp() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Timestamp Test", Level::Task);
        repo.create("ts1", &task).await.unwrap();

        // Update timestamp
        repo.update_timestamp("ts1").await.unwrap();

        // Verify updated_at is set
        #[derive(Debug, Deserialize)]
        struct TimestampRow {
            updated_at: Option<surrealdb::sql::Datetime>,
        }

        let query = "SELECT updated_at FROM task:ts1";
        let mut result = db.client().query(query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();

        assert!(row.is_some());
        assert!(row.unwrap().updated_at.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_title() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Original Title", Level::Task);
        repo.create("upd1", &task).await.unwrap();

        let updates = TaskUpdate::new().with_title("New Title");
        repo.update("upd1", &updates).await.unwrap();

        let retrieved = repo.get("upd1").await.unwrap().unwrap();
        assert_eq!(retrieved.title, "New Title");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_priority() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Priority Test", Level::Task);
        repo.create("upd2", &task).await.unwrap();

        let updates = TaskUpdate::new().with_priority(Priority::Critical);
        repo.update("upd2", &updates).await.unwrap();

        let retrieved = repo.get("upd2").await.unwrap().unwrap();
        assert_eq!(retrieved.priority, Some(Priority::Critical));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_clear_priority() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Clear Priority", Level::Task).with_priority(Priority::High);
        repo.create("upd3", &task).await.unwrap();

        let updates = TaskUpdate::new().clear_priority();
        repo.update("upd3", &updates).await.unwrap();

        let retrieved = repo.get("upd3").await.unwrap().unwrap();
        assert!(retrieved.priority.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_tags() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Tag Test", Level::Task).with_tag("existing");
        repo.create("upd4", &task).await.unwrap();

        let updates = TaskUpdate::new().add_tag("new1").add_tag("new2");
        repo.update("upd4", &updates).await.unwrap();

        let retrieved = repo.get("upd4").await.unwrap().unwrap();
        assert!(retrieved.tags.contains(&"existing".to_string()));
        assert!(retrieved.tags.contains(&"new1".to_string()));
        assert!(retrieved.tags.contains(&"new2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_remove_tags() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Remove Tag Test", Level::Task).with_tags(["keep", "remove"]);
        repo.create("upd5", &task).await.unwrap();

        let updates = TaskUpdate::new().remove_tag("remove");
        repo.update("upd5", &updates).await.unwrap();

        let retrieved = repo.get("upd5").await.unwrap().unwrap();
        assert!(retrieved.tags.contains(&"keep".to_string()));
        assert!(!retrieved.tags.contains(&"remove".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Duplicate Tag Test", Level::Task).with_tag("existing");
        repo.create("upd6", &task).await.unwrap();

        let updates = TaskUpdate::new().add_tag("existing");
        repo.update("upd6", &updates).await.unwrap();

        let retrieved = repo.get("upd6").await.unwrap().unwrap();
        // Should only have one instance of the tag
        assert_eq!(retrieved.tags.len(), 1);
        assert_eq!(retrieved.tags[0], "existing");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("No Change Test", Level::Task);
        repo.create("upd7", &task).await.unwrap();

        let updates = TaskUpdate::new();
        assert!(!updates.has_updates());

        // Should not error
        repo.update("upd7", &updates).await.unwrap();

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Delete Test", Level::Task);
        repo.create("del1", &task).await.unwrap();

        assert!(repo.exists("del1").await.unwrap());

        repo.delete("del1").await.unwrap();

        assert!(!repo.exists("del1").await.unwrap());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Should not error when deleting non-existent task
        repo.delete("nonexistent").await.unwrap();

        cleanup(&temp_dir);
    }

    #[test]
    fn test_task_update_builder() {
        let update = TaskUpdate::new()
            .with_title("New Title")
            .with_priority(Priority::High)
            .add_tag("tag1")
            .add_tag("tag2")
            .remove_tag("old");

        assert_eq!(update.title, Some("New Title".to_string()));
        assert_eq!(update.priority, Some(Some(Priority::High)));
        assert_eq!(update.add_tags, vec!["tag1", "tag2"]);
        assert_eq!(update.remove_tags, vec!["old"]);
        assert!(update.has_updates());
    }

    #[test]
    fn test_task_update_default() {
        let update = TaskUpdate::default();

        assert!(update.title.is_none());
        assert!(update.priority.is_none());
        assert!(update.add_tags.is_empty());
        assert!(update.remove_tags.is_empty());
        assert!(!update.has_updates());
    }

    #[tokio::test]
    async fn test_update_needs_human_review_on_task_without_field() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create a task WITHOUT setting needs_human_review (should be null)
        let task = Task::new("Review Test", Level::Task);
        repo.create("nhr1", &task).await.unwrap();

        // Verify the field is null initially
        let retrieved = repo.get("nhr1").await.unwrap().unwrap();
        assert_eq!(
            retrieved.needs_human_review, None,
            "Initially needs_human_review should be None"
        );

        // Update the task to set needs_human_review to true
        let updates = TaskUpdate::new().with_needs_human_review(true);
        repo.update("nhr1", &updates).await.unwrap();

        // Verify the update was successful
        let updated = repo.get("nhr1").await.unwrap().unwrap();
        assert_eq!(
            updated.needs_human_review,
            Some(true),
            "needs_human_review should be true after update"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_needs_human_review_toggle() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create a task with needs_human_review = false
        let task = Task::new("Toggle Test", Level::Task).with_needs_human_review(false);
        repo.create("nhr2", &task).await.unwrap();

        // Update to true
        let updates = TaskUpdate::new().with_needs_human_review(true);
        repo.update("nhr2", &updates).await.unwrap();

        let retrieved = repo.get("nhr2").await.unwrap().unwrap();
        assert_eq!(retrieved.needs_human_review, Some(true));

        // Update back to false
        let updates = TaskUpdate::new().with_needs_human_review(false);
        repo.update("nhr2", &updates).await.unwrap();

        let retrieved = repo.get("nhr2").await.unwrap().unwrap();
        assert_eq!(retrieved.needs_human_review, Some(false));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_assign_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create a task
        let task = Task::new("Assign Workflow Test", Level::Task);
        repo.create("wf1", &task).await.unwrap();

        // Create a workflow_id Thing
        let workflow_id = surrealdb::sql::Thing::from(("workflow", "abc123"));

        // Assign the task to the workflow
        repo.assign_workflow("wf1", &workflow_id).await.unwrap();

        // Verify the task was updated
        let retrieved = repo.get("wf1").await.unwrap().unwrap();
        assert!(
            retrieved.workflow_id.is_some(),
            "Task should have workflow_id"
        );
        assert_eq!(retrieved.current_step, Some(0), "Task should be at step 0");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unassign_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create a task and assign it
        let task = Task::new("Unassign Workflow Test", Level::Task);
        repo.create("wf2", &task).await.unwrap();

        let workflow_id = surrealdb::sql::Thing::from(("workflow", "abc123"));
        repo.assign_workflow("wf2", &workflow_id).await.unwrap();

        // Verify task is assigned
        let retrieved = repo.get("wf2").await.unwrap().unwrap();
        assert!(retrieved.workflow_id.is_some());

        // Unassign the workflow
        repo.unassign_workflow("wf2").await.unwrap();

        // Verify the task was updated
        let retrieved = repo.get("wf2").await.unwrap().unwrap();
        assert!(
            retrieved.workflow_id.is_none(),
            "Task should not have workflow_id after unassign"
        );
        assert!(
            retrieved.current_step.is_none(),
            "Task should not have current_step after unassign"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_description() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Description Test", Level::Task);
        repo.create("desc1", &task).await.unwrap();

        // Update with description
        let updates = TaskUpdate::new().with_description("This is a description");
        repo.update("desc1", &updates).await.unwrap();

        // Verify the description was set
        let retrieved = repo.get("desc1").await.unwrap().unwrap();
        assert_eq!(
            retrieved.description,
            Some("This is a description".to_string())
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_clear_description() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with initial description
        let query = r#"CREATE task:desc2 SET
            title = "Clear Description Test",
            description = "Initial description",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Verify initial description
        let retrieved = repo.get("desc2").await.unwrap().unwrap();
        assert_eq!(
            retrieved.description,
            Some("Initial description".to_string())
        );

        // Clear description
        let updates = TaskUpdate::new().clear_description();
        repo.update("desc2", &updates).await.unwrap();

        // Verify description was cleared
        let retrieved = repo.get("desc2").await.unwrap().unwrap();
        assert!(retrieved.description.is_none());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_task_update_description_builder() {
        let update = TaskUpdate::new().with_description("My description");
        assert_eq!(update.description, Some(Some("My description".to_string())));
        assert!(update.has_updates());

        let update = TaskUpdate::new().clear_description();
        assert_eq!(update.description, Some(None));
        assert!(update.has_updates());
    }

    // ========================================
    // append_ref tests
    // ========================================

    #[tokio::test]
    async fn test_append_ref_to_empty_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task without refs
        let task = Task::new("Ref Test", Level::Task);
        repo.create("ref1", &task).await.unwrap();

        // Append a ref
        let code_ref = CodeRef::file("src/main.rs");
        repo.append_ref("ref1", &code_ref).await.unwrap();

        // Verify the ref was added
        let retrieved = repo.get("ref1").await.unwrap().unwrap();
        assert_eq!(retrieved.code_refs.len(), 1);
        assert_eq!(retrieved.code_refs[0].path, "src/main.rs");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_ref_to_existing_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with initial ref
        let query = r#"CREATE task:ref2 SET
            title = "Multiple Refs Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [],
            refs = [{ path: "src/lib.rs" }]"#;
        db.client().query(query).await.unwrap();

        // Append another ref
        let code_ref = CodeRef::line("src/main.rs", 42);
        repo.append_ref("ref2", &code_ref).await.unwrap();

        // Verify both refs exist
        let retrieved = repo.get("ref2").await.unwrap().unwrap();
        assert_eq!(retrieved.code_refs.len(), 2);
        assert_eq!(retrieved.code_refs[0].path, "src/lib.rs");
        assert_eq!(retrieved.code_refs[1].path, "src/main.rs");
        assert_eq!(retrieved.code_refs[1].line_start, Some(42));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_ref_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task
        let task = Task::new("Timestamp Ref Test", Level::Task);
        repo.create("ref3", &task).await.unwrap();

        // Get initial updated_at (should be None)
        let initial = repo.get("ref3").await.unwrap().unwrap();
        let initial_updated = initial.updated_at;

        // Append a ref
        let code_ref = CodeRef::file("src/test.rs");
        repo.append_ref("ref3", &code_ref).await.unwrap();

        // Verify updated_at was set
        let updated = repo.get("ref3").await.unwrap().unwrap();
        assert!(
            updated.updated_at.is_some(),
            "updated_at should be set after append_ref"
        );
        assert!(
            updated.updated_at != initial_updated,
            "updated_at should change after append_ref"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_ref_with_all_fields() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task
        let task = Task::new("Full Ref Test", Level::Task);
        repo.create("ref4", &task).await.unwrap();

        // Append a ref with all optional fields
        let code_ref = CodeRef::range("src/module.rs", 10, 25)
            .with_name("process_data")
            .with_description("Main data processing function");
        repo.append_ref("ref4", &code_ref).await.unwrap();

        // Verify all fields
        let retrieved = repo.get("ref4").await.unwrap().unwrap();
        assert_eq!(retrieved.code_refs.len(), 1);
        let ref_retrieved = &retrieved.code_refs[0];
        assert_eq!(ref_retrieved.path, "src/module.rs");
        assert_eq!(ref_retrieved.line_start, Some(10));
        assert_eq!(ref_retrieved.line_end, Some(25));
        assert_eq!(ref_retrieved.name, Some("process_data".to_string()));
        assert_eq!(
            ref_retrieved.description,
            Some("Main data processing function".to_string())
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_ref_to_null_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with explicitly null refs
        let query = r#"CREATE task:ref5 SET
            title = "Null Refs Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [],
            refs = NONE"#;
        db.client().query(query).await.unwrap();

        // Append a ref - should work even with null refs
        let code_ref = CodeRef::file("src/null_test.rs");
        repo.append_ref("ref5", &code_ref).await.unwrap();

        // Verify the ref was added
        let retrieved = repo.get("ref5").await.unwrap().unwrap();
        assert_eq!(retrieved.code_refs.len(), 1);
        assert_eq!(retrieved.code_refs[0].path, "src/null_test.rs");

        cleanup(&temp_dir);
    }

    // ========================================
    // append_section_ref tests
    // ========================================

    #[tokio::test]
    async fn test_append_section_ref_to_empty_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a section that has empty refs
        let query = r#"CREATE task:secref1 SET
            title = "Section Ref Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "testing_criterion", content: "Verify something", refs: [] }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Append a ref to the section
        let code_ref = CodeRef::file("src/test.rs");
        repo.append_section_ref("secref1", 0, &code_ref)
            .await
            .unwrap();

        // Verify the ref was added to the section
        let retrieved = repo.get("secref1").await.unwrap().unwrap();
        assert_eq!(retrieved.sections.len(), 1);
        assert_eq!(retrieved.sections[0].refs.len(), 1);
        assert_eq!(retrieved.sections[0].refs[0].path, "src/test.rs");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_section_ref_to_existing_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a section that already has refs
        let query = r#"CREATE task:secref2 SET
            title = "Section Ref Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "testing_criterion", content: "Verify something", refs: [{ path: "src/existing.rs" }] }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Append another ref to the section
        let code_ref = CodeRef::file("src/new.rs");
        repo.append_section_ref("secref2", 0, &code_ref)
            .await
            .unwrap();

        // Verify both refs are present
        let retrieved = repo.get("secref2").await.unwrap().unwrap();
        assert_eq!(retrieved.sections[0].refs.len(), 2);
        assert_eq!(retrieved.sections[0].refs[0].path, "src/existing.rs");
        assert_eq!(retrieved.sections[0].refs[1].path, "src/new.rs");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_section_ref_invalid_section_index() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with one section
        let query = r#"CREATE task:secref3 SET
            title = "Section Ref Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "step", content: "Do something", refs: [] }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Try to append to section index 5 (out of bounds)
        let code_ref = CodeRef::file("src/test.rs");
        let result = repo.append_section_ref("secref3", 5, &code_ref).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(message.contains("out of bounds"));
                assert!(message.contains("5"));
            }
            other => panic!("Expected ValidationError, got: {:?}", other),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_section_ref_task_not_found() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Try to append to nonexistent task
        let code_ref = CodeRef::file("src/test.rs");
        let result = repo.append_section_ref("nonexistent", 0, &code_ref).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            other => panic!("Expected TaskNotFound, got: {:?}", other),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_append_section_ref_to_null_refs() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a section that has no refs field (null/missing)
        let query = r#"CREATE task:secref4 SET
            title = "Section Ref Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "testing_criterion", content: "Test criterion" }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Append a ref - should work even with null refs
        let code_ref = CodeRef::file("src/null_test.rs");
        repo.append_section_ref("secref4", 0, &code_ref)
            .await
            .unwrap();

        // Verify the ref was added to the section
        let retrieved = repo.get("secref4").await.unwrap().unwrap();
        assert_eq!(retrieved.sections[0].refs.len(), 1);
        assert_eq!(retrieved.sections[0].refs[0].path, "src/null_test.rs");

        cleanup(&temp_dir);
    }

    // ========================================
    // remove_section tests
    // ========================================

    #[tokio::test]
    async fn test_remove_section_single() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a single step section
        let query = r#"CREATE task:remsec1 SET
            title = "Remove Section Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "step", content: "Only step", order: 1 }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Remove the only step
        repo.remove_section("remsec1", SectionType::Step, 1)
            .await
            .unwrap();

        // Verify sections is now empty
        let retrieved = repo.get("remsec1").await.unwrap().unwrap();
        assert!(retrieved.sections.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_section_renumbers_ordinals() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with three step sections
        let query = r#"CREATE task:remsec2 SET
            title = "Remove Section Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [
                { type: "step", content: "Step 1", order: 1 },
                { type: "step", content: "Step 2", order: 2 },
                { type: "step", content: "Step 3", order: 3 }
            ],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Remove the middle step (ordinal 2)
        repo.remove_section("remsec2", SectionType::Step, 2)
            .await
            .unwrap();

        // Verify remaining steps are renumbered
        let retrieved = repo.get("remsec2").await.unwrap().unwrap();
        assert_eq!(retrieved.sections.len(), 2);
        assert_eq!(retrieved.sections[0].content, "Step 1");
        assert_eq!(retrieved.sections[0].order, Some(1));
        assert_eq!(retrieved.sections[1].content, "Step 3");
        assert_eq!(retrieved.sections[1].order, Some(2)); // Renumbered from 3 to 2

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_section_preserves_other_types() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with mixed section types
        let query = r#"CREATE task:remsec3 SET
            title = "Remove Section Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [
                { type: "goal", content: "The goal", order: 1 },
                { type: "step", content: "Step 1", order: 1 },
                { type: "step", content: "Step 2", order: 2 },
                { type: "constraint", content: "A constraint", order: 1 }
            ],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Remove step 1
        repo.remove_section("remsec3", SectionType::Step, 1)
            .await
            .unwrap();

        // Verify other section types are unchanged
        let retrieved = repo.get("remsec3").await.unwrap().unwrap();
        assert_eq!(retrieved.sections.len(), 3);

        // Goal should be unchanged
        let goal = retrieved
            .sections
            .iter()
            .find(|s| s.section_type == SectionType::Goal)
            .unwrap();
        assert_eq!(goal.content, "The goal");
        assert_eq!(goal.order, Some(1));

        // Only one step remains, renumbered to 1
        let step = retrieved
            .sections
            .iter()
            .find(|s| s.section_type == SectionType::Step)
            .unwrap();
        assert_eq!(step.content, "Step 2");
        assert_eq!(step.order, Some(1)); // Renumbered from 2 to 1

        // Constraint should be unchanged
        let constraint = retrieved
            .sections
            .iter()
            .find(|s| s.section_type == SectionType::Constraint)
            .unwrap();
        assert_eq!(constraint.content, "A constraint");
        assert_eq!(constraint.order, Some(1));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_section_not_found() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a goal section
        let query = r#"CREATE task:remsec4 SET
            title = "Remove Section Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "goal", content: "The goal", order: 1 }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Try to remove a step that doesn't exist
        let result = repo.remove_section("remsec4", SectionType::Step, 1).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(message.contains("step"));
                assert!(message.contains("1"));
            }
            other => panic!("Expected ValidationError, got: {:?}", other),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_section_wrong_ordinal() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Create task with a step at ordinal 1
        let query = r#"CREATE task:remsec5 SET
            title = "Remove Section Test",
            level = "task",
            status = "in_progress",
            tags = [],
            sections = [{ type: "step", content: "Step 1", order: 1 }],
            refs = []"#;
        db.client().query(query).await.unwrap();

        // Try to remove step at ordinal 5 (doesn't exist)
        let result = repo.remove_section("remsec5", SectionType::Step, 5).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(message.contains("step"));
                assert!(message.contains("5"));
            }
            other => panic!("Expected ValidationError, got: {:?}", other),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_section_task_not_found() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Try to remove section from nonexistent task
        let result = repo
            .remove_section("nonexistent", SectionType::Step, 1)
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            other => panic!("Expected TaskNotFound, got: {:?}", other),
        }

        cleanup(&temp_dir);
    }
}
