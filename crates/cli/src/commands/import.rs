//! Import command for importing database from JSONL format
//!
//! Implements the `vtb import` command to import workflows, steps, tasks and relations
//! from a JSONL (JSON Lines) file for restoration or migration purposes.
//!
//! The import format matches the export format with UUIDv7 IDs.

use clap::Args;
use serde::Deserialize;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use surrealdb::sql::Thing;
use vertebrae_core::{ServiceError, VertebraeServices};
use vertebrae_db::{AgentConfig, CodeRef, Level, Priority, Section, Step, Task, Workflow};

/// Import database from JSONL format
#[derive(Debug, Args)]
pub struct ImportCommand {
    /// Input file path (reads from stdin if not specified)
    #[arg(short, long)]
    pub input: Option<PathBuf>,

    /// Skip records that already exist (by ID)
    #[arg(long, default_value = "false")]
    pub skip_existing: bool,
}

// ============================================================================
// Import Structs - mirror export structs with Deserialize
// ============================================================================

/// Imported workflow
#[derive(Debug, Deserialize)]
pub struct ImportedWorkflow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub initial_step_id: Option<String>,
    #[serde(default)]
    pub auto_advance: bool,
    #[serde(default)]
    pub order: i32,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Imported step
#[derive(Debug, Deserialize)]
pub struct ImportedStep {
    pub id: String,
    pub name: String,
    pub workflow_id: String,
    pub goal: Option<String>,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub agent_config: AgentConfig,
    #[serde(default)]
    pub is_final: bool,
    #[serde(default)]
    pub transitions_to: Vec<String>,
    #[serde(default)]
    pub order: i32,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Imported workflow transition
#[derive(Debug, Deserialize)]
pub struct ImportedWorkflowTransition {
    pub id: String,
    pub from_workflow_id: String,
    pub to_workflow_id: String,
    pub label: String,
    pub target_step_id: Option<String>,
}

/// Imported task
#[derive(Debug, Deserialize)]
pub struct ImportedTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub level: String,
    pub priority: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub code_refs: Vec<CodeRef>,
    pub needs_human_review: Option<bool>,
    pub revision_feedback: Option<String>,
    pub rejection_reason: Option<String>,
    pub workflow_id: Option<String>,
    pub current_step_id: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// A record in the import file
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ImportRecord {
    /// A workflow record
    #[serde(rename = "workflow")]
    Workflow(ImportedWorkflow),
    /// A step record
    #[serde(rename = "step")]
    Step(Box<ImportedStep>),
    /// A workflow transition record
    #[serde(rename = "workflow_transition")]
    WorkflowTransition(ImportedWorkflowTransition),
    /// A task record
    #[serde(rename = "task")]
    Task(Box<ImportedTask>),
    /// A parent-child relationship
    #[serde(rename = "child_of")]
    ChildOf {
        /// The child task ID
        child: String,
        /// The parent task ID
        parent: String,
    },
    /// A dependency relationship
    #[serde(rename = "depends_on")]
    DependsOn {
        /// The task that depends on another
        task: String,
        /// The task it depends on (the blocker)
        blocker: String,
    },
}

/// Result of the import command
pub struct ImportResult {
    /// Number of workflows imported
    pub workflows_imported: usize,
    /// Number of workflows skipped (already exist)
    pub workflows_skipped: usize,
    /// Number of steps imported
    pub steps_imported: usize,
    /// Number of steps skipped (already exist)
    pub steps_skipped: usize,
    /// Number of workflow transitions imported
    pub transitions_imported: usize,
    /// Number of workflow transitions skipped
    pub transitions_skipped: usize,
    /// Number of tasks imported
    pub tasks_imported: usize,
    /// Number of tasks skipped (already exist)
    pub tasks_skipped: usize,
    /// Number of child_of relations imported
    pub child_of_relations: usize,
    /// Number of depends_on relations imported
    pub depends_on_relations: usize,
    /// Input source
    pub source: String,
}

impl std::fmt::Display for ImportResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Import complete!")?;
        if self.workflows_imported > 0 || self.workflows_skipped > 0 {
            writeln!(f, "  Workflows imported: {}", self.workflows_imported)?;
            if self.workflows_skipped > 0 {
                writeln!(f, "  Workflows skipped: {}", self.workflows_skipped)?;
            }
        }
        if self.steps_imported > 0 || self.steps_skipped > 0 {
            writeln!(f, "  Steps imported: {}", self.steps_imported)?;
            if self.steps_skipped > 0 {
                writeln!(f, "  Steps skipped: {}", self.steps_skipped)?;
            }
        }
        if self.transitions_imported > 0 || self.transitions_skipped > 0 {
            writeln!(f, "  Transitions imported: {}", self.transitions_imported)?;
            if self.transitions_skipped > 0 {
                writeln!(f, "  Transitions skipped: {}", self.transitions_skipped)?;
            }
        }
        writeln!(f, "  Tasks imported: {}", self.tasks_imported)?;
        if self.tasks_skipped > 0 {
            writeln!(f, "  Tasks skipped: {}", self.tasks_skipped)?;
        }
        writeln!(f, "  Child relationships: {}", self.child_of_relations)?;
        writeln!(f, "  Dependencies: {}", self.depends_on_relations)?;
        write!(f, "  Source: {}", self.source)
    }
}

