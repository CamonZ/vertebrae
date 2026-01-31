//! Integration tests for the `step` command
//!
//! Tests step subcommands including create, list, show, update, and delete operations.

use super::mock::mock_services;
use vertebrae_cli::commands::step::*;
use vertebrae_core::CreateWorkflowOptions;

// ============================================================================
// Step creation tests
// ============================================================================

#[cfg(test)]
mod step_create_tests {
    use super::*;

    #[tokio::test]
    async fn test_create_basic_step() {
        let services = mock_services();

        // Create workflow first
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step
        let cmd = StepAddCommand {
            name: "Review".to_string(),
            workflow: workflow_id.clone(),
            id: None,
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        let result = cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Created step:"));
    }

    #[tokio::test]
    async fn test_create_step_with_id() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with custom ID
        let cmd = StepAddCommand {
            name: "Review".to_string(),
            workflow: workflow_id.clone(),
            id: Some("review-step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        let result = cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("review-step"));

        // Verify step exists
        let step = services
            .steps()
            .get_step("review-step")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.name, "Review");
        assert_eq!(step.workflow_id, workflow_id);
    }

    #[tokio::test]
    async fn test_create_step_with_goal() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with goal
        let cmd = StepAddCommand {
            name: "Code Review".to_string(),
            workflow: workflow_id.clone(),
            id: Some("code-review".to_string()),
            goal: Some("Review code for quality and best practices".to_string()),
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify goal is set
        let step = services
            .steps()
            .get_step("code-review")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            step.goal,
            Some("Review code for quality and best practices".to_string())
        );
    }

