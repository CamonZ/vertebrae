//! Database module for Vertebrae
//!
//! Provides SurrealDB connection management with embedded RocksDB backend,
//! schema initialization, and data models for task management.

pub mod error;
pub mod models;
pub mod repository;
pub mod schema;

pub use error::{DbError, DbResult, IncompleteChildInfo};
#[allow(unused_imports)]
pub use models::{CodeRef, Level, Priority, Section, SectionType, Status, Task};
pub use repository::{
    BlockerNode, GraphQueries, Progress, RelationshipRepository, TaskFilter, TaskLister,
    TaskRepository, TaskSummary, TaskUpdate,
};

use std::path::{Path, PathBuf};
use std::process::Command;
use surrealdb::Surreal;
use surrealdb::engine::local::{Db, RocksDb};

/// Default database path relative to project root or current working directory
pub const DEFAULT_DB_PATH: &str = ".vtb/data";

/// Database wrapper providing connection management for SurrealDB
pub struct Database {
    /// The underlying SurrealDB client
    client: Surreal<Db>,
    /// Path where the database is stored
    #[allow(dead_code)] // Used by path() method for tests and future features
    path: PathBuf,
}

impl Database {
    /// Connect to a SurrealDB database at the specified path.
    ///
    /// Creates the database directory if it doesn't exist.
    ///
    /// # Arguments
    ///
    /// * `path` - Path to the database directory
    ///
    /// # Errors
    ///
    /// Returns `DbError::InvalidPath` if the path is invalid.
    /// Returns `DbError::CreateDirectory` if directory creation fails.
    /// Returns `DbError::Connection` if database connection fails.
    pub async fn connect(path: &Path) -> DbResult<Self> {
        // Validate and create the database directory
        let path = Self::prepare_path(path)?;

        // Connect to the database using RocksDB backend
        let client =
            Surreal::new::<RocksDb>(path.clone())
                .await
                .map_err(|e| DbError::Connection {
                    path: path.clone(),
                    source: Box::new(e),
                })?;

        Ok(Self { client, path })
    }

    /// Initialize the database schema.
    ///
    /// Sets up the namespace and database for Vertebrae operations,
    /// then initializes the task table and graph relations.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Schema` if schema initialization fails.
    pub async fn init(&self) -> DbResult<()> {
        // Use namespace and database for Vertebrae
        self.client
            .use_ns("vertebrae")
            .use_db("main")
            .await
            .map_err(|e| DbError::Schema(Box::new(e)))?;

        // Initialize the schema (task table, relations)
        schema::init_schema(&self.client).await?;

        Ok(())
    }

    /// Get a reference to the underlying SurrealDB client.
    ///
    /// Use this for executing queries against the database.
    #[allow(dead_code)] // Will be used by future features
    pub fn client(&self) -> &Surreal<Db> {
        &self.client
    }

    /// Get the path where the database is stored.
    #[allow(dead_code)] // Used in tests and future features
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the default database path based on project root.
    ///
    /// Uses `git rev-parse --show-toplevel` to find the project root and
    /// returns `<project_root>/.vtb/data`. If not in a git repository,
    /// falls back to `.vtb/data` relative to the current working directory.
    pub fn default_path() -> DbResult<PathBuf> {
        let base_path = find_project_root().unwrap_or_else(|| PathBuf::from("."));
        Ok(base_path.join(DEFAULT_DB_PATH))
    }

    /// Prepare the database path by validating and creating directories.
    fn prepare_path(path: &Path) -> DbResult<PathBuf> {
        let path = path.to_path_buf();

        // Check if parent directory exists or can be created
        if let Some(parent) = path.parent()
            && !parent.exists()
        {
            std::fs::create_dir_all(parent).map_err(|e| DbError::CreateDirectory {
                path: parent.to_path_buf(),
                source: e,
            })?;
        }

        // Create the database directory itself if it doesn't exist
        if !path.exists() {
            std::fs::create_dir_all(&path).map_err(|e| DbError::CreateDirectory {
                path: path.clone(),
                source: e,
            })?;
        }

        Ok(path)
    }
}

// Ensure Database is Send + Sync for async compatibility
static_assertions::assert_impl_all!(Database: Send, Sync);

/// Find the project root by running `git rev-parse --show-toplevel`.
///
/// Returns `Some(PathBuf)` with the absolute path to the git repository root,
/// or `None` if not in a git repository or the command fails.
pub fn find_project_root() -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;

    if output.status.success() {
        let path_str = String::from_utf8(output.stdout).ok()?;
        Some(PathBuf::from(path_str.trim()))
    } else {
        None
    }
}

/// Test utilities for creating isolated test databases
#[cfg(test)]
pub mod test_utils {
    use super::*;
    use std::env;

