//! Graph queries for complex graph traversal operations
//!
//! Provides repository pattern implementation for graph-based queries
//! such as dependency chain traversal, path finding, cycle detection,
//! and descendant collection.

use crate::error::DbResult;
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// Repository for graph-based query operations
///
/// Encapsulates complex graph traversal queries that operate on
/// the task dependency graph (depends_on edges) and hierarchy
/// (child_of edges).
pub struct GraphQueries<'a> {
    client: &'a Surreal<Db>,
}

/// Progress information for a task and its descendants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    /// Number of descendants (including self) that are done.
    pub done_count: usize,
    /// Total number of descendants (including self).
    pub total_count: usize,
    /// Completion percentage (0-100).
    pub percentage: u8,
}

impl Progress {
    /// Create a new Progress with computed percentage.
    pub fn new(done_count: usize, total_count: usize) -> Self {
        let percentage = if total_count == 0 {
            0
        } else {
            ((done_count as f64 / total_count as f64) * 100.0).round() as u8
        };
        Self {
            done_count,
            total_count,
            percentage,
        }
    }

    /// Check if this represents complete progress (100%).
    pub fn is_complete(&self) -> bool {
        self.percentage == 100
    }

    /// Check if this represents no progress (0%).
    pub fn is_empty(&self) -> bool {
        self.percentage == 0
    }
}

/// A node in the blocker tree with full task information
#[derive(Debug, Clone)]
pub struct BlockerNode {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level (epic, ticket, task)
    pub level: String,
    /// Current status
    pub status: String,
    /// Child blockers (tasks that this blocker depends on)
    pub children: Vec<BlockerNode>,
}

/// Row for fetching task info in graph queries
#[derive(Debug, Deserialize)]
struct TaskInfoRow {
    id: surrealdb::sql::Thing,
    title: String,
    level: String,
    status: String,
}

/// Row for fetching task ID only
#[derive(Debug, Deserialize)]
struct TaskIdRow {
    id: surrealdb::sql::Thing,
}

impl<'a> GraphQueries<'a> {
    /// Create a new GraphQueries with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    // ========================================
    // Blocker/Dependency Chain Queries
    // ========================================

    /// Get all blockers for a task as a tree structure.
    ///
    /// Recursively traverses the dependency graph to build a tree of
    /// all tasks blocking the given task, respecting an optional depth limit.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task to find blockers for
    /// * `max_depth` - Optional maximum depth to traverse (None = unlimited)
    ///
    /// # Returns
    ///
    /// A vector of root blocker nodes, each potentially containing children.
    pub async fn get_blockers(
        &self,
        task_id: &str,
        max_depth: Option<usize>,
    ) -> DbResult<Vec<BlockerNode>> {
        self.build_blocker_tree(task_id, 0, max_depth).await
    }

    /// Build the blocker tree recursively.
    ///
    /// Internal method that performs the actual tree construction with
    /// depth tracking.
    async fn build_blocker_tree(
        &self,
        task_id: &str,
        current_depth: usize,
        max_depth: Option<usize>,
    ) -> DbResult<Vec<BlockerNode>> {
        // Check depth limit
        if let Some(max) = max_depth
            && current_depth >= max
        {
            return Ok(vec![]);
        }

        // Get direct blockers (tasks that this task depends on)
        let direct_blockers = self.fetch_direct_blockers(task_id).await?;

        // Build nodes for each direct blocker
        let mut nodes = Vec::new();
        for blocker in direct_blockers {
            let blocker_id = blocker.id.id.to_string();

            // Recursively get children (blockers of this blocker)
            let children =
                Box::pin(self.build_blocker_tree(&blocker_id, current_depth + 1, max_depth))
                    .await?;

            nodes.push(BlockerNode {
                id: blocker_id,
                title: blocker.title,
                level: blocker.level,
                status: blocker.status,
                children,
            });
        }

        Ok(nodes)
    }

    /// Fetch direct blockers for a task (tasks it depends on).
    async fn fetch_direct_blockers(&self, task_id: &str) -> DbResult<Vec<TaskInfoRow>> {
        // Get tasks that this task depends on via the depends_on edge
        let query = format!(
            "SELECT id, title, level, status FROM task WHERE <-depends_on<-task CONTAINS task:{}",
            task_id
        );

        let mut result = self.client.query(&query).await?;
        let blockers: Vec<TaskInfoRow> = result.take(0)?;

        Ok(blockers)
    }

    // ========================================
    // Path Finding Queries
    // ========================================

    /// Find the shortest dependency path between two tasks.
    ///
    /// Uses BFS to traverse the dependency graph following `depends_on`
    /// edges from the source to the target.
    ///
    /// # Arguments
    ///
    /// * `from_id` - The source task ID
    /// * `to_id` - The target task ID
    ///
    /// # Returns
    ///
    /// `Some(path)` if a path exists (list of task IDs from source to target),
    /// `None` if no path exists.
    pub async fn find_path(&self, from_id: &str, to_id: &str) -> DbResult<Option<Vec<String>>> {
        // Handle same task case
        if from_id == to_id {
            return Ok(Some(vec![from_id.to_string()]));
        }

        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent_map: HashMap<String, String> = HashMap::new();

        // Start BFS from the source
        queue.push_back(from_id.to_string());
        visited.insert(from_id.to_string());

        while let Some(current) = queue.pop_front() {
            // Get all tasks that the current task depends on
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = self.client.query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                // If we haven't visited this task yet
                if visited.insert(dep_id.clone()) {
                    // Record the parent for path reconstruction
                    parent_map.insert(dep_id.clone(), current.clone());

                    // If we found the target, reconstruct the path
                    if dep_id == to_id {
                        return Ok(Some(self.reconstruct_path(from_id, to_id, &parent_map)));
                    }

                    queue.push_back(dep_id);
                }
            }
        }

