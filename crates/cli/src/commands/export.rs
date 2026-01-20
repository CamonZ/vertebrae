//! Export command for exporting database to JSONL format
//!
//! Implements the `vtb export` command to export all data to a portable
//! JSONL (JSON Lines) file for backup, migration, or import into other databases.
//!
//! The export format uses UUIDv7 IDs for portability and time-ordering.
//! All original IDs are transformed to UUIDv7 with consistent foreign key references.

use chrono::Utc;
use clap::Args;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::{AgentConfig, CodeRef, Section};

/// Export database to JSONL format
#[derive(Debug, Args)]
pub struct ExportCommand {
    /// Output file path (defaults to vtb-export-YYYYMMDD-HHMMSS.jsonl)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

// ============================================================================
// ID Mapping - transforms old IDs to UUIDv7, preserves existing UUIDs
// ============================================================================

/// Check if a string is a valid UUID (with or without hyphens)
#[cfg(test)]
fn is_valid_uuid(s: &str) -> bool {
    // Try parsing as UUID (handles both hyphenated and simple formats)
    Uuid::try_parse(s).is_ok()
}

/// Normalize an ID: if it's a valid UUID, format with hyphens; otherwise generate new UUIDv7
fn normalize_or_generate(old_id: &str) -> String {
    if let Ok(uuid) = Uuid::try_parse(old_id) {
        // Already a valid UUID, return with standard hyphenated format
        uuid.to_string()
    } else {
        // Old-style ID, generate new UUIDv7
        Uuid::now_v7().to_string()
    }
}

/// Maps old IDs to new UUIDv7 IDs for each entity type.
/// Preserves existing UUIDs (normalizing to hyphenated format).
/// Only generates new UUIDv7s for old-style IDs (like `x123456`).
#[derive(Debug, Default)]
struct IdMapper {
    workflows: HashMap<String, String>,
    steps: HashMap<String, String>,
    tasks: HashMap<String, String>,
    workflow_transitions: HashMap<String, String>,
}

impl IdMapper {
    fn new() -> Self {
        Self::default()
    }

    /// Get or create a UUIDv7 for a workflow ID
    fn workflow(&mut self, old_id: &str) -> String {
        self.workflows
            .entry(old_id.to_string())
            .or_insert_with(|| normalize_or_generate(old_id))
            .clone()
    }

    /// Get or create a UUIDv7 for a step ID
    fn step(&mut self, old_id: &str) -> String {
        self.steps
            .entry(old_id.to_string())
            .or_insert_with(|| normalize_or_generate(old_id))
            .clone()
    }

    /// Get or create a UUIDv7 for a task ID
    fn task(&mut self, old_id: &str) -> String {
        self.tasks
            .entry(old_id.to_string())
            .or_insert_with(|| normalize_or_generate(old_id))
            .clone()
    }

    /// Get or create a UUIDv7 for a workflow transition ID
    fn workflow_transition(&mut self, old_id: &str) -> String {
        self.workflow_transitions
            .entry(old_id.to_string())
            .or_insert_with(|| normalize_or_generate(old_id))
            .clone()
    }

    /// Look up a workflow ID (must already exist)
    fn get_workflow(&self, old_id: &str) -> Option<String> {
        self.workflows.get(old_id).cloned()
    }

    /// Look up a step ID (must already exist)
    fn get_step(&self, old_id: &str) -> Option<String> {
        self.steps.get(old_id).cloned()
    }

    /// Look up a task ID (must already exist)
    fn get_task(&self, old_id: &str) -> Option<String> {
        self.tasks.get(old_id).cloned()
    }

