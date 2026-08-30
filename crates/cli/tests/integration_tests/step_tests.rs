//! Integration tests for the `step` command
//!
//! Tests step subcommands including create, list, show, update, and delete operations.

use super::mock::mock_services;
use vertebrae_cli::commands::step::*;
use vertebrae_cli::commands::{Command, CommandResult};
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        let result = cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Created step:"));
    }

    #[tokio::test]
    async fn test_create_update_and_clear_persistence_options() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Default", vec![]))
            .await
            .unwrap();

        let persistence = r#"{"artifact":{"logical_name":"step_result"}}"#;
        let add = StepAddCommand {
            name: "Persisted".to_string(),
            workflow: workflow_id,
            id: Some("persisted-step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: Some(r#"{"type":"object"}"#.to_string()),
            persistence_options: Some(persistence.to_string()),
            route_config: None,
        };
        add.execute(services.steps()).await.unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("persisted-step")
                .await
                .unwrap()
                .unwrap()
                .persistence_options,
            Some(serde_json::json!({ "artifact": { "logical_name": "step_result" } }))
        );

        StepUpdateCommand {
            id: "persisted-step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: Some(
                r#"{"artifact":{"logical_name":"latest_result"}}"#.to_string(),
            ),
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        }
        .execute(services.steps())
        .await
        .unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("persisted-step")
                .await
                .unwrap()
                .unwrap()
                .persistence_options,
            Some(serde_json::json!({ "artifact": { "logical_name": "latest_result" } }))
        );

        StepUpdateCommand {
            id: "persisted-step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: true,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        }
        .execute(services.steps())
        .await
        .unwrap();
        assert!(
            services
                .steps()
                .get_step("persisted-step")
                .await
                .unwrap()
                .unwrap()
                .persistence_options
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_create_finish_step_is_terminal_by_type() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Default", vec![]))
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Finish".to_string(),
            workflow: workflow_id,
            id: Some("finish-step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Finish,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();
        let step = services
            .steps()
            .get_step("finish-step")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(step.step_type, vertebrae_core::StepType::Finish);
        assert!(step.prompt.is_none());
        assert!(step.transitions_to.is_empty());
    }

    #[tokio::test]
    async fn test_create_finish_step_rejects_prompt_and_transitions() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Default", vec![]))
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Invalid Finish".to_string(),
            workflow: workflow_id,
            id: Some("invalid-finish".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: Some("This must not run".to_string()),
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec!["next-step".to_string()],
            step_type: CliStepType::Finish,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        let error = cmd.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("Finish steps"));
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 5,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        // Verify order is set
        let step = services.steps().get_step("deploy").await.unwrap().unwrap();
        assert_eq!(step.order, 5);
    }

    #[tokio::test]
    async fn test_create_finish_step() {
        let services = mock_services();

        // Create workflow
        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create finish step
        let cmd = StepAddCommand {
            name: "Complete".to_string(),
            workflow: workflow_id.clone(),
            id: Some("complete".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Finish,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("complete")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.step_type, vertebrae_core::StepType::Finish);
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![
                "approved".to_string(),
                "rejected".to_string(),
                "needs_revision".to_string(),
            ],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: Some("sonnet".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
                prompt: None,
                agent_config: None,
                model: None,
                provider: None,
                reasoning_effort: None,
                codex_model_provider: None,
                order: i,
                transitions_to: vec![],
                step_type: if i == 2 {
                    CliStepType::Finish
                } else {
                    CliStepType::Execute
                },
                output_schema: None,
                persistence_options: None,
                route_config: None,
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
        assert!(result.contains("1. Step 1 (id: step-0, type: execute, model: default)"));
        assert!(result.contains("2. Step 2 (id: step-1, type: execute, model: default)"));
        assert!(result.contains("3. Step 3 (id: step-2, type: finish, model: default)"));
    }

    #[tokio::test]
    async fn test_list_steps_json_outputs_raw_steps() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Pipeline", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Review".to_string(),
            workflow: workflow_id.clone(),
            id: Some("review-step".to_string()),
            goal: Some("Review implementation".to_string()),
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: Some("sonnet".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Evaluate,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        let command = Command::Step(StepCommand::List(StepListCommand {
            workflow: workflow_id.clone(),
        }));
        let result = command.execute_json(&services).await.unwrap();

        let CommandResult::Json(json) = result else {
            panic!("step list --json should return JSON output");
        };
        let steps = json
            .as_array()
            .expect("step list --json should return an array");

        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["id"], "review-step");
        assert_eq!(steps[0]["name"], "Review");
        assert_eq!(steps[0]["workflow_id"], workflow_id);
        assert_eq!(steps[0]["goal"], "Review implementation");
        assert_eq!(steps[0]["step_type"], "evaluate");
        assert_eq!(steps[0]["agent_config"]["model"], "sonnet");
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 1,
            transitions_to: vec!["approved".to_string(), "rejected".to_string()],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: Some("opus".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
    async fn test_show_finish_step() {
        let services = mock_services();

        // Create workflow and finish step
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 10,
            transitions_to: vec![],
            step_type: CliStepType::Finish,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show step
        let show_cmd = StepShowCommand {
            id: "complete".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Step Type:     finish"));
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        // Show with uppercase
        let show_cmd = StepShowCommand {
            id: "MYSTEP".to_string(),
        };
        let result = show_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("MyStep"));
    }

    #[tokio::test]
    async fn test_show_step_json_outputs_structured_human_input_step() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Ask human".to_string(),
            workflow: workflow_id.clone(),
            id: Some("human-gate".to_string()),
            goal: Some("Collect reviewer decision".to_string()),
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 2,
            transitions_to: vec![],
            step_type: CliStepType::HumanInput,
            output_schema: Some(r#"{"type":"object","required":["decision"]}"#.to_string()),
            persistence_options: Some(
                r#"{"artifact":{"logical_name":"human-result"}}"#.to_string(),
            ),
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        let command = Command::Step(StepCommand::Show(StepShowCommand {
            id: "human-gate".to_string(),
        }));
        let result = command.execute_json(&services).await.unwrap();

        let CommandResult::Json(json) = result else {
            panic!("step show --json should return JSON output");
        };

        assert!(
            json.get("output").is_none(),
            "step show --json should not wrap human-readable output"
        );
        assert_eq!(json["id"], "human-gate");
        assert_eq!(json["name"], "Ask human");
        assert_eq!(json["workflow_id"], workflow_id);
        assert_eq!(json["goal"], "Collect reviewer decision");
        assert_eq!(json["order"], 2);
        assert_eq!(json["step_type"], "human_input");
        assert_eq!(json["output_schema"]["required"][0], "decision");
        assert_eq!(
            json["persistence_options"],
            serde_json::json!({ "artifact": { "logical_name": "human-result" } })
        );
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step: step1"));
    }

    #[tokio::test]
    async fn test_update_step_to_finish_rejects_existing_prompt() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Default", vec![]))
            .await
            .unwrap();

        StepAddCommand {
            name: "Prompted".to_string(),
            workflow: workflow_id,
            id: Some("prompted".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: Some("Run this".to_string()),
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        }
        .execute(services.steps())
        .await
        .unwrap();

        let error = StepUpdateCommand {
            id: "prompted".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: Some(CliStepType::Finish),
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        }
        .execute(services.steps())
        .await
        .unwrap_err();

        assert!(error.to_string().contains("Finish steps"));
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        // Update order
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: Some(5),
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));

        // Verify agents were actually stored (kills !self.agent.is_empty() mutant)
        let step = services.steps().get_step("step").await.unwrap().unwrap();
        assert!(
            step.agents.contains(&".claude/agents/new.md".to_string()),
            "expected agent to be set after update, got: {:?}",
            step.agents
        );
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec!["next".to_string(), "retry".to_string()],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));

        // Verify transitions were actually stored (kills !self.transitions_to.is_empty() mutant)
        let step = services.steps().get_step("step").await.unwrap().unwrap();
        assert!(
            step.transitions_to.contains(&"next".to_string()),
            "expected 'next' transition, got: {:?}",
            step.transitions_to
        );
        assert!(
            step.transitions_to.contains(&"retry".to_string()),
            "expected 'retry' transition, got: {:?}",
            step.transitions_to
        );
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec!["old".to_string()],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: true,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();

        assert!(result.contains("Updated step"));
    }

    #[tokio::test]
    async fn test_update_step_add_skills() {
        let services = mock_services();

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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        cmd.execute(services.steps()).await.unwrap();

        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec!["code-review".to_string(), "testing".to_string()],
            clear_skills: false,
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();
        assert!(result.contains("Updated step"));

        // Verify skills were actually stored (kills !self.skill.is_empty() mutant)
        let step = services.steps().get_step("step").await.unwrap().unwrap();
        assert!(
            step.skills.contains(&"code-review".to_string()),
            "expected 'code-review' skill, got: {:?}",
            step.skills
        );
        assert!(
            step.skills.contains(&"testing".to_string()),
            "expected 'testing' skill, got: {:?}",
            step.skills
        );
    }
}

