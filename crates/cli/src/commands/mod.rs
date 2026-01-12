//! CLI commands for Vertebrae
//!
//! This module contains all subcommand implementations for the vtb CLI.

pub mod add;
pub mod blockers;
pub mod criterion_ref;
pub mod delete;
pub mod depend;
pub mod done;
pub mod execution;
pub mod export;
pub mod import;
pub mod init;
pub mod list;
pub mod path;
pub mod ready;
pub mod r#ref;
pub mod refs;
pub mod review;
pub mod section;
pub mod sections;
pub mod show;
pub mod start;
pub mod step_done;
pub mod submit;
pub mod transition_to;
pub mod triage;
pub mod undepend;
pub mod unref;
pub mod unsection;
pub mod update;
pub mod workflow;

pub use add::AddCommand;
pub use blockers::BlockersCommand;
pub use criterion_ref::CriterionRefCommand;
pub use delete::DeleteCommand;
pub use depend::DependCommand;
pub use done::DoneCommand;
pub use execution::ExecutionCommand;
pub use export::ExportCommand;
pub use import::ImportCommand;
pub use init::InitCommand;
pub use list::ListCommand;
pub use path::PathCommand;
pub use ready::ReadyCommand;
pub use r#ref::RefCommand;
pub use refs::RefsCommand;
pub use review::ReviewCommand;
pub use section::SectionCommand;
pub use sections::SectionsCommand;
pub use show::ShowCommand;
pub use start::StartCommand;
pub use step_done::StepDoneCommand;
pub use submit::SubmitCommand;
pub use transition_to::TransitionToCommand;
pub use triage::TriageCommand;
pub use undepend::UndependCommand;
pub use unref::UnrefCommand;
pub use unsection::UnsectionCommand;
pub use update::UpdateCommand;
pub use workflow::WorkflowCommand;

use crate::notification;
use crate::output::{format_task_table, format_task_tree};
use clap::Subcommand;
use vertebrae_core::TaskService;
use vertebrae_db::DbError;