    /// Look up a workflow transition ID (must already exist)
    fn get_workflow_transition(&self, old_id: &str) -> Option<String> {
        self.workflow_transitions.get(old_id).cloned()
    }
}

// ============================================================================
// Clean Export Structs - portable format with string IDs
// ============================================================================

/// Exported workflow with string IDs
#[derive(Debug, Serialize)]
pub struct ExportedWorkflow {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_step_id: Option<String>,
    pub auto_advance: bool,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Exported step with string IDs
#[derive(Debug, Serialize)]
pub struct ExportedStep {
    pub id: String,
    pub name: String,
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    pub agent_config: AgentConfig,
    pub is_final: bool,
    /// Step IDs this step can transition to
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions_to: Vec<String>,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Exported workflow transition with string IDs
#[derive(Debug, Serialize)]
pub struct ExportedWorkflowTransition {
    pub id: String,
    pub from_workflow_id: String,
    pub to_workflow_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_step_id: Option<String>,
}

/// Exported task with string IDs
#[derive(Debug, Serialize)]
pub struct ExportedTask {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<Section>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub code_refs: Vec<CodeRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_human_review: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_feedback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// A record in the export file
///
/// Records are ordered by dependency: workflows first, then steps,
/// then workflow_transitions, then tasks, then relationships.
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ExportRecord {
    #[serde(rename = "workflow")]
    Workflow(ExportedWorkflow),
    #[serde(rename = "step")]
    Step(Box<ExportedStep>),
    #[serde(rename = "workflow_transition")]
    WorkflowTransition(ExportedWorkflowTransition),
    #[serde(rename = "task")]
    Task(Box<ExportedTask>),
    #[serde(rename = "child_of")]
    ChildOf { child: String, parent: String },
    #[serde(rename = "depends_on")]
    DependsOn { task: String, blocker: String },
}

/// Result of the export command
pub struct ExportResult {
    /// Number of workflows exported
    pub workflows: usize,
    /// Number of steps exported
    pub steps: usize,
    /// Number of workflow transitions exported
    pub workflow_transitions: usize,
    /// Number of tasks exported
    pub tasks: usize,
    /// Number of child_of relations exported
    pub child_of_relations: usize,
    /// Number of depends_on relations exported
    pub depends_on_relations: usize,
    /// Output destination
    pub destination: String,
}

impl std::fmt::Display for ExportResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Export complete!")?;
        writeln!(f, "  Workflows: {}", self.workflows)?;
        writeln!(f, "  Steps: {}", self.steps)?;
        writeln!(f, "  Workflow transitions: {}", self.workflow_transitions)?;
        writeln!(f, "  Tasks: {}", self.tasks)?;
        writeln!(f, "  Child relationships: {}", self.child_of_relations)?;
        writeln!(f, "  Dependencies: {}", self.depends_on_relations)?;
        write!(f, "  Output: {}", self.destination)
    }
}

impl ExportCommand {
    /// Execute the export command.
    ///
    /// Exports all workflows, steps, tasks, and relationships to JSONL format.
    /// Records are ordered by dependency to allow sequential import.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database queries fail or file I/O fails.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<ExportResult, ServiceError> {
        let mut records: Vec<ExportRecord> = Vec::new();
        let mut mapper = IdMapper::new();
        let db = service.database();

        // ===================================================================
        // Phase 1: Populate ID mappings (must be done before creating records)
        // ===================================================================

        // 1a. Map workflow IDs
        let workflows = db.workflows().export_all().await?;
        for (old_id, _) in &workflows {
            mapper.workflow(old_id);
        }

        // 1b. Map step IDs
        let steps = db.steps().list().await?;
        for step in &steps {
            if let Some(thing) = &step.id {
                mapper.step(&thing.id.to_raw());
            }
        }

        // 1c. Map workflow transition IDs
        let transitions = db.workflow_transitions().list_all().await?;
        for transition in &transitions {
            if let Some(thing) = &transition.id {
                mapper.workflow_transition(&thing.id.to_raw());
            }
        }

        // 1d. Map task IDs
        let tasks = db.tasks().export_all().await?;
        for (old_id, _) in &tasks {
            mapper.task(old_id);
        }

        // ===================================================================
        // Phase 2: Create export records with transformed UUIDv7 IDs
        // ===================================================================

        // 2a. Export workflows
        let workflow_count = workflows.len();
        for (old_id, workflow) in workflows {
            let new_id = mapper.get_workflow(&old_id).unwrap_or_default();
            let initial_step_id = workflow
                .initial_step
                .and_then(|t| mapper.get_step(&t.id.to_raw()));

            records.push(ExportRecord::Workflow(ExportedWorkflow {
                id: new_id,
                name: workflow.name,
                description: workflow.description,
                initial_step_id,
                auto_advance: workflow.auto_advance,
                order: workflow.order,
                created_at: workflow.created_at.map(|dt| dt.to_rfc3339()),
                updated_at: workflow.updated_at.map(|dt| dt.to_rfc3339()),
            }));
        }

