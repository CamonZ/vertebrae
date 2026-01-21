//! Shared display types for workflow commands

use std::collections::HashMap;

/// A summary of a workflow for display in the list
#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
pub struct StepDisplayInfo {
    /// Step name
    pub name: String,
    /// Agent model
    pub model: Option<String>,
    /// Step order (0-based)
    pub order: i32,
}

/// Detailed view of a workflow with all steps
#[derive(Debug)]
pub struct WorkflowDetail {
    /// The workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Whether to automatically advance to the next step on successful completion
    pub auto_advance: bool,
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

        // Auto advance setting
        writeln!(
            f,
            "Auto Advance: {}",
            if self.auto_advance { "Yes" } else { "No" }
        )?;
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
            auto_advance: false,
            steps: vec![
                StepDisplayInfo {
                    name: "step1".to_string(),
                    model: Some("model1".to_string()),
                    order: 0,
                },
                StepDisplayInfo {
                    name: "step2".to_string(),
                    model: Some("model2".to_string()),
                    order: 1,
                },
            ],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);
        assert!(output.contains("Workflow: wf1 - Test Workflow"));
        assert!(output.contains("A detailed workflow"));
        assert!(output.contains("Auto Advance: No"));
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
            auto_advance: true,
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
            auto_advance: false,
            steps: vec![],
            metadata: HashMap::new(),
            created_at: None,
            updated_at: None,
        };
        let debug = format!("{:?}", detail);
        assert!(debug.contains("WorkflowDetail"));
    }
}
