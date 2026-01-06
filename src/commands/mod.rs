//! CLI commands for Vertebrae
//!
//! This module contains all subcommand implementations for the vtb CLI.

pub mod add;
pub mod list;
pub mod show;

pub use add::AddCommand;
pub use list::ListCommand;
pub use show::ShowCommand;

use crate::db::{Database, DbError};
use crate::output::format_task_table;
use clap::Subcommand;

/// Available CLI commands
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new task
    Add(AddCommand),
    /// List tasks with optional filters
    List(ListCommand),
    /// Show full details of a task
    Show(ShowCommand),
}

/// Result of executing a command
pub enum CommandResult {
    /// A simple message to display
    Message(String),
    /// A formatted table to display
    Table(String),
}

impl std::fmt::Display for CommandResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommandResult::Message(msg) => write!(f, "{}", msg),
            CommandResult::Table(table) => write!(f, "{}", table),
        }
    }
}

impl Command {
    /// Execute the command with the given database connection.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if the command execution fails.
    pub async fn execute(&self, db: &Database) -> Result<CommandResult, DbError> {
        match self {
            Command::Add(cmd) => {
                let id = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("Created task: {}", id)))
            }
            Command::List(cmd) => {
                let tasks = cmd.execute(db).await?;
                Ok(CommandResult::Table(format_task_table(&tasks)))
            }
            Command::Show(cmd) => {
                let detail = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", detail)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Test struct to parse commands
    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: Command,
    }

    #[test]
    fn test_command_add_parses() {
        let cli = TestCli::try_parse_from(["test", "add", "My task"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.title, "My task");
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_level() {
        let cli = TestCli::try_parse_from(["test", "add", "Epic task", "--level", "epic"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.title, "Epic task");
                assert_eq!(cmd.level.unwrap().as_str(), "epic");
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_short_level() {
        let cli = TestCli::try_parse_from(["test", "add", "Task", "-l", "ticket"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.level.unwrap().as_str(), "ticket");
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_priority() {
        let cli = TestCli::try_parse_from(["test", "add", "Urgent", "--priority", "high"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.priority.unwrap().as_str(), "high");
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_tags() {
        let cli = TestCli::try_parse_from(["test", "add", "Tagged", "-t", "backend", "-t", "api"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.tags, vec!["backend", "api"]);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_parent() {
        let cli = TestCli::try_parse_from(["test", "add", "Child", "--parent", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.parent, Some("abc123".to_string()));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_depends_on() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Dependent",
            "--depends-on",
            "xyz789",
            "--depends-on",
            "abc123",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(cmd.depends_on, vec!["xyz789", "abc123"]);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_description() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Described",
            "-d",
            "This is a detailed description",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(
                    cmd.description,
                    Some("This is a detailed description".to_string())
                );
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_command_add_with_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Complete Task",
            "--level",
            "epic",
            "--priority",
            "critical",
            "-t",
            "urgent",
            "-t",
            "backend",
            "--parent",
            "parent1",
            "--depends-on",
            "dep1",
            "--description",
            "Full description",
        ]);
        assert!(cli.is_ok());
        let cmd = match cli.unwrap().command {
            Command::Add(cmd) => cmd,
            _ => panic!("Expected Add command"),
        };
        assert_eq!(cmd.title, "Complete Task");
        assert_eq!(cmd.level.unwrap().as_str(), "epic");
        assert_eq!(cmd.priority.unwrap().as_str(), "critical");
        assert_eq!(cmd.tags, vec!["urgent", "backend"]);
        assert_eq!(cmd.parent, Some("parent1".to_string()));
        assert_eq!(cmd.depends_on, vec!["dep1"]);
        assert_eq!(cmd.description, Some("Full description".to_string()));
    }

    #[test]
    fn test_command_debug() {
        let cli = TestCli::try_parse_from(["test", "add", "Debug test"]).unwrap();
        // Test Debug trait is implemented
        let debug_str = format!("{:?}", cli.command);
        assert!(debug_str.contains("Add"));
    }

    #[test]
    fn test_command_list_parses() {
        let cli = TestCli::try_parse_from(["test", "list"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert!(cmd.levels.is_empty());
                assert!(cmd.statuses.is_empty());
                assert!(!cmd.all);
                assert!(!cmd.root);
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_level() {
        let cli = TestCli::try_parse_from(["test", "list", "--level", "epic"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.levels.len(), 1);
                assert_eq!(cmd.levels[0].as_str(), "epic");
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_multiple_levels() {
        let cli = TestCli::try_parse_from(["test", "list", "-l", "epic", "-l", "ticket"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.levels.len(), 2);
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_status() {
        let cli = TestCli::try_parse_from(["test", "list", "--status", "blocked"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.statuses.len(), 1);
                assert_eq!(cmd.statuses[0].as_str(), "blocked");
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_priority() {
        let cli = TestCli::try_parse_from(["test", "list", "--priority", "high"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.priorities.len(), 1);
                assert_eq!(cmd.priorities[0].as_str(), "high");
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_tag() {
        let cli = TestCli::try_parse_from(["test", "list", "--tag", "backend"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.tags, vec!["backend"]);
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_root() {
        let cli = TestCli::try_parse_from(["test", "list", "--root"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert!(cmd.root);
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_children() {
        let cli = TestCli::try_parse_from(["test", "list", "--children", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.children, Some("abc123".to_string()));
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_all() {
        let cli = TestCli::try_parse_from(["test", "list", "--all"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert!(cmd.all);
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_invalid_level() {
        let result = TestCli::try_parse_from(["test", "list", "--level", "invalid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_list_invalid_status() {
        let result = TestCli::try_parse_from(["test", "list", "--status", "unknown"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_list_invalid_priority() {
        let result = TestCli::try_parse_from(["test", "list", "--priority", "wrong"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_result_display_message() {
        let result = CommandResult::Message("Test message".to_string());
        assert_eq!(format!("{}", result), "Test message");
    }

    #[test]
    fn test_command_result_display_table() {
        let result = CommandResult::Table("Table content".to_string());
        assert_eq!(format!("{}", result), "Table content");
    }

    #[test]
    fn test_command_show_parses() {
        let cli = TestCli::try_parse_from(["test", "show", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Show(cmd) => {
                assert_eq!(cmd.id, "abc123");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_command_show_requires_id() {
        let result = TestCli::try_parse_from(["test", "show"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_show_debug() {
        let cli = TestCli::try_parse_from(["test", "show", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(debug_str.contains("Show"));
    }
}