    #[tokio::test]
    async fn test_create_step_with_order() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with specific order
        let cmd = StepAddCommand {
            name: "Deploy".to_string(),
            workflow: workflow_id.clone(),
            id: Some("deploy".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 5,
            r#final: false,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify order is set
        let step = services.steps().get_step("deploy").await.unwrap().unwrap();
        assert_eq!(step.order, 5);
    }

    #[tokio::test]
    async fn test_create_final_step() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create final step
        let cmd = StepAddCommand {
            name: "Complete".to_string(),
            workflow: workflow_id.clone(),
            id: Some("complete".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: true,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify is_final is set
        let step = services
            .steps()
            .get_step("complete")
            .await
            .unwrap()
            .unwrap();
        assert!(step.is_final);
    }

    #[tokio::test]
    async fn test_create_step_with_agents() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with agents
        let cmd = StepAddCommand {
            name: "Analysis".to_string(),
            workflow: workflow_id.clone(),
            id: Some("analysis".to_string()),
            goal: None,
            agent: vec![
                ".claude/agents/reviewer.md".to_string(),
                ".claude/agents/analyzer.md".to_string(),
            ],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify agents are set
        let step = services
            .steps()
            .get_step("analysis")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agents.len(), 2);
        assert!(
            step.agents
                .contains(&".claude/agents/reviewer.md".to_string())
        );
        assert!(
            step.agents
                .contains(&".claude/agents/analyzer.md".to_string())
        );
    }

    #[tokio::test]
    async fn test_create_step_with_skills() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with skills
        let cmd = StepAddCommand {
            name: "Testing".to_string(),
            workflow: workflow_id.clone(),
            id: Some("testing".to_string()),
            goal: None,
            agent: vec![],
            skill: vec!["test-writing".to_string(), "debugging".to_string()],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify skills are set
        let step = services.steps().get_step("testing").await.unwrap().unwrap();
        assert_eq!(step.skills.len(), 2);
        assert!(step.skills.contains(&"test-writing".to_string()));
        assert!(step.skills.contains(&"debugging".to_string()));
    }

    #[tokio::test]
    async fn test_create_step_with_transitions() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with transitions
        let cmd = StepAddCommand {
            name: "Decision".to_string(),
            workflow: workflow_id.clone(),
            id: Some("decision".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![
                "approved".to_string(),
                "rejected".to_string(),
                "needs_revision".to_string(),
            ],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify transitions are set
        let step = services
            .steps()
            .get_step("decision")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.transitions_to.len(), 3);
        assert!(step.transitions_to.contains(&"approved".to_string()));
        assert!(step.transitions_to.contains(&"rejected".to_string()));
        assert!(step.transitions_to.contains(&"needs_revision".to_string()));
    }

    #[tokio::test]
    async fn test_create_step_with_model_legacy() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step with legacy model field
        let cmd = StepAddCommand {
            name: "LegacyStep".to_string(),
            workflow: workflow_id.clone(),
            id: Some("legacy-step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: Some("sonnet".to_string()),
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify model is in agent config
        let step = services
            .steps()
            .get_step("legacy-step")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
    }
}

// ============================================================================
// Step list tests
// ============================================================================

#[cfg(test)]
mod step_list_tests {
    use super::*;

    #[tokio::test]
    async fn test_list_steps_for_workflow() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Pipeline", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create steps
        for i in 0..3 {
            let cmd = StepAddCommand {
                name: format!("Step {}", i + 1),
                workflow: workflow_id.clone(),
                id: Some(format!("step-{}", i)),
                goal: None,
                agent: vec![],
                skill: vec![],
                model: None,
                order: i,
                r#final: i == 2,
                transitions_to: vec![],
            };
            cmd.execute(services.steps()).await.unwrap();
        }

        // List steps
        let cmd = StepListCommand {
            workflow: workflow_id.clone(),
        };
        let result = cmd.execute(services.steps()).await.unwrap();

        // Verify output contains steps
        assert!(result.contains("Steps for workflow"));
        assert!(result.contains("Step 1"));
        assert!(result.contains("Step 2"));
        assert!(result.contains("Step 3"));
        assert!(result.contains("FINAL"));
    }

    #[tokio::test]
    async fn test_list_steps_empty_workflow() {
        let services = mock_services();

        // Create empty workflow
        let workflow_options = CreateWorkflowOptions::new("Empty", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // List steps
        let cmd = StepListCommand {
            workflow: workflow_id,
        };
        let result = cmd.execute(services.steps()).await.unwrap();

        // Verify empty message
        assert!(result.contains("No steps found"));
    }

    #[tokio::test]
    async fn test_list_steps_case_insensitive() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create step
        let cmd = StepAddCommand {
            name: "MyStep".to_string(),
            workflow: workflow_id.clone(),
            id: Some("mystep".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // List with uppercase workflow ID
        let cmd = StepListCommand {
            workflow: workflow_id.to_uppercase(),
        };
        let result = cmd.execute(services.steps()).await.unwrap();

        // Should still find the step
        assert!(result.contains("MyStep"));
    }
}

// ============================================================================
// Step show tests
// ============================================================================

#[cfg(test)]
mod step_show_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_step_basic() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Review".to_string(),
            workflow: workflow_id.clone(),
            id: Some("review".to_string()),
            goal: Some("Review code quality".to_string()),
            agent: vec![],
            skill: vec![],
            model: None,
            order: 1,
            r#final: false,
            transitions_to: vec!["approved".to_string(), "rejected".to_string()],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show step
        let show_cmd = StepShowCommand {
            id: "review".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        // Verify output
        assert!(result.contains("Step: review - Review"));
        assert!(result.contains("Workflow:"));
        assert!(result.contains("Goal:          Review code quality"));
        assert!(result.contains("Order:         1"));
        assert!(result.contains("Is Final:      No"));
        assert!(result.contains("Transitions:   approved, rejected"));
    }

    #[tokio::test]
    async fn test_show_step_with_agents_and_skills() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Analysis".to_string(),
            workflow: workflow_id,
            id: Some("analysis".to_string()),
            goal: None,
            agent: vec![".claude/agents/reviewer.md".to_string()],
            skill: vec!["code-review".to_string(), "lint".to_string()],
            model: Some("opus".to_string()),
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show step
        let show_cmd = StepShowCommand {
            id: "analysis".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        // Verify agents and skills are shown
        assert!(result.contains("Agents:        .claude/agents/reviewer.md"));
        assert!(result.contains("Skills:        code-review, lint"));
        assert!(result.contains("Model:         opus"));
    }

    #[tokio::test]
    async fn test_show_final_step() {
        let services = mock_services();

        // Create workflow and final step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Complete".to_string(),
            workflow: workflow_id,
            id: Some("complete".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 10,
            r#final: true,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show step
        let show_cmd = StepShowCommand {
            id: "complete".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        // Verify final marker
        assert!(result.contains("Is Final:      Yes"));
    }

    #[tokio::test]
    async fn test_show_nonexistent_step() {
        let services = mock_services();

        let cmd = StepShowCommand {
            id: "nonexistent".to_string(),
        };
        let result = cmd.execute(services.steps()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_show_step_case_insensitive() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "MyStep".to_string(),
            workflow: workflow_id,
            id: Some("mystep".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show with uppercase
        let show_cmd = StepShowCommand {
            id: "MYSTEP".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("MyStep"));
    }
}

// ============================================================================
// Step update tests
// ============================================================================

#[cfg(test)]
mod step_update_tests {
    use super::*;

    #[tokio::test]
    async fn test_update_step_name() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Original".to_string(),
            workflow: workflow_id,
            id: Some("step1".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Update name
        let update_cmd = StepUpdateCommand {
            id: "step1".to_string(),
            name: Some("Updated".to_string()),
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec![],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step: step1"));
    }

    #[tokio::test]
    async fn test_update_step_goal() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Analysis".to_string(),
            workflow: workflow_id,
            id: Some("analysis".to_string()),
            goal: Some("Old goal".to_string()),
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Update goal
        let update_cmd = StepUpdateCommand {
            id: "analysis".to_string(),
            name: None,
            goal: Some("New goal".to_string()),
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec![],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_order_and_final() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Update order and final flag
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: Some(5),
            r#final: Some(true),
            transitions_to: vec![],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_add_agents() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Add agents
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![".claude/agents/new.md".to_string()],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec![],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_clear_agents() {
        let services = mock_services();

        // Create workflow and step with agents
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![".claude/agents/old.md".to_string()],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Clear agents
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: true,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec![],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_add_transitions() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Add transitions
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec!["next".to_string(), "retry".to_string()],
            clear_transitions: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_clear_transitions() {
        let services = mock_services();

        // Create workflow and step with transitions
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec!["old".to_string()],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Clear transitions
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            model: None,
            order: None,
            r#final: None,
            transitions_to: vec![],
            clear_transitions: true,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }
}

// ============================================================================
// Step delete tests
// ============================================================================

#[cfg(test)]
mod step_delete_tests {
    use super::*;

    #[tokio::test]
    async fn test_delete_step() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "ToDelete".to_string(),
            workflow: workflow_id,
            id: Some("todelete".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Verify step exists
        let step = services.steps().get_step("todelete").await.unwrap();
        assert!(step.is_some());

        // Delete step
        let delete_cmd = StepDeleteCommand {
            id: "todelete".to_string(),
            force: true,
        };
        let result = delete_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Deleted step: todelete"));

        // Verify step is deleted
        let step = services.steps().get_step("todelete").await.unwrap();
        assert!(step.is_none());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_step() {
        let services = mock_services();

        let delete_cmd = StepDeleteCommand {
            id: "nonexistent".to_string(),
            force: true,
        };
        let result = delete_cmd.execute(services.steps()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_with_force_flag() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Delete with force flag
        let delete_cmd = StepDeleteCommand {
            id: "step".to_string(),
            force: true,
        };
        let result = delete_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Deleted step"));
    }

    #[tokio::test]
    async fn test_delete_case_insensitive() {
        let services = mock_services();

        // Create workflow and step
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("mystep".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            model: None,
            order: 0,
            r#final: false,
            transitions_to: vec![],
        };
        cmd.execute(services.steps()).await.unwrap();

        // Delete with uppercase ID
        let delete_cmd = StepDeleteCommand {
            id: "MYSTEP".to_string(),
            force: true,
        };
        let result = delete_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Deleted step"));
    }
}
