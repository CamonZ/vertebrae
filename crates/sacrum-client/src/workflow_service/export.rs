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

fn validate_workflow_selection(workflow_ids: &[String]) -> ServiceResult<()> {
    if workflow_ids.is_empty() {
        return Err(ServiceError::invalid_input(
            "workflow export requires at least one selected workflow ID",
        ));
    }

    let unique_ids: HashSet<&str> = workflow_ids.iter().map(String::as_str).collect();
    if unique_ids.len() != workflow_ids.len() {
        return Err(ServiceError::invalid_input(
            "workflow export contains duplicate workflow IDs",
        ));
    }

    Ok(())
}

impl SacrumWorkflowService {
    pub async fn export_workflow_bundle(
        &self,
        workflow_id: Option<&str>,
    ) -> ServiceResult<WorkflowBundleManifest> {
        let workflow_ids = workflow_id.map(|workflow_id| vec![workflow_id.to_string()]);
        self.export_workflow_bundle_selected(workflow_ids.as_deref())
            .await
    }

    pub async fn export_workflow_bundle_for(
        &self,
        workflow_ids: &[String],
    ) -> ServiceResult<WorkflowBundleManifest> {
        self.export_workflow_bundle_selected(Some(workflow_ids))
            .await
    }

    async fn export_workflow_bundle_selected(
        &self,
        workflow_ids: Option<&[String]>,
    ) -> ServiceResult<WorkflowBundleManifest> {
        let snapshot = self.export_workflow_snapshot_selected(workflow_ids).await?;
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
        let workflow_ids = workflow_id.map(|workflow_id| vec![workflow_id.to_string()]);
        self.export_workflow_snapshot_selected(workflow_ids.as_deref())
            .await
    }

    async fn export_workflow_snapshot_selected(
        &self,
        workflow_ids: Option<&[String]>,
    ) -> ServiceResult<WorkflowExportSnapshot> {
        let fragments = [WORKFLOW_EXPORT_FIELDS, WORKFLOW_EXPORT_STEP_FIELDS];
        let workflows = match workflow_ids {
            Some(workflow_ids) => {
                validate_workflow_selection(workflow_ids)?;
                let query = with_fragments(EXPORT_WORKFLOW, &fragments);
                let mut workflows = Vec::with_capacity(workflow_ids.len());
                for workflow_id in workflow_ids {
                    workflows.push(self.read_export_workflow(&query, workflow_id).await?);
                }
                workflows
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
    let step_type = step
        .step_type
        .as_deref()
        .map(StepType::from_wire_str)
        .unwrap_or_default();
    let route_config = step
        .config_field("route_config")
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
        prompt: step.prompt().map(str::to_string),
        agents: string_list(step.config_field("agents")),
        skills: string_list(step.config_field("skills")),
        agent_config: step.config_field("agent_config").cloned(),
        step_type,
        step_order: step.step_order,
        output_schema: step.config_field("output_schema").cloned(),
        persistence_options: step.persistence_options.clone(),
        route_config,
        provider: step
            .config_field("provider")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        model: step
            .config_field("model")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        state: step.config_field("state").cloned(),
        questions: step.config_field("questions").cloned(),
    })
}

/// The V1 bundle keeps step config as flat fields.
fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
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
            left.prompt(),
            &left.id,
        )
            .cmp(&(
                right.step_order,
                portable_ref(&right.name, "step"),
                &right.name,
                &right.goal,
                right.prompt(),
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
            step_type: Some("llm_inference".to_string()),
            config: Some(json!({
                "version": 1,
                "prompt": "",
                "agents": ["first-agent", "second-agent"],
                "skills": ["first-skill", "second-skill"],
                "agent_config": {"model": "sonnet"},
                "output_schema": {"type": "object"}
            })),
            persistence_options: Some(json!({"artifact": {"logical_name": name}})),
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
    fn conversion_exports_structured_inference_questions() {
        let mut snapshot = snapshot();
        let step = &mut snapshot.workflows[0].workflow_steps[0];
        step.step_type = Some("structured_inference".to_string());
        step.config = Some(json!({
            "version": 1,
            "provider": "typesafe",
            "model": "jev",
            "state": "{{ task.title }}",
            "questions": {"ok": {"type": "noul", "instructions": "ok?", "criteria": {"true": "yes", "false": "no"}}}
        }));

        let bundle = snapshot_to_bundle(&snapshot).unwrap();
        let step = bundle.workflows[0]
            .steps
            .iter()
            .find(|step| step.step_ref == "second")
            .unwrap();
        assert_eq!(step.provider.as_deref(), Some("typesafe"));
        assert_eq!(step.model.as_deref(), Some("jev"));
        assert_eq!(step.state, Some(json!("{{ task.title }}")));
        assert_eq!(
            step.questions,
            Some(json!({
                "ok": {"type": "noul", "instructions": "ok?", "criteria": {"true": "yes", "false": "no"}}
            }))
        );
        assert_eq!(step.config_value()["questions"]["ok"]["type"], "noul");
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