/// Available CLI commands
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new task
    Add(AddCommand),
    /// Show all tasks blocking a given task (recursive)
    Blockers(BlockersCommand),
    /// Add a code reference to a testing criterion
    #[command(name = "criterion-ref")]
    CriterionRef(CriterionRefCommand),
    /// Delete a task (with optional cascade)
    Delete(DeleteCommand),
    /// Create a dependency relationship between tasks
    Depend(DependCommand),
    /// Complete a task (transition from pending_review to done)
    Done(DoneCommand),
    /// Execution history commands
    #[command(subcommand)]
    Execution(ExecutionCommand),
    /// Export all tasks and relationships to JSONL format
    Export(ExportCommand),
    /// Import tasks and relationships from JSONL format
    Import(ImportCommand),
    /// Initialize vertebrae in the current project
    Init(InitCommand),
    /// List tasks with optional filters
    List(ListCommand),
    /// Find the dependency path between two tasks
    Path(PathCommand),
    /// Show highest-level actionable items (entry points for work/triage)
    Ready(ReadyCommand),
    /// Add a code reference to a task
    Ref(RefCommand),
    /// List all code references for a task
    Refs(RefsCommand),
    /// Toggle or set the needs_human_review flag on a task
    Review(ReviewCommand),
    /// Add a typed content section to a task
    Section(SectionCommand),
    /// List all sections for a task
    Sections(SectionsCommand),
    /// Show full details of a task
    Show(ShowCommand),
    /// Start a task (transition from todo to in_progress)
    Start(StartCommand),
    /// Remove a dependency relationship between tasks
    Undepend(UndependCommand),
    /// Remove code references from a task
    Unref(UnrefCommand),
    /// Remove sections from a task
    Unsection(UnsectionCommand),
    /// Mark a step as done within a task
    #[command(name = "step-done")]
    StepDone(StepDoneCommand),
    /// Submit a task for review (transition from in_progress to pending_review)
    Submit(SubmitCommand),
    /// Transition a task to a specific status
    #[command(name = "transition-to")]
    TransitionTo(TransitionToCommand),
    /// Triage a task (transition from backlog to todo)
    Triage(TriageCommand),
    /// Update an existing task
    Update(UpdateCommand),
    /// Workflow management commands
    #[command(subcommand)]
    Workflow(WorkflowCommand),
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
    /// Execute the command with the given task service.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `DbError` if the command execution fails.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<CommandResult, DbError> {
        let db = service.database();
        match self {
            Command::Add(cmd) => {
                let id = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", id), "Created").await;
                Ok(CommandResult::Message(format!("Created task: {}", id)))
            }
            Command::Blockers(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::CriterionRef(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Delete(cmd) => {
                let message = cmd.execute(db).await?;
                // Extract task ID from message (format: "Deleted task: task:id")
                if let Some(task_id) = message.split("task:").nth(1) {
                    let task_id = format!("task:{}", task_id.trim());
                    notification::notify_task_changed(task_id, "Deleted").await;
                }
                Ok(CommandResult::Message(message))
            }
            Command::Depend(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Done(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "StatusChanged")
                    .await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Execution(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Export(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Import(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Init(cmd) => {
                // Init doesn't use the database - it creates the db directory
                let result = cmd.execute().map_err(|e| DbError::InvalidPath {
                    path: std::path::PathBuf::from("."),
                    reason: e.to_string(),
                })?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::List(cmd) => {
                let tasks = cmd.execute(db).await?;
                // Use tree format if --tree is specified (or if default behavior)
                // Use flat format if --flat is specified
                let output = if cmd.tree {
                    // Get all parent-child relationships for tree rendering
                    let parent_relations = db.relationships().export_all_child_of().await?;
                    // Build a map from child_id to parent_id
                    let parent_map: std::collections::HashMap<String, String> =
                        parent_relations.into_iter().collect();
                    format_task_tree(&tasks, &parent_map)
                } else {
                    format_task_table(&tasks)
                };
                Ok(CommandResult::Table(output))
            }
            Command::Path(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Ready(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Ref(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Refs(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Review(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "StatusChanged")
                    .await;
                Ok(CommandResult::Message(result))
            }
            Command::Section(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "Updated").await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Sections(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Show(cmd) => {
                // Service handles notification via callback if needed
                let detail = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", detail)))
            }
            Command::Start(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "StatusChanged")
                    .await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Undepend(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unref(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "Updated").await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unsection(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(service).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::StepDone(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "Updated").await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Submit(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", cmd.id), "StatusChanged")
                    .await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::TransitionTo(cmd) => {
                let result = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", result.id), "StatusChanged")
                    .await;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Triage(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Update(cmd) => {
                let id = cmd.execute(db).await?;
                notification::notify_task_changed(format!("task:{}", id), "Updated").await;
                Ok(CommandResult::Message(format!("Updated task: {}", id)))
            }
            Command::Workflow(cmd) => {
                let result = cmd.execute(db).await?;
                Ok(CommandResult::Message(result))
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
        let cli = TestCli::try_parse_from(["test", "list", "--status", "backlog"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.statuses.len(), 1);
                assert_eq!(cmd.statuses[0].as_str(), "backlog");
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

    #[test]
    fn test_command_transition_to_parses() {
        let cli = TestCli::try_parse_from(["test", "transition-to", "abc123", "todo"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::TransitionTo(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert_eq!(cmd.target, transition_to::TargetStatus::Todo);
            }
            _ => panic!("Expected TransitionTo command"),
        }
    }

    #[test]
    fn test_command_transition_to_requires_id() {
        let result = TestCli::try_parse_from(["test", "transition-to"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_transition_to_requires_target() {
        let result = TestCli::try_parse_from(["test", "transition-to", "abc123"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_transition_to_all_targets() {
        // Test all valid target values
        let targets = ["todo", "in_progress", "pending_review", "done", "rejected"];
        for target in targets {
            let cli = TestCli::try_parse_from(["test", "transition-to", "abc123", target]);
            assert!(cli.is_ok(), "Failed to parse target: {}", target);
        }
    }

    #[test]
    fn test_command_transition_to_invalid_target() {
        let result = TestCli::try_parse_from(["test", "transition-to", "abc123", "invalid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_transition_to_with_reason() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "abc123",
            "rejected",
            "--reason",
            "Out of scope",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::TransitionTo(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert_eq!(cmd.target, transition_to::TargetStatus::Rejected);
                assert_eq!(cmd.reason, Some("Out of scope".to_string()));
            }
            _ => panic!("Expected TransitionTo command"),
        }
    }

    #[test]
    fn test_command_transition_to_with_short_reason() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "abc123",
            "rejected",
            "-r",
            "Reason",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::TransitionTo(cmd) => {
                assert_eq!(cmd.reason, Some("Reason".to_string()));
            }
            _ => panic!("Expected TransitionTo command"),
        }
    }

    #[test]
    fn test_command_transition_to_debug() {
        let cli = TestCli::try_parse_from(["test", "transition-to", "test123", "todo"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("TransitionTo") && debug_str.contains("test123"),
            "Debug output should contain TransitionTo variant and id field value"
        );
    }

    #[test]
    fn test_command_init_parses() {
        let cli = TestCli::try_parse_from(["test", "init"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Init(cmd) => {
                assert_eq!(cmd.skills_source.to_str().unwrap(), "skills");
                assert_eq!(cmd.skills_target.to_str().unwrap(), ".claude/skills");
            }
            _ => panic!("Expected Init command"),
        }
    }

    #[test]
    fn test_command_init_with_custom_source() {
        let cli = TestCli::try_parse_from(["test", "init", "--skills-source", "custom/skills"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Init(cmd) => {
                assert_eq!(cmd.skills_source.to_str().unwrap(), "custom/skills");
            }
            _ => panic!("Expected Init command"),
        }
    }

    #[test]
    fn test_command_init_with_custom_target() {
        let cli = TestCli::try_parse_from(["test", "init", "--skills-target", ".custom/skills"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Init(cmd) => {
                assert_eq!(cmd.skills_target.to_str().unwrap(), ".custom/skills");
            }
            _ => panic!("Expected Init command"),
        }
    }

    #[test]
    fn test_command_init_debug() {
        let cli = TestCli::try_parse_from(["test", "init"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Init"),
            "Debug output should contain Init variant"
        );
    }

    #[test]
    fn test_command_workflow_add_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "My Workflow",
            "--step",
            "review:code-reviewer",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Add(cmd)) => {
                assert_eq!(cmd.name, "My Workflow");
                assert_eq!(cmd.steps.len(), 1);
                assert_eq!(cmd.steps[0].name, "review");
                assert_eq!(
                    cmd.steps[0].agent_config.model,
                    Some("code-reviewer".to_string())
                );
            }
            _ => panic!("Expected Workflow Add command"),
        }
    }

    #[test]
    fn test_command_workflow_add_with_description() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "My Workflow",
            "--description",
            "A test workflow",
            "--step",
            "review:code-reviewer",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Add(cmd)) => {
                assert_eq!(cmd.name, "My Workflow");
                assert_eq!(cmd.description, Some("A test workflow".to_string()));
            }
            _ => panic!("Expected Workflow Add command"),
        }
    }

    #[test]
    fn test_command_workflow_add_with_short_description() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "My Workflow",
            "-d",
            "Short desc",
            "--step",
            "review:code-reviewer",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Add(cmd)) => {
                assert_eq!(cmd.description, Some("Short desc".to_string()));
            }
            _ => panic!("Expected Workflow Add command"),
        }
    }

    #[test]
    fn test_command_workflow_add_with_multiple_steps() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "Multi-step Workflow",
            "--step",
            "review:code-reviewer",
            "--step",
            "test:tester",
            "--step",
            "deploy:deployer",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Add(cmd)) => {
                assert_eq!(cmd.name, "Multi-step Workflow");
                assert_eq!(cmd.steps.len(), 3);
                assert_eq!(cmd.steps[0].name, "review");
                assert_eq!(
                    cmd.steps[0].agent_config.model,
                    Some("code-reviewer".to_string())
                );
                assert_eq!(cmd.steps[1].name, "test");
                assert_eq!(cmd.steps[1].agent_config.model, Some("tester".to_string()));
                assert_eq!(cmd.steps[2].name, "deploy");
                assert_eq!(
                    cmd.steps[2].agent_config.model,
                    Some("deployer".to_string())
                );
            }
            _ => panic!("Expected Workflow Add command"),
        }
    }

    #[test]
    fn test_command_workflow_add_with_short_step_flag() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "Workflow",
            "-s",
            "review:code-reviewer",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Add(cmd)) => {
                assert_eq!(cmd.steps.len(), 1);
                assert_eq!(cmd.steps[0].name, "review");
            }
            _ => panic!("Expected Workflow Add command"),
        }
    }

    #[test]
    fn test_command_workflow_add_requires_name() {
        let result = TestCli::try_parse_from(["test", "workflow", "add"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_workflow_add_invalid_step_format() {
        let result = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "Workflow",
            "--step",
            "invalid-step-format",
        ]);
        assert!(result.is_err());
        match result {
            Err(e) => {
                let err = e.to_string();
                assert!(
                    err.contains("name:model"),
                    "Error should mention expected format, got: {}",
                    err
                );
            }
            Ok(_) => panic!("Expected error for invalid step format"),
        }
    }

    #[test]
    fn test_command_workflow_add_debug() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "add",
            "Test Workflow",
            "--step",
            "step1:agent1",
        ])
        .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Workflow") && debug_str.contains("Test Workflow"),
            "Debug output should contain Workflow variant and name field value"
        );
    }
}