// ============================================================================
// Step dispatcher tests
// ============================================================================

#[cfg(test)]
mod step_dispatcher_tests {
    use super::*;
    use vertebrae_cli::commands::step::StepCommand;

    #[tokio::test]
    async fn test_step_command_dispatch_add() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepCommand::Add(StepAddCommand {
            name: "Dispatched".to_string(),
            workflow: workflow_id,
            id: Some("dispatched".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        });

        // Call through the dispatcher, not the inner command directly
        let result = cmd.execute(&services).await.unwrap();
        assert!(
            result.starts_with("Created step:"),
            "expected 'Created step:' output, got: {}",
            result
        );
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
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

// ============================================================================
// Step prompt and agent_config tests
// ============================================================================

#[cfg(test)]
mod step_prompt_and_agent_config_tests {
    use super::*;

    #[tokio::test]
    async fn test_create_step_with_prompt() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Review".to_string(),
            workflow: workflow_id,
            id: Some("review".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: Some("Review the code for quality and best practices".to_string()),

            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        let step = services.steps().get_step("review").await.unwrap().unwrap();
        assert_eq!(
            step.prompt,
            Some("Review the code for quality and best practices".to_string())
        );
    }

    #[tokio::test]
    async fn test_create_step_with_agent_config_json() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Deploy".to_string(),
            workflow: workflow_id,
            id: Some("deploy".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: Some(r#"{"model":"opus","max_budget_usd":5.0}"#.to_string()),
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        let step = services.steps().get_step("deploy").await.unwrap().unwrap();
        assert_eq!(step.agent_config.model, Some("opus".to_string()));
        assert_eq!(step.agent_config.max_budget_usd, Some(5.0));
    }

    #[tokio::test]
    async fn test_create_step_agent_config_and_model_override() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // --agent-config sets model to "sonnet", but --model overrides to "opus"
        let cmd = StepAddCommand {
            name: "Override".to_string(),
            workflow: workflow_id,
            id: Some("override".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: Some(r#"{"model":"sonnet","max_budget_usd":10.0}"#.to_string()),
            model: Some("opus".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("override")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            step.agent_config.model,
            Some("opus".to_string()),
            "--model should override model from --agent-config"
        );
        assert_eq!(
            step.agent_config.max_budget_usd,
            Some(10.0),
            "Other agent_config fields from JSON should be preserved"
        );
    }

    #[tokio::test]
    async fn test_create_step_invalid_agent_config_json() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "Bad".to_string(),
            workflow: workflow_id,
            id: None,
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: Some("not valid json".to_string()),
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        let result = cmd.execute(services.steps()).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("--agent-config JSON"),
            "Error should mention --agent-config JSON, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_update_step_with_agent_config_json() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let add_cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: Some("sonnet".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        add_cmd.execute(services.steps()).await.unwrap();

        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: Some(r#"{"model":"haiku","max_budget_usd":2.5}"#.to_string()),
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();
        assert!(result.contains("Updated step: step"));
    }

    #[tokio::test]
    async fn test_update_step_agent_config_and_model_override() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let add_cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        add_cmd.execute(services.steps()).await.unwrap();

        // --agent-config sets model to "sonnet", --model overrides to "opus"
        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: Some(r#"{"model":"sonnet","max_budget_usd":3.0}"#.to_string()),
            model: Some("opus".to_string()),
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await.unwrap();
        assert!(result.contains("Updated step: step"));
    }

    #[tokio::test]
    async fn test_update_step_invalid_agent_config_json() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let add_cmd = StepAddCommand {
            name: "Step".to_string(),
            workflow: workflow_id,
            id: Some("step".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };
        add_cmd.execute(services.steps()).await.unwrap();

        let update_cmd = StepUpdateCommand {
            id: "step".to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config: Some("{bad json}".to_string()),
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        };

        let result = update_cmd.execute(services.steps()).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("--agent-config JSON"),
            "Error should mention --agent-config JSON, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_create_step_with_prompt_and_agent_config_together() {
        let services = mock_services();

        let workflow_options = CreateWorkflowOptions::new("Default", vec![]);
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        let cmd = StepAddCommand {
            name: "FullStep".to_string(),
            workflow: workflow_id,
            id: Some("full".to_string()),
            goal: Some("Complete review".to_string()),
            agent: vec![],
            skill: vec![],
            prompt: Some("Analyze the codebase".to_string()),
            agent_config: Some(r#"{"model":"opus","max_budget_usd":15.0}"#.to_string()),
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 2,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        };

        cmd.execute(services.steps()).await.unwrap();

        let step = services.steps().get_step("full").await.unwrap().unwrap();
        assert_eq!(step.prompt, Some("Analyze the codebase".to_string()));
        assert_eq!(step.goal, Some("Complete review".to_string()));
        assert_eq!(step.agent_config.model, Some("opus".to_string()));
        assert_eq!(step.agent_config.max_budget_usd, Some(15.0));
        assert_eq!(step.order, 2);
    }
}

// ============================================================================
// Provider selection tests
// ============================================================================

#[cfg(test)]
mod provider_tests {
    use super::*;
    use vertebrae_core::{AgentConfig, PermissionMode, Provider};

    fn add_cmd_with(
        name: &str,
        workflow_id: String,
        id: &str,
        agent_config: Option<String>,
        model: Option<String>,
        provider: Option<Provider>,
    ) -> StepAddCommand {
        StepAddCommand {
            name: name.to_string(),
            workflow: workflow_id,
            id: Some(id.to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config,
            model,
            provider,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        }
    }

    fn update_cmd_with(
        id: &str,
        agent_config: Option<String>,
        model: Option<String>,
        provider: Option<Provider>,
    ) -> StepUpdateCommand {
        StepUpdateCommand {
            id: id.to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            agent_config,
            model,
            provider,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_prompt: false,
            clear_route_config: false,
        }
    }

    async fn mk_workflow() -> (vertebrae_core::VertebraeServices, String) {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Default", vec![]))
            .await
            .unwrap();
        (services, workflow_id)
    }

    #[tokio::test]
    async fn add_overlay_preserves_unrelated_agent_config_fields() {
        let (services, workflow_id) = mk_workflow().await;

        let agent_config_json = r#"{
            "model": "sonnet",
            "system_prompt": "Be helpful",
            "permission_mode": "plan",
            "max_budget_usd": 7.5,
            "allowed_tools": ["bash", "read"]
        }"#;

        let cmd = add_cmd_with(
            "Step",
            workflow_id,
            "ovl-1",
            Some(agent_config_json.to_string()),
            Some("opus".to_string()),
            Some(Provider::Anthropic),
        );

        cmd.execute(services.steps()).await.unwrap();

        let step = services.steps().get_step("ovl-1").await.unwrap().unwrap();
        let cfg: &AgentConfig = &step.agent_config;

        assert_eq!(cfg.model.as_deref(), Some("opus"));
        assert_eq!(cfg.provider, Some(Provider::Anthropic));
        assert_eq!(cfg.system_prompt.as_deref(), Some("Be helpful"));
        assert_eq!(cfg.permission_mode, Some(PermissionMode::Plan));
        assert_eq!(cfg.max_budget_usd, Some(7.5));
        assert_eq!(
            cfg.allowed_tools,
            vec!["bash".to_string(), "read".to_string()]
        );
    }

    #[tokio::test]
    async fn add_persists_openai_reasoning_effort() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Codex",
            workflow_id,
            "reason-1",
            None,
            Some("gpt-5.5".to_string()),
            Some(Provider::Openai),
        );
        cmd.reasoning_effort = Some(" HIGH ".to_string());

        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("reason-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Openai));
        assert_eq!(step.agent_config.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(step.agent_config.reasoning_effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn add_persists_codex_model_provider_with_provider_scoped_model() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Codex",
            workflow_id,
            "codex-provider-1",
            None,
            Some("deepseek/deepseek-v4-flash".to_string()),
            Some(Provider::Openai),
        );
        cmd.codex_model_provider = Some(" OpenRouter ".to_string());

        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("codex-provider-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Openai));
        assert_eq!(
            step.agent_config.model.as_deref(),
            Some("deepseek/deepseek-v4-flash")
        );
        assert_eq!(
            step.agent_config.codex_model_provider.as_deref(),
            Some("openrouter")
        );
    }

    #[tokio::test]
    async fn add_rejects_invalid_reasoning_effort_before_persistence() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-reason-1",
            None,
            Some("gpt-5.5".to_string()),
            Some(Provider::Openai),
        );
        cmd.reasoning_effort = Some("minimal".to_string());

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("minimal"), "got: {msg}");
        assert!(msg.contains("low"), "got: {msg}");
        assert!(
            services
                .steps()
                .get_step("bad-reason-1")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn add_rejects_anthropic_reasoning_effort() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-reason-2",
            None,
            Some("opus".to_string()),
            Some(Provider::Anthropic),
        );
        cmd.reasoning_effort = Some("high".to_string());

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("openai"), "got: {msg}");
        assert!(msg.contains("anthropic"), "got: {msg}");
        assert!(
            services
                .steps()
                .get_step("bad-reason-2")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn update_provider_only_preserves_existing_agent_config() {
        let (services, workflow_id) = mk_workflow().await;

        let initial = r#"{
            "model": "claude-opus-4-5",
            "system_prompt": "Original prompt",
            "permission_mode": "auto",
            "max_budget_usd": 12.0,
            "allowed_tools": ["bash"]
        }"#;
        add_cmd_with(
            "S",
            workflow_id,
            "upd-1",
            Some(initial.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        update_cmd_with("upd-1", None, None, Some(Provider::Anthropic))
            .execute(services.steps())
            .await
            .unwrap();

        let step = services.steps().get_step("upd-1").await.unwrap().unwrap();
        let cfg = &step.agent_config;

        assert_eq!(cfg.provider, Some(Provider::Anthropic));
        assert_eq!(cfg.model.as_deref(), Some("claude-opus-4-5"));
        assert_eq!(cfg.system_prompt.as_deref(), Some("Original prompt"));
        assert_eq!(cfg.permission_mode, Some(PermissionMode::Auto));
        assert_eq!(cfg.max_budget_usd, Some(12.0));
        assert_eq!(cfg.allowed_tools, vec!["bash".to_string()]);
    }

    #[tokio::test]
    async fn update_reasoning_effort_preserves_existing_provider_and_model() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "Codex",
            workflow_id,
            "reason-upd-1",
            Some(r#"{"provider":"openai","model":"gpt-5.5"}"#.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        let mut cmd = update_cmd_with("reason-upd-1", None, None, None);
        cmd.reasoning_effort = Some("xhigh".to_string());
        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("reason-upd-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Openai));
        assert_eq!(step.agent_config.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(step.agent_config.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[tokio::test]
    async fn update_persists_codex_model_provider_and_provider_scoped_model() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "Codex",
            workflow_id,
            "codex-provider-upd-1",
            Some(r#"{"provider":"openai","model":"gpt-5.5"}"#.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        let mut cmd = update_cmd_with(
            "codex-provider-upd-1",
            None,
            Some("glm-5.1".to_string()),
            Some(Provider::Openai),
        );
        cmd.codex_model_provider = Some("zai".to_string());
        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("codex-provider-upd-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Openai));
        assert_eq!(step.agent_config.model.as_deref(), Some("glm-5.1"));
        assert_eq!(
            step.agent_config.codex_model_provider.as_deref(),
            Some("zai")
        );
    }

    #[tokio::test]
    async fn update_normalizes_reasoning_effort() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "Codex",
            workflow_id,
            "reason-upd-2",
            Some(r#"{"provider":"openai","model":"gpt-5.5"}"#.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        let mut cmd = update_cmd_with("reason-upd-2", None, None, None);
        cmd.reasoning_effort = Some(" HIGH ".to_string());
        cmd.execute(services.steps()).await.unwrap();

        let step = services
            .steps()
            .get_step("reason-upd-2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.reasoning_effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn update_to_anthropic_clears_stale_reasoning_effort() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "Codex",
            workflow_id,
            "reason-upd-3",
            Some(
                r#"{"provider":"openai","model":"gpt-5.5","reasoning_effort":"high"}"#.to_string(),
            ),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        update_cmd_with(
            "reason-upd-3",
            None,
            Some("opus".to_string()),
            Some(Provider::Anthropic),
        )
        .execute(services.steps())
        .await
        .unwrap();

        let step = services
            .steps()
            .get_step("reason-upd-3")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Anthropic));
        assert_eq!(step.agent_config.model.as_deref(), Some("opus"));
        assert_eq!(step.agent_config.reasoning_effort, None);
    }

    #[tokio::test]
    async fn update_model_only_preserves_existing_provider_and_fields() {
        let (services, workflow_id) = mk_workflow().await;

        let initial = r#"{
            "provider": "anthropic",
            "model": "sonnet",
            "system_prompt": "Stay focused",
            "max_budget_usd": 4.0
        }"#;
        add_cmd_with(
            "S",
            workflow_id,
            "upd-2",
            Some(initial.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        update_cmd_with("upd-2", None, Some("opus".to_string()), None)
            .execute(services.steps())
            .await
            .unwrap();

        let step = services.steps().get_step("upd-2").await.unwrap().unwrap();
        let cfg = &step.agent_config;

        assert_eq!(cfg.provider, Some(Provider::Anthropic));
        assert_eq!(cfg.model.as_deref(), Some("opus"));
        assert_eq!(cfg.system_prompt.as_deref(), Some("Stay focused"));
        assert_eq!(cfg.max_budget_usd, Some(4.0));
    }

    #[tokio::test]
    async fn add_rejects_openai_provider_with_claude_model() {
        let (services, workflow_id) = mk_workflow().await;

        let cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-1",
            None,
            Some("claude-opus".to_string()),
            Some(Provider::Openai),
        );

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("claude-opus"),
            "error should mention rejected model: {}",
            msg
        );
        assert!(
            msg.to_lowercase().contains("anthropic"),
            "error should suggest anthropic provider: {}",
            msg
        );
        assert!(
            msg.to_lowercase().contains("openai"),
            "error should mention requested provider: {}",
            msg
        );

        assert!(services.steps().get_step("bad-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn add_rejects_openai_provider_with_unknown_model() {
        let (services, workflow_id) = mk_workflow().await;

        let cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-2",
            None,
            Some("kimi2.6".to_string()),
            Some(Provider::Openai),
        );

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("kimi2.6"),
            "error should mention model: {}",
            msg
        );
        assert!(
            msg.contains("catalog"),
            "error should mention catalog: {}",
            msg
        );

        assert!(services.steps().get_step("bad-2").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn add_rejects_anthropic_provider_with_codex_model_provider() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-codex-provider-1",
            None,
            Some("opus".to_string()),
            Some(Provider::Anthropic),
        );
        cmd.codex_model_provider = Some("openrouter".to_string());

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("openrouter"), "got: {msg}");
        assert!(msg.contains("openai"), "got: {msg}");
        assert!(msg.contains("anthropic"), "got: {msg}");
        assert!(
            services
                .steps()
                .get_step("bad-codex-provider-1")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn add_rejects_codex_model_provider_without_openai_provider() {
        let (services, workflow_id) = mk_workflow().await;

        let mut cmd = add_cmd_with(
            "Bad",
            workflow_id,
            "bad-codex-provider-2",
            None,
            Some("deepseek/deepseek-v4-flash".to_string()),
            None,
        );
        cmd.codex_model_provider = Some("openrouter".to_string());

        let err = cmd.execute(services.steps()).await.expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("openrouter"), "got: {msg}");
        assert!(msg.contains("openai"), "got: {msg}");
        assert!(msg.contains("anthropic"), "got: {msg}");
        assert!(
            services
                .steps()
                .get_step("bad-codex-provider-2")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn update_rejects_openai_provider_with_claude_model() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "S",
            workflow_id,
            "upd-bad-1",
            Some(r#"{"provider":"anthropic","model":"sonnet"}"#.to_string()),
            None,
            None,
        )
        .execute(services.steps())
        .await
        .unwrap();

        let err = update_cmd_with(
            "upd-bad-1",
            None,
            Some("claude-opus".to_string()),
            Some(Provider::Openai),
        )
        .execute(services.steps())
        .await
        .expect_err("must fail");
        let msg = err.to_string();
        assert!(msg.contains("claude-opus"));
        assert!(msg.to_lowercase().contains("openai"));

        let step = services
            .steps()
            .get_step("upd-bad-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Anthropic));
        assert_eq!(step.agent_config.model.as_deref(), Some("sonnet"));
    }

    #[tokio::test]
    async fn add_accepts_unknown_model_via_full_agent_config_json() {
        let (services, workflow_id) = mk_workflow().await;

        let cmd = add_cmd_with(
            "Custom",
            workflow_id,
            "esc-1",
            Some(r#"{"model":"vendor-mystery-3"}"#.to_string()),
            None,
            None,
        );

        cmd.execute(services.steps()).await.unwrap();
        let step = services.steps().get_step("esc-1").await.unwrap().unwrap();
        assert_eq!(step.agent_config.model.as_deref(), Some("vendor-mystery-3"));
        assert_eq!(step.agent_config.provider, None);
    }

    #[tokio::test]
    async fn add_accepts_matching_provider_and_model() {
        let (services, workflow_id) = mk_workflow().await;

        add_cmd_with(
            "OK",
            workflow_id.clone(),
            "ok-1",
            None,
            Some("gpt-4o".to_string()),
            Some(Provider::Openai),
        )
        .execute(services.steps())
        .await
        .unwrap();

        let step = services.steps().get_step("ok-1").await.unwrap().unwrap();
        assert_eq!(step.agent_config.provider, Some(Provider::Openai));
        assert_eq!(step.agent_config.model.as_deref(), Some("gpt-4o"));
    }
}

// ============================================================================
// Deterministic route configuration tests
// ============================================================================

#[cfg(test)]
mod route_config_tests {
    use super::*;
    use vertebrae_core::{Step, StepType};

    fn route_config() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "rules": [
                {
                    "id": "result-rule",
                    "when": {"kind": "result", "step_id": "source", "path": "$.decision"},
                    "then": {"kind": "step", "step_id": "approved"}
                },
                {
                    "id": "level-tag-visit-rule",
                    "when": {
                        "all": [
                            {"kind": "level", "value": "task"},
                            {"kind": "tag", "value": "urgent"},
                            {"kind": "visit_count", "step_id": "router", "value": 2}
                        ]
                    },
                    "then": {
                        "kind": "workflow_step",
                        "workflow_id": "workflow-b",
                        "step_id": "review"
                    }
                }
            ],
            "future": {"nested": ["preserve", 3, false, null]}
        })
    }

    fn add_command(workflow: &str, id: &str, route_config: Option<String>) -> StepAddCommand {
        StepAddCommand {
            name: "Router".to_string(),
            workflow: workflow.to_string(),
            id: Some(id.to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: None,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Route,
            output_schema: None,
            persistence_options: None,
            route_config,
        }
    }

    fn update_command(id: &str) -> StepUpdateCommand {
        StepUpdateCommand {
            id: id.to_string(),
            name: None,
            goal: None,
            agent: vec![],
            clear_agents: false,
            skill: vec![],
            clear_skills: false,
            prompt: None,
            clear_prompt: false,
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: None,
            transitions_to: vec![],
            clear_transitions: false,
            step_type: None,
            output_schema: None,
            clear_output_schema: false,
            persistence_options: None,
            clear_persistence_options: false,
            route_config: None,
            clear_route_config: false,
        }
    }

    #[tokio::test]
    async fn route_config_can_be_drafted_set_replaced_and_cleared_exactly() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Routes", vec![]))
            .await
            .unwrap();

        add_command(&workflow_id, "router", None)
            .execute(services.steps())
            .await
            .unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("router")
                .await
                .unwrap()
                .unwrap()
                .route_config,
            None
        );

        let first = route_config();
        let mut update = update_command("router");
        update.route_config = Some(first.to_string());
        update.execute(services.steps()).await.unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("router")
                .await
                .unwrap()
                .unwrap()
                .route_config,
            Some(first.clone())
        );

        let replacement = serde_json::json!({
            "version": 2,
            "rules": [{"future_rule": {"array": [1, true, null]}}]
        });
        let mut update = update_command("router");
        update.route_config = Some(replacement.to_string());
        update.execute(services.steps()).await.unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("router")
                .await
                .unwrap()
                .unwrap()
                .route_config,
            Some(replacement)
        );

        let mut update = update_command("router");
        update.clear_route_config = true;
        update.execute(services.steps()).await.unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("router")
                .await
                .unwrap()
                .unwrap()
                .route_config,
            None
        );
    }

    #[tokio::test]
    async fn route_prompt_clear_is_distinct_from_empty_prompt_and_visible_in_reads() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Routes", vec![]))
            .await
            .unwrap();
        let config = route_config();
        let mut route_step = Step::new("Router", workflow_id)
            .with_step_type(StepType::Route)
            .with_prompt("legacy prompt")
            .with_route_config(config.clone());
        route_step.id = Some("router".to_string());
        services.steps().create_step(&route_step).await.unwrap();

        let human = StepShowCommand {
            id: "router".to_string(),
        }
        .execute(services.steps())
        .await
        .unwrap();
        assert!(human.contains("Prompt:        legacy prompt"));
        assert!(human.contains("Route Config:"));
        assert!(human.contains("\"future\""));

        let json = Command::Step(StepCommand::Show(StepShowCommand {
            id: "router".to_string(),
        }))
        .execute_json(&services)
        .await
        .unwrap();
        let CommandResult::Json(json) = json else {
            panic!("step show --json should return the raw step");
        };
        assert_eq!(json["prompt"], "legacy prompt");
        assert_eq!(json["route_config"], config);

        let mut update = update_command("router");
        update.clear_prompt = true;
        update.execute(services.steps()).await.unwrap();
        assert_eq!(
            services
                .steps()
                .get_step("router")
                .await
                .unwrap()
                .unwrap()
                .prompt,
            None
        );

        let mut update = update_command("router");
        update.prompt = Some(String::new());
        let error = update.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("Route steps"));
    }

    #[tokio::test]
    async fn route_invariants_reject_invalid_arguments_before_mutation() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Routes", vec![]))
            .await
            .unwrap();

        let mut non_route = add_command(&workflow_id, "execute", Some(route_config().to_string()));
        non_route.step_type = CliStepType::Execute;
        let error = non_route.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("only valid for route steps"));
        assert!(
            services
                .steps()
                .get_step("execute")
                .await
                .unwrap()
                .is_none()
        );

        let mut prompted_route = add_command(&workflow_id, "prompted", None);
        prompted_route.prompt = Some("write this".to_string());
        let error = prompted_route.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("only clear"));
        assert!(
            services
                .steps()
                .get_step("prompted")
                .await
                .unwrap()
                .is_none()
        );