        // 2b. Export steps
        let step_count = steps.len();
        for step in steps {
            let old_id = step.id.as_ref().map(|t| t.id.to_raw()).unwrap_or_default();
            let new_id = mapper.get_step(&old_id).unwrap_or_default();
            let workflow_id = mapper
                .get_workflow(&step.workflow_id.id.to_raw())
                .unwrap_or_default();
            let transitions_to: Vec<String> = step
                .transitions_to
                .iter()
                .filter_map(|t| mapper.get_step(&t.id.to_raw()))
                .collect();

            records.push(ExportRecord::Step(Box::new(ExportedStep {
                id: new_id,
                name: step.name,
                workflow_id,
                goal: step.goal,
                agents: step.agents,
                skills: step.skills,
                agent_config: step.agent_config,
                is_final: step.is_final,
                transitions_to,
                order: step.order,
                created_at: step.created_at.map(|dt| dt.to_rfc3339()),
                updated_at: step.updated_at.map(|dt| dt.to_rfc3339()),
            })));
        }

        // 2c. Export workflow transitions
        let transition_count = transitions.len();
        for transition in transitions {
            let old_id = transition
                .id
                .as_ref()
                .map(|t| t.id.to_raw())
                .unwrap_or_default();
            let new_id = mapper.get_workflow_transition(&old_id).unwrap_or_default();
            let from_workflow_id = mapper
                .get_workflow(&transition.from_workflow.id.to_raw())
                .unwrap_or_default();
            let to_workflow_id = mapper
                .get_workflow(&transition.to_workflow.id.to_raw())
                .unwrap_or_default();
            let target_step_id = transition
                .target_step
                .and_then(|t| mapper.get_step(&t.id.to_raw()));

            records.push(ExportRecord::WorkflowTransition(
                ExportedWorkflowTransition {
                    id: new_id,
                    from_workflow_id,
                    to_workflow_id,
                    label: transition.label,
                    target_step_id,
                },
            ));
        }

        // 2d. Export tasks
        let task_count = tasks.len();
        for (old_id, task) in tasks {
            let new_id = mapper.get_task(&old_id).unwrap_or_default();
            let workflow_id = task
                .workflow_id
                .and_then(|t| mapper.get_workflow(&t.id.to_raw()));
            let current_step_id = task
                .current_step_id
                .and_then(|t| mapper.get_step(&t.id.to_raw()));

            records.push(ExportRecord::Task(Box::new(ExportedTask {
                id: new_id,
                title: task.title,
                description: task.description,
                level: task.level.as_str().to_string(),
                priority: task.priority.map(|p| p.as_str().to_string()),
                tags: task.tags,
                sections: task.sections,
                code_refs: task.code_refs,
                needs_human_review: task.needs_human_review,
                revision_feedback: task.revision_feedback,
                rejection_reason: task.rejection_reason,
                workflow_id,
                current_step_id,
                created_at: task.created_at.map(|dt| dt.to_rfc3339()),
                updated_at: task.updated_at.map(|dt| dt.to_rfc3339()),
                started_at: task.started_at.map(|dt| dt.to_rfc3339()),
                completed_at: task.completed_at.map(|dt| dt.to_rfc3339()),
            })));
        }

        // 2e. Export child_of relationships
        let child_of_relations = db.relationships().export_all_child_of().await?;
        let child_of_count = child_of_relations.len();
        for (child_old, parent_old) in child_of_relations {
            let child = mapper.get_task(&child_old).unwrap_or_default();
            let parent = mapper.get_task(&parent_old).unwrap_or_default();
            records.push(ExportRecord::ChildOf { child, parent });
        }

        // 2f. Export depends_on relationships
        let depends_on_relations = db.relationships().export_all_depends_on().await?;
        let depends_on_count = depends_on_relations.len();
        for (task_old, blocker_old) in depends_on_relations {
            let task = mapper.get_task(&task_old).unwrap_or_default();
            let blocker = mapper.get_task(&blocker_old).unwrap_or_default();
            records.push(ExportRecord::DependsOn { task, blocker });
        }

        // Write to output
        let destination = self.write_records(&records)?;

        Ok(ExportResult {
            workflows: workflow_count,
            steps: step_count,
            workflow_transitions: transition_count,
            tasks: task_count,
            child_of_relations: child_of_count,
            depends_on_relations: depends_on_count,
            destination,
        })
    }