    /// Create an isolated SurrealDB database for testing
    ///
    /// Provides isolated database instances for unit tests with unique temporary directories.
    /// Each test gets its own RocksDB database in a separate temp directory,
    /// allowing tests to run concurrently without interference.
    /// Each call creates a new independent database.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// #[tokio::test]
    /// async fn test_something() {
    ///     let db = test_utils::create_test_db().await.unwrap();
    ///     // Use db for testing
    /// }
    /// ```
    pub async fn create_test_db() -> DbResult<Surreal<Db>> {
        // Create unique temp directory for this test
        let temp_dir = env::temp_dir().join(format!(
            "vtb-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let client = Surreal::new::<RocksDb>(temp_dir.to_str().unwrap())
            .await
            .map_err(|e| DbError::Connection {
                path: temp_dir.clone(),
                source: Box::new(e),
            })?;

        // Initialize schema
        client
            .use_ns("vertebrae")
            .use_db("main")
            .await
            .map_err(|e| DbError::Schema(Box::new(e)))?;

        schema::init_schema(&client).await?;

        Ok(client)
    }

    /// Helper to create a task in a test database
    ///
    /// Inserts a task with the specified properties into the database.
    /// Use this to set up test data quickly.
    pub async fn create_task_in_db(
        db: &Surreal<Db>,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
    ) -> DbResult<()> {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                priority = NONE,
                tags = [],
                created_at = time::now(),
                updated_at = time::now()"#,
            id, title, level, status
        );
        db.query(&query).await?;
        Ok(())
    }

    /// Helper to fetch a task from a test database
    ///
    /// Retrieves a task by its ID to verify state during tests.
    pub async fn fetch_task_from_db(db: &Surreal<Db>, id: &str) -> DbResult<Option<Task>> {
        let query = format!("SELECT * FROM task:{}", id);
        let mut result = db.query(&query).await?;
        let task: Option<Task> = result.take(0)?;
        Ok(task)
    }

    /// Helper to get task status from a test database
    ///
    /// Quickly retrieve just the status of a task for assertions.
    pub async fn get_task_status(db: &Surreal<Db>, id: &str) -> DbResult<Option<String>> {
        let query = format!("SELECT status FROM task:{}", id);
        let mut result = db.query(&query).await?;
        #[derive(serde::Deserialize)]
        struct StatusRow {
            status: String,
        }
        let row: Option<StatusRow> = result.take(0)?;
        Ok(row.map(|r| r.status))
    }

    /// Helper to query all tasks from a test database
    ///
    /// Retrieve all tasks for testing list operations and filters.
    pub async fn list_all_tasks(db: &Surreal<Db>) -> DbResult<Vec<Task>> {
        let mut result = db.query("SELECT * FROM task").await?;
        let tasks: Vec<Task> = result.take(0)?;
        Ok(tasks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_default_path() {
        let result = Database::default_path();
        assert!(result.is_ok());
        let path = result.unwrap();
        // In a git repository, default_path returns an absolute path to project root
        // If not in a git repo, it falls back to relative path
        assert!(
            path.ends_with(".vtb/data"),
            "Path should end with .vtb/data, got: {:?}",
            path
        );
    }

    #[test]
    fn test_find_project_root() {
        // This test runs inside the vertebrae git repository
        let result = find_project_root();
        // Should find the project root since we're in a git repo
        assert!(result.is_some(), "Should find project root in git repo");
        let path = result.unwrap();
        // The path should be absolute and exist
        assert!(path.is_absolute(), "Project root should be absolute path");
        assert!(path.exists(), "Project root should exist");
        // The path should contain a .git directory
        assert!(
            path.join(".git").exists(),
            "Project root should contain .git directory"
        );
    }

    #[test]
    fn test_default_db_path_constant() {
        assert_eq!(DEFAULT_DB_PATH, ".vtb/data");
    }

    #[tokio::test]
    async fn test_connect_and_init() {
        // Create a temporary directory for testing
        let temp_dir = env::temp_dir().join(format!("vtb-test-{}", std::process::id()));

        // Connect to database
        let db = Database::connect(&temp_dir).await;
        assert!(db.is_ok(), "Failed to connect: {:?}", db.err());

        let db = db.unwrap();

        // Verify path was stored correctly
        assert_eq!(db.path(), temp_dir);

        // Test client accessor
        let _client = db.client();

        // Initialize schema
        let init_result = db.init().await;
        assert!(
            init_result.is_ok(),
            "Failed to init: {:?}",
            init_result.err()
        );

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_connect_creates_directory() {
        let temp_dir =
            env::temp_dir().join(format!("vtb-test-nested-{}/nested/db", std::process::id()));

        // Ensure it doesn't exist
        let _ = std::fs::remove_dir_all(temp_dir.parent().unwrap().parent().unwrap());

        // Connect should create the directory
        let db = Database::connect(&temp_dir).await;
        assert!(db.is_ok(), "Failed to connect: {:?}", db.err());

        // Verify directory was created
        assert!(temp_dir.exists());

        // Clean up
        let _ = std::fs::remove_dir_all(temp_dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn test_prepare_path_creates_directories() {
        let temp_dir =
            env::temp_dir().join(format!("vtb-test-prepare-{}/sub/dir", std::process::id()));

        // Ensure it doesn't exist
        let _ = std::fs::remove_dir_all(temp_dir.parent().unwrap().parent().unwrap());

        let result = Database::prepare_path(&temp_dir);
        assert!(result.is_ok());
        assert!(temp_dir.exists());

        // Clean up
        let _ = std::fs::remove_dir_all(temp_dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn test_prepare_path_existing_directory() {
        // Test with an existing directory (temp dir always exists)
        let temp_dir = env::temp_dir();
        let result = Database::prepare_path(&temp_dir);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), temp_dir);
    }

    #[test]
    fn test_prepare_path_with_existing_parent() {
        // Create a path where the parent exists but the child doesn't
        let temp_dir = env::temp_dir().join(format!("vtb-test-child-{}", std::process::id()));

        // Ensure it doesn't exist
        let _ = std::fs::remove_dir_all(&temp_dir);

        let result = Database::prepare_path(&temp_dir);
        assert!(result.is_ok());
        assert!(temp_dir.exists());

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
