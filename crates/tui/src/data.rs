//! Data loading for the TUI.
//!
//! Provides functions to load tasks from the database and convert them
//! to tree structures for the navigation panel.

use std::collections::HashMap;

use vertebrae_db::{
    Database, GraphQueries, Level, RelationshipRepository, TaskFilter, TaskLister, TaskRepository,
    TaskSummary,
};

use crate::details::{TaskDetails, TaskRelationships};
use crate::error::TuiResult;
use crate::navigation::TreeNode;
use crate::timeline::TimelineTask;

// Re-export needed for TimelineTaskRow deserialization
use surrealdb;

/// Load all root tasks (epics with no parent) from the database.
pub async fn load_root_tasks(db: &Database) -> TuiResult<Vec<TaskSummary>> {
    let lister = TaskLister::new(db.client());
    let filter = TaskFilter::new()
        .root_only()
        .with_level(Level::Epic)
        .include_done();

    let tasks = lister.list(&filter).await?;
    Ok(tasks)
}

/// Load children of a specific task.
pub async fn load_children(db: &Database, parent_id: &str) -> TuiResult<Vec<TaskSummary>> {
    let lister = TaskLister::new(db.client());
    let filter = TaskFilter::new().children_of(parent_id).include_done();

    let tasks = lister.list(&filter).await?;
    Ok(tasks)
}

/// Convert a TaskSummary to a TreeNode (without children initially).
fn task_to_node(task: &TaskSummary) -> TreeNode {
    TreeNode::new(&task.id, &task.title, task.level.clone()).with_status(task.status.clone())
}

/// Load the complete task tree from the database.
///
/// This loads all epics, tickets, and tasks and builds a full tree structure.
/// For large databases, consider using lazy loading instead.
pub async fn load_full_tree(db: &Database) -> TuiResult<Vec<TreeNode>> {
    // Load all tasks at once (more efficient than multiple queries)
    let lister = TaskLister::new(db.client());
    let filter = TaskFilter::new().include_done();
    let all_tasks = lister.list(&filter).await?;

    if all_tasks.is_empty() {
        return Ok(Vec::new());
    }

    // Build a map of task_id -> TaskSummary for quick lookup
    let task_map: HashMap<String, &TaskSummary> =
        all_tasks.iter().map(|t| (t.id.clone(), t)).collect();

    // Load parent-child relationships
    // We need to query children for each task
    let mut children_map: HashMap<String, Vec<String>> = HashMap::new();

    for task in &all_tasks {
        let children = load_children(db, &task.id).await?;
        if !children.is_empty() {
            children_map.insert(
                task.id.clone(),
                children.iter().map(|c| c.id.clone()).collect(),
            );
        }
    }

    // Find root tasks (those that are not children of any other task)
    let all_child_ids: std::collections::HashSet<String> =
        children_map.values().flatten().cloned().collect();

    let root_ids: Vec<String> = all_tasks
        .iter()
        .filter(|t| !all_child_ids.contains(&t.id))
        .map(|t| t.id.clone())
        .collect();

    // Build tree recursively
    let mut roots: Vec<TreeNode> = Vec::with_capacity(root_ids.len());
    for id in &root_ids {
        if let Some(task) = task_map.get(id) {
            let node = build_tree_node_with_progress(db, task, &task_map, &children_map).await?;
            roots.push(node);
        }
    }

    Ok(roots)
}

/// Recursively build a TreeNode with its children and progress.
async fn build_tree_node_with_progress(
    db: &Database,
    task: &TaskSummary,
    task_map: &HashMap<String, &TaskSummary>,
    children_map: &HashMap<String, Vec<String>>,
) -> TuiResult<TreeNode> {
    let mut node = task_to_node(task);

    if let Some(child_ids) = children_map.get(&task.id) {
        let mut children: Vec<TreeNode> = Vec::with_capacity(child_ids.len());
        for id in child_ids {
            if let Some(child) = task_map.get(id) {
                let child_node = Box::pin(build_tree_node_with_progress(
                    db,
                    child,
                    task_map,
                    children_map,
                ))
                .await?;
                children.push(child_node);
            }
        }

        node = node.with_children(children);

        // Load progress for nodes with children
        let graph = GraphQueries::new(db.client());
        let progress = graph.get_progress(&task.id).await?;
        node = node.with_progress(progress);
    }

    Ok(node)
}

