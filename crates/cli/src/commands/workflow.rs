//! Workflow commands for managing workflow definitions
//!
//! Implements the `vtb workflow` subcommand group for creating and managing workflows.

use crate::id::IdGenerator;
use clap::{Args, Subcommand};
use vertebrae_db::{Database, DbError, Workflow, WorkflowStep};

/// Workflow management commands
#[derive(Debug, Subcommand)]
pub enum WorkflowCommand {
    /// Create a new workflow
    Add(WorkflowAddCommand),
}

impl WorkflowCommand {
    /// Execute the workflow subcommand.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if the command execution fails.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        match self {
            WorkflowCommand::Add(cmd) => cmd.execute(db).await,
        }
    }
}

/// Create a new workflow
#[derive(Debug, Args)]
pub struct WorkflowAddCommand {
    /// Name of the workflow
    #[arg(required = true)]
    pub name: String,

    /// Optional description of the workflow
    #[arg(short, long)]
    pub description: Option<String>,

    /// Workflow steps in 'name:agent_template' format (can be specified multiple times)
    #[arg(short, long = "step", value_parser = parse_step)]
    pub steps: Vec<ParsedStep>,
}

/// A parsed workflow step from the command line
#[derive(Debug, Clone)]
pub struct ParsedStep {
    /// Name of the step
    pub name: String,
    /// Agent template for the step
    pub agent_template: String,
}

/// Parse a step string in 'name:agent_template' format
fn parse_step(s: &str) -> Result<ParsedStep, String> {
    let parts: Vec<&str> = s.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!(
            "invalid step format '{}'. Expected 'name:agent_template' format (e.g., 'review:code-reviewer')",
            s
        ));
    }

    let name = parts[0].trim();
    let agent_template = parts[1].trim();

    if name.is_empty() {
        return Err("step name cannot be empty".to_string());
    }

    if agent_template.is_empty() {
        return Err("agent template cannot be empty".to_string());
    }

    Ok(ParsedStep {
        name: name.to_string(),
        agent_template: agent_template.to_string(),
    })
}

impl WorkflowAddCommand {
    /// Execute the add workflow command.
    ///
    /// Creates a new workflow with the specified options and stores it in the database.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The name is empty
    /// - No steps are provided
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Validate name is not empty
        if self.name.trim().is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("name"),
                reason: "workflow name required".to_string(),
            });
        }

        // Validate at least one step is provided
        if self.steps.is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("steps"),
                reason: "at least one step is required (use --step 'name:agent_template')"
                    .to_string(),
            });
        }

        // Generate unique ID with collision detection
        let id = self.generate_unique_id(db).await?;

        // Create the workflow
        let mut workflow = Workflow::new(self.name.clone());

        if let Some(description) = &self.description {
            workflow = workflow.with_description(description.clone());
        }

        // Add steps with order based on command line position
        for (order, parsed_step) in self.steps.iter().enumerate() {
            let step = WorkflowStep::new(
                parsed_step.name.clone(),
                parsed_step.agent_template.clone(),
                order as u32,
            );
            workflow = workflow.with_step(step);
        }

        // Store the workflow in the database
        db.workflows().create(&id, &workflow).await?;

        Ok(id)
    }

    /// Check if a workflow with the given ID exists.
    async fn workflow_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        db.workflows().exists(id).await
    }

    /// Generate a unique ID that doesn't collide with existing workflows.
    async fn generate_unique_id(&self, db: &Database) -> Result<String, DbError> {
        let mut generator = IdGenerator::new(&self.name);

        while let Some(id) = generator.next_id() {
            if !self.workflow_exists(db, &id).await? {
                return Ok(id);
            }
        }

        Err(DbError::InvalidPath {
            path: std::path::PathBuf::from("id"),
            reason: "failed to generate unique ID after maximum retries".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-workflow-cmd-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // Step parsing tests
    #[test]
    fn test_parse_step_valid() {
        let result = parse_step("review:code-reviewer");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code-reviewer");
    }

    #[test]
    fn test_parse_step_with_spaces() {
        let result = parse_step(" review : code-reviewer ");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code-reviewer");
    }

    #[test]
    fn test_parse_step_with_multiple_colons() {
        // Should only split on the first colon
        let result = parse_step("review:code:reviewer:template");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code:reviewer:template");
    }

    #[test]
    fn test_parse_step_missing_colon() {
        let result = parse_step("review-code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid step format"));
        assert!(err.contains("name:agent_template"));
    }

    #[test]
    fn test_parse_step_empty_name() {
        let result = parse_step(":code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_empty_agent_template() {
        let result = parse_step("review:");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("agent template cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_name() {
        let result = parse_step("   :code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_agent_template() {
        let result = parse_step("review:   ");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("agent template cannot be empty"));
    }

    // WorkflowAddCommand tests
    #[tokio::test]
    async fn test_add_workflow_simple() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "My Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");
        assert_eq!(id.len(), 6);

        // Verify workflow was persisted
        let workflow = db.workflows().get(&id).await.unwrap();
        assert!(workflow.is_some());
        let workflow = workflow.unwrap();
        assert_eq!(workflow.name, "My Workflow");
        assert!(workflow.description.is_none());
        assert_eq!(workflow.steps.len(), 1);
        assert_eq!(workflow.steps[0].name, "step1");
        assert_eq!(workflow.steps[0].agent_template, "agent1");
        assert_eq!(workflow.steps[0].order, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_with_description() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Described Workflow".to_string(),
            description: Some("A workflow with a description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Described Workflow");
        assert_eq!(
            workflow.description,
            Some("A workflow with a description".to_string())
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_with_multiple_steps() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Multi-step Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_template: "code-reviewer".to_string(),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_template: "tester".to_string(),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_template: "deployer".to_string(),
                },
            ],
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.steps.len(), 3);

        // Verify steps are ordered correctly
        assert_eq!(workflow.steps[0].name, "review");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "test");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "deploy");
        assert_eq!(workflow.steps[2].order, 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_empty_name_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
                    "Expected 'name required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_whitespace_name_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "   ".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
                    "Expected 'name required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_no_steps_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "No Steps Workflow".to_string(),
            description: None,
            steps: vec![],
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("at least one step is required"),
                    "Expected 'at least one step is required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_workflow_returns_6_char_id() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "ID test workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.unwrap();
        assert_eq!(result.len(), 6);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unique_ids_for_multiple_workflows() {
        let (db, temp_dir) = setup_test_db().await;

        let mut ids = std::collections::HashSet::new();

        for i in 0..10 {
            let cmd = WorkflowAddCommand {
                name: format!("Workflow {}", i),
                description: None,
                steps: vec![ParsedStep {
                    name: "step1".to_string(),
                    agent_template: "agent1".to_string(),
                }],
            };

            let id = cmd.execute(&db).await.unwrap();
            assert!(ids.insert(id), "Duplicate ID generated");
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_false_for_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Test".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let exists = cmd.workflow_exists(&db, "xxxxxx").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_true_for_existing() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Existing workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let id = cmd.execute(&db).await.unwrap();

        let exists = cmd.workflow_exists(&db, &id).await.unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }
}