    /// Write records to the output destination
    fn write_records(&self, records: &[ExportRecord]) -> Result<String, ServiceError> {
        // Generate default filename if not provided
        let path = match &self.output {
            Some(p) => p.clone(),
            None => {
                let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
                PathBuf::from(format!("vtb-export-{}.jsonl", timestamp))
            }
        };

        let file = std::fs::File::create(&path)
            .map_err(|e| ServiceError::validation_failed(format!("{}: {}", path.display(), e)))?;
        let mut writer = std::io::BufWriter::new(file);

        for record in records {
            let json = serde_json::to_string(record).map_err(|e| {
                ServiceError::validation_failed(format!("JSON serialization error: {}", e))
            })?;
            writeln!(writer, "{}", json).map_err(|e| {
                ServiceError::validation_failed(format!("{}: {}", path.display(), e))
            })?;
        }

        Ok(path.display().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_record_workflow_serialization() {
        let record = ExportRecord::Workflow(ExportedWorkflow {
            id: "wf123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A test workflow".to_string()),
            initial_step_id: Some("step1".to_string()),
            auto_advance: false,
            order: 0,
            created_at: None,
            updated_at: None,
        });

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"workflow""#));
        assert!(json.contains(r#""id":"wf123""#));
        assert!(json.contains(r#""name":"Test Workflow""#));
        assert!(json.contains(r#""initial_step_id":"step1""#));
    }

    #[test]
    fn test_export_record_step_serialization() {
        let record = ExportRecord::Step(Box::new(ExportedStep {
            id: "step123".to_string(),
            name: "Review".to_string(),
            workflow_id: "default".to_string(),
            goal: Some("Review the code".to_string()),
            agents: vec![],
            skills: vec![],
            agent_config: AgentConfig::default(),
            is_final: false,
            transitions_to: vec!["step456".to_string()],
            order: 1,
            created_at: None,
            updated_at: None,
        }));

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"step""#));
        assert!(json.contains(r#""id":"step123""#));
        assert!(json.contains(r#""name":"Review""#));
        assert!(json.contains(r#""workflow_id":"default""#));
        assert!(json.contains(r#""transitions_to":["step456"]"#));
    }

    #[test]
    fn test_export_record_workflow_transition_serialization() {
        let record = ExportRecord::WorkflowTransition(ExportedWorkflowTransition {
            id: "trans123".to_string(),
            from_workflow_id: "backlog".to_string(),
            to_workflow_id: "implementation".to_string(),
            label: "Start Work".to_string(),
            target_step_id: None,
        });

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"workflow_transition""#));
        assert!(json.contains(r#""id":"trans123""#));
        assert!(json.contains(r#""from_workflow_id":"backlog""#));
        assert!(json.contains(r#""to_workflow_id":"implementation""#));
        assert!(json.contains(r#""label":"Start Work""#));
    }

    #[test]
    fn test_export_record_task_serialization() {
        let record = ExportRecord::Task(Box::new(ExportedTask {
            id: "abc123".to_string(),
            title: "Test task".to_string(),
            description: None,
            level: "task".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["test".to_string()],
            sections: vec![],
            code_refs: vec![],
            needs_human_review: None,
            revision_feedback: None,
            rejection_reason: None,
            workflow_id: Some("default".to_string()),
            current_step_id: Some("default_backlog".to_string()),
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        }));

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"task""#));
        assert!(json.contains(r#""id":"abc123""#));
        assert!(json.contains(r#""title":"Test task""#));
        assert!(json.contains(r#""level":"task""#));
        assert!(json.contains(r#""workflow_id":"default""#));
        assert!(json.contains(r#""current_step_id":"default_backlog""#));
    }

    #[test]
    fn test_export_record_child_of_serialization() {
        let record = ExportRecord::ChildOf {
            child: "child123".to_string(),
            parent: "parent456".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"child_of""#));
        assert!(json.contains(r#""child":"child123""#));
        assert!(json.contains(r#""parent":"parent456""#));
    }

    #[test]
    fn test_export_record_depends_on_serialization() {
        let record = ExportRecord::DependsOn {
            task: "task123".to_string(),
            blocker: "blocker456".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"depends_on""#));
        assert!(json.contains(r#""task":"task123""#));
        assert!(json.contains(r#""blocker":"blocker456""#));
    }

    #[test]
    fn test_export_result_display() {
        let result = ExportResult {
            workflows: 2,
            steps: 8,
            workflow_transitions: 4,
            tasks: 10,
            child_of_relations: 5,
            depends_on_relations: 3,
            destination: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(output.contains("Export complete!"));
        assert!(output.contains("Workflows: 2"));
        assert!(output.contains("Steps: 8"));
        assert!(output.contains("Workflow transitions: 4"));
        assert!(output.contains("Tasks: 10"));
        assert!(output.contains("Child relationships: 5"));
        assert!(output.contains("Dependencies: 3"));
        assert!(output.contains("backup.jsonl"));
    }

    #[test]
    fn test_export_command_debug() {
        let cmd = ExportCommand {
            output: Some(PathBuf::from("test.jsonl")),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ExportCommand"));
        assert!(debug_str.contains("test.jsonl"));
    }

    #[test]
    fn test_is_valid_uuid_with_hyphens() {
        assert!(is_valid_uuid("019bdbcf-c4d3-76c3-9502-176660223f2a"));
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn test_is_valid_uuid_without_hyphens() {
        assert!(is_valid_uuid("019bdbcfc4d376c39502176660223f2a"));
        assert!(is_valid_uuid("550e8400e29b41d4a716446655440000"));
    }

    #[test]
    fn test_is_valid_uuid_old_style_ids() {
        assert!(!is_valid_uuid("x123456"));
        assert!(!is_valid_uuid("x1234567890"));
        assert!(!is_valid_uuid("default"));
        assert!(!is_valid_uuid("backlog"));
    }

    #[test]
    fn test_normalize_or_generate_preserves_uuid_with_hyphens() {
        let uuid = "019bdbcf-c4d3-76c3-9502-176660223f2a";
        let result = normalize_or_generate(uuid);
        assert_eq!(result, uuid);
    }

    #[test]
    fn test_normalize_or_generate_normalizes_uuid_without_hyphens() {
        let uuid_simple = "019bdbcfc4d376c39502176660223f2a";
        let result = normalize_or_generate(uuid_simple);
        // Should add hyphens
        assert_eq!(result, "019bdbcf-c4d3-76c3-9502-176660223f2a");
    }

    #[test]
    fn test_normalize_or_generate_creates_new_uuid_for_old_style() {
        let old_id = "x123456";
        let result = normalize_or_generate(old_id);
        // Should be a valid UUID with hyphens
        assert!(is_valid_uuid(&result));
        assert!(result.contains('-'));
        assert_eq!(result.len(), 36); // UUID with hyphens
        // Should NOT be the old ID
        assert_ne!(result, old_id);
    }

    #[test]
    fn test_id_mapper_preserves_existing_uuid() {
        let mut mapper = IdMapper::new();
        let uuid = "019bdbcfc4d376c39502176660223f2a"; // without hyphens

        let result = mapper.task(uuid);
        // Should normalize to hyphenated format
        assert_eq!(result, "019bdbcf-c4d3-76c3-9502-176660223f2a");

        // Second call should return same value
        let result2 = mapper.get_task(uuid).unwrap();
        assert_eq!(result, result2);
    }

    #[test]
    fn test_id_mapper_generates_new_uuid_for_old_style() {
        let mut mapper = IdMapper::new();
        let old_id = "x123456";

        let result = mapper.task(old_id);
        // Should be a new valid UUID
        assert!(is_valid_uuid(&result));
        assert_ne!(result, old_id);

        // Second call should return same generated value
        let result2 = mapper.get_task(old_id).unwrap();
        assert_eq!(result, result2);
    }

    #[test]
    fn test_id_mapper_consistent_across_entity_types() {
        let mut mapper = IdMapper::new();

        // Same old ID used for different entity types should get different UUIDs
        let old_id = "x123456";
        let task_uuid = mapper.task(old_id);
        let workflow_uuid = mapper.workflow(old_id);
        let step_uuid = mapper.step(old_id);

        // All should be valid UUIDs
        assert!(is_valid_uuid(&task_uuid));
        assert!(is_valid_uuid(&workflow_uuid));
        assert!(is_valid_uuid(&step_uuid));

        // All should be different (different entity types)
        assert_ne!(task_uuid, workflow_uuid);
        assert_ne!(task_uuid, step_uuid);
        assert_ne!(workflow_uuid, step_uuid);
    }
}
