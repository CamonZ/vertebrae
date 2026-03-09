use clap::Parser;
use std::process;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use vertebrae_cli::commands::Command;
use vertebrae_core::ServiceError;
use vertebrae_sacrum_client::SacrumConfig;

/// Vertebrae - A task management CLI tool
#[derive(Parser)]
#[command(name = "vtb")]
#[command(version = "0.1.0")]
#[command(about = "A task management CLI tool", long_about = None)]
struct Args {
    /// Subcommand to execute
    #[command(subcommand)]
    command: Option<Command>,
}

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
        eprintln!("error: {}", e);
        if let Some(hint) = e.hint() {
            eprintln!("{}", hint);
        }
        process::exit(1);
    }
}

/// Main application logic - separated for testability
async fn run_app() -> Result<(), ServiceError> {
    let args = Args::parse();
    run_with_args(args).await
}

/// Run the application with the given arguments
async fn run_with_args(args: Args) -> Result<(), ServiceError> {
    if let Some(Command::Init(ref cmd)) = args.command {
        let result = cmd
            .execute()
            .await
            .map_err(|e| ServiceError::config_error(e.to_string()))?;
        println!("{}", result);
        return Ok(());
    }

    if let Some(Command::Daemon(ref cmd)) = args.command {
        let result = cmd
            .execute()
            .await
            .map_err(|e| ServiceError::config_error(e.to_string()))?;
        println!("{}", result);
        return Ok(());
    }

    // Load Sacrum configuration from ~/.config/vertebrae/config.toml
    let config = SacrumConfig::load().map_err(|e| {
        ServiceError::config_error(format!("Failed to load Sacrum configuration: {}", e))
    })?;

    // Initialize Sacrum HTTP client
    let client = vertebrae_sacrum_client::GraphqlClient::new(config);
    let client_arc = Arc::new(client);

    // Create services using Sacrum backend
    // Sacrum automatically broadcasts all mutations to connected clients
    let services = vertebrae_sacrum_client::from_sacrum(client_arc);

    // Run the command or show welcome message
    match args.command {
        Some(mut cmd) => {
            cmd.resolve_ids(&services).await?;
            let result = cmd.execute(&services).await?;
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
    use vertebrae_cli::commands::DaemonCommand;

    #[test]
    fn test_args_parsing() {
        // Test that Args can be parsed with default values
        let args = Args::try_parse_from(["vtb"]).unwrap();
        assert!(args.command.is_none());
    }

    #[test]
    fn test_args_with_add_command() {
        let args = Args::try_parse_from(["vtb", "add", "My task"]).unwrap();
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
    fn test_args_with_multiple_tags() {
        let args = Args::try_parse_from([
            "vtb", "add", "My task", "-t", "tag1", "-t", "tag2", "-t", "tag3",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_show_command() {
        let args =
            Args::try_parse_from(["vtb", "show", "a1b2c3d4-0000-4000-8000-000000000001"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_list_command() {
        let args = Args::try_parse_from(["vtb", "list"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_delete_command() {
        let args = Args::try_parse_from(["vtb", "delete", "a1b2c3d4-0000-4000-8000-000000000001"])
            .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_update_command() {
        let args = Args::try_parse_from([
            "vtb",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--title",
            "New title",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_depend_command() {
        let args = Args::try_parse_from([
            "vtb",
            "depend",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--on",
            "a1b2c3d4-0000-4000-8000-000000000002",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_workflow_command() {
        let args = Args::try_parse_from(["vtb", "workflow", "list"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_with_multiple_filters() {
        let args = Args::try_parse_from(["vtb", "list", "--level", "epic", "--status", "backlog"])
            .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_various_subcommands() {
        let commands = vec![
            vec!["vtb", "add", "Task"],
            vec!["vtb", "list"],
            vec!["vtb", "show", "a1b2c3d4-0000-4000-8000-000000000001"],
            vec!["vtb", "delete", "a1b2c3d4-0000-4000-8000-000000000001"],
            vec!["vtb", "ready"],
            vec!["vtb", "blockers", "a1b2c3d4-0000-4000-8000-000000000001"],
        ];

        for cmd in &commands {
            let args = Args::try_parse_from(cmd.clone()).unwrap();
            assert!(args.command.is_some(), "Failed to parse: {:?}", cmd);
        }
    }

    #[test]
    fn test_args_with_no_arguments() {
        let args = Args::try_parse_from(["vtb"]).unwrap();
        assert!(args.command.is_none());
    }

    #[test]
    fn test_args_add_minimal() {
        let args = Args::try_parse_from(["vtb", "add", "Minimal task"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_single_tag() {
        let args = Args::try_parse_from(["vtb", "add", "Task", "-t", "urgent"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_level_only() {
        let args = Args::try_parse_from(["vtb", "add", "Task", "--level", "epic"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_priority_only() {
        let args = Args::try_parse_from(["vtb", "add", "Task", "--priority", "high"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_description() {
        let args =
            Args::try_parse_from(["vtb", "add", "Task", "-d", "This is a description"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_show_command() {
        let args =
            Args::try_parse_from(["vtb", "show", "a1b2c3d4-0000-4000-8000-000000000003"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_delete_command() {
        let args = Args::try_parse_from(["vtb", "delete", "a1b2c3d4-0000-4000-8000-000000000003"])
            .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_list_command_no_filters() {
        let args = Args::try_parse_from(["vtb", "list"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_list_with_level_filter() {
        let args = Args::try_parse_from(["vtb", "list", "--level", "task"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_list_with_status_filter() {
        let args = Args::try_parse_from(["vtb", "list", "--status", "backlog"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_update_basic() {
        let args = Args::try_parse_from([
            "vtb",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--title",
            "New Title",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_update_with_priority() {
        let args = Args::try_parse_from([
            "vtb",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--priority",
            "high",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_depend_command() {
        let args = Args::try_parse_from([
            "vtb",
            "depend",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--on",
            "a1b2c3d4-0000-4000-8000-000000000002",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_blockers_command() {
        let args =
            Args::try_parse_from(["vtb", "blockers", "a1b2c3d4-0000-4000-8000-000000000001"])
                .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_ready_command() {
        let args = Args::try_parse_from(["vtb", "ready"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_help_flag() {
        let result = Args::try_parse_from(["vtb", "--help"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_args_version_flag() {
        let result = Args::try_parse_from(["vtb", "--version"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_args_with_empty_title() {
        let result = Args::try_parse_from(["vtb", "add", ""]);
        // Empty title should still parse but might be rejected by validation
        let args = result.unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_command_case_sensitivity() {
        // Commands should be case-sensitive
        let result = Args::try_parse_from(["vtb", "ADD", "Task"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_args_with_special_characters_in_title() {
        let args =
            Args::try_parse_from(["vtb", "add", "Task with special chars !@#$%^&*()"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_long_title() {
        let long_title = "a".repeat(500);
        let args = Args::try_parse_from(["vtb", "add", &long_title]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_add_with_many_tags() {
        let mut cmd: Vec<&str> = vec!["vtb", "add", "Task"];
        let tag_strings: Vec<String> = (0..10).map(|i| format!("tag{}", i)).collect();
        for tag_str in &tag_strings {
            cmd.push("-t");
            cmd.push(tag_str);
        }
        let args = Args::try_parse_from(&cmd).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_workflow_list() {
        let args = Args::try_parse_from(["vtb", "workflow", "list"]).unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_workflow_show() {
        let args = Args::try_parse_from([
            "vtb",
            "workflow",
            "show",
            "a1b2c3d4-0000-4000-8000-000000000006",
        ])
        .unwrap();
        assert!(args.command.is_some());
    }

    #[test]
    fn test_args_daemon_install() {
        let args = Args::try_parse_from(["vtb", "daemon", "install"]).unwrap();
        assert!(args.command.is_some());
        match args.command.unwrap() {
            Command::Daemon(DaemonCommand::Install(_)) => {}
            other => panic!("Expected Daemon(Install), got: {:?}", other),
        }
    }

    #[test]
    fn test_args_daemon_install_with_binary() {
        let args = Args::try_parse_from([
            "vtb",
            "daemon",
            "install",
            "--binary",
            "/usr/bin/vtb-daemon",
        ])
        .unwrap();
        match args.command.unwrap() {
            Command::Daemon(DaemonCommand::Install(cmd)) => {
                assert_eq!(
                    cmd.binary.as_deref(),
                    Some("/usr/bin/vtb-daemon"),
                    "binary flag should be captured"
                );
            }
            other => panic!("Expected Daemon(Install), got: {:?}", other),
        }
    }

    #[test]
    fn test_args_daemon_uninstall() {
        let args = Args::try_parse_from(["vtb", "daemon", "uninstall"]).unwrap();
        match args.command.unwrap() {
            Command::Daemon(DaemonCommand::Uninstall(_)) => {}
            other => panic!("Expected Daemon(Uninstall), got: {:?}", other),
        }
    }

    #[test]
    fn test_args_daemon_status() {
        let args = Args::try_parse_from(["vtb", "daemon", "status"]).unwrap();
        match args.command.unwrap() {
            Command::Daemon(DaemonCommand::Status(_)) => {}
            other => panic!("Expected Daemon(Status), got: {:?}", other),
        }
    }
}