        let malformed = add_command(&workflow_id, "malformed", Some("{not-json}".to_string()));
        let error = malformed.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("Invalid --route-config JSON"));
        assert!(
            services
                .steps()
                .get_step("malformed")
                .await
                .unwrap()
                .is_none()
        );

        add_command(&workflow_id, "conflict", None)
            .execute(services.steps())
            .await
            .unwrap();
        let mut conflict = update_command("conflict");
        conflict.route_config = Some(route_config().to_string());
        conflict.clear_route_config = true;
        let error = conflict.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("cannot be used together"));
        assert_eq!(
            services
                .steps()
                .get_step("conflict")
                .await
                .unwrap()
                .unwrap()
                .route_config,
            None
        );
    }

    #[tokio::test]
    async fn conversion_away_from_configured_route_requires_atomic_clear() {
        let services = mock_services();
        let workflow_id = services
            .workflows()
            .create_workflow(CreateWorkflowOptions::new("Routes", vec![]))
            .await
            .unwrap();
        let prompt = "keep until explicitly cleared";
        let config = route_config();
        StepAddCommand {
            name: "Execute".to_string(),
            workflow: workflow_id,
            id: Some("convert".to_string()),
            goal: None,
            agent: vec![],
            skill: vec![],
            prompt: Some(prompt.to_string()),
            agent_config: None,
            model: None,
            provider: None,
            reasoning_effort: None,
            codex_model_provider: None,
            order: 0,
            transitions_to: vec![],
            step_type: CliStepType::Execute,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        }
        .execute(services.steps())
        .await
        .unwrap();

        let mut to_route = update_command("convert");
        to_route.step_type = Some(CliStepType::Route);
        to_route.route_config = Some(config.to_string());
        let error = to_route.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("only clear"));
        let unchanged = services.steps().get_step("convert").await.unwrap().unwrap();
        assert_eq!(unchanged.step_type, StepType::Execute);
        assert_eq!(unchanged.prompt.as_deref(), Some(prompt));
        assert_eq!(unchanged.route_config, None);

        let mut to_route = update_command("convert");
        to_route.step_type = Some(CliStepType::Route);
        to_route.route_config = Some(config.clone().to_string());
        to_route.clear_prompt = true;
        to_route.execute(services.steps()).await.unwrap();
        let routed = services.steps().get_step("convert").await.unwrap().unwrap();
        assert_eq!(routed.step_type, StepType::Route);
        assert_eq!(routed.prompt, None);
        assert_eq!(routed.route_config, Some(config.clone()));

        let mut to_execute = update_command("convert");
        to_execute.step_type = Some(CliStepType::Execute);
        let error = to_execute.execute(services.steps()).await.unwrap_err();
        assert!(error.to_string().contains("route_config"));
        let still_routed = services.steps().get_step("convert").await.unwrap().unwrap();
        assert_eq!(still_routed.step_type, StepType::Route);
        assert_eq!(still_routed.route_config, Some(config.clone()));

        let mut to_execute = update_command("convert");
        to_execute.step_type = Some(CliStepType::Execute);
        to_execute.clear_route_config = true;
        to_execute.execute(services.steps()).await.unwrap();
        let executed = services.steps().get_step("convert").await.unwrap().unwrap();
        assert_eq!(executed.step_type, StepType::Execute);
        assert_eq!(executed.route_config, None);
    }
}
