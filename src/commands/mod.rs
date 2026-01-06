//! CLI commands for Vertebrae
//!
//! This module contains all subcommand implementations for the vtb CLI.

pub mod add;
pub mod block;
pub mod blockers;
pub mod delete;
pub mod depend;
pub mod done;
pub mod list;
pub mod path;
pub mod r#ref;
pub mod refs;
pub mod section;
pub mod sections;
pub mod show;
pub mod start;
pub mod step_done;
pub mod undepend;
pub mod unref;
pub mod unsection;
pub mod update;

pub use add::AddCommand;
pub use block::BlockCommand;
pub use blockers::BlockersCommand;
pub use delete::DeleteCommand;
pub use depend::DependCommand;
pub use done::DoneCommand;
pub use list::ListCommand;
pub use path::PathCommand;
pub use r#ref::RefCommand;
pub use refs::RefsCommand;
pub use section::SectionCommand;
pub use sections::SectionsCommand;
pub use show::ShowCommand;
pub use start::StartCommand;
pub use step_done::StepDoneCommand;
pub use undepend::UndependCommand;
pub use unref::UnrefCommand;
pub use unsection::UnsectionCommand;
pub use update::UpdateCommand;

use crate::db::{Database, DbError};
use crate::output::format_task_table;
use clap::Subcommand;