/// Load root epics only (for lazy loading).
///
/// Returns TreeNode objects with has_children set correctly but without
/// actually loading the children. Children can be loaded on-demand when
/// a node is expanded.
pub async fn load_root_epics_lazy(db: &Database) -> TuiResult<Vec<TreeNode>> {
    let roots = load_root_tasks(db).await?;
    let graph = GraphQueries::new(db.client());

    let mut nodes = Vec::with_capacity(roots.len());

    for root in &roots {
        let mut node = task_to_node(root);

        // Check if this task has children
        let children = load_children(db, &root.id).await?;
        if !children.is_empty() {
            // Add placeholder children so has_children() returns true
            // These will be replaced when the node is expanded
            node = node.with_children(children.iter().map(task_to_node).collect::<Vec<_>>());

            // Load progress for nodes with children
            let progress = graph.get_progress(&root.id).await?;
            node = node.with_progress(progress);
        }

        nodes.push(node);
    }

    Ok(nodes)
}

/// Refresh children of a specific node in the tree.
///
/// This is used for lazy loading - when a node is expanded, we load
/// its children from the database.
pub async fn load_node_children(db: &Database, node_id: &str) -> TuiResult<Vec<TreeNode>> {
    let children = load_children(db, node_id).await?;
    let graph = GraphQueries::new(db.client());

    let mut nodes = Vec::with_capacity(children.len());

    for child in &children {
        let mut node = task_to_node(child);

        // Check if this child has its own children
        let grandchildren = load_children(db, &child.id).await?;
        if !grandchildren.is_empty() {
            node = node.with_children(grandchildren.iter().map(task_to_node).collect::<Vec<_>>());

            // Load progress for nodes with children
            let progress = graph.get_progress(&child.id).await?;
            node = node.with_progress(progress);
        }

        nodes.push(node);
    }

    Ok(nodes)
}

/// Load full task details including relationships for the details view.
///
/// This function fetches the complete task data along with parent and
/// dependency relationships for display in the details panel.
///
/// # Arguments
///
/// * `db` - Database connection
/// * `task_id` - The ID of the task to load
///
/// # Returns
///
/// `Some(TaskDetails)` if the task exists, `None` otherwise.
pub async fn load_task_details(db: &Database, task_id: &str) -> TuiResult<Option<TaskDetails>> {
    let task_repo = TaskRepository::new(db.client());
    let rel_repo = RelationshipRepository::new(db.client());
    let graph = GraphQueries::new(db.client());

    // Load the task
    let task = match task_repo.get(task_id).await? {
        Some(t) => t,
        None => return Ok(None),
    };

    // Load parent relationship
    let parent = if let Some(parent_id) = rel_repo.get_parent(task_id).await? {
        // Get parent title
        if let Some(parent_task) = task_repo.get(&parent_id).await? {
            Some((parent_id, parent_task.title))
        } else {
            Some((parent_id, "Unknown".to_string()))
        }
    } else {
        None
    };

    // Load dependencies (tasks this task depends on / blocked by)
    let dependency_ids = rel_repo.get_dependencies(task_id).await?;
    let mut blocked_by = Vec::new();
    for dep_id in dependency_ids {
        if let Some(dep_task) = task_repo.get(&dep_id).await? {
            blocked_by.push((dep_id, dep_task.title));
        } else {
            blocked_by.push((dep_id, "Unknown".to_string()));
        }
    }

    // Load dependents (tasks that depend on this task / blocks)
    let dependent_ids = rel_repo.get_dependents(task_id).await?;
    let mut blocks = Vec::new();
    for dep_id in dependent_ids {
        if let Some(dep_task) = task_repo.get(&dep_id).await? {
            blocks.push((dep_id, dep_task.title));
        } else {
            blocks.push((dep_id, "Unknown".to_string()));
        }
    }

    let relationships = TaskRelationships {
        parent,
        blocked_by,
        blocks,
    };

    // Load progress (only meaningful for tasks with children)
    let progress = {
        let p = graph.get_progress(task_id).await?;
        // Only include progress if total_count > 1 (meaning task has children)
        // A leaf task returns total_count = 1 (itself)
        if p.total_count > 1 { Some(p) } else { None }
    };

    Ok(Some(TaskDetails {
        task,
        id: task_id.to_string(),
        relationships,
        progress,
    }))
}

