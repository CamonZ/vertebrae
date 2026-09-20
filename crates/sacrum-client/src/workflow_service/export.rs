use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::{
    StepAddress, StepEdge, StepManifest, StepType, WORKFLOW_BUNDLE_SCHEMA_VERSION,
    WorkflowBundleManifest, WorkflowEdge, WorkflowManifest, symbolize_route_config,
};

use crate::api_types::{
    ShortIdResponse, WorkflowExport, WorkflowExportSnapshot, WorkflowExportStep,
};
use crate::client::with_fragments;
use crate::queries::steps::WORKFLOW_EXPORT_STEP_FIELDS;
use crate::queries::workflows::{
    EXPORT_WORKFLOW, LIST_WORKFLOW_EXPORT_IDS, WORKFLOW_EXPORT_FIELDS,
};

use super::SacrumWorkflowService;

impl SacrumWorkflowService {
    pub async fn export_workflow_bundle(
        &self,
        workflow_id: Option<&str>,
    ) -> ServiceResult<WorkflowBundleManifest> {
        let snapshot = self.export_workflow_snapshot(workflow_id).await?;
        snapshot_to_bundle(&snapshot)
    }

    /// Read a complete workflow graph for one workflow or the configured
    /// project.
    ///
    /// Export snapshots intentionally retain Sacrum's wire DTOs rather than
    /// converting through [`crate::api_types::WorkflowResponse`], whose
    /// nested steps and metadata are presentation projections. The operation
    /// is read-only and returns an error for missing or structurally
    /// incomplete graph data.
    pub async fn export_workflow_snapshot(
        &self,
        workflow_id: Option<&str>,
    ) -> ServiceResult<WorkflowExportSnapshot> {
        let fragments = [WORKFLOW_EXPORT_FIELDS, WORKFLOW_EXPORT_STEP_FIELDS];
        let workflows = match workflow_id {
            Some(workflow_id) => {
                let query = with_fragments(EXPORT_WORKFLOW, &fragments);
                vec![self.read_export_workflow(&query, workflow_id).await?]
            }
            None => {
                let workflow_ids: Vec<ShortIdResponse> = self
                    .client
                    .execute(
                        LIST_WORKFLOW_EXPORT_IDS,
                        json!({ "project_id": self.client.project_id() }),
                        "workflows",
                    )
                    .await?;
                let query = with_fragments(EXPORT_WORKFLOW, &fragments);
                let mut workflows = Vec::with_capacity(workflow_ids.len());
                for workflow_id in workflow_ids {
                    workflows.push(self.read_export_workflow(&query, &workflow_id.id).await?);
                }
                workflows
            }
        };

        let snapshot = WorkflowExportSnapshot {
            project_id: self.client.project_id().to_string(),
            workflows,
        };
        Self::validate_export_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    async fn read_export_workflow(
        &self,
        query: &str,
        workflow_id: &str,
    ) -> ServiceResult<WorkflowExport> {
        let workflow: Option<WorkflowExport> = self
            .client
            .execute(query, json!({ "id": workflow_id }), "workflow")
            .await?;
        let workflow = workflow.ok_or_else(|| ServiceError::workflow_not_found(workflow_id))?;
        if workflow.id != workflow_id {
            return Err(ServiceError::invalid_input(format!(
                "workflow export returned {} for requested workflow {}",
                workflow.id, workflow_id
            )));
        }
        Ok(workflow)
    }

    fn validate_export_snapshot(snapshot: &WorkflowExportSnapshot) -> ServiceResult<()> {
        let workflow_ids: HashSet<&str> = snapshot
            .workflows
            .iter()
            .map(|workflow| workflow.id.as_str())
            .collect();
        if workflow_ids.len() != snapshot.workflows.len() {
            return Err(ServiceError::invalid_input(
                "workflow export contains duplicate workflow IDs",
            ));
        }

        let mut all_step_ids = HashSet::new();
        for workflow in &snapshot.workflows {
            if workflow.project_id != snapshot.project_id {
                return Err(ServiceError::invalid_input(format!(
                    "workflow {} belongs to project {}, expected {}",
                    workflow.id, workflow.project_id, snapshot.project_id
                )));
            }

            let step_ids: HashSet<&str> = workflow
                .workflow_steps
                .iter()
                .map(|step| step.id.as_str())
                .collect();
            if step_ids.len() != workflow.workflow_steps.len() {
                return Err(ServiceError::invalid_input(format!(
                    "workflow {} export contains duplicate step IDs",
                    workflow.id
                )));
            }
            if step_ids
                .iter()
                .any(|step_id| !all_step_ids.insert(*step_id))
            {
                return Err(ServiceError::invalid_input(
                    "workflow export contains duplicate step IDs across workflows",
                ));
            }

            if let Some(initial_step_id) = &workflow.initial_step_id
                && !step_ids.contains(initial_step_id.as_str())
            {
                return Err(ServiceError::invalid_input(format!(
                    "workflow {} export references missing initial step {}",
                    workflow.id, initial_step_id
                )));
            }

            for step in &workflow.workflow_steps {
                if step.workflow_id != workflow.id {
                    return Err(ServiceError::invalid_input(format!(
                        "step {} belongs to workflow {}, expected {}",
                        step.id, step.workflow_id, workflow.id
                    )));
                }
                if step.project_id != snapshot.project_id {
                    return Err(ServiceError::invalid_input(format!(
                        "step {} belongs to project {}, expected {}",
                        step.id, step.project_id, snapshot.project_id
                    )));
                }
                for transition in &step.transitions {
                    if !step_ids.contains(transition.to_step_id.as_str()) {
                        return Err(ServiceError::invalid_input(format!(
                            "step {} transition {} references missing step {}",
                            step.id, transition.id, transition.to_step_id
                        )));
                    }
                }
            }

            for transition in &workflow.transitions {
                let Some(target_workflow) = snapshot
                    .workflows
                    .iter()
                    .find(|candidate| candidate.id == transition.to_workflow_id)
                else {
                    return Err(closed_bundle_error(
                        &workflow.id,
                        &transition.to_workflow_id,
                        format!(
                            "workflow transition {} has missing destination workflow {}",
                            transition.id, transition.to_workflow_id
                        ),
                    ));
                };
                if let Some(target_step_id) = &transition.target_step_id
                    && !target_workflow
                        .workflow_steps
                        .iter()
                        .any(|step| step.id == *target_step_id)
                {
                    return Err(ServiceError::invalid_input(format!(
                        "workflow {} transition {} references missing target step {} in workflow {}",
                        workflow.id, transition.id, target_step_id, target_workflow.id
                    )));
                }
            }
        }

        Ok(())
    }
}

#[derive(Debug, Default)]
struct ReferenceMaps {
    workflow_refs: HashMap<String, String>,
    step_refs: HashMap<String, String>,
    step_addresses: HashMap<String, StepAddress>,
}

impl ReferenceMaps {
    fn route_target_refs(&self, workflow_ref: &str) -> vertebrae_core::RouteTargetRefs {
        vertebrae_core::RouteTargetRefs {
            step_refs: self
                .step_refs
                .iter()
                .filter_map(|(id, step_ref)| {
                    self.step_addresses.get(id).and_then(|address| {
                        (address.workflow_ref == workflow_ref)
                            .then(|| (id.clone(), step_ref.clone()))
                    })
                })
                .collect(),
            workflow_refs: self.workflow_refs.clone().into_iter().collect(),
        }
    }
}

fn snapshot_to_bundle(snapshot: &WorkflowExportSnapshot) -> ServiceResult<WorkflowBundleManifest> {
    let mut refs = ReferenceMaps::default();
    let workflow_order = ordered_workflows(&snapshot.workflows);
    let mut workflow_names = BTreeMap::new();
    for workflow in &workflow_order {
        let base = portable_ref(&workflow.name, "workflow");
        let workflow_ref = unique_ref(base, &mut workflow_names);
        refs.workflow_refs.insert(workflow.id.clone(), workflow_ref);
    }

    let mut workflow_manifests = Vec::with_capacity(snapshot.workflows.len());
    for workflow in &workflow_order {
        let workflow_ref = refs
            .workflow_refs
            .get(&workflow.id)
            .expect("every workflow has a generated ref")
            .clone();
        let step_order = ordered_steps(&workflow.workflow_steps);
        let mut step_names = BTreeMap::new();
        for step in &step_order {
            let base = portable_ref(&step.name, "step");
            let step_ref = unique_ref(base, &mut step_names);
            refs.step_refs.insert(step.id.clone(), step_ref.clone());
            refs.step_addresses
                .insert(step.id.clone(), StepAddress::new(&workflow_ref, step_ref));
        }

        let initial_step = workflow
            .initial_step_id
            .as_ref()
            .map(|step_id| {
                refs.step_addresses.get(step_id).cloned().ok_or_else(|| {
                    ServiceError::invalid_input(format!(
                        "workflow {} references missing initial step {}",
                        workflow.id, step_id
                    ))
                })
            })
            .transpose()?;

        let steps = step_order
            .iter()
            .map(|step| convert_step(step, &workflow.id, &workflow_ref, &refs))
            .collect::<ServiceResult<Vec<_>>>()?;

        workflow_manifests.push(WorkflowManifest {
            workflow_ref,
            name: workflow.name.clone(),
            description: workflow.description.clone(),
            display_order: workflow.display_order.unwrap_or_default(),
            is_default: workflow.is_default.unwrap_or(false),
            kanban_column: workflow.kanban_column.clone(),
            factory_name: workflow.factory_name.clone(),
            metadata: workflow.metadata.clone(),
            initial_step,
            steps,
        });
    }

    let mut step_edges = Vec::new();
    for workflow in &snapshot.workflows {
        for step in &workflow.workflow_steps {
            let from = refs
                .step_addresses
                .get(&step.id)
                .cloned()
                .ok_or_else(|| missing_ref("step", &step.id))?;
            for transition in &step.transitions {
                let to = refs
                    .step_addresses
                    .get(&transition.to_step_id)
                    .cloned()
                    .ok_or_else(|| {
                        closed_bundle_error(
                            &workflow.id,
                            &transition.to_step_id,
                            format!(
                                "step transition {} has missing destination step {}",
                                transition.id, transition.to_step_id
                            ),
                        )
                    })?;
                step_edges.push(StepEdge {
                    from: from.clone(),
                    to,
                    label: transition.label.clone(),
                });
            }
        }
    }

    let mut workflow_edges = Vec::new();
    for workflow in &snapshot.workflows {
        let from_workflow_ref = refs
            .workflow_refs
            .get(&workflow.id)
            .cloned()
            .ok_or_else(|| missing_ref("workflow", &workflow.id))?;
        for transition in &workflow.transitions {
            let to_workflow_ref = refs
                .workflow_refs
                .get(&transition.to_workflow_id)
                .cloned()
                .ok_or_else(|| {
                    closed_bundle_error(
                        &workflow.id,
                        &transition.to_workflow_id,
                        format!(
                            "workflow transition {} has missing destination workflow {}",
                            transition.id, transition.to_workflow_id
                        ),
                    )
                })?;
            let destination_step = transition
                .target_step_id
                .as_ref()
                .map(|step_id| {
                    refs.step_addresses.get(step_id).cloned().ok_or_else(|| {
                        closed_bundle_error(
                            &workflow.id,
                            step_id,
                            format!(
                                "workflow transition {} has missing destination step {}",
                                transition.id, step_id
                            ),
                        )
                    })
                })
                .transpose()?;
            workflow_edges.push(WorkflowEdge {
                from_workflow_ref: from_workflow_ref.clone(),
                to_workflow_ref,
                destination_step,
                label: transition.label.clone(),
            });
        }
    }

    let bundle = WorkflowBundleManifest {
        schema_version: WORKFLOW_BUNDLE_SCHEMA_VERSION,
        workflows: workflow_manifests,
        step_edges,
        workflow_edges,
    };
    bundle.validate().map_err(|error| {
        ServiceError::invalid_input(format!("workflow export validation failed: {error}"))
    })?;
    Ok(bundle)
}

fn convert_step(
    step: &WorkflowExportStep,
    workflow_id: &str,
    workflow_ref: &str,
    refs: &ReferenceMaps,
) -> ServiceResult<StepManifest> {
    let step_ref = refs
        .step_refs
        .get(&step.id)
        .cloned()
        .ok_or_else(|| missing_ref("step", &step.id))?;
    let route_config = step
        .route_config
        .as_ref()
        .map(|route_config| {
            let route_refs = refs.route_target_refs(workflow_ref);
            symbolize_route_config(route_config, &route_refs).map_err(|error| {
                closed_bundle_error(
                    workflow_id,
                    &step.id,
                    format!(
                        "step {} route_config has an invalid destination: {error}",
                        step.id
                    ),
                )
            })
        })
        .transpose()?;

    Ok(StepManifest {
        step_ref,
        name: step.name.clone(),
        goal: step.goal.clone(),
        prompt: step.prompt.clone(),
        agents: step.agents.clone(),
        skills: step.skills.clone(),
        agent_config: step.agent_config.clone(),
        step_type: StepType::from_wire_str(step.step_type.as_deref().unwrap_or("execute")),
        step_order: step.step_order,
        output_schema: step.output_schema.clone(),
        persistence_options: step.persistence_options.clone(),
        route_config,
    })
}

fn ordered_workflows(workflows: &[WorkflowExport]) -> Vec<&WorkflowExport> {
    let mut ordered = workflows.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        (
            left.display_order.unwrap_or_default(),
            portable_ref(&left.name, "workflow"),
            &left.name,
            &left.description,
            &left.id,
        )
            .cmp(&(
                right.display_order.unwrap_or_default(),
                portable_ref(&right.name, "workflow"),
                &right.name,
                &right.description,
                &right.id,
            ))
    });
    ordered
}

