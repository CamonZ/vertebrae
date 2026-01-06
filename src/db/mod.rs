//! Database module for Vertebrae
//!
//! Provides SurrealDB connection management with embedded RocksDB backend,
//! schema initialization, and data models for task management.

pub mod error;
pub mod models;
pub mod schema;

pub use error::{DbError, DbResult};
#[allow(unused_imports)]
pub use models::{CodeRef, Level, Priority, Section, SectionType, Status, Task};

use std::path::{Path, PathBuf};
use surrealdb::Surreal;
use surrealdb::engine::local::{Db, RocksDb};

/// Default database path relative to user's home directory
pub const DEFAULT_DB_SUBPATH: &str = ".vtb/data";

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

    /// Get the default database path based on user's home directory.
    ///
    /// Returns `~/.vtb/data` expanded to the actual home directory path.
    ///
    /// # Errors
    ///
    /// Returns `DbError::InvalidPath` if the home directory cannot be determined.
    pub fn default_path() -> DbResult<PathBuf> {
        dirs::home_dir()
            .map(|home| home.join(DEFAULT_DB_SUBPATH))
            .ok_or_else(|| DbError::InvalidPath {
                path: PathBuf::from("~"),
                reason: "Could not determine home directory".to_string(),
            })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_default_path() {
        let result = Database::default_path();
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.to_string_lossy().contains(".vtb/data"));
    }

    #[test]
    fn test_default_db_subpath_constant() {
        assert_eq!(DEFAULT_DB_SUBPATH, ".vtb/data");
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