/// Available CLI commands
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new task
    Add(AddCommand),
    /// Mark a task as blocked (with optional reason)
    Block(BlockCommand),
    /// Show all tasks blocking a given task (recursive)
    Blockers(BlockersCommand),
    /// Delete a task (with optional cascade)
    Delete(DeleteCommand),
    /// Create a dependency relationship between tasks
    Depend(DependCommand),
    /// Mark a task as complete (transition to done)
    Done(DoneCommand),
    /// List tasks with optional filters
    List(ListCommand),
    /// Find the dependency path between two tasks
    Path(PathCommand),
    /// Add a code reference to a task
    Ref(RefCommand),
    /// List all code references for a task
    Refs(RefsCommand),
    /// Add a typed content section to a task
    Section(SectionCommand),
    /// List all sections for a task
    Sections(SectionsCommand),
    /// Show full details of a task
    Show(ShowCommand),
    /// Remove a dependency relationship between tasks
    Undepend(UndependCommand),
    /// Remove code references from a task
    Unref(UnrefCommand),
    /// Remove sections from a task
    Unsection(UnsectionCommand),
    /// Start working on a task (transition to in_progress)
    Start(StartCommand),
    /// Mark a step as done within a task
    #[command(name = "step-done")]
    StepDone(StepDoneCommand),
    /// Update an existing task
    Update(UpdateCommand),
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
            Command::Block(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Blockers(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Delete(cmd) => {
                let message = cmd.execute(db).await?;
                Ok(CommandResult::Message(message))
            }
            Command::Depend(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Done(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::List(cmd) => {
                let tasks = cmd.execute(db).await?;
                Ok(CommandResult::Table(format_task_table(&tasks)))
            }
            Command::Path(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Ref(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Refs(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Section(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Sections(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Show(cmd) => {
                let detail = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", detail)))
            }
            Command::Undepend(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unref(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unsection(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Start(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::StepDone(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Update(cmd) => {
                let id = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("Updated task: {}", id)))
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
        let cli = TestCli::try_parse_from(["test", "add", "Debug test title"]).unwrap();
        // Test Debug trait is implemented and shows field values
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Add") && debug_str.contains("Debug test title"),
            "Debug output should contain Add command and title field value"
        );
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
        assert!(
            debug_str.contains("Show") && debug_str.contains("test123"),
            "Debug output should contain Show variant and id field value"
        );
    }

    #[test]
    fn test_command_update_parses() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.id, "abc123");
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_requires_id() {
        let result = TestCli::try_parse_from(["test", "update"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_update_with_title() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--title", "New Title"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert_eq!(cmd.title, Some("New Title".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_priority() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--priority", "high"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(
                    cmd.priority.map(|p| p.as_str().to_string()),
                    Some("high".to_string())
                );
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_add_tag() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--add-tag", "urgent"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.add_tags, vec!["urgent"]);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_multiple_add_tags() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "abc123",
            "--add-tag",
            "urgent",
            "--add-tag",
            "backend",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.add_tags, vec!["urgent", "backend"]);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_remove_tag() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--remove-tag", "old"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.remove_tags, vec!["old"]);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_parent() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--parent", "xyz789"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.parent, Some("xyz789".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_empty_parent() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--parent", ""]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.parent, Some("".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_invalid_priority() {
        let result = TestCli::try_parse_from(["test", "update", "abc123", "--priority", "invalid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_update_with_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "abc123",
            "--title",
            "New Title",
            "--priority",
            "critical",
            "--add-tag",
            "urgent",
            "--remove-tag",
            "old",
            "--parent",
            "xyz789",
        ]);
        assert!(cli.is_ok());
        let cmd = match cli.unwrap().command {
            Command::Update(cmd) => cmd,
            _ => panic!("Expected Update command"),
        };
        assert_eq!(cmd.id, "abc123");
        assert_eq!(cmd.title, Some("New Title".to_string()));
        assert_eq!(
            cmd.priority.map(|p| p.as_str().to_string()),
            Some("critical".to_string())
        );
        assert_eq!(cmd.add_tags, vec!["urgent"]);
        assert_eq!(cmd.remove_tags, vec!["old"]);
        assert_eq!(cmd.parent, Some("xyz789".to_string()));
    }

    #[test]
    fn test_command_update_debug() {
        let cli = TestCli::try_parse_from(["test", "update", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Update") && debug_str.contains("test123"),
            "Debug output should contain Update variant and id field value"
        );
    }

    #[test]
    fn test_command_delete_parses() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(!cmd.cascade);
                assert!(!cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_requires_id() {
        let result = TestCli::try_parse_from(["test", "delete"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_delete_with_cascade() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123", "--cascade"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(cmd.cascade);
                assert!(!cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_with_force() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123", "--force"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(!cmd.cascade);
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_with_force_short() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123", "-f"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_with_cascade_and_force() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123", "--cascade", "--force"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(cmd.cascade);
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_debug() {
        let cli = TestCli::try_parse_from(["test", "delete", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Delete") && debug_str.contains("test123"),
            "Debug output should contain Delete variant and id field value"
        );
    }

    #[test]
    fn test_command_start_parses() {
        let cli = TestCli::try_parse_from(["test", "start", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Start(cmd) => {
                assert_eq!(cmd.id, "abc123");
            }
            _ => panic!("Expected Start command"),
        }
    }

    #[test]
    fn test_command_start_requires_id() {
        let result = TestCli::try_parse_from(["test", "start"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_start_debug() {
        let cli = TestCli::try_parse_from(["test", "start", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Start") && debug_str.contains("test123"),
            "Debug output should contain Start variant and id field value"
        );
    }

    #[test]
    fn test_command_done_parses() {
        let cli = TestCli::try_parse_from(["test", "done", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Done(cmd) => {
                assert_eq!(cmd.id, "abc123");
            }
            _ => panic!("Expected Done command"),
        }
    }

    #[test]
    fn test_command_done_requires_id() {
        let result = TestCli::try_parse_from(["test", "done"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_done_debug() {
        let cli = TestCli::try_parse_from(["test", "done", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Done") && debug_str.contains("test123"),
            "Debug output should contain Done variant and id field value"
        );
    }

    #[test]
    fn test_command_block_parses() {
        let cli = TestCli::try_parse_from(["test", "block", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Block(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(cmd.reason.is_none());
            }
            _ => panic!("Expected Block command"),
        }
    }

    #[test]
    fn test_command_block_requires_id() {
        let result = TestCli::try_parse_from(["test", "block"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_block_with_reason() {
        let cli =
            TestCli::try_parse_from(["test", "block", "abc123", "--reason", "Waiting for API"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Block(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert_eq!(cmd.reason, Some("Waiting for API".to_string()));
            }
            _ => panic!("Expected Block command"),
        }
    }

    #[test]
    fn test_command_block_with_short_reason() {
        let cli = TestCli::try_parse_from(["test", "block", "abc123", "-r", "Short reason"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Block(cmd) => {
                assert_eq!(cmd.reason, Some("Short reason".to_string()));
            }
            _ => panic!("Expected Block command"),
        }
    }

    #[test]
    fn test_command_block_debug() {
        let cli = TestCli::try_parse_from(["test", "block", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Block") && debug_str.contains("test123"),
            "Debug output should contain Block variant and id field value"
        );
    }

    #[test]
    fn test_command_sections_parses() {
        let cli = TestCli::try_parse_from(["test", "sections", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Sections(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(cmd.section_type.is_none());
            }
            _ => panic!("Expected Sections command"),
        }
    }

    #[test]
    fn test_command_sections_requires_id() {
        let result = TestCli::try_parse_from(["test", "sections"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_sections_with_type_filter() {
        let cli = TestCli::try_parse_from(["test", "sections", "abc123", "--type", "step"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Sections(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(cmd.section_type.is_some());
                assert_eq!(cmd.section_type.unwrap().as_str(), "step");
            }
            _ => panic!("Expected Sections command"),
        }
    }

    #[test]
    fn test_command_sections_with_anti_pattern_filter() {
        let cli = TestCli::try_parse_from(["test", "sections", "abc123", "--type", "anti_pattern"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Sections(cmd) => {
                assert_eq!(cmd.section_type.unwrap().as_str(), "anti_pattern");
            }
            _ => panic!("Expected Sections command"),
        }
    }

    #[test]
    fn test_command_sections_invalid_type() {
        let result = TestCli::try_parse_from(["test", "sections", "abc123", "--type", "invalid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_sections_debug() {
        let cli = TestCli::try_parse_from(["test", "sections", "test123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Sections") && debug_str.contains("test123"),
            "Debug output should contain Sections variant and id field value"
        );
    }
}
