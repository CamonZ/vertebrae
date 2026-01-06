//! Data loading for the TUI.
//!
//! Provides functions to load tasks from the database and convert them
//! to tree structures for the navigation panel.

use std::collections::HashMap;

use vertebrae_db::{Database, Level, TaskFilter, TaskLister, TaskSummary};

use crate::error::TuiResult;
use crate::navigation::TreeNode;

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
    let roots: Vec<TreeNode> = root_ids
        .iter()
        .filter_map(|id| {
            task_map
                .get(id)
                .map(|task| build_tree_node(task, &task_map, &children_map))
        })
        .collect();

    Ok(roots)
}

/// Recursively build a TreeNode with its children.
fn build_tree_node(
    task: &TaskSummary,
    task_map: &HashMap<String, &TaskSummary>,
    children_map: &HashMap<String, Vec<String>>,
) -> TreeNode {
    let mut node = task_to_node(task);

    if let Some(child_ids) = children_map.get(&task.id) {
        let children: Vec<TreeNode> = child_ids
            .iter()
            .filter_map(|id| {
                task_map
                    .get(id)
                    .map(|child| build_tree_node(child, task_map, children_map))
            })
            .collect();

        node = node.with_children(children);
    }

    node
}

/// Load root epics only (for lazy loading).
///
/// Returns TreeNode objects with has_children set correctly but without
/// actually loading the children. Children can be loaded on-demand when
/// a node is expanded.
pub async fn load_root_epics_lazy(db: &Database) -> TuiResult<Vec<TreeNode>> {
    let roots = load_root_tasks(db).await?;

    let mut nodes = Vec::with_capacity(roots.len());

    for root in &roots {
        let mut node = task_to_node(root);

        // Check if this task has children
        let children = load_children(db, &root.id).await?;
        if !children.is_empty() {
            // Add placeholder children so has_children() returns true
            // These will be replaced when the node is expanded
            node = node.with_children(children.iter().map(task_to_node).collect::<Vec<_>>());
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

    let mut nodes = Vec::with_capacity(children.len());

    for child in &children {
        let mut node = task_to_node(child);

        // Check if this child has its own children
        let grandchildren = load_children(db, &child.id).await?;
        if !grandchildren.is_empty() {
            node = node.with_children(grandchildren.iter().map(task_to_node).collect::<Vec<_>>());
        }

        nodes.push(node);
    }

    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use vertebrae_db::{Level, Status, Task, TaskRepository};

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
}
