//! Shared display types for workflow commands

use serde::Serialize;
use std::collections::HashMap;

/// A summary of a workflow for display in the list
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowSummary {
    /// The workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Number of steps in the workflow
    pub step_count: usize,
}

impl std::fmt::Display for WorkflowSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let desc = self
            .description
            .as_ref()
            .map(|d| format!(" - {}", d))
            .unwrap_or_default();
        write!(
            f,
            "{} - {} ({} steps){}",
            self.id, self.name, self.step_count, desc
        )
    }
}

/// Display information for a workflow step
#[derive(Debug, Clone, Serialize)]
pub struct StepDisplayInfo {
    /// Step ID
    pub id: Option<String>,
    /// Step name
    pub name: String,
    /// Agent model
    pub model: Option<String>,
    /// Step order (0-based)
    pub order: i32,
    /// Prompt sent to the agent
    pub prompt: Option<String>,
}

/// Detailed view of a workflow with all steps
#[derive(Debug, Serialize)]
pub struct WorkflowDetail {
    /// The workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Whether this is the default workflow for new tasks
    pub is_default: bool,
    /// Whether this workflow is terminal/final
    pub is_final: bool,
    /// Optional kanban column
    pub kanban_column: Option<String>,
    /// Ordered list of workflow steps
    pub steps: Vec<StepDisplayInfo>,
    /// Additional metadata as key-value pairs
    pub metadata: HashMap<String, String>,
    /// Creation timestamp
    pub created_at: Option<String>,
    /// Last update timestamp
    pub updated_at: Option<String>,
}

impl std::fmt::Display for WorkflowDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header with workflow ID and name
        writeln!(f, "Workflow: {} - {}", self.id, self.name)?;
        writeln!(f, "{}", "=".repeat(60))?;
        writeln!(f)?;

        // Description (if present)
        if let Some(ref description) = self.description {
            writeln!(f, "Description")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", description)?;
            writeln!(f)?;
        }

        // Default workflow setting
        writeln!(f, "Default: {}", if self.is_default { "Yes" } else { "No" })?;

        // Final workflow setting
        writeln!(f, "Final: {}", if self.is_final { "Yes" } else { "No" })?;

        // Kanban column (if present)
        if let Some(ref kanban_column) = self.kanban_column {
            writeln!(f, "Kanban Column: {}", kanban_column)?;
        }

        writeln!(f)?;

        // Steps section
        writeln!(f, "Steps ({} total)", self.steps.len())?;
        writeln!(f, "{}", "-".repeat(40))?;

        if self.steps.is_empty() {
            writeln!(f, "(no steps defined)")?;
        } else {
            // Sort steps by order
            let mut sorted_steps = self.steps.clone();
            sorted_steps.sort_by_key(|s| s.order);

            for step in &sorted_steps {
                let model_display = step.model.as_deref().unwrap_or("default");
                writeln!(
                    f,
                    "{}. {} (model: {})",
                    step.order + 1,
                    step.name,
                    model_display
                )?;
                if let Some(ref prompt) = step.prompt {
                    writeln!(f, "   Prompt: {}", prompt)?;
                }
            }
        }
        writeln!(f)?;

        // Metadata section (if any)
        if !self.metadata.is_empty() {
            writeln!(f, "Metadata")?;
            writeln!(f, "{}", "-".repeat(40))?;
            for (key, value) in &self.metadata {
                writeln!(f, "  {}: {}", key, value)?;
            }
            writeln!(f)?;
        }

        // Timestamps
        if self.created_at.is_some() || self.updated_at.is_some() {
            writeln!(f, "Timestamps")?;
            writeln!(f, "{}", "-".repeat(40))?;
            if let Some(ref created) = self.created_at {
                writeln!(f, "Created:  {}", format_timestamp(Some(created)))?;
            }
            if let Some(ref updated) = self.updated_at {
                writeln!(f, "Updated:  {}", format_timestamp(Some(updated)))?;
            }
        }

        Ok(())
    }
}

