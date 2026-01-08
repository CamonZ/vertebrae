use clap::Parser;
use std::path::PathBuf;
use std::process;
use tracing_subscriber::EnvFilter;

mod commands;
mod id;
mod output;

use commands::Command;
use vertebrae_db::{Database, DbError};

/// Environment variable name for the database path
const VTB_DB_PATH_ENV: &str = "VTB_DB_PATH";

/// Vertebrae - A task management CLI tool
#[derive(Parser)]
#[command(name = "vtb")]
#[command(version = "0.1.0")]
#[command(about = "A task management CLI tool", long_about = None)]
struct Args {
    /// Path to the database directory (can also be set via VTB_DB_PATH env var)
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    /// Subcommand to execute
    #[command(subcommand)]
    command: Option<Command>,
}

/// Get the database path from command line, environment variable, or default.
///
/// Priority:
/// 1. Command line --db argument
/// 2. VTB_DB_PATH environment variable (if non-empty)
/// 3. Default path (~/.vtb/data)
fn resolve_db_path(cli_db: Option<PathBuf>) -> DbResult<PathBuf> {
    // First priority: explicit command line argument
    if let Some(path) = cli_db {
        return Ok(path);
    }

    // Second priority: environment variable (if set and non-empty)
    if let Ok(env_path) = std::env::var(VTB_DB_PATH_ENV)
        && !env_path.is_empty()
    {
        return Ok(PathBuf::from(env_path));
    }

    // Third priority: default path
    Database::default_path()
}

use vertebrae_db::DbResult;

/// Initialize logging based on DEBUGGING environment variable
///
/// Examples:
/// - `DEBUGGING=trace` - show all trace logs
/// - `DEBUGGING=debug` - show debug and above
/// - `DEBUGGING=info` - show info and above
/// - `DEBUGGING=warn` - show warn and above
/// - `DEBUGGING=error` - show error only
fn init_logging() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_level(true)
        .init();
}