        // No path found
        Ok(None)
    }

    /// Reconstruct the path from source to target using the parent map.
    fn reconstruct_path(
        &self,
        from_id: &str,
        to_id: &str,
        parent_map: &HashMap<String, String>,
    ) -> Vec<String> {
        let mut path = Vec::new();

        // Build path from target to source
        let mut current = to_id.to_string();
        while current != from_id {
            path.push(current.clone());

            if let Some(parent) = parent_map.get(&current) {
                current = parent.clone();
            } else {
                break;
            }
        }

        // Add the source task
        path.push(from_id.to_string());

        // Reverse to get path from source to target
        path.reverse();
        path
    }

    // ========================================
    // Cycle Detection Queries
    // ========================================

    /// Check if creating a dependency would form a cycle.
    ///
    /// A cycle would be created if we can reach `task_id` from `depends_on_id`
    /// by following existing depends_on edges. This means the potential blocker
    /// (directly or transitively) already depends on the task.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task that would depend on another
    /// * `depends_on_id` - The task that would be depended on (the blocker)
    ///
    /// # Returns
    ///
    /// `true` if adding the dependency would create a cycle, `false` otherwise.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Given: A -> B (A depends on B)
    /// // Check: Would B -> A create a cycle?
    /// let would_cycle = graph.would_create_cycle("taskb", "taska").await?;
    /// assert!(would_cycle); // Yes, it would create A -> B -> A
    /// ```
    pub async fn would_create_cycle(&self, task_id: &str, depends_on_id: &str) -> DbResult<bool> {
        // Use BFS to check if we can reach task_id from depends_on_id via depends_on edges.
        // If depends_on_id depends on X, and X depends on Y, and Y depends on task_id,
        // then creating task_id -> depends_on_id would form a cycle.

        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();

        // Start from the potential blocker and traverse its dependencies
        queue.push_back(depends_on_id.to_string());
        visited.insert(depends_on_id.to_string());

        while let Some(current) = queue.pop_front() {
            // Get all tasks that current depends on
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = self.client.query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                // If we can reach task_id from depends_on_id, creating task_id -> depends_on_id
                // would form a cycle
                if dep_id == task_id {
                    return Ok(true);
                }

                // Add to queue if not visited
                if visited.insert(dep_id.clone()) {
                    queue.push_back(dep_id);
                }
            }
        }

        Ok(false)
    }

    /// Get the cycle path that would be created by adding a dependency.
    ///
    /// Uses BFS with parent tracking to reconstruct the path that would
    /// form a cycle if the dependency were created.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task that would depend on another
    /// * `depends_on_id` - The task that would be depended on
    ///
    /// # Returns
    ///
    /// `Some(path)` containing the task IDs forming the cycle if one would be created,
    /// `None` if no cycle would be created.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Given: A -> B -> C (A depends on B, B depends on C)
    /// // Check: What cycle would C -> A create?
    /// let path = graph.get_cycle_path("taskc", "taska").await?;
    /// assert_eq!(path, Some(vec!["taskc", "taska", "taskb", "taskc"]));
    /// ```
    pub async fn get_cycle_path(
        &self,
        task_id: &str,
        depends_on_id: &str,
    ) -> DbResult<Option<Vec<String>>> {
        // Use BFS with parent tracking to find the path from depends_on_id to task_id
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent_map: HashMap<String, String> = HashMap::new();

        queue.push_back(depends_on_id.to_string());
        visited.insert(depends_on_id.to_string());

        while let Some(current) = queue.pop_front() {
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = self.client.query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                if dep_id == task_id {
                    // Found the path - reconstruct it
                    let mut path = vec![task_id.to_string()];
                    let mut curr = current.clone();
                    path.push(curr.clone());

                    while let Some(p) = parent_map.get(&curr) {
                        path.push(p.clone());
                        curr = p.clone();
                    }

                    // Add the starting task_id to complete the cycle representation
                    path.push(task_id.to_string());

                    // Reverse to show task_id -> ... -> depends_on_id -> task_id
                    path.reverse();
                    return Ok(Some(path));
                }

                if visited.insert(dep_id.clone()) {
                    parent_map.insert(dep_id.clone(), current.clone());
                    queue.push_back(dep_id);
                }
            }
        }

        // No cycle would be created
        Ok(None)
    }

    /// Format a cycle path as a human-readable string.
    ///
    /// Converts a vector of task IDs into an arrow-separated path string
    /// suitable for error messages.
    ///
    /// # Arguments
    ///
    /// * `path` - Vector of task IDs forming the cycle
    ///
    /// # Returns
    ///
    /// A string like "task1 -> task2 -> task3 -> task1"
    ///
    /// # Example
    ///
    /// ```ignore
    /// let path = vec!["a".to_string(), "b".to_string(), "c".to_string(), "a".to_string()];
    /// let formatted = GraphQueries::format_cycle_path(&path);
    /// assert_eq!(formatted, "a -> b -> c -> a");
    /// ```
    pub fn format_cycle_path(path: &[String]) -> String {
        path.join(" -> ")
    }

    /// Detect if a task is part of any existing cycle.
    ///
    /// Checks whether the given task participates in a cycle in the current
    /// dependency graph. This differs from `would_create_cycle` which checks
    /// hypothetical cycles from adding a new edge.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task to check for cycle membership
    ///
    /// # Returns
    ///
    /// `Some(path)` if the task is part of a cycle, containing the cycle path.
    /// `None` if the task is not part of any cycle.
    ///
    /// # Note
    ///
    /// In a properly maintained graph with cycle prevention, this should always
    /// return `None`. This method is useful for validation and debugging.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Check if task is in a cycle
    /// if let Some(cycle) = graph.detect_cycle("taska").await? {
    ///     println!("Task is in cycle: {}", GraphQueries::format_cycle_path(&cycle));
    /// }
    /// ```
    pub async fn detect_cycle(&self, task_id: &str) -> DbResult<Option<Vec<String>>> {
        // Use DFS with path tracking to find cycles
        let mut visited = HashSet::new();
        let mut path = Vec::new();
        let mut path_set = HashSet::new();

        self.detect_cycle_dfs(task_id, &mut visited, &mut path, &mut path_set)
            .await
    }

    /// DFS helper for cycle detection.
    ///
    /// Recursively traverses the dependency graph looking for back edges
    /// that indicate cycles.
    async fn detect_cycle_dfs(
        &self,
        current: &str,
        visited: &mut HashSet<String>,
        path: &mut Vec<String>,
        path_set: &mut HashSet<String>,
    ) -> DbResult<Option<Vec<String>>> {
        // If we've seen this node in the current path, we found a cycle
        if path_set.contains(current) {
            // Extract the cycle from the path
            let cycle_start = path.iter().position(|x| x == current).unwrap();
            let mut cycle: Vec<String> = path[cycle_start..].to_vec();
            cycle.push(current.to_string()); // Close the cycle
            return Ok(Some(cycle));
        }

        // If already fully explored, no cycle through this node
        if visited.contains(current) {
            return Ok(None);
        }

        // Mark as in current path and visited
        path.push(current.to_string());
        path_set.insert(current.to_string());
        visited.insert(current.to_string());

        // Get dependencies
        let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
        let mut result = self.client.query(&query).await?;
        let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

        // Recursively check each dependency
        for dep in deps {
            let dep_id = dep.id.to_string();
            if let Some(cycle) =
                Box::pin(self.detect_cycle_dfs(&dep_id, visited, path, path_set)).await?
            {
                return Ok(Some(cycle));
            }
        }

        // Backtrack
        path.pop();
        path_set.remove(current);

        Ok(None)
    }

    // ========================================
    // Hierarchy Traversal Queries
    // ========================================

    /// Get all descendants of a task (children, grandchildren, etc.).
    ///
    /// Recursively collects all tasks in the child_of hierarchy below
    /// the given task.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the parent task
    ///
    /// # Returns
    ///
    /// A vector of all descendant task IDs.
    pub async fn get_all_descendants(&self, task_id: &str) -> DbResult<Vec<String>> {
        let mut all_descendants = Vec::new();
        let mut to_process = vec![task_id.to_string()];

        while let Some(current_id) = to_process.pop() {
            let children = self.fetch_children_ids(&current_id).await?;
            for child_id in children {
                if !all_descendants.contains(&child_id) {
                    all_descendants.push(child_id.clone());
                    to_process.push(child_id);
                }
            }
        }

        Ok(all_descendants)
    }

    /// Fetch IDs of all direct children of a task.
    async fn fetch_children_ids(&self, parent_id: &str) -> DbResult<Vec<String>> {
        // Children are tasks that have a child_of edge pointing to this task
        let query = format!(
            "SELECT id FROM task WHERE ->child_of->task CONTAINS task:{}",
            parent_id
        );

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskIdRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Get the ancestor chain from a task to the root.
    ///
    /// Traverses up the child_of hierarchy to collect all ancestors
    /// in order from immediate parent to root.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task
    ///
    /// # Returns
    ///
    /// A vector of ancestor task IDs, ordered from immediate parent to root.
    pub async fn get_ancestor_chain(&self, task_id: &str) -> DbResult<Vec<String>> {
        let mut ancestors = Vec::new();
        let mut current_id = task_id.to_string();

        // Follow child_of edges upward
        loop {
            let query = format!("SELECT VALUE out FROM task:{}->child_of", current_id);
            let mut result = self.client.query(&query).await?;
            let parents: Vec<surrealdb::sql::Thing> = result.take(0)?;

            match parents.first() {
                Some(parent) => {
                    let parent_id = parent.id.to_string();
                    ancestors.push(parent_id.clone());
                    current_id = parent_id;
                }
                None => break, // No more parents, reached root
            }
        }

        Ok(ancestors)
    }

    // ========================================
    // Utility Queries
    // ========================================

    /// Check if a task has any incomplete children.
    ///
    /// Used to prevent marking a task as done if its children are not done.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task to check
    ///
    /// # Returns
    ///
    /// `true` if the task has children that are not in "done" status.
    pub async fn has_incomplete_children(&self, task_id: &str) -> DbResult<bool> {
        let query = format!(
            r#"SELECT id FROM task
               WHERE ->child_of->task CONTAINS task:{}
               AND status != "done""#,
            task_id
        );

        let mut result = self.client.query(&query).await?;
        let incomplete: Vec<TaskIdRow> = result.take(0)?;

        Ok(!incomplete.is_empty())
    }

    /// Get all incomplete descendants of a task with their information.
    ///
    /// Recursively finds all descendants (children, grandchildren, etc.) that are
    /// not in "done" status. This is used for parent completion validation.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task to check
    ///
    /// # Returns
    ///
    /// A vector of `IncompleteChildInfo` structs containing task details.
    /// Returns an empty vector if all descendants are complete.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Check if an epic can be marked as done
    /// let incomplete = graph.get_incomplete_descendants("epic1").await?;
    /// if !incomplete.is_empty() {
    ///     // Cannot complete - has incomplete children
    ///     for child in &incomplete {
    ///         println!("  - {} ({}) [{}]", child.id, child.title, child.status);
    ///     }
    /// }
    /// ```
    pub async fn get_incomplete_descendants(
        &self,
        task_id: &str,
    ) -> DbResult<Vec<crate::error::IncompleteChildInfo>> {
        // First get all descendants
        let descendants = self.get_all_descendants(task_id).await?;

        if descendants.is_empty() {
            return Ok(vec![]);
        }

        // Build the query to get incomplete descendants with their info
        let ids_quoted: Vec<String> = descendants
            .iter()
            .map(|id| format!("task:{}", id))
            .collect();
        let ids_str = ids_quoted.join(", ");

        let query = format!(
            r#"SELECT id, title, status, level FROM task
               WHERE id IN [{}]
               AND status != "done""#,
            ids_str
        );

        let mut result = self.client.query(&query).await?;
        let incomplete: Vec<TaskInfoRow> = result.take(0)?;

        Ok(incomplete
            .into_iter()
            .map(|row| crate::error::IncompleteChildInfo {
                id: row.id.id.to_string(),
                title: row.title,
                status: row.status,
                level: row.level,
            })
            .collect())
    }

    /// Get all incomplete blockers for a task.
    ///
    /// Returns the IDs of tasks that block this task and are not done.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task to check
    ///
    /// # Returns
    ///
    /// A vector of task IDs that are blocking this task and not complete.
    pub async fn get_incomplete_blockers(&self, task_id: &str) -> DbResult<Vec<String>> {
        let query = format!(
            r#"SELECT id FROM task
               WHERE <-depends_on<-task CONTAINS task:{}
               AND status != "done""#,
            task_id
        );

        let mut result = self.client.query(&query).await?;
        let blockers: Vec<TaskIdRow> = result.take(0)?;

        Ok(blockers.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Get all tasks that depend on the given task and will become unblocked when it's done.
    ///
    /// A task becomes unblocked when ALL its dependencies are done.
    /// This method finds tasks that depend on the current task and checks
    /// if completing this task will make them fully unblocked (i.e., all other dependencies are already done).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task that is being completed
    ///
    /// # Returns
    ///
    /// A vector of (task_id, title) tuples for tasks that will become unblocked.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // If task1 is a blocker for task2 and task3, but task3 has other blockers:
    /// let unblocked = graph.get_unblocked_tasks("task1").await?;
    /// // Returns only task2, not task3 (since task3 has other incomplete dependencies)
    /// ```
    pub async fn get_unblocked_tasks(&self, task_id: &str) -> DbResult<Vec<(String, String)>> {
        // Find all tasks that depend on this task
        let dependents_query = format!(
            "SELECT id, title FROM task WHERE ->depends_on->task CONTAINS task:{}",
            task_id
        );

        #[derive(Debug, Deserialize)]
        struct DependentRow {
            id: surrealdb::sql::Thing,
            title: String,
        }

        let mut result = self.client.query(&dependents_query).await?;
        let dependents: Vec<DependentRow> = result.take(0)?;

        // For each dependent, check if this is their only incomplete dependency
        let mut unblocked = Vec::new();

        for dependent in dependents {
            let dep_id = dependent.id.id.to_string();

            // Count incomplete dependencies for this task (excluding the current task which we're completing)
            let count_query = format!(
                "SELECT count() as cnt FROM task \
                 WHERE <-depends_on<-task CONTAINS task:{} \
                 AND id != task:{} \
                 AND status != 'done'",
                dep_id, task_id
            );

            #[derive(Debug, Deserialize)]
            struct CountResult {
                cnt: i64,
            }

            let mut count_result = self.client.query(&count_query).await?;
            let count: Option<CountResult> = count_result.take(0)?;

            // If no other incomplete dependencies, this task will be unblocked
            if count.is_none() || count.is_some_and(|c| c.cnt == 0) {
                unblocked.push((dep_id, dependent.title));
            }
        }

        Ok(unblocked)
    }

    // ========================================
    // Progress Aggregation
    // ========================================

    /// Get progress information for a task based on its descendants.
    ///
    /// For a leaf task (no children), returns progress based on the task's own status.
    /// For a parent task, recursively counts all descendants and how many are done.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task to get progress for
    ///
    /// # Returns
    ///
    /// A `Progress` struct with done_count, total_count, and percentage.
    ///
    /// # Example
    ///
    /// ```ignore
    /// // Epic with 3 tickets, 2 done, 1 in progress
    /// let progress = graph.get_progress("epic1").await?;
    /// assert_eq!(progress.done_count, 2);
    /// assert_eq!(progress.total_count, 3);
    /// assert_eq!(progress.percentage, 67);
    /// ```
    pub async fn get_progress(&self, task_id: &str) -> DbResult<Progress> {
        // First check if the task has any descendants
        let descendants = self.get_all_descendants(task_id).await?;

        if descendants.is_empty() {
            // Leaf task - progress is based on own status
            let query = format!(r#"SELECT status FROM task:{}"#, task_id);
            let mut result = self.client.query(&query).await?;

            #[derive(Debug, Deserialize)]
            struct StatusRow {
                status: String,
            }

            let rows: Vec<StatusRow> = result.take(0)?;

            let is_done = rows.first().map(|r| r.status == "done").unwrap_or(false);

            if is_done {
                return Ok(Progress::new(1, 1));
            } else {
                return Ok(Progress::new(0, 1));
            }
        }

        // Has descendants - count them efficiently with a single query
        // Get the status of all descendants in one query
        let ids_quoted: Vec<String> = descendants
            .iter()
            .map(|id| format!("task:{}", id))
            .collect();
        let ids_str = ids_quoted.join(", ");

        let query = format!(
            r#"SELECT count() as total,
                      count(status = "done") as done
               FROM task
               WHERE id IN [{}]
               GROUP ALL"#,
            ids_str
        );

        let mut result = self.client.query(&query).await?;

        #[derive(Debug, Deserialize)]
        struct CountRow {
            total: usize,
            done: usize,
        }

        let rows: Vec<CountRow> = result.take(0)?;

        let (done_count, total_count) = rows
            .first()
            .map(|r| (r.done, r.total))
            .unwrap_or((0, descendants.len()));

        Ok(Progress::new(done_count, total_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-graph-test-{}-{:?}-{}",
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

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str, level: &str, status: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                tags = [],
                sections = [],
                refs = []"#,
            id, title, level, status
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, task_id: &str, blocker_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            task_id, blocker_id
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // ========================================
    // get_blockers tests
    // ========================================

    #[tokio::test]
    async fn test_get_blockers_no_blockers() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Independent Task", "task", "todo").await;

        let blockers = graph.get_blockers("task1", None).await.unwrap();
        assert!(blockers.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_blockers_single_blocker() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "blocker1", "Blocker Task", "task", "todo").await;
        create_task(&db, "task1", "Blocked Task", "task", "backlog").await;
        create_depends_on(&db, "task1", "blocker1").await;

        let blockers = graph.get_blockers("task1", None).await.unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].id, "blocker1");
        assert_eq!(blockers[0].title, "Blocker Task");
        assert_eq!(blockers[0].level, "task");
        assert_eq!(blockers[0].status, "todo");
        assert!(blockers[0].children.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_blockers_transitive() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Create chain: task1 -> blocker1 -> blocker2
        create_task(&db, "blocker2", "Root Blocker", "task", "todo").await;
        create_task(&db, "blocker1", "Intermediate Blocker", "task", "todo").await;
        create_task(&db, "task1", "Final Task", "task", "backlog").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "blocker1", "blocker2").await;

        let blockers = graph.get_blockers("task1", None).await.unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].id, "blocker1");
        assert_eq!(blockers[0].children.len(), 1);
        assert_eq!(blockers[0].children[0].id, "blocker2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_blockers_with_depth_limit() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Create chain: task1 -> blocker1 -> blocker2 -> blocker3
        create_task(&db, "blocker3", "Deep Blocker", "task", "todo").await;
        create_task(&db, "blocker2", "Mid Blocker", "task", "todo").await;
        create_task(&db, "blocker1", "Direct Blocker", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "backlog").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "blocker1", "blocker2").await;
        create_depends_on(&db, "blocker2", "blocker3").await;

        // Depth 1: only direct blocker, no children
        let blockers = graph.get_blockers("task1", Some(1)).await.unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].id, "blocker1");
        assert!(blockers[0].children.is_empty());

        // Depth 2: direct blocker with one level of children
        let blockers = graph.get_blockers("task1", Some(2)).await.unwrap();
        assert_eq!(blockers[0].children.len(), 1);
        assert_eq!(blockers[0].children[0].id, "blocker2");
        assert!(blockers[0].children[0].children.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_blockers_depth_zero() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "blocker1", "Blocker", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "backlog").await;
        create_depends_on(&db, "task1", "blocker1").await;

        // Depth 0 should show no blockers
        let blockers = graph.get_blockers("task1", Some(0)).await.unwrap();
        assert!(blockers.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_blockers_multiple_direct() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "blocker1", "Blocker 1", "task", "todo").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "in_progress").await;
        create_task(&db, "task1", "Blocked Task", "task", "backlog").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;

        let blockers = graph.get_blockers("task1", None).await.unwrap();
        assert_eq!(blockers.len(), 2);

        let blocker_ids: HashSet<_> = blockers.iter().map(|b| b.id.as_str()).collect();
        assert!(blocker_ids.contains("blocker1"));
        assert!(blocker_ids.contains("blocker2"));

        cleanup(&temp_dir);
    }

    // ========================================
    // find_path tests
    // ========================================

    #[tokio::test]
    async fn test_find_path_same_task() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;

        let path = graph.find_path("taska", "taska").await.unwrap();
        assert!(path.is_some());
        assert_eq!(path.unwrap(), vec!["taska"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_find_path_direct() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;

        let path = graph.find_path("taska", "taskb").await.unwrap();
        assert!(path.is_some());
        assert_eq!(path.unwrap(), vec!["taska", "taskb"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_find_path_transitive() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Create chain: A -> B -> C
        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_task(&db, "taskc", "Task C", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taskb", "taskc").await;

        let path = graph.find_path("taska", "taskc").await.unwrap();
        assert!(path.is_some());
        assert_eq!(path.unwrap(), vec!["taska", "taskb", "taskc"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_find_path_no_path() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        // No dependency between them

        let path = graph.find_path("taska", "taskb").await.unwrap();
        assert!(path.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_find_path_wrong_direction() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;

        // Path in reverse direction should not exist
        let path = graph.find_path("taskb", "taska").await.unwrap();
        assert!(path.is_none());

        cleanup(&temp_dir);
    }

    // ========================================
    // would_create_cycle tests
    // ========================================

    #[tokio::test]
    async fn test_would_create_cycle_no_cycle() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;

        let would_cycle = graph.would_create_cycle("taska", "taskb").await.unwrap();
        assert!(!would_cycle);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_would_create_cycle_direct() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;

        // Creating B -> A would create a cycle (A -> B -> A)
        let would_cycle = graph.would_create_cycle("taskb", "taska").await.unwrap();
        assert!(would_cycle);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_would_create_cycle_transitive() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_task(&db, "taskc", "Task C", "task", "todo").await;

        // A depends on B, B depends on C
        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taskb", "taskc").await;

        // Creating C -> A would create a transitive cycle
        let would_cycle = graph.would_create_cycle("taskc", "taska").await.unwrap();
        assert!(would_cycle);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_cycle_path() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;

        let cycle_path = graph.get_cycle_path("taskb", "taska").await.unwrap();
        assert!(cycle_path.is_some());
        let path = cycle_path.unwrap();
        assert!(path.contains(&"taska".to_string()));
        assert!(path.contains(&"taskb".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_cycle_path_no_cycle() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        // No dependencies

        let cycle_path = graph.get_cycle_path("taska", "taskb").await.unwrap();
        assert!(cycle_path.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_cycle_path_transitive() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_task(&db, "taskc", "Task C", "task", "todo").await;

        // A depends on B, B depends on C
        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taskb", "taskc").await;

        // Creating C -> A would create cycle: C -> A -> B -> C
        let cycle_path = graph.get_cycle_path("taskc", "taska").await.unwrap();
        assert!(cycle_path.is_some());
        let path = cycle_path.unwrap();
        assert_eq!(path.len(), 4); // C -> A -> B -> C
        assert!(path.contains(&"taska".to_string()));
        assert!(path.contains(&"taskb".to_string()));
        assert!(path.contains(&"taskc".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_format_cycle_path() {
        let path = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "a".to_string(),
        ];
        let formatted = GraphQueries::format_cycle_path(&path);
        assert_eq!(formatted, "a -> b -> c -> a");
    }

    #[tokio::test]
    async fn test_detect_cycle_no_cycle() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_depends_on(&db, "taska", "taskb").await;

        // No cycle in this graph
        let cycle = graph.detect_cycle("taska").await.unwrap();
        assert!(cycle.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_detect_cycle_no_dependencies() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "taska", "Task A", "task", "todo").await;

        // No dependencies at all
        let cycle = graph.detect_cycle("taska").await.unwrap();
        assert!(cycle.is_none());

        cleanup(&temp_dir);
    }

    // ========================================
    // get_all_descendants tests
    // ========================================

    #[tokio::test]
    async fn test_get_all_descendants_none() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent Task", "epic", "todo").await;

        let descendants = graph.get_all_descendants("parent").await.unwrap();
        assert!(descendants.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_all_descendants_direct_children() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "epic", "todo").await;
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "todo").await;

        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;

        let descendants = graph.get_all_descendants("parent").await.unwrap();
        assert_eq!(descendants.len(), 2);
        assert!(descendants.contains(&"child1".to_string()));
        assert!(descendants.contains(&"child2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_all_descendants_deep_hierarchy() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Create: parent -> child -> grandchild
        create_task(&db, "parent", "Parent", "epic", "todo").await;
        create_task(&db, "child", "Child", "ticket", "todo").await;
        create_task(&db, "grandchild", "Grandchild", "task", "todo").await;

        create_child_of(&db, "child", "parent").await;
        create_child_of(&db, "grandchild", "child").await;

        let descendants = graph.get_all_descendants("parent").await.unwrap();
        assert_eq!(descendants.len(), 2);
        assert!(descendants.contains(&"child".to_string()));
        assert!(descendants.contains(&"grandchild".to_string()));

        cleanup(&temp_dir);
    }

    // ========================================
    // get_ancestor_chain tests
    // ========================================

    #[tokio::test]
    async fn test_get_ancestor_chain_no_parent() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "root", "Root Task", "epic", "todo").await;

        let ancestors = graph.get_ancestor_chain("root").await.unwrap();
        assert!(ancestors.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_ancestor_chain_single_parent() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "epic", "todo").await;
        create_task(&db, "child", "Child", "ticket", "todo").await;
        create_child_of(&db, "child", "parent").await;

        let ancestors = graph.get_ancestor_chain("child").await.unwrap();
        assert_eq!(ancestors, vec!["parent"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_ancestor_chain_multiple_levels() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "grandparent", "Grandparent", "epic", "todo").await;
        create_task(&db, "parent", "Parent", "ticket", "todo").await;
        create_task(&db, "child", "Child", "task", "todo").await;

        create_child_of(&db, "parent", "grandparent").await;
        create_child_of(&db, "child", "parent").await;

        let ancestors = graph.get_ancestor_chain("child").await.unwrap();
        assert_eq!(ancestors, vec!["parent", "grandparent"]);

        cleanup(&temp_dir);
    }

    // ========================================
    // has_incomplete_children tests
    // ========================================

    #[tokio::test]
    async fn test_has_incomplete_children_no_children() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "epic", "todo").await;

        let has_incomplete = graph.has_incomplete_children("parent").await.unwrap();
        assert!(!has_incomplete);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_has_incomplete_children_all_complete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "epic", "in_progress").await;
        create_task(&db, "child1", "Child 1", "ticket", "done").await;
        create_task(&db, "child2", "Child 2", "ticket", "done").await;

        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;

        let has_incomplete = graph.has_incomplete_children("parent").await.unwrap();
        assert!(!has_incomplete);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_has_incomplete_children_some_incomplete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "epic", "in_progress").await;
        create_task(&db, "child1", "Child 1", "ticket", "done").await;
        create_task(&db, "child2", "Child 2", "ticket", "todo").await;

        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;

        let has_incomplete = graph.has_incomplete_children("parent").await.unwrap();
        assert!(has_incomplete);

        cleanup(&temp_dir);
    }

    // ========================================
    // get_incomplete_blockers tests
    // ========================================

    #[tokio::test]
    async fn test_get_incomplete_blockers_none() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Task 1", "task", "todo").await;

        let blockers = graph.get_incomplete_blockers("task1").await.unwrap();
        assert!(blockers.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_blockers_all_complete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "blocker1", "Blocker 1", "task", "done").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "done").await;
        create_task(&db, "task1", "Task 1", "task", "todo").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;

        let blockers = graph.get_incomplete_blockers("task1").await.unwrap();
        assert!(blockers.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_blockers_some_incomplete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "blocker1", "Blocker 1", "task", "done").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "in_progress").await;
        create_task(&db, "task1", "Task 1", "task", "backlog").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;

        let blockers = graph.get_incomplete_blockers("task1").await.unwrap();
        assert_eq!(blockers.len(), 1);
        assert!(blockers.contains(&"blocker2".to_string()));

        cleanup(&temp_dir);
    }

    // ========================================
    // get_incomplete_descendants tests
    // ========================================

    #[tokio::test]
    async fn test_get_incomplete_descendants_no_children() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Task 1", "task", "todo").await;

        let incomplete = graph.get_incomplete_descendants("task1").await.unwrap();
        assert!(incomplete.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_descendants_all_complete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "ticket", "in_progress").await;
        create_task(&db, "child1", "Child 1", "task", "done").await;
        create_task(&db, "child2", "Child 2", "task", "done").await;

        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;

        let incomplete = graph.get_incomplete_descendants("parent").await.unwrap();
        assert!(incomplete.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_descendants_some_incomplete() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent", "ticket", "in_progress").await;
        create_task(&db, "child1", "Child 1", "task", "done").await;
        create_task(&db, "child2", "Child 2", "task", "todo").await;
        create_task(&db, "child3", "Child 3", "task", "backlog").await;

        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;
        create_child_of(&db, "child3", "parent").await;

        let incomplete = graph.get_incomplete_descendants("parent").await.unwrap();
        assert_eq!(incomplete.len(), 2);

        let incomplete_ids: HashSet<_> = incomplete.iter().map(|c| c.id.as_str()).collect();
        assert!(incomplete_ids.contains("child2"));
        assert!(incomplete_ids.contains("child3"));
        assert!(!incomplete_ids.contains("child1"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_descendants_nested_hierarchy() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Epic -> Ticket -> Tasks (nested hierarchy)
        create_task(&db, "epic", "Epic", "epic", "in_progress").await;
        create_task(&db, "ticket", "Ticket", "ticket", "in_progress").await;
        create_task(&db, "task1", "Task 1", "task", "done").await;
        create_task(&db, "task2", "Task 2", "task", "todo").await;

        create_child_of(&db, "ticket", "epic").await;
        create_child_of(&db, "task1", "ticket").await;
        create_child_of(&db, "task2", "ticket").await;

        // Epic should see both ticket and task2 as incomplete
        let incomplete = graph.get_incomplete_descendants("epic").await.unwrap();
        assert_eq!(incomplete.len(), 2);

        let incomplete_ids: HashSet<_> = incomplete.iter().map(|c| c.id.as_str()).collect();
        assert!(
            incomplete_ids.contains("ticket"),
            "ticket should be incomplete"
        );
        assert!(
            incomplete_ids.contains("task2"),
            "task2 should be incomplete"
        );
        assert!(
            !incomplete_ids.contains("task1"),
            "task1 should not be in incomplete list"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_descendants_returns_correct_info() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "parent", "Parent Epic", "epic", "in_progress").await;
        create_task(&db, "child", "Incomplete Child", "ticket", "backlog").await;

        create_child_of(&db, "child", "parent").await;

        let incomplete = graph.get_incomplete_descendants("parent").await.unwrap();
        assert_eq!(incomplete.len(), 1);

        let child = &incomplete[0];
        assert_eq!(child.id, "child");
        assert_eq!(child.title, "Incomplete Child");
        assert_eq!(child.status, "backlog");
        assert_eq!(child.level, "ticket");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_incomplete_descendants_deep_nesting() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Create a 4-level deep hierarchy
        create_task(&db, "epic", "Epic", "epic", "in_progress").await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "done").await;
        create_task(&db, "ticket2", "Ticket 2", "ticket", "in_progress").await;
        create_task(&db, "task1", "Task 1", "task", "done").await;
        create_task(&db, "task2", "Task 2", "task", "todo").await;

        create_child_of(&db, "ticket1", "epic").await;
        create_child_of(&db, "ticket2", "epic").await;
        create_child_of(&db, "task1", "ticket2").await;
        create_child_of(&db, "task2", "ticket2").await;

        // Epic should see ticket2 and task2 as incomplete (ticket1 and task1 are done)
        let incomplete = graph.get_incomplete_descendants("epic").await.unwrap();
        assert_eq!(incomplete.len(), 2);

        let incomplete_ids: HashSet<_> = incomplete.iter().map(|c| c.id.as_str()).collect();
        assert!(incomplete_ids.contains("ticket2"));
        assert!(incomplete_ids.contains("task2"));
        assert!(!incomplete_ids.contains("ticket1"));
        assert!(!incomplete_ids.contains("task1"));

        cleanup(&temp_dir);
    }

    // ========================================
    // Additional edge cases
    // ========================================

    #[tokio::test]
    async fn test_blocker_node_clone() {
        let node = BlockerNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            children: vec![],
        };

        let cloned = node.clone();
        assert_eq!(cloned.id, "test");
        assert_eq!(cloned.title, "Test");
        assert_eq!(cloned.level, "task");
        assert_eq!(cloned.status, "todo");
    }

    #[tokio::test]
    async fn test_blocker_node_debug() {
        let node = BlockerNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            children: vec![],
        };

        let debug_str = format!("{:?}", node);
        assert!(debug_str.contains("BlockerNode"));
        assert!(debug_str.contains("test"));
    }

    #[tokio::test]
    async fn test_diamond_dependency_graph() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Diamond: A -> (B, C) -> D
        create_task(&db, "taska", "Task A", "task", "todo").await;
        create_task(&db, "taskb", "Task B", "task", "todo").await;
        create_task(&db, "taskc", "Task C", "task", "todo").await;
        create_task(&db, "taskd", "Task D", "task", "todo").await;

        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taska", "taskc").await;
        create_depends_on(&db, "taskb", "taskd").await;
        create_depends_on(&db, "taskc", "taskd").await;

        // A should have path to D
        let path = graph.find_path("taska", "taskd").await.unwrap();
        assert!(path.is_some());
        let path = path.unwrap();
        assert_eq!(path.len(), 3); // A -> B/C -> D
        assert_eq!(path[0], "taska");
        assert_eq!(path[2], "taskd");

        cleanup(&temp_dir);
    }

    // ========================================
    // Progress tests
    // ========================================

    #[test]
    fn test_progress_new() {
        let progress = Progress::new(2, 5);
        assert_eq!(progress.done_count, 2);
        assert_eq!(progress.total_count, 5);
        assert_eq!(progress.percentage, 40);
    }

    #[test]
    fn test_progress_new_zero_total() {
        let progress = Progress::new(0, 0);
        assert_eq!(progress.percentage, 0);
    }

    #[test]
    fn test_progress_new_all_done() {
        let progress = Progress::new(5, 5);
        assert_eq!(progress.percentage, 100);
        assert!(progress.is_complete());
        assert!(!progress.is_empty());
    }

    #[test]
    fn test_progress_new_none_done() {
        let progress = Progress::new(0, 5);
        assert_eq!(progress.percentage, 0);
        assert!(!progress.is_complete());
        assert!(progress.is_empty());
    }

    #[test]
    fn test_progress_rounding() {
        // 2/3 = 66.67% -> rounds to 67%
        let progress = Progress::new(2, 3);
        assert_eq!(progress.percentage, 67);

        // 1/3 = 33.33% -> rounds to 33%
        let progress = Progress::new(1, 3);
        assert_eq!(progress.percentage, 33);
    }

    #[test]
    fn test_progress_clone_and_eq() {
        let p1 = Progress::new(3, 5);
        let p2 = p1.clone();
        assert_eq!(p1, p2);
    }

    #[test]
    fn test_progress_debug() {
        let progress = Progress::new(2, 5);
        let debug = format!("{:?}", progress);
        assert!(debug.contains("Progress"));
        assert!(debug.contains("done_count: 2"));
    }

    #[tokio::test]
    async fn test_get_progress_leaf_task_done() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Task 1", "task", "done").await;

        let progress = graph.get_progress("task1").await.unwrap();
        assert_eq!(progress.done_count, 1);
        assert_eq!(progress.total_count, 1);
        assert_eq!(progress.percentage, 100);
        assert!(progress.is_complete());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_leaf_task_not_done() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Task 1", "task", "todo").await;

        let progress = graph.get_progress("task1").await.unwrap();
        assert_eq!(progress.done_count, 0);
        assert_eq!(progress.total_count, 1);
        assert_eq!(progress.percentage, 0);
        assert!(progress.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_leaf_task_in_progress() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "task1", "Task 1", "task", "in_progress").await;

        let progress = graph.get_progress("task1").await.unwrap();
        assert_eq!(progress.done_count, 0);
        assert_eq!(progress.total_count, 1);
        assert_eq!(progress.percentage, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_epic_with_tickets() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Epic with 3 tickets: 2 done, 1 todo
        create_task(&db, "epic1", "Epic 1", "epic", "in_progress").await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "done").await;
        create_task(&db, "ticket2", "Ticket 2", "ticket", "done").await;
        create_task(&db, "ticket3", "Ticket 3", "ticket", "todo").await;

        create_child_of(&db, "ticket1", "epic1").await;
        create_child_of(&db, "ticket2", "epic1").await;
        create_child_of(&db, "ticket3", "epic1").await;

        let progress = graph.get_progress("epic1").await.unwrap();
        assert_eq!(progress.done_count, 2);
        assert_eq!(progress.total_count, 3);
        assert_eq!(progress.percentage, 67);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_all_descendants_done() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Ticket with 4 tasks all done
        create_task(&db, "ticket1", "Ticket 1", "ticket", "in_progress").await;
        create_task(&db, "task1", "Task 1", "task", "done").await;
        create_task(&db, "task2", "Task 2", "task", "done").await;
        create_task(&db, "task3", "Task 3", "task", "done").await;
        create_task(&db, "task4", "Task 4", "task", "done").await;

        create_child_of(&db, "task1", "ticket1").await;
        create_child_of(&db, "task2", "ticket1").await;
        create_child_of(&db, "task3", "ticket1").await;
        create_child_of(&db, "task4", "ticket1").await;

        let progress = graph.get_progress("ticket1").await.unwrap();
        assert_eq!(progress.done_count, 4);
        assert_eq!(progress.total_count, 4);
        assert_eq!(progress.percentage, 100);
        assert!(progress.is_complete());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_nested_descendants() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        // Epic -> Ticket -> Task (all counted)
        create_task(&db, "epic1", "Epic 1", "epic", "in_progress").await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "done").await;
        create_task(&db, "task1", "Task 1", "task", "done").await;
        create_task(&db, "task2", "Task 2", "task", "todo").await;

        create_child_of(&db, "ticket1", "epic1").await;
        create_child_of(&db, "task1", "ticket1").await;
        create_child_of(&db, "task2", "ticket1").await;

        // Epic has 3 descendants: ticket1 (done), task1 (done), task2 (todo)
        let progress = graph.get_progress("epic1").await.unwrap();
        assert_eq!(progress.total_count, 3);
        assert_eq!(progress.done_count, 2);
        assert_eq!(progress.percentage, 67);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_progress_no_descendants_done() {
        let (db, temp_dir) = setup_test_db().await;
        let graph = GraphQueries::new(db.client());

        create_task(&db, "epic1", "Epic 1", "epic", "todo").await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "todo").await;
        create_task(&db, "ticket2", "Ticket 2", "ticket", "backlog").await;

        create_child_of(&db, "ticket1", "epic1").await;
        create_child_of(&db, "ticket2", "epic1").await;

        let progress = graph.get_progress("epic1").await.unwrap();
        assert_eq!(progress.done_count, 0);
        assert_eq!(progress.total_count, 2);
        assert_eq!(progress.percentage, 0);
        assert!(progress.is_empty());

        cleanup(&temp_dir);
    }
}