/// Row type for timeline task query
#[derive(Debug, serde::Deserialize)]
struct TimelineTaskRow {
    id: surrealdb::sql::Thing,
    title: String,
    status: vertebrae_db::Status,
    started_at: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Load all tasks that have been started for the timeline view.
///
/// Only returns tasks where `started_at` is set. Tasks are sorted by
/// their start time (oldest first).
///
/// # Arguments
///
/// * `db` - Database connection
///
/// # Returns
///
/// A vector of `TimelineTask` objects for tasks that have been started.
pub async fn load_timeline_tasks(db: &Database) -> TuiResult<Vec<TimelineTask>> {
    let rel_repo = RelationshipRepository::new(db.client());

    // Query tasks with started_at directly from the database
    // The TaskRepository.get() doesn't include started_at/completed_at
    // Note: In SurrealDB, we need to check both that the field exists AND is not None
    let query = "SELECT id, title, status, started_at, completed_at \
                 FROM task WHERE started_at != NONE";

    let mut result = db.client().query(query).await?;
    let rows: Vec<TimelineTaskRow> = result.take(0)?;

    let mut timeline_tasks = Vec::new();

    for row in rows {
        // Extract ID from the Thing type
        let id = row.id.id.to_string();

        // Check if this task has dependencies
        let dependencies = rel_repo.get_dependencies(&id).await?;
        let has_dependencies = !dependencies.is_empty();

        timeline_tasks.push(TimelineTask {
            id,
            title: row.title,
            status: row.status,
            started_at: row.started_at,
            completed_at: row.completed_at,
            has_dependencies,
        });
    }

    // Sort by start time (oldest first)
    timeline_tasks.sort_by_key(|t| t.started_at);

    Ok(timeline_tasks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use vertebrae_db::{Level, Status, Task};

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-data-test-{}-{:?}-{}",
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

    /// Helper to create a task and add parent relationship
    async fn create_task_with_parent(
        db: &Database,
        id: &str,
        title: &str,
        level: Level,
        parent_id: Option<&str>,
    ) {
        let repo = TaskRepository::new(db.client());
        let task = Task::new(title, level);
        repo.create(id, &task).await.unwrap();

        if let Some(parent) = parent_id {
            let query = format!("RELATE task:{} -> child_of -> task:{}", id, parent);
            db.client().query(&query).await.unwrap();
        }
    }

    #[tokio::test]
    async fn test_load_root_tasks_empty_db() {
        let (db, temp_dir) = setup_test_db().await;

        let roots = load_root_tasks(&db).await.unwrap();
        assert!(roots.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_root_tasks_with_epics() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "epic2", "Epic 2", Level::Epic, None).await;

        let roots = load_root_tasks(&db).await.unwrap();
        assert_eq!(roots.len(), 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_children() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Ticket 1", Level::Ticket, Some("epic1")).await;
        create_task_with_parent(&db, "ticket2", "Ticket 2", Level::Ticket, Some("epic1")).await;

        let children = load_children(&db, "epic1").await.unwrap();
        assert_eq!(children.len(), 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_full_tree() {
        let (db, temp_dir) = setup_test_db().await;

        // Create hierarchy: epic -> ticket -> task
        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Ticket 1", Level::Ticket, Some("epic1")).await;
        create_task_with_parent(&db, "task1", "Task 1", Level::Task, Some("ticket1")).await;

        let tree = load_full_tree(&db).await.unwrap();

        assert_eq!(tree.len(), 1); // One root epic
        assert_eq!(tree[0].id, "epic1");
        assert_eq!(tree[0].children.len(), 1); // One ticket
        assert_eq!(tree[0].children[0].id, "ticket1");
        assert_eq!(tree[0].children[0].children.len(), 1); // One task
        assert_eq!(tree[0].children[0].children[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_full_tree_empty() {
        let (db, temp_dir) = setup_test_db().await;

        let tree = load_full_tree(&db).await.unwrap();
        assert!(tree.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_to_node_preserves_fields() {
        let summary = TaskSummary {
            id: "test123".to_string(),
            title: "Test Task".to_string(),
            level: Level::Ticket,
            status: Status::InProgress,
            priority: None,
            tags: vec![],
        };

        let node = task_to_node(&summary);

        assert_eq!(node.id, "test123");
        assert_eq!(node.title, "Test Task");
        assert_eq!(node.level, Level::Ticket);
        assert_eq!(node.status, Status::InProgress);
    }

    #[tokio::test]
    async fn test_load_root_epics_lazy() {
        let (db, temp_dir) = setup_test_db().await;

        // Create epic with children
        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Ticket 1", Level::Ticket, Some("epic1")).await;

        let roots = load_root_epics_lazy(&db).await.unwrap();

        assert_eq!(roots.len(), 1);
        assert!(roots[0].has_children());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_tree_node_with_3_epics_shows_exactly_3() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "epic2", "Epic 2", Level::Epic, None).await;
        create_task_with_parent(&db, "epic3", "Epic 3", Level::Epic, None).await;

        let tree = load_full_tree(&db).await.unwrap();
        assert_eq!(tree.len(), 3);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_expanding_epic_with_2_tickets_shows_2_children() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "Epic 1", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Ticket 1", Level::Ticket, Some("epic1")).await;
        create_task_with_parent(&db, "ticket2", "Ticket 2", Level::Ticket, Some("epic1")).await;

        let tree = load_full_tree(&db).await.unwrap();

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_tree_node_id_matches_task_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "myepic", "My Epic", Level::Epic, None).await;

        let tree = load_full_tree(&db).await.unwrap();
        assert_eq!(tree[0].id, "myepic");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_tree_node_title_matches_task_title() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "My Custom Epic Title", Level::Epic, None).await;

        let tree = load_full_tree(&db).await.unwrap();
        assert_eq!(tree[0].title, "My Custom Epic Title");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_not_found() {
        let (db, temp_dir) = setup_test_db().await;

        let details = load_task_details(&db, "nonexistent").await.unwrap();
        assert!(details.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_basic() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "task1", "My Task", Level::Task, None).await;

        let details = load_task_details(&db, "task1").await.unwrap();
        assert!(details.is_some());
        let details = details.unwrap();
        assert_eq!(details.id, "task1");
        assert_eq!(details.task.title, "My Task");
        assert!(details.relationships.parent.is_none());
        assert!(details.relationships.blocked_by.is_empty());
        assert!(details.relationships.blocks.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_with_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_parent(&db, "epic1", "Parent Epic", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Child Ticket", Level::Ticket, Some("epic1")).await;

        let details = load_task_details(&db, "ticket1").await.unwrap();
        assert!(details.is_some());
        let details = details.unwrap();
        assert_eq!(details.id, "ticket1");
        assert!(details.relationships.parent.is_some());
        let (parent_id, parent_title) = details.relationships.parent.unwrap();
        assert_eq!(parent_id, "epic1");
        assert_eq!(parent_title, "Parent Epic");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_with_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task_with_parent(&db, "blocker", "Blocker Task", Level::Task, None).await;
        create_task_with_parent(&db, "task1", "Main Task", Level::Task, None).await;
        create_task_with_parent(&db, "dependent", "Dependent Task", Level::Task, None).await;

        // Create relationships: dependent -> task1 -> blocker
        let rel_repo = RelationshipRepository::new(db.client());
        rel_repo
            .create_depends_on("task1", "blocker")
            .await
            .unwrap();
        rel_repo
            .create_depends_on("dependent", "task1")
            .await
            .unwrap();

        let details = load_task_details(&db, "task1").await.unwrap();
        assert!(details.is_some());
        let details = details.unwrap();

        // task1 is blocked by "blocker"
        assert_eq!(details.relationships.blocked_by.len(), 1);
        assert_eq!(details.relationships.blocked_by[0].0, "blocker");
        assert_eq!(details.relationships.blocked_by[0].1, "Blocker Task");

        // task1 blocks "dependent"
        assert_eq!(details.relationships.blocks.len(), 1);
        assert_eq!(details.relationships.blocks[0].0, "dependent");
        assert_eq!(details.relationships.blocks[0].1, "Dependent Task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_empty_db() {
        let (db, temp_dir) = setup_test_db().await;

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert!(timeline_tasks.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_excludes_unstarted() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task without started_at
        create_task_with_parent(&db, "task1", "Unstarted Task", Level::Task, None).await;

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert!(
            timeline_tasks.is_empty(),
            "Should not include tasks without started_at"
        );

        cleanup(&temp_dir);
    }

    /// Helper to set started_at timestamp on a task
    async fn set_started_at(db: &Database, id: &str) {
        let query = format!(
            "UPDATE task:{} SET started_at = time::now(), status = 'in_progress'",
            id
        );
        db.client().query(&query).await.unwrap();
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_includes_started() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task
        create_task_with_parent(&db, "started1", "Started Task", Level::Task, None).await;

        // Set started_at using raw SQL (the repo.create doesn't include started_at)
        set_started_at(&db, "started1").await;

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert_eq!(timeline_tasks.len(), 1);
        assert_eq!(timeline_tasks[0].id, "started1");
        assert_eq!(timeline_tasks[0].title, "Started Task");
        assert_eq!(timeline_tasks[0].status, Status::InProgress);
        assert!(timeline_tasks[0].completed_at.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_includes_completed() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task
        create_task_with_parent(&db, "done1", "Completed Task", Level::Task, None).await;

        // Set started_at and completed_at using raw SQL
        let query = "UPDATE task:done1 SET started_at = time::now() - 2h, completed_at = time::now(), status = 'done'";
        db.client().query(query).await.unwrap();

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert_eq!(timeline_tasks.len(), 1);
        assert_eq!(timeline_tasks[0].id, "done1");
        assert_eq!(timeline_tasks[0].status, Status::Done);
        assert!(timeline_tasks[0].completed_at.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_sorted_by_start_time() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task_with_parent(&db, "task1", "Task 1", Level::Task, None).await;
        create_task_with_parent(&db, "task2", "Task 2", Level::Task, None).await;
        create_task_with_parent(&db, "task3", "Task 3", Level::Task, None).await;

        // Set start times using raw SQL with different offsets
        let query1 = "UPDATE task:task1 SET started_at = time::now() - 1h, status = 'done'";
        let query2 = "UPDATE task:task2 SET started_at = time::now() - 3h, status = 'in_progress'";
        let query3 = "UPDATE task:task3 SET started_at = time::now() - 2h, status = 'done'";

        db.client().query(query1).await.unwrap();
        db.client().query(query2).await.unwrap();
        db.client().query(query3).await.unwrap();

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert_eq!(timeline_tasks.len(), 3);

        // Should be sorted by start time (oldest first)
        assert_eq!(timeline_tasks[0].id, "task2"); // Started 3 hours ago
        assert_eq!(timeline_tasks[1].id, "task3"); // Started 2 hours ago
        assert_eq!(timeline_tasks[2].id, "task1"); // Started 1 hour ago

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_timeline_tasks_with_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        let rel_repo = RelationshipRepository::new(db.client());

        // Create two tasks
        create_task_with_parent(&db, "blocker", "Blocker", Level::Task, None).await;
        create_task_with_parent(&db, "dependent", "Dependent", Level::Task, None).await;

        // Set timestamps using raw SQL
        let query1 = "UPDATE task:blocker SET started_at = time::now() - 2h, status = 'done'";
        let query2 = "UPDATE task:dependent SET started_at = time::now(), status = 'in_progress'";
        db.client().query(query1).await.unwrap();
        db.client().query(query2).await.unwrap();

        // Create dependency relationship
        rel_repo
            .create_depends_on("dependent", "blocker")
            .await
            .unwrap();

        let timeline_tasks = load_timeline_tasks(&db).await.unwrap();
        assert_eq!(timeline_tasks.len(), 2);

        // Find the dependent task and verify it has has_dependencies set
        let dependent_task = timeline_tasks.iter().find(|t| t.id == "dependent").unwrap();
        assert!(
            dependent_task.has_dependencies,
            "Dependent task should have has_dependencies=true"
        );

        // Blocker task should not have dependencies
        let blocker_task = timeline_tasks.iter().find(|t| t.id == "blocker").unwrap();
        assert!(
            !blocker_task.has_dependencies,
            "Blocker task should have has_dependencies=false"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_with_progress() {
        let (db, temp_dir) = setup_test_db().await;

        // Create epic with children
        create_task_with_parent(&db, "epic1", "Progress Epic", Level::Epic, None).await;
        create_task_with_parent(&db, "ticket1", "Ticket 1", Level::Ticket, Some("epic1")).await;
        create_task_with_parent(&db, "ticket2", "Ticket 2", Level::Ticket, Some("epic1")).await;

        // Mark one ticket as done
        let query = "UPDATE task:ticket1 SET status = 'done'";
        db.client().query(query).await.unwrap();

        let details = load_task_details(&db, "epic1").await.unwrap();
        assert!(details.is_some());
        let details = details.unwrap();

        // Epic should have progress since it has children
        assert!(
            details.progress.is_some(),
            "Epic with children should have progress"
        );

        let progress = details.progress.unwrap();
        assert_eq!(progress.done_count, 1);
        assert_eq!(progress.total_count, 2);
        assert_eq!(progress.percentage, 50);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_load_task_details_leaf_no_progress() {
        let (db, temp_dir) = setup_test_db().await;

        // Create leaf task with no children
        create_task_with_parent(&db, "task1", "Leaf Task", Level::Task, None).await;

        let details = load_task_details(&db, "task1").await.unwrap();
        assert!(details.is_some());
        let details = details.unwrap();

        // Leaf task should not have progress (or have total_count = 1)
        assert!(
            details.progress.is_none(),
            "Leaf task should not have progress displayed"
        );

        cleanup(&temp_dir);
    }
}