#[tokio::main]
async fn main() {
    init_logging();

    if let Err(e) = run_app().await {
        eprintln!("error: {}", e.full_message());
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
    // Determine database path using priority: CLI arg > env var > default
    let db_path = resolve_db_path(args.db.clone())?;

    // Initialize database connection
    let db = Database::connect(&db_path).await?;

    // Initialize database schema
    db.init().await?;

    // Run the command or show welcome message
    match &args.command {
        Some(cmd) => {
            let result = cmd.execute(&db).await?;
            println!("{}", result);
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
    use serial_test::serial;
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
        match result {
            Err(e) => {
                let err = e.to_string();
                assert!(
                    err.contains("required") || err.contains("<TITLE>"),
                    "Error should mention the required title argument, got: {}",
                    err
                );
            }
            Ok(_) => panic!("Expected error for missing title"),
        }
    }

    #[test]
    fn test_add_command_invalid_level() {
        let result = Args::try_parse_from(["vtb", "add", "Task", "--level", "invalid"]);
        match result {
            Err(e) => {
                let err = e.to_string();
                assert!(
                    err.contains("level") || err.contains("invalid"),
                    "Error should mention the level argument, got: {}",
                    err
                );
            }
            Ok(_) => panic!("Expected error for invalid level"),
        }
    }

    #[test]
    fn test_add_command_invalid_priority() {
        let result = Args::try_parse_from(["vtb", "add", "Task", "--priority", "wrong"]);
        match result {
            Err(e) => {
                let err = e.to_string();
                assert!(
                    err.contains("priority") || err.contains("wrong"),
                    "Error should mention the priority argument, got: {}",
                    err
                );
            }
            Ok(_) => panic!("Expected error for invalid priority"),
        }
    }

    #[test]
    fn test_args_debug() {
        let args = Args::try_parse_from(["vtb", "add", "Test task title"]).unwrap();
        // Args does not derive Debug, but Command does - verify Command debug works
        if let Some(cmd) = &args.command {
            let cmd_debug = format!("{:?}", cmd);
            assert!(
                cmd_debug.contains("Add") && cmd_debug.contains("Test task title"),
                "Command debug should contain Add variant and title field value"
            );
        }
    }

    #[test]
    fn test_resolve_db_path_cli_takes_priority() {
        // CLI argument takes priority over everything else
        let cli_path = PathBuf::from("/custom/path");
        let result = resolve_db_path(Some(cli_path.clone()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), cli_path);
    }

    #[test]
    #[serial]
    fn test_resolve_db_path_env_var_takes_priority_over_default() {
        // Set environment variable
        let original = env::var(VTB_DB_PATH_ENV).ok();
        // SAFETY: Test is single-threaded and we restore the original value
        unsafe { env::set_var(VTB_DB_PATH_ENV, "/env/path") };

        let result = resolve_db_path(None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from("/env/path"));

        // Restore original
        // SAFETY: Test is single-threaded and we're restoring to original state
        unsafe {
            match original {
                Some(val) => env::set_var(VTB_DB_PATH_ENV, val),
                None => env::remove_var(VTB_DB_PATH_ENV),
            }
        }
    }

    #[test]
    #[serial]
    fn test_resolve_db_path_empty_env_var_uses_default() {
        // Set environment variable to empty string
        let original = env::var(VTB_DB_PATH_ENV).ok();
        // SAFETY: Test is single-threaded and we restore the original value
        unsafe { env::set_var(VTB_DB_PATH_ENV, "") };

        let result = resolve_db_path(None);
        assert!(result.is_ok());
        // Should use default path (based on project root), not empty string
        let path = result.unwrap();
        // In a git repo, default_path returns an absolute path ending with .vtb/data
        // If not in a git repo, it returns a relative path
        assert!(
            path.ends_with(".vtb/data"),
            "Expected path ending with .vtb/data, got: {:?}",
            path
        );

        // Restore original
        // SAFETY: Test is single-threaded and we're restoring to original state
        unsafe {
            match original {
                Some(val) => env::set_var(VTB_DB_PATH_ENV, val),
                None => env::remove_var(VTB_DB_PATH_ENV),
            }
        }
    }

    #[test]
    #[serial]
    fn test_resolve_db_path_unset_env_var_uses_default() {
        // Unset environment variable
        let original = env::var(VTB_DB_PATH_ENV).ok();
        // SAFETY: Test is single-threaded and we restore the original value
        unsafe { env::remove_var(VTB_DB_PATH_ENV) };

        let result = resolve_db_path(None);
        assert!(result.is_ok());
        // Should use default path (based on project root)
        let path = result.unwrap();
        // In a git repo, default_path returns an absolute path ending with .vtb/data
        // If not in a git repo, it returns a relative path
        assert!(
            path.ends_with(".vtb/data"),
            "Expected path ending with .vtb/data, got: {:?}",
            path
        );

        // Restore original
        // SAFETY: Test is single-threaded and we're restoring to original state
        if let Some(val) = original {
            unsafe { env::set_var(VTB_DB_PATH_ENV, val) };
        }
    }

    #[test]
    #[serial]
    fn test_resolve_db_path_cli_overrides_env_var() {
        // Set environment variable
        let original = env::var(VTB_DB_PATH_ENV).ok();
        // SAFETY: Test is single-threaded and we restore the original value
        unsafe { env::set_var(VTB_DB_PATH_ENV, "/env/path") };

        // CLI should take priority
        let cli_path = PathBuf::from("/cli/path");
        let result = resolve_db_path(Some(cli_path.clone()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), cli_path);

        // Restore original
        // SAFETY: Test is single-threaded and we're restoring to original state
        unsafe {
            match original {
                Some(val) => env::set_var(VTB_DB_PATH_ENV, val),
                None => env::remove_var(VTB_DB_PATH_ENV),
            }
        }
    }
}