/// Format a timestamp for readable display
pub fn format_timestamp(ts: Option<&String>) -> String {
    match ts {
        Some(s) => {
            // Try to parse and format nicely, otherwise return as-is
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                dt.format("%Y-%m-%d %H:%M").to_string()
            } else {
                // Try parsing SurrealDB format
                s.replace('T', " ").replace('Z', "")
            }
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_summary_display() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A test".to_string()),
            step_count: 3,
        };
        assert_eq!(
            format!("{}", summary),
            "wf1 - Test Workflow (3 steps) - A test"
        );
    }

    #[test]
    fn test_workflow_summary_display_no_description() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Test Workflow".to_string(),
            description: None,
            step_count: 3,
        };
        assert_eq!(format!("{}", summary), "wf1 - Test Workflow (3 steps)");
    }

    #[test]
    fn test_workflow_detail_display() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A detailed workflow".to_string()),
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![
                StepDisplayInfo {
                    id: Some("step-id".to_string()),
                    name: "step1".to_string(),
                    model: Some("model1".to_string()),
                    order: 0,
                    prompt: None,
                },
                StepDisplayInfo {
                    id: Some("step-id".to_string()),
                    name: "step2".to_string(),
                    model: Some("model2".to_string()),
                    order: 1,
                    prompt: None,
                },
            ],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);
        assert!(output.contains("Workflow: wf1 - Test Workflow"));
        assert!(output.contains("A detailed workflow"));
        assert!(output.contains("Final: No"));
        assert!(output.contains("1. step1 (model: model1)"));
        assert!(output.contains("2. step2 (model: model2)"));
    }

    #[test]
    fn test_workflow_detail_display_with_metadata() {
        let mut metadata = HashMap::new();
        metadata.insert("key1".to_string(), "value1".to_string());

        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Test".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata,
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);
        assert!(output.contains("Metadata"));
        assert!(output.contains("key1: value1"));
    }

    #[test]
    fn test_format_timestamp() {
        // Test with None
        assert_eq!(format_timestamp(None), "");

        // Test with a simple timestamp string
        let ts = "2024-01-15T10:30:00Z".to_string();
        let formatted = format_timestamp(Some(&ts));
        // Should strip T and Z
        assert!(!formatted.is_empty());
    }

    #[test]
    fn test_workflow_summary_clone() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Test".to_string(),
            description: Some("Desc".to_string()),
            step_count: 2,
        };
        let cloned = summary.clone();
        assert_eq!(summary.id, cloned.id);
        assert_eq!(summary.name, cloned.name);
    }

    #[test]
    fn test_workflow_summary_debug() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Test".to_string(),
            description: None,
            step_count: 1,
        };
        let debug = format!("{:?}", summary);
        assert!(debug.contains("WorkflowSummary"));
        assert!(debug.contains("wf1"));
    }

    #[test]
    fn test_workflow_detail_debug() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Test".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let debug = format!("{:?}", detail);
        assert!(debug.contains("WorkflowDetail"));
    }

    // ==================== WorkflowDetail Display branch coverage ====================

    #[test]
    fn test_workflow_detail_display_no_steps() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Empty".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Steps (0 total)"));
        assert!(output.contains("(no steps defined)"));
    }

    #[test]
    fn test_workflow_detail_display_default_yes() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Def".to_string(),
            description: None,
            is_default: true,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Default: Yes"));
    }

    #[test]
    fn test_workflow_detail_display_default_no() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "NoDef".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Default: No"));
    }

    #[test]
    fn test_workflow_detail_display_final_yes() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Final".to_string(),
            description: None,
            is_default: false,
            is_final: true,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Final: Yes"));
    }

    #[test]
    fn test_workflow_detail_display_with_timestamps() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Timestamped".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: Some("2024-01-15T10:30:00Z".to_string()),
            updated_at: Some("2024-01-16T12:00:00Z".to_string()),
        };
        let output = format!("{}", detail);
        assert!(output.contains("Timestamps"));
        assert!(output.contains("Created:"));
        assert!(output.contains("Updated:"));
    }

    #[test]
    fn test_workflow_detail_display_created_only() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Created".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: Some("2024-01-15T10:30:00Z".to_string()),
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Timestamps"));
        assert!(output.contains("Created:"));
        assert!(!output.contains("Updated:"));
    }

    #[test]
    fn test_workflow_detail_display_updated_only() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Updated".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: Some("2024-01-16T12:00:00Z".to_string()),
        };
        let output = format!("{}", detail);
        assert!(output.contains("Timestamps"));
        assert!(!output.contains("Created:"));
        assert!(output.contains("Updated:"));
    }

    #[test]
    fn test_workflow_detail_display_no_timestamps_no_section() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "NoTs".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(!output.contains("Timestamps"));
    }

    #[test]
    fn test_workflow_detail_display_step_default_model() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Default Model".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![StepDisplayInfo {
                id: Some("step-id".to_string()),
                name: "review".to_string(),
                model: None,
                order: 0,
                prompt: None,
            }],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("1. review (model: default)"));
    }

    #[test]
    fn test_workflow_detail_display_steps_sorted_by_order() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Sorted".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![
                StepDisplayInfo {
                    id: Some("step-id".to_string()),
                    name: "deploy".to_string(),
                    model: Some("m3".to_string()),
                    order: 2,
                    prompt: None,
                },
                StepDisplayInfo {
                    id: Some("step-id".to_string()),
                    name: "code".to_string(),
                    model: Some("m1".to_string()),
                    order: 0,
                    prompt: None,
                },
                StepDisplayInfo {
                    id: Some("step-id".to_string()),
                    name: "review".to_string(),
                    model: Some("m2".to_string()),
                    order: 1,
                    prompt: None,
                },
            ],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        // Steps should be sorted: code (0), review (1), deploy (2)
        let code_pos = output.find("code").unwrap();
        let review_pos = output.find("review").unwrap();
        let deploy_pos = output.find("deploy").unwrap();
        assert!(code_pos < review_pos);
        assert!(review_pos < deploy_pos);
    }

    #[test]
    fn test_workflow_detail_display_no_description() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "NoDesc".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        // Should not have Description section header followed by separator
        assert!(!output.contains("Description\n"));
    }

    #[test]
    fn test_workflow_detail_display_multiple_metadata() {
        let mut metadata = HashMap::new();
        metadata.insert("team".to_string(), "backend".to_string());
        metadata.insert("env".to_string(), "production".to_string());

        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Meta".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![],
            metadata,
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Metadata"));
        assert!(output.contains("team: backend"));
        assert!(output.contains("env: production"));
    }

    // ==================== format_timestamp tests ====================

    #[test]
    fn test_format_timestamp_rfc3339() {
        let ts = "2024-06-15T14:30:00Z".to_string();
        let result = format_timestamp(Some(&ts));
        assert_eq!(result, "2024-06-15 14:30");
    }

    #[test]
    fn test_format_timestamp_rfc3339_with_offset() {
        let ts = "2024-06-15T14:30:00+05:00".to_string();
        let result = format_timestamp(Some(&ts));
        assert_eq!(result, "2024-06-15 14:30");
    }

    #[test]
    fn test_format_timestamp_surrealdb_format() {
        // Non-RFC3339 format falls back to replacing T and Z
        let ts = "2024-06-15T14:30:00Z extra".to_string();
        let result = format_timestamp(Some(&ts));
        // Can't parse as RFC3339, so falls back to replacement
        assert!(result.contains("2024-06-15"));
        assert!(!result.contains('T'));
        assert!(!result.contains('Z'));
    }

    #[test]
    fn test_format_timestamp_none() {
        assert_eq!(format_timestamp(None), "");
    }

    #[test]
    fn test_format_timestamp_empty_string() {
        let ts = "".to_string();
        let result = format_timestamp(Some(&ts));
        assert_eq!(result, "");
    }

    // ==================== StepDisplayInfo tests ====================

    #[test]
    fn test_step_display_info_clone() {
        let step = StepDisplayInfo {
            id: Some("step-id".to_string()),
            name: "review".to_string(),
            model: Some("sonnet".to_string()),
            order: 1,
            prompt: Some("Review carefully".to_string()),
        };
        let cloned = step.clone();
        assert_eq!(step.id, cloned.id);
        assert_eq!(step.name, cloned.name);
        assert_eq!(step.model, cloned.model);
        assert_eq!(step.order, cloned.order);
        assert_eq!(step.prompt, cloned.prompt);
    }

    #[test]
    fn test_workflow_detail_serializes_final_flag_and_step_ids() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Serializable".to_string(),
            description: None,
            is_default: false,
            is_final: true,
            kanban_column: None,
            steps: vec![StepDisplayInfo {
                id: Some("step-123".to_string()),
                name: "review".to_string(),
                model: Some("sonnet".to_string()),
                order: 0,
                prompt: None,
            }],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let json = serde_json::to_value(&detail).unwrap();

        assert_eq!(json["is_final"], true);
        assert_eq!(json["steps"][0]["id"], "step-123");
        assert_eq!(json["steps"][0]["name"], "review");
    }

    #[test]
    fn test_step_display_info_debug() {
        let step = StepDisplayInfo {
            id: Some("step-id".to_string()),
            name: "review".to_string(),
            model: Some("opus".to_string()),
            order: 0,
            prompt: None,
        };
        let debug = format!("{:?}", step);
        assert!(debug.contains("StepDisplayInfo"));
        assert!(debug.contains("review"));
        assert!(debug.contains("opus"));
    }

    #[test]
    fn test_step_display_info_no_model() {
        let step = StepDisplayInfo {
            id: Some("step-id".to_string()),
            name: "test".to_string(),
            model: None,
            order: 0,
            prompt: None,
        };
        assert!(step.model.is_none());
    }

    // ==================== Prompt display ====================

    #[test]
    fn test_workflow_detail_display_step_with_prompt() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "Prompted".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![StepDisplayInfo {
                id: Some("step-id".to_string()),
                name: "review".to_string(),
                model: None,
                order: 0,
                prompt: Some("Review the code for bugs".to_string()),
            }],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("Prompt: Review the code for bugs"));
    }

    #[test]
    fn test_workflow_detail_display_step_without_prompts() {
        let detail = WorkflowDetail {
            id: "wf1".to_string(),
            name: "NoPrompts".to_string(),
            description: None,
            is_default: false,
            is_final: false,
            kanban_column: None,
            steps: vec![StepDisplayInfo {
                id: Some("step-id".to_string()),
                name: "basic".to_string(),
                model: None,
                order: 0,
                prompt: None,
            }],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let output = format!("{}", detail);
        assert!(output.contains("1. basic (model: default)"));
        assert!(!output.contains("Prompt:"));
    }

    // ==================== WorkflowSummary edge cases ====================

    #[test]
    fn test_workflow_summary_display_zero_steps() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Empty".to_string(),
            description: None,
            step_count: 0,
        };
        assert_eq!(format!("{}", summary), "wf1 - Empty (0 steps)");
    }

    #[test]
    fn test_workflow_summary_display_one_step() {
        let summary = WorkflowSummary {
            id: "wf1".to_string(),
            name: "Single".to_string(),
            description: None,
            step_count: 1,
        };
        // Note: uses "steps" not "step" even for 1
        assert_eq!(format!("{}", summary), "wf1 - Single (1 steps)");
    }
}
