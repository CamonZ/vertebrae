use clap::Parser;
use std::path::PathBuf;
use std::process;

mod commands;
mod db;
mod id;

use commands::Command;
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

    /// Subcommand to execute
    #[command(subcommand)]
    command: Option<Command>,
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

    // Run the command or show welcome message
    match &args.command {
        Some(cmd) => {
            let result = cmd.execute(&db).await?;
            println!("Created task: {}", result);
        }
        None => {
            println!("Welcome to Vertebrae!");
            println!("Use 'vtb --help' for usage information.");
        }
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
        assert!(args.command.is_none());
    }

    #[test]
    fn test_args_with_db_path() {
        let args = Args::try_parse_from(["vtb", "--db", "/tmp/test-db"]).unwrap();
        assert_eq!(args.db, Some(PathBuf::from("/tmp/test-db")));
    }

    #[test]
    fn test_args_with_add_command() {
        let args = Args::try_parse_from(["vtb", "add", "My task"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_db_and_add_command() {
        let args = Args::try_parse_from(["vtb", "--db", "/custom/path", "add", "My task"]).unwrap();
        assert_eq!(args.db, Some(PathBuf::from("/custom/path")));
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_all_options() {
        let args = Args::try_parse_from([
            "vtb",
            "add",
            "Task title",
            "--level",
            "epic",
            "--priority",
            "high",
            "-t",
            "backend",
            "-t",
            "api",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[tokio::test]
    async fn test_run_with_args_no_command() {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-main-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let args = Args {
            db: Some(temp_dir.clone()),
            command: None,
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
            command: None,
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
    async fn test_run_with_add_command() {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-main-add-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let args = Args::try_parse_from([
            "vtb",
            "--db",
            temp_dir.to_str().unwrap(),
            "add",
            "Test task",
        ])
        .unwrap();

        let result = run_with_args(&args).await;
        assert!(result.is_ok(), "Add command failed: {:?}", result.err());

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_run_with_add_command_all_options() {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-main-add-full-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let args = Args::try_parse_from([
            "vtb",
            "--db",
            temp_dir.to_str().unwrap(),
            "add",
            "Full task",
            "--level",
            "epic",
            "--priority",
            "critical",
            "-t",
            "urgent",
        ])
        .unwrap();

        let result = run_with_args(&args).await;
        assert!(
            result.is_ok(),
            "Full add command failed: {:?}",
            result.err()
        );

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_args_env_variable_support() {
        // Test that the env attribute is correctly set up
        // Note: We can't easily test env var parsing in unit tests,
        // but we can verify the Args struct handles None correctly
        let args = Args::try_parse_from(["vtb"]).unwrap();
        assert!(args.db.is_none());
    }

    #[test]
    fn test_add_command_requires_title() {
        // Add command without title should fail
        let result = Args::try_parse_from(["vtb", "add"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_command_invalid_level() {
        let result = Args::try_parse_from(["vtb", "add", "Task", "--level", "invalid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_command_invalid_priority() {
        let result = Args::try_parse_from(["vtb", "add", "Task", "--priority", "wrong"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_args_debug() {
        let args = Args::try_parse_from(["vtb", "add", "Test"]).unwrap();
        // Command should implement Debug
        if let Some(cmd) = &args.command {
            let _ = format!("{:?}", cmd);
        }
    }
}