// ============================================================================
// Helper functions for type conversions
// ============================================================================

/// Parse Level from string
fn parse_level(s: &str) -> Level {
    match s.to_lowercase().as_str() {
        "epic" => Level::Epic,
        "ticket" => Level::Ticket,
        _ => Level::Task,
    }
}

/// Parse Priority from string
fn parse_priority(s: &str) -> Option<Priority> {
    match s.to_lowercase().as_str() {
        "low" => Some(Priority::Low),
        "medium" => Some(Priority::Medium),
        "high" => Some(Priority::High),
        "critical" => Some(Priority::Critical),
        _ => None,
    }
}

/// Parse an optional ISO 8601 datetime string
fn parse_datetime(s: &Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
    s.as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// Create a Thing from table name and ID string
fn make_thing(table: &str, id: &str) -> Thing {
    Thing::from((table.to_string(), id.to_string()))
}

impl ImportCommand {
    /// Execute the import command.
    ///
    /// Imports workflows, steps, tasks and relationships from JSONL format.
    /// Records are processed in dependency order: workflows → steps → transitions → tasks → relationships.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database operations fail or file I/O fails.
    #[allow(deprecated)]
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<ImportResult, ServiceError> {
        let (records, source) = self.read_records()?;

        let db = services.tasks().database();
        let mut result = ImportResult {
            workflows_imported: 0,
            workflows_skipped: 0,
            steps_imported: 0,
            steps_skipped: 0,
            transitions_imported: 0,
            transitions_skipped: 0,
            tasks_imported: 0,
            tasks_skipped: 0,
            child_of_relations: 0,
            depends_on_relations: 0,
            source,
        };

        // Pass 1: Import workflows
        for record in &records {
            if let ImportRecord::Workflow(workflow) = record {
                if db.workflows().exists(&workflow.id).await? {
                    if self.skip_existing {
                        result.workflows_skipped += 1;
                        continue;
                    }
                    db.workflows().delete(&workflow.id).await?;
                }

                let db_workflow = Workflow {
                    id: None,
                    name: workflow.name.clone(),
                    description: workflow.description.clone(),
                    initial_step: None, // Set after steps are imported
                    metadata: std::collections::HashMap::new(),
                    validation_gate_id: None,
                    auto_advance: workflow.auto_advance,
                    order: workflow.order,
                    created_at: parse_datetime(&workflow.created_at),
                    updated_at: parse_datetime(&workflow.updated_at),
                };
                db.workflows().create(&workflow.id, &db_workflow).await?;
                result.workflows_imported += 1;
            }
        }

        // Pass 2: Import steps
        for record in &records {
            if let ImportRecord::Step(step) = record {
                if db.steps().exists(&step.id).await? {
                    if self.skip_existing {
                        result.steps_skipped += 1;
                        continue;
                    }
                    db.steps().delete(&step.id).await?;
                }

                let db_step = Step {
                    id: None,
                    name: step.name.clone(),
                    workflow_id: make_thing("workflow", &step.workflow_id),
                    goal: step.goal.clone(),
                    agents: step.agents.clone(),
                    skills: step.skills.clone(),
                    agent_config: step.agent_config.clone(),
                    is_final: step.is_final,
                    order: step.order,
                    transitions_to: step
                        .transitions_to
                        .iter()
                        .map(|s| make_thing("step", s))
                        .collect(),
                    created_at: parse_datetime(&step.created_at),
                    updated_at: parse_datetime(&step.updated_at),
                };
                db.steps().create_with_id(&step.id, &db_step).await?;
                result.steps_imported += 1;
            }
        }

        // Pass 2b: Update workflow initial_step now that steps exist
        for record in &records {
            if let ImportRecord::Workflow(workflow) = record
                && let Some(ref initial_step_id) = workflow.initial_step_id
            {
                let updates = vertebrae_db::WorkflowUpdate {
                    name: None,
                    description: None,
                    metadata: None,
                    initial_step: Some(make_thing("step", initial_step_id)),
                    auto_advance: None,
                    order: None,
                };
                db.workflows().update(&workflow.id, &updates).await?;
            }
        }

        // Pass 3: Import workflow transitions
        for record in &records {
            if let ImportRecord::WorkflowTransition(transition) = record {
                // Check if transition already exists between these workflows
                if db
                    .workflow_transitions()
                    .exists(&transition.from_workflow_id, &transition.to_workflow_id)
                    .await?
                {
                    if self.skip_existing {
                        result.transitions_skipped += 1;
                        continue;
                    }
                    db.workflow_transitions()
                        .delete(&transition.from_workflow_id, &transition.to_workflow_id)
                        .await?;
                }

                db.workflow_transitions()
                    .create(
                        &transition.from_workflow_id,
                        &transition.to_workflow_id,
                        &transition.label,
                        transition.target_step_id.as_deref(),
                    )
                    .await?;
                result.transitions_imported += 1;
            }
        }

        // Pass 4: Import tasks
        for record in &records {
            if let ImportRecord::Task(task) = record {
                if db.tasks().exists(&task.id).await? {
                    if self.skip_existing {
                        result.tasks_skipped += 1;
                        continue;
                    }
                    db.tasks().delete(&task.id).await?;
                }

                let db_task = Task {
                    id: None,
                    title: task.title.clone(),
                    description: task.description.clone(),
                    level: parse_level(&task.level),
                    priority: task.priority.as_deref().and_then(parse_priority),
                    tags: task.tags.clone(),
                    sections: task.sections.clone(),
                    code_refs: task.code_refs.clone(),
                    needs_human_review: task.needs_human_review,
                    revision_feedback: task.revision_feedback.clone(),
                    rejection_reason: task.rejection_reason.clone(),
                    workflow_id: task
                        .workflow_id
                        .as_ref()
                        .map(|id| make_thing("workflow", id)),
                    current_step_id: task
                        .current_step_id
                        .as_ref()
                        .map(|id| make_thing("step", id)),
                    created_at: parse_datetime(&task.created_at),
                    updated_at: parse_datetime(&task.updated_at),
                    started_at: parse_datetime(&task.started_at),
                    completed_at: parse_datetime(&task.completed_at),
                };
                db.tasks().create(&task.id, &db_task).await?;
                result.tasks_imported += 1;
            }
        }

        // Pass 5: Import relationships (after all tasks exist)
        for record in &records {
            match record {
                ImportRecord::ChildOf { child, parent } => {
                    db.relationships().create_child_of(child, parent).await?;
                    result.child_of_relations += 1;
                }
                ImportRecord::DependsOn { task, blocker } => {
                    db.relationships().create_depends_on(task, blocker).await?;
                    result.depends_on_relations += 1;
                }
                _ => {
                    // Already handled in earlier passes
                }
            }
        }

        Ok(result)
    }

    /// Read records from the input source
    fn read_records(&self) -> Result<(Vec<ImportRecord>, String), ServiceError> {
        match &self.input {
            Some(path) => {
                let file = std::fs::File::open(path).map_err(|e| {
                    ServiceError::validation_failed(format!("{}: {}", path.display(), e))
                })?;
                let reader = std::io::BufReader::new(file);
                let records = self.parse_lines(reader, path)?;
                Ok((records, path.display().to_string()))
            }
            None => {
                let stdin = std::io::stdin();
                let reader = stdin.lock();
                let path = PathBuf::from("<stdin>");
                let records = self.parse_lines(reader, &path)?;
                Ok((records, "stdin".to_string()))
            }
        }
    }

    /// Parse lines from a reader into records
    fn parse_lines<R: BufRead>(
        &self,
        reader: R,
        path: &Path,
    ) -> Result<Vec<ImportRecord>, ServiceError> {
        let mut records = Vec::new();
        for (line_num, line) in reader.lines().enumerate() {
            let line = line.map_err(|e| {
                ServiceError::validation_failed(format!(
                    "{}: error reading line {}: {}",
                    path.display(),
                    line_num + 1,
                    e
                ))
            })?;

            // Skip empty lines
            if line.trim().is_empty() {
                continue;
            }

            let record: ImportRecord = serde_json::from_str(&line).map_err(|e| {
                ServiceError::validation_failed(format!(
                    "{}: error parsing line {}: {}",
                    path.display(),
                    line_num + 1,
                    e
                ))
            })?;
            records.push(record);
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_import_record_workflow_deserialization() {
        let json = r#"{"type":"workflow","id":"abc123","name":"Test Workflow","auto_advance":false,"order":0}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::Workflow(workflow) => {
                assert_eq!(workflow.id, "abc123");
                assert_eq!(workflow.name, "Test Workflow");
                assert!(!workflow.auto_advance);
            }
            _ => panic!("Expected Workflow record"),
        }
    }

    #[test]
    fn test_import_record_step_deserialization() {
        let json = r#"{"type":"step","id":"step123","name":"Review","workflow_id":"wf1","is_final":false,"order":1,"agent_config":{"model":"sonnet"}}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::Step(step) => {
                assert_eq!(step.id, "step123");
                assert_eq!(step.name, "Review");
                assert_eq!(step.workflow_id, "wf1");
            }
            _ => panic!("Expected Step record"),
        }
    }

    #[test]
    fn test_import_record_workflow_transition_deserialization() {
        let json = r#"{"type":"workflow_transition","id":"tr1","from_workflow_id":"wf1","to_workflow_id":"wf2","label":"Start"}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::WorkflowTransition(transition) => {
                assert_eq!(transition.id, "tr1");
                assert_eq!(transition.from_workflow_id, "wf1");
                assert_eq!(transition.to_workflow_id, "wf2");
                assert_eq!(transition.label, "Start");
            }
            _ => panic!("Expected WorkflowTransition record"),
        }
    }

    #[test]
    fn test_import_record_task_deserialization() {
        let json = r#"{"type":"task","id":"task123","title":"Test task","level":"task","tags":[],"sections":[],"code_refs":[]}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::Task(task) => {
                assert_eq!(task.id, "task123");
                assert_eq!(task.title, "Test task");
                assert_eq!(task.level, "task");
            }
            _ => panic!("Expected Task record"),
        }
    }

    #[test]
    fn test_import_record_child_of_deserialization() {
        let json = r#"{"type":"child_of","child":"child123","parent":"parent456"}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::ChildOf { child, parent } => {
                assert_eq!(child, "child123");
                assert_eq!(parent, "parent456");
            }
            _ => panic!("Expected ChildOf record"),
        }
    }

    #[test]
    fn test_import_record_depends_on_deserialization() {
        let json = r#"{"type":"depends_on","task":"task123","blocker":"blocker456"}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::DependsOn { task, blocker } => {
                assert_eq!(task, "task123");
                assert_eq!(blocker, "blocker456");
            }
            _ => panic!("Expected DependsOn record"),
        }
    }

    #[test]
    fn test_import_result_display() {
        let result = ImportResult {
            workflows_imported: 2,
            workflows_skipped: 0,
            steps_imported: 6,
            steps_skipped: 0,
            transitions_imported: 3,
            transitions_skipped: 0,
            tasks_imported: 10,
            tasks_skipped: 2,
            child_of_relations: 5,
            depends_on_relations: 3,
            source: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(output.contains("Import complete!"));
        assert!(output.contains("Workflows imported: 2"));
        assert!(output.contains("Steps imported: 6"));
        assert!(output.contains("Transitions imported: 3"));
        assert!(output.contains("Tasks imported: 10"));
        assert!(output.contains("Tasks skipped: 2"));
        assert!(output.contains("Child relationships: 5"));
        assert!(output.contains("Dependencies: 3"));
        assert!(output.contains("backup.jsonl"));
    }

    #[test]
    fn test_import_result_display_no_skipped() {
        let result = ImportResult {
            workflows_imported: 0,
            workflows_skipped: 0,
            steps_imported: 0,
            steps_skipped: 0,
            transitions_imported: 0,
            transitions_skipped: 0,
            tasks_imported: 10,
            tasks_skipped: 0,
            child_of_relations: 5,
            depends_on_relations: 3,
            source: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(!output.contains("Tasks skipped"));
        assert!(!output.contains("Workflows"));
    }

    #[test]
    fn test_import_command_debug() {
        let cmd = ImportCommand {
            input: Some(PathBuf::from("test.jsonl")),
            skip_existing: true,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ImportCommand"));
        assert!(debug_str.contains("test.jsonl"));
        assert!(debug_str.contains("skip_existing"));
    }

    #[test]
    fn test_parse_datetime() {
        let valid = Some("2024-01-15T10:30:00Z".to_string());
        let result = parse_datetime(&valid);
        assert!(result.is_some());

        let invalid = Some("not a date".to_string());
        let result = parse_datetime(&invalid);
        assert!(result.is_none());

        let none: Option<String> = None;
        let result = parse_datetime(&none);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_level() {
        assert!(matches!(parse_level("epic"), Level::Epic));
        assert!(matches!(parse_level("EPIC"), Level::Epic));
        assert!(matches!(parse_level("ticket"), Level::Ticket));
        assert!(matches!(parse_level("task"), Level::Task));
        assert!(matches!(parse_level("unknown"), Level::Task));
    }

    #[test]
    fn test_parse_priority() {
        assert!(matches!(parse_priority("low"), Some(Priority::Low)));
        assert!(matches!(parse_priority("HIGH"), Some(Priority::High)));
        assert!(matches!(
            parse_priority("critical"),
            Some(Priority::Critical)
        ));
        assert!(parse_priority("unknown").is_none());
    }
}
