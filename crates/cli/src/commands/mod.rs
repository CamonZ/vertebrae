//! CLI commands for Vertebrae
//!
//! This module contains all subcommand implementations for the vtb CLI.

#![allow(deprecated)]

pub mod add;
pub mod archive;
pub mod artifact;
pub mod blockers;
pub mod check_item;
pub mod criterion_ref;
pub mod delete;
pub mod depend;
pub mod init;
pub mod list;
pub mod path;
pub mod ready;
pub mod r#ref;
pub mod refs;
pub mod run;
pub mod run_workflow;
pub mod section;
pub mod sections;
pub mod show;
pub mod step;
pub mod stop;
pub mod transition_to;
pub mod uncheck_item;
pub mod undepend;
pub mod unref;
pub mod unsection;
pub mod update;
pub mod workflow;

pub use add::AddCommand;
pub use archive::{ArchiveCommand, UnarchiveCommand};
pub use artifact::ArtifactCommand;
pub use blockers::BlockersCommand;
pub use check_item::CheckItemCommand;
pub use criterion_ref::CriterionRefCommand;
pub use delete::DeleteCommand;
pub use depend::DependCommand;
pub use init::InitCommand;
pub use list::ListCommand;
pub use path::PathCommand;
pub use ready::ReadyCommand;
pub use r#ref::RefCommand;
pub use refs::RefsCommand;
pub use run::RunCommand;
pub use run_workflow::RunWorkflowCommand;
pub use section::SectionCommand;
pub use sections::SectionsCommand;
pub use show::ShowCommand;
pub use step::StepCommand;
pub use stop::StopCommand;
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
use serde_json::{self, json};
use vertebrae_core::{SectionType, ServiceError, VertebraeServices};

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

