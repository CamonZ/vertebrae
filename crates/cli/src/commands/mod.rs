//! CLI commands for Vertebrae
//!
//! This module contains all subcommand implementations for the vtb CLI.

#![allow(deprecated)]

pub mod add;
pub mod archive;
pub mod blockers;
pub mod check_item;
pub mod complete_step;
pub mod criterion_ref;
pub mod daemon;
pub mod delete;
pub mod depend;
pub mod execution;
pub mod init;
pub mod list;
pub mod path;
pub mod ready;
pub mod r#ref;
pub mod refs;
pub mod reject_step;
pub mod review;
pub mod run;
pub mod section;
pub mod sections;
pub mod show;
pub mod start_step;
pub mod step;
pub mod transition_to;
pub mod uncheck_item;
pub mod undepend;
pub mod unref;
pub mod unsection;
pub mod update;
pub mod workflow;

pub use add::AddCommand;
pub use archive::{ArchiveCommand, UnarchiveCommand};
pub use blockers::BlockersCommand;
pub use check_item::CheckItemCommand;
pub use complete_step::CompleteStepCommand;
pub use criterion_ref::CriterionRefCommand;
pub use daemon::DaemonCommand;
pub use delete::DeleteCommand;
pub use depend::DependCommand;
pub use execution::ExecutionCommand;
pub use init::InitCommand;
pub use list::ListCommand;
pub use path::PathCommand;
pub use ready::ReadyCommand;
pub use r#ref::RefCommand;
pub use refs::RefsCommand;
pub use reject_step::RejectStepCommand;
pub use review::ReviewCommand;
pub use run::RunCommand;
pub use section::SectionCommand;
pub use sections::SectionsCommand;
pub use show::ShowCommand;
pub use start_step::StartStepCommand;
pub use step::StepCommand;
pub use transition_to::TransitionToCommand;
pub use uncheck_item::UncheckItemCommand;
pub use undepend::UndependCommand;
pub use unref::UnrefCommand;
pub use unsection::UnsectionCommand;
pub use update::UpdateCommand;
pub use workflow::WorkflowCommand;

