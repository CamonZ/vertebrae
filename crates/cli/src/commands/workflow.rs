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
    /// List all workflows
    List(WorkflowListCommand),
    /// Show details of a specific workflow
    Show(WorkflowShowCommand),
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
            WorkflowCommand::List(cmd) => cmd.execute(db).await,
            WorkflowCommand::Show(cmd) => cmd.execute(db).await,
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

        Ok(format!("Created workflow: {}", id))
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

/// List all workflows
#[derive(Debug, Args)]
pub struct WorkflowListCommand {}

impl WorkflowListCommand {
    /// Execute the list workflows command.
    ///
    /// Fetches all workflows from the database and returns a formatted list.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        let workflows = db.workflows().list().await?;

        if workflows.is_empty() {
            return Ok("No workflows found".to_string());
        }

        let summaries: Vec<WorkflowSummary> = workflows
            .into_iter()
            .map(|w| {
                let id =
                    w.id.as_ref()
                        .map(|t| t.id.to_raw())
                        .unwrap_or_else(|| "unknown".to_string());
                WorkflowSummary {
                    id,
                    name: w.name,
                    description: w.description,
                    step_count: w.steps.len(),
                }
            })
            .collect();

        let output = summaries
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join("\n");

        Ok(output)
    }
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
    /// Ordered list of workflow steps
    pub steps: Vec<WorkflowStep>,
    /// Additional metadata as key-value pairs
    pub metadata: std::collections::HashMap<String, String>,
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
                let skills_str = if step.skills.is_empty() {
                    String::new()
                } else {
                    format!(" [skills: {}]", step.skills.join(", "))
                };
                writeln!(
                    f,
                    "{}. {} (agent: {}){}",
                    step.order + 1,
                    step.name,
                    step.agent_template,
                    skills_str
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
fn format_timestamp(ts: Option<&String>) -> String {
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

/// Show details of a specific workflow
#[derive(Debug, Args)]
pub struct WorkflowShowCommand {
    /// Workflow ID to show (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

impl WorkflowShowCommand {
    /// Execute the show workflow command.
    ///
    /// Fetches the workflow with the given ID and returns detailed information.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the workflow doesn't exist.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        let workflow = db.workflows().get(&id).await?;

        match workflow {
            Some(w) => {
                let detail = WorkflowDetail {
                    id: w
                        .id
                        .as_ref()
                        .map(|t| t.id.to_raw())
                        .unwrap_or_else(|| id.clone()),
                    name: w.name,
                    description: w.description,
                    steps: w.steps,
                    metadata: w.metadata,
                    created_at: w.created_at.map(|dt| dt.to_rfc3339()),
                    updated_at: w.updated_at.map(|dt| dt.to_rfc3339()),
                };
                Ok(detail.to_string())
            }
            None => Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: self.id.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
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

    /// Extract the workflow ID from "Created workflow: {id}" message
    fn extract_workflow_id(msg: &str) -> String {
        msg.strip_prefix("Created workflow: ")
            .unwrap_or(msg)
            .to_string()
    }

    // WorkflowAddCommand tests
    #[tokio::test]
    async fn test_add_workflow_simple() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "My Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.expect("Add should succeed");
        assert!(
            result.starts_with("Created workflow: "),
            "Result should start with 'Created workflow: '"
        );
        let id = extract_workflow_id(&result);
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
    }

    #[tokio::test]
    async fn test_add_workflow_with_description() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Described Workflow".to_string(),
            description: Some("A workflow with a description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Described Workflow");
        assert_eq!(
            workflow.description,
            Some("A workflow with a description".to_string())
        );
    }

    #[tokio::test]
    async fn test_add_workflow_with_multiple_steps() {
        let db = setup_test_db().await;

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

        let result = cmd.execute(&db).await.expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.steps.len(), 3);

        // Verify steps are ordered correctly
        assert_eq!(workflow.steps[0].name, "review");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "test");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "deploy");
        assert_eq!(workflow.steps[2].order, 2);
    }

    #[tokio::test]
    async fn test_add_workflow_empty_name_fails() {
        let db = setup_test_db().await;

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
    }

    #[tokio::test]
    async fn test_add_workflow_whitespace_name_fails() {
        let db = setup_test_db().await;

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
    }

    #[tokio::test]
    async fn test_add_workflow_no_steps_fails() {
        let db = setup_test_db().await;

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
    }

    #[tokio::test]
    async fn test_add_workflow_returns_6_char_id() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "ID test workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 6);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn test_unique_ids_for_multiple_workflows() {
        let db = setup_test_db().await;

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

            let result = cmd.execute(&db).await.unwrap();
            let id = extract_workflow_id(&result);
            assert!(ids.insert(id), "Duplicate ID generated");
        }
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_false_for_nonexistent() {
        let db = setup_test_db().await;

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
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_true_for_existing() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Existing workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&result);

        let exists = cmd.workflow_exists(&db, &id).await.unwrap();
        assert!(exists);
    }

    // ========================================
    // WorkflowListCommand tests
    // ========================================

    #[tokio::test]
    async fn test_list_workflows_empty() {
        let db = setup_test_db().await;

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result, "No workflows found");
    }

    #[tokio::test]
    async fn test_list_workflows_shows_all_with_step_counts() {
        let db = setup_test_db().await;

        // Create workflow with 1 step
        let add_cmd1 = WorkflowAddCommand {
            name: "Workflow A".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };
        let result1 = add_cmd1.execute(&db).await.unwrap();
        let id1 = extract_workflow_id(&result1);

        // Create workflow with 3 steps
        let add_cmd2 = WorkflowAddCommand {
            name: "Workflow B".to_string(),
            description: Some("A workflow with description".to_string()),
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_template: "reviewer".to_string(),
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
        let result2 = add_cmd2.execute(&db).await.unwrap();
        let id2 = extract_workflow_id(&result2);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

        // Should contain both workflows with step counts
        assert!(
            result.contains(&id1),
            "Should contain first workflow ID: {}",
            id1
        );
        assert!(result.contains("Workflow A"), "Should contain Workflow A");
        assert!(result.contains("(1 steps)"), "Should show 1 step count");

        assert!(
            result.contains(&id2),
            "Should contain second workflow ID: {}",
            id2
        );
        assert!(result.contains("Workflow B"), "Should contain Workflow B");
        assert!(result.contains("(3 steps)"), "Should show 3 step count");
        assert!(
            result.contains("A workflow with description"),
            "Should include description"
        );
    }

    #[tokio::test]
    async fn test_list_workflows_output_format() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: Some("Test description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

        // Verify the output format: "id - name (N steps) - description"
        assert!(
            result.contains(&format!(
                "{} - Test Workflow (1 steps) - Test description",
                id
            )),
            "Output format should be 'id - name (N steps) - description', got: {}",
            result
        );
    }

    // ========================================
    // WorkflowShowCommand tests
    // ========================================

    #[tokio::test]
    async fn test_show_workflow_displays_steps_in_order() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Multi-step Workflow".to_string(),
            description: Some("Workflow description".to_string()),
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
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&db).await.unwrap();

        // Verify header
        assert!(
            result.contains(&format!("Workflow: {} - Multi-step Workflow", id)),
            "Should show header with ID and name"
        );

        // Verify description
        assert!(
            result.contains("Description"),
            "Should have Description section"
        );
        assert!(
            result.contains("Workflow description"),
            "Should show description content"
        );

        // Verify steps are shown in order
        assert!(result.contains("Steps (3 total)"), "Should show step count");
        assert!(
            result.contains("1. review (agent: code-reviewer)"),
            "Should show step 1"
        );
        assert!(
            result.contains("2. test (agent: tester)"),
            "Should show step 2"
        );
        assert!(
            result.contains("3. deploy (agent: deployer)"),
            "Should show step 3"
        );
    }

    #[tokio::test]
    async fn test_show_workflow_not_found() {
        let db = setup_test_db().await;

        let cmd = WorkflowShowCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err(), "Should return error for nonexistent ID");

        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow", "Entity should be 'workflow'");
                assert_eq!(id, "nonexistent", "ID should be 'nonexistent'");
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_show_workflow_case_insensitive() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Case Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try with uppercase ID
        let show_cmd = WorkflowShowCommand {
            id: id.to_uppercase(),
        };
        let result = show_cmd.execute(&db).await;

        assert!(
            result.is_ok(),
            "Should find workflow with case-insensitive ID"
        );
        assert!(
            result.unwrap().contains("Case Test Workflow"),
            "Should show workflow name"
        );
    }

    #[tokio::test]
    async fn test_show_workflow_without_description() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "No Desc Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&db).await.unwrap();

        // Should not have a Description section
        assert!(
            !result.contains("Description\n---"),
            "Should not show Description section when none exists"
        );
        assert!(
            result.contains("Steps (1 total)"),
            "Should still show Steps section"
        );
    }

    // ========================================
    // Display tests
    // ========================================

    #[test]
    fn test_workflow_summary_display() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A test workflow".to_string()),
            step_count: 3,
        };

        let output = format!("{}", summary);
        assert_eq!(output, "abc123 - Test Workflow (3 steps) - A test workflow");
    }

    #[test]
    fn test_workflow_summary_display_no_description() {
        let summary = WorkflowSummary {
            id: "def456".to_string(),
            name: "Simple Workflow".to_string(),
            description: None,
            step_count: 1,
        };

        let output = format!("{}", summary);
        assert_eq!(output, "def456 - Simple Workflow (1 steps)");
    }

    #[test]
    fn test_workflow_detail_display() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Full Workflow".to_string(),
            description: Some("A complete workflow".to_string()),
            steps: vec![
                WorkflowStep::new("step1", "agent1", 0),
                WorkflowStep::new("step2", "agent2", 1),
            ],
            metadata: std::collections::HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("Workflow: abc123 - Full Workflow"));
        assert!(output.contains("Description"));
        assert!(output.contains("A complete workflow"));
        assert!(output.contains("Steps (2 total)"));
        assert!(output.contains("1. step1 (agent: agent1)"));
        assert!(output.contains("2. step2 (agent: agent2)"));
    }

    #[test]
    fn test_workflow_detail_display_with_skills() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Skill Workflow".to_string(),
            description: None,
            steps: vec![
                WorkflowStep::new("step1", "agent1", 0)
                    .with_skill("skill1")
                    .with_skill("skill2"),
            ],
            metadata: std::collections::HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("[skills: skill1, skill2]"));
    }

    #[test]
    fn test_workflow_detail_display_with_metadata() {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert("version".to_string(), "1.0".to_string());
        metadata.insert("team".to_string(), "platform".to_string());

        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Metadata Workflow".to_string(),
            description: None,
            steps: vec![WorkflowStep::new("step1", "agent1", 0)],
            metadata,
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("Metadata"));
        // HashMap order is not guaranteed, so check for both keys
        assert!(output.contains("version: 1.0"));
        assert!(output.contains("team: platform"));
    }

    #[test]
    fn test_format_timestamp() {
        // RFC3339 format
        assert_eq!(
            format_timestamp(Some(&"2024-01-15T10:30:00+00:00".to_string())),
            "2024-01-15 10:30"
        );

        // SurrealDB format fallback
        let result = format_timestamp(Some(&"2024-01-15T10:30:00Z".to_string()));
        assert!(result.contains("2024-01-15"));

        // None
        assert_eq!(format_timestamp(None), "");
    }

    #[test]
    fn test_workflow_list_command_debug() {
        let cmd = WorkflowListCommand {};
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowListCommand"),
            "Debug output should contain WorkflowListCommand"
        );
    }

    #[test]
    fn test_workflow_show_command_debug() {
        let cmd = WorkflowShowCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowShowCommand") && debug_str.contains("test123"),
            "Debug output should contain WorkflowShowCommand and id"
        );
    }

    #[test]
    fn test_workflow_summary_clone() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test".to_string(),
            description: Some("desc".to_string()),
            step_count: 2,
        };

        let cloned = summary.clone();
        assert_eq!(summary.id, cloned.id);
        assert_eq!(summary.name, cloned.name);
        assert_eq!(summary.description, cloned.description);
        assert_eq!(summary.step_count, cloned.step_count);
    }

    #[test]
    fn test_workflow_summary_debug() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A description".to_string()),
            step_count: 3,
        };

        let debug_str = format!("{:?}", summary);
        assert!(
            debug_str.contains("WorkflowSummary")
                && debug_str.contains("abc123")
                && debug_str.contains("Test Workflow")
                && debug_str.contains("step_count: 3"),
            "Debug output should contain all fields"
        );
    }

    #[test]
    fn test_workflow_detail_debug() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![],
            metadata: std::collections::HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let debug_str = format!("{:?}", detail);
        assert!(
            debug_str.contains("WorkflowDetail")
                && debug_str.contains("abc123")
                && debug_str.contains("Test Workflow"),
            "Debug output should contain WorkflowDetail and fields"
        );
    }
}