fn ordered_steps(steps: &[WorkflowExportStep]) -> Vec<&WorkflowExportStep> {
    let mut ordered = steps.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        (
            left.step_order,
            portable_ref(&left.name, "step"),
            &left.name,
            &left.goal,
            &left.prompt,
            &left.id,
        )
            .cmp(&(
                right.step_order,
                portable_ref(&right.name, "step"),
                &right.name,
                &right.goal,
                &right.prompt,
                &right.id,
            ))
    });
    ordered
}

fn unique_ref(base: String, used: &mut BTreeMap<String, usize>) -> String {
    let count = used.entry(base.clone()).or_insert(0);
    *count += 1;
    if *count == 1 {
        base
    } else {
        format!("{base}_{}", count)
    }
}

fn portable_ref(value: &str, fallback: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in value.trim().chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if separator && !result.is_empty() {
                result.push('_');
            }
            separator = false;
            result.push(character);
        } else {
            separator = true;
        }
    }
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

fn missing_ref(kind: &str, id: &str) -> ServiceError {
    ServiceError::invalid_input(format!(
        "workflow export has unresolved {kind} reference {id}"
    ))
}

fn closed_bundle_error(source: &str, destination: &str, detail: String) -> ServiceError {
    ServiceError::invalid_input(format!(
        "{detail}; missing destination {destination} in the closed workflow bundle from {source}. Export the required workflow set or use --all workflows."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{WorkflowExportStepTransition, WorkflowExportTransition};
    use serde_json::Value;

    fn step(id: &str, name: &str, order: i32, transitions: Vec<&str>) -> WorkflowExportStep {
        WorkflowExportStep {
            id: id.to_string(),
            name: name.to_string(),
            goal: Some(format!("goal-{name}")),
            prompt: Some(String::new()),
            agents: vec!["first-agent".to_string(), "second-agent".to_string()],
            skills: vec!["first-skill".to_string(), "second-skill".to_string()],
            agent_config: Some(json!({"model": "sonnet"})),
            step_type: Some("execute".to_string()),
            output_schema: Some(json!({"type": "object"})),
            persistence_options: Some(json!({"artifact": {"logical_name": name}})),
            route_config: None,
            step_order: order,
            workflow_id: "workflow-id".to_string(),
            project_id: "project-id".to_string(),
            transitions: transitions
                .into_iter()
                .enumerate()
                .map(|(index, to_step_id)| WorkflowExportStepTransition {
                    id: format!("edge-{index}"),
                    to_step_id: to_step_id.to_string(),
                    label: Some(format!("label-{index}")),
                })
                .collect(),
            inserted_at: Some("timestamp".to_string()),
            updated_at: Some("timestamp".to_string()),
        }
    }

    fn workflow(
        id: &str,
        name: &str,
        display_order: i32,
        steps: Vec<WorkflowExportStep>,
    ) -> WorkflowExport {
        WorkflowExport {
            id: id.to_string(),
            name: name.to_string(),
            description: Some("description".to_string()),
            is_default: Some(false),
            display_order: Some(display_order),
            metadata: Some(json!({"nested": {"id": "opaque"}})),
            initial_step_id: steps.first().map(|step| step.id.clone()),
            kanban_column: Some("column".to_string()),
            factory_name: Some("factory".to_string()),
            project_id: "project-id".to_string(),
            workflow_steps: steps,
            transitions: Vec::new(),
            inserted_at: Some("timestamp".to_string()),
            updated_at: Some("timestamp".to_string()),
        }
    }

    fn snapshot() -> WorkflowExportSnapshot {
        WorkflowExportSnapshot {
            project_id: "project-id".to_string(),
            workflows: vec![workflow(
                "workflow-id",
                "Build Workflow",
                1,
                vec![
                    step("second-step-id", "Second", 1, vec![]),
                    step("first-step-id", "First", 0, vec!["second-step-id"]),
                ],
            )],
        }
    }

    #[test]
    fn conversion_is_portable_and_preserves_meaningful_order() {
        let bundle = snapshot_to_bundle(&snapshot()).unwrap();
        let value: Value = serde_json::from_str(&bundle.canonical_json().unwrap()).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["workflows"][0]["workflow_ref"], "build_workflow");
        assert_eq!(value["workflows"][0]["steps"][0]["step_ref"], "first");
        assert_eq!(value["workflows"][0]["steps"][1]["step_ref"], "second");
        assert_eq!(
            value["workflows"][0]["steps"][0]["agents"],
            json!(["first-agent", "second-agent"])
        );
        assert_eq!(
            value["workflows"][0]["steps"][0]["skills"],
            json!(["first-skill", "second-skill"])
        );
        assert!(value["workflows"][0].get("id").is_none());
        assert!(value["workflows"][0].get("project_id").is_none());
        assert!(value["workflows"][0].get("inserted_at").is_none());
        assert!(value["workflows"][0]["steps"][0].get("id").is_none());
        assert!(
            value["workflows"][0]["steps"][0]
                .get("updated_at")
                .is_none()
        );
    }

    #[test]
    fn closed_snapshot_rejects_missing_workflow_destination_with_guidance() {
        let mut snapshot = snapshot();
        snapshot.workflows[0]
            .transitions
            .push(WorkflowExportTransition {
                id: "cross-edge".to_string(),
                to_workflow_id: "missing-workflow".to_string(),
                target_step_id: None,
                label: Some("handoff".to_string()),
            });
        let error = SacrumWorkflowService::validate_export_snapshot(&snapshot).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("missing destination"));
        assert!(message.contains("required workflow set"));
        assert!(message.contains("--all"));
    }

    #[test]
    fn conversion_is_stable_when_api_arrays_are_reversed() {
        let first = snapshot();
        let mut second = snapshot();
        second.workflows.reverse();
        second.workflows[0].workflow_steps.reverse();
        assert_eq!(
            snapshot_to_bundle(&first)
                .unwrap()
                .canonical_json()
                .unwrap(),
            snapshot_to_bundle(&second)
                .unwrap()
                .canonical_json()
                .unwrap()
        );
    }

    #[test]
    fn conversion_is_stable_for_equal_display_and_step_order() {
        let mut first = snapshot();
        first.workflows[0].workflow_steps[0].step_order = 0;
        first.workflows[0].workflow_steps[1].step_order = 0;
        let mut second = first.clone();
        second.workflows[0].workflow_steps.reverse();

        assert_eq!(
            snapshot_to_bundle(&first)
                .unwrap()
                .canonical_json()
                .unwrap(),
            snapshot_to_bundle(&second)
                .unwrap()
                .canonical_json()
                .unwrap()
        );
    }
}