use crate::output::{format_task_table, format_task_tree};
use clap::Subcommand;
use clap::builder::ValueParser;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Check whether a string is a valid short ID prefix (8 hex characters).
pub fn is_short_id(s: &str) -> bool {
    s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Build a UUID-or-short-ID validator for a named field.
///
/// Returns a [`ValueParser`] for clap that accepts either:
/// - A full UUID (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
/// - A short ID prefix (exactly 8 hex characters, the first segment of a UUID)
///
/// Short IDs are resolved to full UUIDs at execution time via `resolve_short_id`.
pub fn parse_uuid(field_name: &'static str) -> ValueParser {
    ValueParser::from(move |s: &str| -> Result<String, String> {
        // Accept 8-char hex prefix (short ID)
        if is_short_id(s) {
            return Ok(s.to_lowercase());
        }
        // Accept full UUID
        uuid::Uuid::parse_str(s).map_err(|_| {
            format!(
                "{field_name} '{s}' is not a valid UUID or short ID \
                 (expected: 8 hex characters or xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
            )
        })?;
        Ok(s.to_lowercase())
    })
}

/// Like [`parse_uuid`] but the returned validator also accepts an empty string.
///
/// Used for arguments where an empty string has a special meaning
/// (e.g., `--parent ""` clears the parent relationship).
pub fn parse_uuid_or_empty(field_name: &'static str) -> ValueParser {
    ValueParser::from(move |s: &str| -> Result<String, String> {
        if s.is_empty() {
            return Ok(s.to_string());
        }
        // Accept 8-char hex prefix (short ID)
        if is_short_id(s) {
            return Ok(s.to_lowercase());
        }
        // Accept full UUID
        uuid::Uuid::parse_str(s).map_err(|_| {
            format!(
                "{field_name} '{s}' is not a valid UUID or short ID \
                 (expected: 8 hex characters or xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
            )
        })?;
        Ok(s.to_lowercase())
    })
}

/// Available CLI commands
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new task
    Add(AddCommand),
    /// Archive a task (set archived=true)
    Archive(ArchiveCommand),
    /// Show all tasks blocking a given task (recursive)
    Blockers(BlockersCommand),
    /// Complete a workflow step for a task
    #[command(name = "complete-step")]
    CompleteStep(CompleteStepCommand),
    /// Add a code reference to a testing criterion
    #[command(name = "criterion-ref")]
    CriterionRef(CriterionRefCommand),
    /// Manage the vtb-daemon launchd service
    #[command(subcommand)]
    Daemon(DaemonCommand),
    /// Delete a task (with optional cascade)
    Delete(DeleteCommand),
    /// Create a dependency relationship between tasks
    Depend(DependCommand),
    /// Execution history commands
    #[command(subcommand)]
    Execution(ExecutionCommand),
    /// Initialize vertebrae in the current project
    Init(InitCommand),
    /// List tasks with optional filters
    List(ListCommand),
    /// Find the dependency path between two tasks
    Path(PathCommand),
    /// Show highest-level actionable items (entry points for work/triage)
    Ready(ReadyCommand),
    /// Reject a workflow step with optional feedback
    #[command(name = "reject-step")]
    RejectStep(RejectStepCommand),
    /// Add a code reference to a task
    Ref(RefCommand),
    /// List all code references for a task
    Refs(RefsCommand),
    /// Toggle or set the needs_human_review flag on a task
    Review(ReviewCommand),
    /// Run a workflow for a task
    Run(RunCommand),
    /// Add a typed content section to a task
    Section(SectionCommand),
    /// List all sections for a task
    Sections(SectionsCommand),
    /// Show full details of a task
    Show(ShowCommand),
    /// Start a workflow step for a task
    #[command(name = "start-step")]
    StartStep(StartStepCommand),
    /// Unarchive a task (set archived=false)
    Unarchive(UnarchiveCommand),
    /// Uncheck a previously checked checklist item
    #[command(name = "uncheck-item")]
    UncheckItem(UncheckItemCommand),
    /// Remove a dependency relationship between tasks
    Undepend(UndependCommand),
    /// Remove code references from a task
    Unref(UnrefCommand),
    /// Remove sections from a task
    Unsection(UnsectionCommand),
    /// First-class workflow step management commands
    #[command(subcommand)]
    Step(StepCommand),
    /// Mark a checklist item as done within a task
    #[command(name = "check-item")]
    CheckItem(CheckItemCommand),
    /// Transition a task to a specific workflow step
    #[command(name = "transition-to")]
    TransitionTo(TransitionToCommand),
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

/// Resolve a single ID: if it's a short ID (8 hex chars), resolve via the backend.
/// Otherwise return it unchanged.
async fn resolve_id(id: &str, services: &VertebraeServices) -> Result<String, ServiceError> {
    if is_short_id(id) {
        services.tasks().resolve_short_id(id).await
    } else {
        Ok(id.to_string())
    }
}

/// Resolve an optional ID field in place.
async fn resolve_optional_id(
    id: &mut Option<String>,
    services: &VertebraeServices,
) -> Result<(), ServiceError> {
    if let Some(val) = id.as_ref()
        && !val.is_empty()
        && is_short_id(val)
    {
        let resolved = resolve_id(val, services).await?;
        *id = Some(resolved);
    }
    Ok(())
}

impl Command {
    /// Resolve any short task ID prefixes to full UUIDs before execution.
    ///
    /// Walks through all task ID fields in the command and resolves 8-character
    /// hex prefixes to full UUIDs via the `resolveShortId` backend query.
    pub async fn resolve_ids(&mut self, services: &VertebraeServices) -> Result<(), ServiceError> {
        match self {
            Command::Add(cmd) => {
                resolve_optional_id(&mut cmd.parent, services).await?;
                for dep in &mut cmd.depends_on {
                    if is_short_id(dep) {
                        *dep = resolve_id(dep, services).await?;
                    }
                }
            }
            Command::Archive(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Blockers(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::CompleteStep(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::CriterionRef(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Delete(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Depend(cmd) => {
                cmd.id = resolve_id(&cmd.id, services).await?;
                cmd.blocker_id = resolve_id(&cmd.blocker_id, services).await?;
            }
            Command::Daemon(_)
            | Command::Execution(_)
            | Command::Init(_)
            | Command::List(_)
            | Command::Ready(_) => {}
            Command::Path(cmd) => {
                cmd.from_id = resolve_id(&cmd.from_id, services).await?;
                cmd.to_id = resolve_id(&cmd.to_id, services).await?;
            }
            Command::RejectStep(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Ref(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Refs(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Review(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Run(cmd) => cmd.task_id = resolve_id(&cmd.task_id, services).await?,
            Command::Section(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Sections(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Show(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::StartStep(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Unarchive(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::UncheckItem(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Undepend(cmd) => {
                cmd.id = resolve_id(&cmd.id, services).await?;
                cmd.blocker_id = resolve_id(&cmd.blocker_id, services).await?;
            }
            Command::Unref(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Unsection(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Step(_) | Command::Workflow(_) => {}
            Command::CheckItem(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::TransitionTo(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Update(cmd) => {
                cmd.id = resolve_id(&cmd.id, services).await?;
                resolve_optional_id(&mut cmd.parent, services).await?;
            }
        }
        Ok(())
    }

    /// Execute the command with the given task services.tasks().
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<CommandResult, ServiceError> {
        match self {
            Command::Add(cmd) => {
                let id = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("Created task: {}", id)))
            }
            Command::Archive(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Blockers(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::CompleteStep(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::CriterionRef(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Daemon(cmd) => {
                let result = cmd
                    .execute()
                    .await
                    .map_err(|e| ServiceError::validation_failed(e.to_string()))?;
                Ok(CommandResult::Message(result))
            }
            Command::Delete(cmd) => {
                let message = cmd.execute(services).await?;
                Ok(CommandResult::Message(message))
            }
            Command::Depend(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Execution(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Init(cmd) => {
                // Init doesn't use the database - it registers with Sacrum API
                let result = cmd
                    .execute()
                    .await
                    .map_err(|e| ServiceError::validation_failed(e.to_string()))?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::List(cmd) => {
                let tasks = cmd.execute(services).await?;
                // Use tree format by default
                // Use flat format if --flat is specified
                let output = if cmd.flat {
                    format_task_table(&tasks)
                } else {
                    // Build parent_map from task parent_id fields
                    let parent_map: std::collections::HashMap<String, String> = tasks
                        .iter()
                        .filter_map(|t| t.parent_id.as_ref().map(|pid| (t.id.clone(), pid.clone())))
                        .collect();
                    format_task_tree(&tasks, &parent_map)
                };
                Ok(CommandResult::Table(output))
            }
            Command::Path(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Ready(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::RejectStep(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Ref(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Refs(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Review(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Run(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Section(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Sections(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Show(cmd) => {
                // Service handles notification via callback if needed
                let detail = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", detail)))
            }
            Command::StartStep(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unarchive(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::UncheckItem(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Undepend(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unref(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Unsection(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Step(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::CheckItem(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::TransitionTo(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Update(cmd) => {
                let id = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("Updated task: {}", id)))
            }
            Command::Workflow(cmd) => {
                let result = cmd.execute(services).await?;
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
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Child",
            "--parent",
            "a1b2c3d4-0000-4000-8000-000000000001",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(
                    cmd.parent,
                    Some("a1b2c3d4-0000-4000-8000-000000000001".to_string())
                );
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
            "a1b2c3d4-0000-4000-8000-000000000002",
            "--depends-on",
            "a1b2c3d4-0000-4000-8000-000000000001",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Add(cmd) => {
                assert_eq!(
                    cmd.depends_on,
                    vec![
                        "a1b2c3d4-0000-4000-8000-000000000002",
                        "a1b2c3d4-0000-4000-8000-000000000001"
                    ]
                );
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
            "a1b2c3d4-0000-4000-8000-000000000004",
            "--depends-on",
            "a1b2c3d4-0000-4000-8000-000000000005",
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
        assert_eq!(
            cmd.parent,
            Some("a1b2c3d4-0000-4000-8000-000000000004".to_string())
        );
        assert_eq!(cmd.depends_on, vec!["a1b2c3d4-0000-4000-8000-000000000005"]);
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
    fn test_command_list_with_parent() {
        let cli = TestCli::try_parse_from([
            "test",
            "list",
            "--parent",
            "a1b2c3d4-0000-4000-8000-000000000001",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(
                    cmd.parent,
                    Some("a1b2c3d4-0000-4000-8000-000000000001".to_string())
                );
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

    // Note: test_command_list_invalid_status removed - status is now a dynamic String,
    // validation happens at runtime in the service layer when transitioning tasks

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
        let cli = TestCli::try_parse_from(["test", "show", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Show(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
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
        let cli = TestCli::try_parse_from(["test", "show", "a1b2c3d4-0000-4000-8000-000000000003"])
            .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Show")
                && debug_str.contains("a1b2c3d4-0000-4000-8000-000000000003"),
            "Debug output should contain Show variant and id field value"
        );
    }

    #[test]
    fn test_command_update_parses() {
        let cli =
            TestCli::try_parse_from(["test", "update", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
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
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--title",
            "New Title",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert_eq!(cmd.title, Some("New Title".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_priority() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--priority",
            "high",
        ]);
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
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--add-tag",
            "urgent",
        ]);
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
            "a1b2c3d4-0000-4000-8000-000000000001",
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
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--remove-tag",
            "old",
        ]);
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
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--parent",
            "a1b2c3d4-0000-4000-8000-000000000002",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Update(cmd) => {
                assert_eq!(
                    cmd.parent,
                    Some("a1b2c3d4-0000-4000-8000-000000000002".to_string())
                );
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_command_update_with_empty_parent() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--parent",
            "",
        ]);
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
        let result = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--priority",
            "invalid",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_update_with_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--title",
            "New Title",
            "--priority",
            "critical",
            "--add-tag",
            "urgent",
            "--remove-tag",
            "old",
            "--parent",
            "a1b2c3d4-0000-4000-8000-000000000002",
        ]);
        assert!(cli.is_ok());
        let cmd = match cli.unwrap().command {
            Command::Update(cmd) => cmd,
            _ => panic!("Expected Update command"),
        };
        assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
        assert_eq!(cmd.title, Some("New Title".to_string()));
        assert_eq!(
            cmd.priority.map(|p| p.as_str().to_string()),
            Some("critical".to_string())
        );
        assert_eq!(cmd.add_tags, vec!["urgent"]);
        assert_eq!(cmd.remove_tags, vec!["old"]);
        assert_eq!(
            cmd.parent,
            Some("a1b2c3d4-0000-4000-8000-000000000002".to_string())
        );
    }

    #[test]
    fn test_command_update_debug() {
        let cli =
            TestCli::try_parse_from(["test", "update", "a1b2c3d4-0000-4000-8000-000000000003"])
                .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Update")
                && debug_str.contains("a1b2c3d4-0000-4000-8000-000000000003"),
            "Debug output should contain Update variant and id field value"
        );
    }

    #[test]
    fn test_command_delete_parses() {
        let cli =
            TestCli::try_parse_from(["test", "delete", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
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
        let cli = TestCli::try_parse_from([
            "test",
            "delete",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--cascade",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert!(cmd.cascade);
                assert!(!cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_with_force() {
        let cli = TestCli::try_parse_from([
            "test",
            "delete",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--force",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert!(!cmd.cascade);
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_with_force_short() {
        let cli = TestCli::try_parse_from([
            "test",
            "delete",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "-f",
        ]);
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
        let cli = TestCli::try_parse_from([
            "test",
            "delete",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--cascade",
            "--force",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Delete(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert!(cmd.cascade);
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_command_delete_debug() {
        let cli =
            TestCli::try_parse_from(["test", "delete", "a1b2c3d4-0000-4000-8000-000000000003"])
                .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Delete")
                && debug_str.contains("a1b2c3d4-0000-4000-8000-000000000003"),
            "Debug output should contain Delete variant and id field value"
        );
    }

    #[test]
    fn test_command_sections_parses() {
        let cli =
            TestCli::try_parse_from(["test", "sections", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Sections(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
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
        let cli = TestCli::try_parse_from([
            "test",
            "sections",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--type",
            "checklist_item",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Sections(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert!(cmd.section_type.is_some());
                assert_eq!(cmd.section_type.unwrap().as_str(), "checklist_item");
            }
            _ => panic!("Expected Sections command"),
        }
    }

    #[test]
    fn test_command_sections_with_anti_pattern_filter() {
        let cli = TestCli::try_parse_from([
            "test",
            "sections",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--type",
            "anti_pattern",
        ]);
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
        let result = TestCli::try_parse_from([
            "test",
            "sections",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "--type",
            "invalid",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_sections_debug() {
        let cli =
            TestCli::try_parse_from(["test", "sections", "a1b2c3d4-0000-4000-8000-000000000003"])
                .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Sections")
                && debug_str.contains("a1b2c3d4-0000-4000-8000-000000000003"),
            "Debug output should contain Sections variant and id field value"
        );
    }

    #[test]
    fn test_command_transition_to_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "b2c3d4e5-0000-4000-8000-000000000002",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::TransitionTo(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
                assert_eq!(cmd.target, "b2c3d4e5-0000-4000-8000-000000000002");
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
        let result = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000001",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_transition_to_rejects_non_uuid_target() {
        let result = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "not-a-uuid",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_transition_to_with_skip_validation() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "b2c3d4e5-0000-4000-8000-000000000002",
            "--skip-validation",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::TransitionTo(cmd) => {
                assert!(cmd.skip_validation);
            }
            _ => panic!("Expected TransitionTo command"),
        }
    }

    #[test]
    fn test_command_transition_to_debug() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000003",
            "b2c3d4e5-0000-4000-8000-000000000004",
        ])
        .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("TransitionTo")
                && debug_str.contains("a1b2c3d4-0000-4000-8000-000000000003"),
            "Debug output should contain TransitionTo variant and id field value"
        );
    }

    #[test]
    fn test_command_init_parses() {
        let cli = TestCli::try_parse_from(["test", "init"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Init(cmd) => {
                assert_eq!(cmd.skills_target.to_str().unwrap(), ".claude/skills");
            }
            _ => panic!("Expected Init command"),
        }
    }

    #[test]
    fn test_command_init_with_custom_source() {
        // skills_source is no longer a CLI argument since skills are now embedded
        // This test is no longer applicable
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

    // ─── Short ID tests ────────────────────────────────────────────────

    #[test]
    fn test_is_short_id_valid() {
        assert!(is_short_id("a1b2c3d4"));
        assert!(is_short_id("AABBCCDD"));
        assert!(is_short_id("00000000"));
        assert!(is_short_id("ffffffff"));
        assert!(is_short_id("12345678"));
    }

    #[test]
    fn test_is_short_id_invalid() {
        assert!(!is_short_id("a1b2c3d")); // 7 chars
        assert!(!is_short_id("a1b2c3d4e")); // 9 chars
        assert!(!is_short_id("")); // empty
        assert!(!is_short_id("a1b2c3d4-0000-4000-8000-000000000001")); // full UUID
        assert!(!is_short_id("zzzzzzzz")); // non-hex
        assert!(!is_short_id("a1b2-c3d")); // contains dash
    }

    #[test]
    fn test_parse_uuid_accepts_short_id() {
        let cli = TestCli::try_parse_from(["test", "show", "a1b2c3d4"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Show(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_parse_uuid_accepts_full_uuid() {
        let cli = TestCli::try_parse_from(["test", "show", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Show(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_parse_uuid_rejects_invalid_input() {
        // 7 chars - too short for short ID, not a UUID
        let result = TestCli::try_parse_from(["test", "show", "a1b2c3d"]);
        assert!(result.is_err());

        // non-hex chars
        let result = TestCli::try_parse_from(["test", "show", "zzzzzzzz"]);
        assert!(result.is_err());

        // arbitrary string
        let result = TestCli::try_parse_from(["test", "show", "not-valid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_uuid_short_id_in_depend_command() {
        let cli = TestCli::try_parse_from(["test", "depend", "a1b2c3d4", "--on", "e5f6a7b8"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Depend(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4");
                assert_eq!(cmd.blocker_id, "e5f6a7b8");
            }
            _ => panic!("Expected Depend command"),
        }
    }

    #[test]
    fn test_command_archive_parses_with_full_uuid() {
        let cli =
            TestCli::try_parse_from(["test", "archive", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Archive(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
            }
            _ => panic!("Expected Archive command"),
        }
    }

    #[test]
    fn test_command_archive_parses_with_short_id() {
        let cli = TestCli::try_parse_from(["test", "archive", "a1b2c3d4"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Archive(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4");
            }
            _ => panic!("Expected Archive command"),
        }
    }

    #[test]
    fn test_command_archive_requires_id() {
        let result = TestCli::try_parse_from(["test", "archive"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_archive_rejects_invalid_id() {
        let result = TestCli::try_parse_from(["test", "archive", "not-valid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_unarchive_parses_with_full_uuid() {
        let cli =
            TestCli::try_parse_from(["test", "unarchive", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Unarchive(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-000000000001");
            }
            _ => panic!("Expected Unarchive command"),
        }
    }

    #[test]
    fn test_command_unarchive_parses_with_short_id() {
        let cli = TestCli::try_parse_from(["test", "unarchive", "e5f6a7b8"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Unarchive(cmd) => {
                assert_eq!(cmd.id, "e5f6a7b8");
            }
            _ => panic!("Expected Unarchive command"),
        }
    }

    #[test]
    fn test_command_unarchive_requires_id() {
        let result = TestCli::try_parse_from(["test", "unarchive"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_list_include_archived_flag() {
        let cli = TestCli::try_parse_from(["test", "list", "--include-archived"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert!(
                    cmd.include_archived,
                    "include_archived should be true when --include-archived is passed"
                );
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_include_archived_default_false() {
        let cli = TestCli::try_parse_from(["test", "list"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert!(
                    !cmd.include_archived,
                    "include_archived should be false by default"
                );
            }
            _ => panic!("Expected List command"),
        }
    }
}
