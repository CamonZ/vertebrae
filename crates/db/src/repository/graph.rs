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

    /// Get the cycle path for error reporting.
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
    /// A string representing the cycle path (e.g., "A -> B -> C -> A").
    pub async fn get_cycle_path(&self, task_id: &str, depends_on_id: &str) -> DbResult<String> {
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
                    return Ok(path.join(" -> "));
                }

                if visited.insert(dep_id.clone()) {
                    parent_map.insert(dep_id.clone(), current.clone());
                    queue.push_back(dep_id);
                }
            }
        }

        // Fallback if path not found (shouldn't happen if would_create_cycle returned true)
        Ok(format!("{} -> ... -> {}", task_id, depends_on_id))
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
        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;
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
        create_task(&db, "task1", "Final Task", "task", "blocked").await;

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
        create_task(&db, "task1", "Main Task", "task", "blocked").await;

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
        create_task(&db, "task1", "Main Task", "task", "blocked").await;
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
        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

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
        assert!(cycle_path.contains("taska"));
        assert!(cycle_path.contains("taskb"));

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
        create_task(&db, "task1", "Task 1", "task", "blocked").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;

        let blockers = graph.get_incomplete_blockers("task1").await.unwrap();
        assert_eq!(blockers.len(), 1);
        assert!(blockers.contains(&"blocker2".to_string()));

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
}
