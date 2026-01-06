use clap::Parser;
use std::path::PathBuf;
use std::process;

mod db;

use db::{Database, DbError};

/// Vertebrae - A task management CLI tool
#[derive(Parser)]
#[command(name = "vtb")]
#[command(version = "0.1.0")]
#[command(about = "A task management CLI tool", long_about = None)]
struct Args {
    /// Path to the database directory
    #[arg(long, global = true, env = "VTB_DB_PATH")]
    db: Option<PathBuf>,

    /// Optional name to greet
    #[arg(short, long)]
    name: Option<String>,
}

#[tokio::main]
async fn main() {
    if let Err(e) = run_app().await {
        eprintln!("Error: {}", e);
        process::exit(1);
    }
}

/// Main application logic - separated for testability
async fn run_app() -> Result<(), DbError> {
    let args = Args::parse();
    run_with_args(&args).await
}

/// Run the application with the given arguments
async fn run_with_args(args: &Args) -> Result<(), DbError> {
    // Determine database path
    let db_path = match &args.db {
        Some(path) => path.clone(),
        None => Database::default_path()?,
    };

    // Initialize database connection
    let db = Database::connect(&db_path).await?;

    // Initialize database schema
    db.init().await?;

    // Run the application logic
    execute(args)
}

/// Execute the main application logic
fn execute(args: &Args) -> Result<(), DbError> {
    if let Some(name) = &args.name {
        println!("Hello, {}!", name);
    } else {
        println!("Welcome to Vertebrae!");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_args_parsing() {
        // Test that Args can be parsed with default values
        let args = Args::try_parse_from(["vtb"]).unwrap();
        assert!(args.db.is_none());
        assert!(args.name.is_none());
    }

    #[test]
    fn test_args_with_db_path() {
        let args = Args::try_parse_from(["vtb", "--db", "/tmp/test-db"]).unwrap();
        assert_eq!(args.db, Some(PathBuf::from("/tmp/test-db")));
    }

    #[test]
    fn test_args_with_name() {
        let args = Args::try_parse_from(["vtb", "--name", "Alice"]).unwrap();
        assert_eq!(args.name, Some("Alice".to_string()));
    }

    #[test]
    fn test_args_with_all_options() {
        let args = Args::try_parse_from(["vtb", "--db", "/custom/path", "--name", "Bob"]).unwrap();
        assert_eq!(args.db, Some(PathBuf::from("/custom/path")));
        assert_eq!(args.name, Some("Bob".to_string()));
    }

    #[test]
    fn test_execute_with_name() {
        let args = Args {
            db: None,
            name: Some("TestUser".to_string()),
        };
        let result = execute(&args);
        assert!(result.is_ok());
    }

    #[test]
    fn test_execute_without_name() {
        let args = Args {
            db: None,
            name: None,
        };
        let result = execute(&args);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_run_with_args_custom_db_path() {
        let temp_dir = env::temp_dir().join(format!("vtb-main-test-{}", std::process::id()));

        let args = Args {
            db: Some(temp_dir.clone()),
            name: Some("IntegrationTest".to_string()),
        };

        let result = run_with_args(&args).await;
        assert!(result.is_ok(), "run_with_args failed: {:?}", result.err());

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_run_with_args_default_path() {
        // Test with default path (will use ~/.vtb/data)
        let args = Args {
            db: None,
            name: None,
        };

        // This should succeed as it will use the default path
        let result = run_with_args(&args).await;
        assert!(
            result.is_ok(),
            "run_with_args with default path failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_run_with_args_with_name() {
        let temp_dir = env::temp_dir().join(format!("vtb-main-name-test-{}", std::process::id()));

        let args = Args {
            db: Some(temp_dir.clone()),
            name: Some("NameTest".to_string()),
        };

        let result = run_with_args(&args).await;
        assert!(result.is_ok());

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_run_with_args_without_name() {
        let temp_dir = env::temp_dir().join(format!("vtb-main-noname-test-{}", std::process::id()));

        let args = Args {
            db: Some(temp_dir.clone()),
            name: None,
        };

        let result = run_with_args(&args).await;
        assert!(result.is_ok());

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_args_short_name_flag() {
        // Test the -n short flag for name
        let args = Args::try_parse_from(["vtb", "-n", "ShortFlag"]).unwrap();
        assert_eq!(args.name, Some("ShortFlag".to_string()));
    }

    #[test]
    fn test_args_env_variable_support() {
        // Test that the env attribute is correctly set up
        // Note: We can't easily test env var parsing in unit tests,
        // but we can verify the Args struct handles None correctly
        let args = Args::try_parse_from(["vtb"]).unwrap();
        assert!(args.db.is_none());
    }
}