/// Build a UUID-only validator for a named field.
pub fn parse_full_uuid(field_name: &'static str) -> ValueParser {
    ValueParser::from(move |s: &str| -> Result<String, String> {
        uuid::Uuid::parse_str(s).map_err(|_| {
            format!(
                "{field_name} '{s}' is not a valid UUID \
                 (expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
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
    /// Manage project artifacts
    #[command(subcommand)]
    Artifact(ArtifactCommand),
    /// Show all tasks blocking a given task (recursive)
    Blockers(BlockersCommand),
    /// Add a code reference to a testing criterion
    #[command(name = "criterion-ref")]
    CriterionRef(CriterionRefCommand),
    /// Delete a task (with optional cascade)
    Delete(DeleteCommand),
    /// Create a dependency relationship between tasks
    Depend(DependCommand),
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
    /// Run the current step for a task
    Run(RunCommand),
    /// Start a TaskRun for a task's assigned workflow
    #[command(name = "start-taskrun")]
    RunWorkflow(RunWorkflowCommand),
    /// Add a typed content section to a task
    Section(SectionCommand),
    /// List all sections for a task
    Sections(SectionsCommand),
    /// Show full details of a task
    Show(ShowCommand),
    /// Stop the active TaskRun for a task
    #[command(name = "stop-taskrun")]
    Stop(StopCommand),
    /// Mark a checklist item as done within a task
    #[command(name = "check-item")]
    CheckItem(CheckItemCommand),
    /// First-class workflow step management commands
    #[command(subcommand)]
    Step(StepCommand),
    /// Transition a task to a specific workflow step
    #[command(name = "transition-to")]
    TransitionTo(TransitionToCommand),
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
    /// A JSON value to display (used when --json flag is set)
    Json(serde_json::Value),
}

fn json_value<T: serde::Serialize>(value: T) -> Result<serde_json::Value, ServiceError> {
    serde_json::to_value(value).map_err(|e| ServiceError::validation_failed(e.to_string()))
}

fn operation_result(
    command: &'static str,
    status: &'static str,
    fields: serde_json::Value,
) -> serde_json::Value {
    let mut result = serde_json::Map::new();
    result.insert("command".to_string(), json!(command));
    result.insert("status".to_string(), json!(status));
    if let serde_json::Value::Object(fields) = fields {
        for (key, value) in fields {
            result.insert(key, value);
        }
    }
    serde_json::Value::Object(result)
}

impl std::fmt::Display for CommandResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommandResult::Message(msg) => write!(f, "{}", msg),
            CommandResult::Table(table) => write!(f, "{}", table),
            CommandResult::Json(value) => {
                write!(
                    f,
                    "{}",
                    serde_json::to_string_pretty(value).unwrap_or_default()
                )
            }
        }
    }
}

/// Generic short-ID resolver helper.
///
/// If `id` is a short ID (8 hex chars), it is resolved through `resolve_fn`.
/// Otherwise the value is returned unchanged. Errors from the resolver are
/// rewrapped with an entity-scoped message to keep CLI output informative
/// (e.g. "workflow with prefix 'deadbeef' not found").
///
/// This helper centralises short-ID handling so that adding a new entity is
/// one new resolver wiring, not a copy-paste of the same shape three times.
async fn resolve_short_id_generic<F, Fut>(
    id: &str,
    entity: &str,
    resolve_fn: F,
) -> Result<String, ServiceError>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, ServiceError>>,
{
    if !is_short_id(id) {
        return Ok(id.to_string());
    }

    let prefix = id.to_lowercase();
    match resolve_fn(prefix.clone()).await {
        Ok(full_id) => Ok(full_id),
        Err(err) => Err(scope_short_id_error(err, entity, &prefix)),
    }
}

/// Rewrite a short-id resolution error to be entity-scoped.
///
/// Inspects the underlying error message for hints from the backend
/// (`:not_found`, `:invalid_prefix`, `ambiguous`) and produces a
/// human-readable, entity-scoped message. Falls through to the original
/// error otherwise so unexpected failures aren't masked.
fn scope_short_id_error(err: ServiceError, entity: &str, prefix: &str) -> ServiceError {
    let msg = err.to_string();
    let lower = msg.to_lowercase();

    if lower.contains("invalid_prefix") || lower.contains("invalid prefix") {
        return ServiceError::validation_failed(format!(
            "invalid short ID '{}' for {}: must be 1-8 hex characters",
            prefix, entity
        ));
    }

    if lower.contains("ambiguous") {
        // Preserve any candidate list the backend produced.
        return ServiceError::validation_failed(format!(
            "ambiguous {} prefix '{}': {}",
            entity, prefix, msg
        ));
    }

    if lower.contains("not_found") || lower.contains("not found") {
        return ServiceError::validation_failed(format!(
            "{} with prefix '{}' not found",
            entity, prefix
        ));
    }

    err
}

/// Resolve a task short ID via the task service.
async fn resolve_id(id: &str, services: &VertebraeServices) -> Result<String, ServiceError> {
    resolve_short_id_generic(id, "task", |p| async move {
        services.tasks().resolve_short_id(&p).await
    })
    .await
}

/// Resolve a workflow short ID via the workflow service.
async fn resolve_workflow_id(
    id: &str,
    services: &VertebraeServices,
) -> Result<String, ServiceError> {
    resolve_short_id_generic(id, "workflow", |p| async move {
        services.workflows().resolve_short_id(&p).await
    })
    .await
}

/// Resolve a step short ID via the step service.
///
/// `workflow_id` should be the (already-resolved) full workflow UUID when the
/// command has one in scope. Passing `None` falls back to a project-wide scan.
pub(crate) async fn resolve_step_id(
    id: &str,
    workflow_id: Option<&str>,
    services: &VertebraeServices,
) -> Result<String, ServiceError> {
    let wf_owned = workflow_id.map(|s| s.to_string());
    resolve_short_id_generic(id, "step", |p| async move {
        services
            .steps()
            .resolve_short_id(&p, wf_owned.as_deref())
            .await
    })
    .await
}

/// Resolve an optional ID field in place using `resolver`.
///
/// `resolver` already short-circuits non-short-id input, so we just need to
/// skip `None` and empty strings here.
async fn resolve_optional<F, Fut>(id: &mut Option<String>, resolver: F) -> Result<(), ServiceError>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, ServiceError>>,
{
    if let Some(val) = id.as_ref()
        && !val.is_empty()
        && is_short_id(val)
    {
        *id = Some(resolver(val.clone()).await?);
    }
    Ok(())
}

async fn resolve_optional_id(
    id: &mut Option<String>,
    services: &VertebraeServices,
) -> Result<(), ServiceError> {
    resolve_optional(id, |v| async move { resolve_id(&v, services).await }).await
}

async fn resolve_optional_workflow_id(
    id: &mut Option<String>,
    services: &VertebraeServices,
) -> Result<(), ServiceError> {
    resolve_optional(
        id,
        |v| async move { resolve_workflow_id(&v, services).await },
    )
    .await
}

async fn resolve_optional_step_id(
    id: &mut Option<String>,
    workflow_id: Option<&str>,
    services: &VertebraeServices,
) -> Result<(), ServiceError> {
    resolve_optional(id, |v| async move {
        resolve_step_id(&v, workflow_id, services).await
    })
    .await
}

/// Resolved checklist item details.
pub(crate) struct ResolvedChecklistItem {
    pub id: String,
    pub content: String,
    pub section_order: u32,
    pub done: bool,
}

/// Resolve a checklist item from a task by its 1-based index.
///
/// Validates the index, fetches the task, filters to checklist item sections,
/// sorts by order, and returns the resolved item details.
pub(crate) async fn resolve_checklist_item(
    services: &VertebraeServices,
    id: &str,
    index: usize,
) -> Result<ResolvedChecklistItem, ServiceError> {
    let id = id.to_lowercase();

    if index == 0 {
        return Err(ServiceError::validation_failed(
            "Checklist item index must be 1 or greater",
        ));
    }

    let task = services.tasks().get_task(&id).await?;

    let mut items: Vec<&vertebrae_core::Section> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    let item_idx = index - 1;
    if item_idx >= items.len() {
        return Err(ServiceError::validation_failed(format!(
            "Checklist item {} not found. Task has {} checklist item(s).",
            index,
            items.len()
        )));
    }

    let item = items[item_idx];

    Ok(ResolvedChecklistItem {
        id,
        content: item.content.clone(),
        section_order: item.order.unwrap_or(0),
        done: item.done.unwrap_or(false),
    })
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
                resolve_optional_workflow_id(&mut cmd.workflow, services).await?;
            }
            Command::Archive(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Artifact(cmd) => cmd.resolve_ids(services).await?,
            Command::Blockers(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::CriterionRef(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Delete(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Depend(cmd) => {
                cmd.id = resolve_id(&cmd.id, services).await?;
                cmd.blocker_id = resolve_id(&cmd.blocker_id, services).await?;
            }
            Command::Init(_) | Command::Ready(_) => {}
            Command::List(cmd) => {
                resolve_optional_id(&mut cmd.parent, services).await?;
                resolve_optional_workflow_id(&mut cmd.workflow, services).await?;
                let workflow = cmd.workflow.clone();
                resolve_optional_step_id(&mut cmd.step, workflow.as_deref(), services).await?;
            }
            Command::Path(cmd) => {
                cmd.from_id = resolve_id(&cmd.from_id, services).await?;
                cmd.to_id = resolve_id(&cmd.to_id, services).await?;
            }
            Command::Ref(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Refs(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Run(cmd) => cmd.task_id = resolve_id(&cmd.task_id, services).await?,
            Command::RunWorkflow(cmd) => cmd.task_id = resolve_id(&cmd.task_id, services).await?,
            Command::Section(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Sections(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Show(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Stop(cmd) => cmd.task_id = resolve_id(&cmd.task_id, services).await?,
            Command::Unarchive(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::UncheckItem(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Undepend(cmd) => {
                cmd.id = resolve_id(&cmd.id, services).await?;
                cmd.blocker_id = resolve_id(&cmd.blocker_id, services).await?;
            }
            Command::Unref(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Unsection(cmd) => cmd.id = resolve_id(&cmd.id, services).await?,
            Command::Step(cmd) => match cmd {
                step::StepCommand::Add(c) => {
                    c.workflow = resolve_workflow_id(&c.workflow, services).await?;
                    let wf = c.workflow.clone();
                    resolve_optional_step_id(&mut c.id, Some(&wf), services).await?;
                    for t in &mut c.transitions_to {
                        *t = resolve_step_id(t, Some(&wf), services).await?;
                    }
                }
                step::StepCommand::List(c) => {
                    c.workflow = resolve_workflow_id(&c.workflow, services).await?;
                }
                step::StepCommand::Show(c) => {
                    c.id = resolve_step_id(&c.id, None, services).await?;
                }
                step::StepCommand::Update(c) => {
                    c.id = resolve_step_id(&c.id, None, services).await?;
                    // For --transition-to we don't have a workflow in the args,
                    // but each target step still resolves project-wide.
                    for t in &mut c.transitions_to {
                        *t = resolve_step_id(t, None, services).await?;
                    }
                }
                step::StepCommand::Delete(c) => {
                    c.id = resolve_step_id(&c.id, None, services).await?;
                }
            },
            Command::Workflow(cmd) => match cmd {
                workflow::WorkflowCommand::Add(_) | workflow::WorkflowCommand::List(_) => {}
                workflow::WorkflowCommand::Unassign(c) => {
                    c.task_id = resolve_id(&c.task_id, services).await?;
                }
                workflow::WorkflowCommand::Show(c) => {
                    c.id = resolve_workflow_id(&c.id, services).await?;
                }
                workflow::WorkflowCommand::Update(c) => {
                    c.id = resolve_workflow_id(&c.id, services).await?;
                }
                workflow::WorkflowCommand::Delete(c) => {
                    c.id = resolve_workflow_id(&c.id, services).await?;
                }
                workflow::WorkflowCommand::Assign(c) => {
                    c.task_id = resolve_id(&c.task_id, services).await?;
                    c.workflow_id = resolve_workflow_id(&c.workflow_id, services).await?;
                }
                workflow::WorkflowCommand::Transition(t) => match t {
                    workflow::TransitionCommand::Add(c) => {
                        c.from_workflow_id =
                            resolve_workflow_id(&c.from_workflow_id, services).await?;
                        c.to_workflow_id = resolve_workflow_id(&c.to_workflow_id, services).await?;
                        let to_wf = c.to_workflow_id.clone();
                        resolve_optional_step_id(&mut c.target_step, Some(&to_wf), services)
                            .await?;
                    }
                    workflow::TransitionCommand::Delete(c) => {
                        c.from_workflow_id =
                            resolve_workflow_id(&c.from_workflow_id, services).await?;
                        c.to_workflow_id = resolve_workflow_id(&c.to_workflow_id, services).await?;
                    }
                    workflow::TransitionCommand::List(_) => {}
                },
            },
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
            Command::Artifact(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::Blockers(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::CriterionRef(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
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
            Command::Ref(cmd) => {
                // Service handles notification via callback
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Refs(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(format!("{}", result)))
            }
            Command::Run(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
            }
            Command::RunWorkflow(cmd) => {
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
            Command::Stop(cmd) => {
                let result = cmd.execute(services).await?;
                Ok(CommandResult::Message(result))
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

    /// Execute the command and return JSON output.
    ///
    /// Every command has an explicit JSON contract. Human-readable prose stays
    /// on the normal `execute` path.
    pub async fn execute_json(
        &self,
        services: &VertebraeServices,
    ) -> Result<CommandResult, ServiceError> {
        let json = match self {
            Command::Add(cmd) => {
                let task_id = cmd.execute(services).await?;
                operation_result("add", "created", json!({ "task_id": task_id }))
            }
            Command::Archive(cmd) => {
                cmd.execute(services).await?;
                operation_result(
                    "archive",
                    "updated",
                    json!({ "task_id": cmd.id.to_lowercase(), "archived": true }),
                )
            }
            Command::Artifact(cmd) => cmd.execute_json(services).await?,
            Command::Show(cmd) => {
                let detail = cmd.execute(services).await?;
                json_value(&detail)?
            }
            Command::List(cmd) => {
                let tasks = cmd.execute(services).await?;
                json_value(&tasks)?
            }
            Command::Blockers(cmd) => json_value(cmd.execute(services).await?)?,
            Command::CriterionRef(cmd) => {
                let result = cmd.execute(services).await?;
                operation_result(
                    "criterion-ref",
                    "created",
                    json!({
                        "task_id": result.task_id,
                        "criterion_index": result.criterion_index,
                        "criterion_content": result.criterion_content,
                        "path": result.path,
                        "line_start": result.line_start,
                        "line_end": result.line_end,
                        "name": result.name,
                        "warning": result.warning,
                    }),
                )
            }
            Command::Delete(cmd) => {
                let result = cmd.execute_result(services).await?;
                operation_result(
                    "delete",
                    if result.deleted {
                        "deleted"
                    } else {
                        "cancelled"
                    },
                    json_value(result)?,
                )
            }
            Command::Depend(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Init(cmd) => {
                let result = cmd
                    .execute()
                    .await
                    .map_err(|e| ServiceError::validation_failed(e.to_string()))?;
                json_value(result)?
            }
            Command::Path(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Ready(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Ref(cmd) => {
                let result = cmd.execute(services).await?;
                operation_result(
                    "ref",
                    "created",
                    json!({
                        "task_id": result.id,
                        "path": result.path,
                        "line_start": result.line_start,
                        "line_end": result.line_end,
                        "name": result.name,
                        "warning": result.warning,
                    }),
                )
            }
            Command::Refs(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Run(cmd) => json_value(cmd.execute_result(services).await?)?,
            Command::RunWorkflow(cmd) => json_value(cmd.execute_result(services).await?)?,
            Command::Section(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Sections(cmd) => {
                let result = cmd.execute(services).await?;
                json_value(&result)?
            }
            Command::Stop(cmd) => json_value(cmd.execute_result(services).await?)?,
            Command::Unarchive(cmd) => {
                cmd.execute(services).await?;
                operation_result(
                    "unarchive",
                    "updated",
                    json!({ "task_id": cmd.id.to_lowercase(), "archived": false }),
                )
            }
            Command::UncheckItem(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Undepend(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Unref(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Unsection(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Step(step::StepCommand::List(cmd)) => {
                let steps = cmd.list_steps(services.steps()).await?;
                json_value(&steps)?
            }
            Command::Step(step::StepCommand::Show(cmd)) => {
                let step = cmd.get_step(services.steps()).await?;
                json_value(&step)?
            }
            Command::Step(step::StepCommand::Add(cmd)) => {
                let step_id = cmd.execute_result(services.steps()).await?;
                operation_result(
                    "step add",
                    "created",
                    json!({ "step_id": step_id, "workflow_id": cmd.workflow.to_lowercase() }),
                )
            }
            Command::Step(step::StepCommand::Update(cmd)) => {
                cmd.execute(services.steps()).await?;
                operation_result(
                    "step update",
                    "updated",
                    json!({ "step_id": cmd.id.to_lowercase() }),
                )
            }
            Command::Step(step::StepCommand::Delete(cmd)) => {
                cmd.execute(services.steps()).await?;
                operation_result(
                    "step delete",
                    "deleted",
                    json!({ "step_id": cmd.id.to_lowercase() }),
                )
            }
            Command::CheckItem(cmd) => json_value(cmd.execute(services).await?)?,
            Command::TransitionTo(cmd) => json_value(cmd.execute(services).await?)?,
            Command::Update(cmd) => {
                let task_id = cmd.execute(services).await?;
                operation_result("update", "updated", json!({ "task_id": task_id }))
            }
            Command::Workflow(workflow::WorkflowCommand::List(_cmd)) => {
                let workflows = services.workflows().list_workflows().await?;
                json_value(workflows)?
            }
            Command::Workflow(workflow::WorkflowCommand::Show(cmd)) => {
                let detail = cmd.execute_detail(services).await?;
                json_value(&detail)?
            }
            Command::Workflow(workflow::WorkflowCommand::Add(cmd)) => {
                let workflow_id = cmd.execute_result(services.workflows()).await?;
                operation_result(
                    "workflow add",
                    "created",
                    json!({ "workflow_id": workflow_id }),
                )
            }
            Command::Workflow(workflow::WorkflowCommand::Update(cmd)) => {
                cmd.execute(services.workflows()).await?;
                operation_result(
                    "workflow update",
                    "updated",
                    json!({ "workflow_id": cmd.id.to_lowercase() }),
                )
            }
            Command::Workflow(workflow::WorkflowCommand::Delete(cmd)) => {
                cmd.execute(services.workflows()).await?;
                operation_result(
                    "workflow delete",
                    "deleted",
                    json!({ "workflow_id": cmd.id.to_lowercase() }),
                )
            }
            Command::Workflow(workflow::WorkflowCommand::Assign(cmd)) => {
                cmd.execute(services.workflows()).await?;
                operation_result(
                    "workflow assign",
                    "updated",
                    json!({ "task_id": cmd.task_id.to_lowercase(), "workflow_id": cmd.workflow_id.to_lowercase() }),
                )
            }
            Command::Workflow(workflow::WorkflowCommand::Unassign(cmd)) => {
                cmd.execute(services.workflows()).await?;
                operation_result(
                    "workflow unassign",
                    "updated",
                    json!({ "task_id": cmd.task_id.to_lowercase(), "workflow_id": null }),
                )
            }
            Command::Workflow(workflow::WorkflowCommand::Transition(cmd)) => match cmd {
                workflow::transition::TransitionCommand::List(cmd) => json_value(
                    services
                        .workflows()
                        .list_workflow_transitions(cmd.workflow_id.as_deref())
                        .await?,
                )?,
                workflow::transition::TransitionCommand::Add(cmd) => {
                    let transition = services
                        .workflows()
                        .create_workflow_transition(
                            &cmd.from_workflow_id,
                            &cmd.to_workflow_id,
                            &cmd.label,
                            cmd.target_step.as_deref(),
                        )
                        .await?;
                    json_value(transition)?
                }
                workflow::transition::TransitionCommand::Delete(cmd) => {
                    cmd.execute(services.workflows()).await?;
                    operation_result(
                        "workflow transition delete",
                        "deleted",
                        json!({ "from_workflow_id": cmd.from_workflow_id.to_lowercase(), "to_workflow_id": cmd.to_workflow_id.to_lowercase() }),
                    )
                }
            },
        };
        Ok(CommandResult::Json(json))
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
    fn test_command_execution_family_is_not_available() {
        let cli = TestCli::try_parse_from(["test", "execution", "list", "a1b2c3d4"]);
        assert!(
            cli.is_err(),
            "execution command family should be hidden from the CLI"
        );
    }

    #[test]
    fn test_command_manifest_family_is_not_available() {
        let cli = TestCli::try_parse_from(["test", "manifest", "print"]);
        assert!(
            cli.is_err(),
            "manifest command family should be hidden from the CLI"
        );
    }

    #[test]
    fn test_command_start_taskrun_parses_as_run_workflow() {
        let cli = TestCli::try_parse_from(["test", "start-taskrun", "a1b2c3d4"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::RunWorkflow(cmd) => {
                assert_eq!(cmd.task_id, "a1b2c3d4");
            }
            _ => panic!("Expected RunWorkflow command"),
        }
    }

    #[test]
    fn test_command_run_workflow_alias_is_not_available() {
        let cli = TestCli::try_parse_from(["test", "run-workflow", "a1b2c3d4"]);
        assert!(
            cli.is_err(),
            "run-workflow alias should not be part of the CLI surface"
        );
    }

    #[test]
    fn test_command_stop_taskrun_parses_as_stop() {
        let cli = TestCli::try_parse_from(["test", "stop-taskrun", "a1b2c3d4"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Stop(cmd) => {
                assert_eq!(cmd.task_id, "a1b2c3d4");
            }
            _ => panic!("Expected Stop command"),
        }
    }

    #[test]
    fn test_command_stop_alias_is_not_available() {
        let cli = TestCli::try_parse_from(["test", "stop", "a1b2c3d4"]);
        assert!(
            cli.is_err(),
            "stop alias should not be part of the CLI surface"
        );
    }

    #[test]
    fn test_command_stop_workflow_alias_is_not_available() {
        let cli = TestCli::try_parse_from(["test", "stop-workflow", "a1b2c3d4"]);
        assert!(
            cli.is_err(),
            "stop-workflow alias should not be part of the CLI surface"
        );
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
        assert!(cli.is_err());
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
    fn test_command_list_with_step_full_uuid() {
        let cli = TestCli::try_parse_from([
            "test",
            "list",
            "--step",
            "a1b2c3d4-0000-4000-8000-000000000001",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(
                    cmd.step,
                    Some("a1b2c3d4-0000-4000-8000-000000000001".to_string())
                );
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_with_step_short_id() {
        let cli = TestCli::try_parse_from(["test", "list", "--step", "a1b2c3d4"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::List(cmd) => {
                assert_eq!(cmd.step, Some("a1b2c3d4".to_string()));
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_command_list_invalid_step_uuid_errors_clearly() {
        let result = TestCli::try_parse_from(["test", "list", "--step", "not-a-uuid"]);
        let err = match result {
            Ok(_) => panic!("expected --step with invalid UUID to fail, but parsing succeeded"),
            Err(e) => e,
        };
        let err_msg = err.to_string();
        assert!(
            err_msg.contains("step ID"),
            "expected error message to mention 'step ID', got: {}",
            err_msg
        );
        assert!(
            err_msg.contains("not a valid UUID"),
            "expected error message to mention validity, got: {}",
            err_msg
        );
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
    fn test_command_transition_to_accepts_step_name_as_target() {
        let cli = TestCli::try_parse_from([
            "test",
            "transition-to",
            "a1b2c3d4-0000-4000-8000-000000000001",
            "in_progress",
        ]);
        assert!(cli.is_ok(), "step names should be accepted as target");
        let Command::TransitionTo(cmd) = cli.unwrap().command else {
            panic!("expected TransitionTo");
        };
        assert_eq!(cmd.target, "in_progress");
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
    fn test_command_workflow_transition_add_parses_required_label_and_positionals() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "transition",
            "add",
            "a1b2c3d4",
            "11111111-2222-4333-8444-555555555555",
            "--label",
            "approve",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Transition(
                workflow::transition::TransitionCommand::Add(cmd),
            )) => {
                assert_eq!(cmd.from_workflow_id, "a1b2c3d4");
                assert_eq!(cmd.to_workflow_id, "11111111-2222-4333-8444-555555555555");
                assert_eq!(cmd.label, "approve");
                assert_eq!(cmd.target_step, None);
            }
            _ => panic!("Expected Workflow Transition Add command"),
        }
    }

    #[test]
    fn test_command_workflow_transition_add_parses_short_flag_aliases() {
        let cli = TestCli::try_parse_from([
            "test",
            "workflow",
            "transition",
            "add",
            "a1b2c3d4",
            "e5f6a7b8",
            "-l",
            "escalate",
            "-t",
            "1234abcd",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Workflow(WorkflowCommand::Transition(
                workflow::transition::TransitionCommand::Add(cmd),
            )) => {
                assert_eq!(cmd.from_workflow_id, "a1b2c3d4");
                assert_eq!(cmd.to_workflow_id, "e5f6a7b8");
                assert_eq!(cmd.label, "escalate");
                assert_eq!(cmd.target_step.as_deref(), Some("1234abcd"));
            }
            _ => panic!("Expected Workflow Transition Add command"),
        }
    }

    #[test]
    fn test_command_workflow_transition_add_requires_label() {
        let result = TestCli::try_parse_from([
            "test",
            "workflow",
            "transition",
            "add",
            "a1b2c3d4",
            "e5f6a7b8",
        ]);
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
    fn test_parse_uuid_short_id_in_undepend_command() {
        let cli = TestCli::try_parse_from(["test", "undepend", "a1b2c3d4", "--on", "e5f6a7b8"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            Command::Undepend(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4");
                assert_eq!(cmd.blocker_id, "e5f6a7b8");
            }
            _ => panic!("Expected Undepend command"),
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

    #[test]
    fn test_command_result_json_display() {
        let json = serde_json::json!({"id": "abc123", "title": "Test task"});
        let result = CommandResult::Json(json);
        let output = format!("{}", result);
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            parsed["id"], "abc123",
            "JSON output should contain the id field"
        );
        assert_eq!(
            parsed["title"], "Test task",
            "JSON output should contain the title field"
        );
    }

    #[test]
    fn test_command_result_json_display_with_nested_data() {
        let json = serde_json::json!({
            "tasks": [
                {"id": "task1", "title": "First"},
                {"id": "task2", "title": "Second"}
            ]
        });
        let result = CommandResult::Json(json);
        let output = format!("{}", result);
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            parsed["tasks"].as_array().unwrap().len(),
            2,
            "JSON output should contain 2 tasks"
        );
        assert_eq!(parsed["tasks"][0]["id"], "task1");
        assert_eq!(parsed["tasks"][1]["id"], "task2");
    }

    #[test]
    fn test_command_result_json_displays_operation_result() {
        let json = serde_json::json!({
            "command": "add",
            "status": "created",
            "task_id": "abc-123"
        });
        let result = CommandResult::Json(json);
        let output = format!("{}", result);
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert!(parsed.get("output").is_none());
        assert_eq!(parsed["command"], "add");
        assert_eq!(parsed["status"], "created");
        assert_eq!(parsed["task_id"], "abc-123");
    }

    #[test]
    fn test_command_result_message_display() {
        let result = CommandResult::Message("Hello world".to_string());
        assert_eq!(format!("{}", result), "Hello world");
    }

    #[test]
    fn test_command_result_table_display() {
        let result = CommandResult::Table("col1 | col2\nval1 | val2".to_string());
        assert_eq!(format!("{}", result), "col1 | col2\nval1 | val2");
    }
}
