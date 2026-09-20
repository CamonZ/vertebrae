use std::collections::HashSet;

use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};

use crate::api_types::ShortIdResponse;
use crate::api_types::{WorkflowExport, WorkflowExportSnapshot};
use crate::client::with_fragments;
use crate::queries::steps::WORKFLOW_EXPORT_STEP_FIELDS;
use crate::queries::workflows::{
    EXPORT_WORKFLOW, LIST_WORKFLOW_EXPORT_IDS, WORKFLOW_EXPORT_FIELDS,
};

use super::SacrumWorkflowService;

enum ExportScope {
    SingleWorkflow,
    Project,
}

impl SacrumWorkflowService {
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
        let (workflows, scope) = match workflow_id {
            Some(workflow_id) => {
                let query = with_fragments(EXPORT_WORKFLOW, &fragments);
                let workflow = self.read_export_workflow(&query, workflow_id).await?;
                (vec![workflow], ExportScope::SingleWorkflow)
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
                (workflows, ExportScope::Project)
            }
        };

        let snapshot = WorkflowExportSnapshot {
            project_id: self.client.project_id().to_string(),
            workflows,
        };
        Self::validate_export_snapshot(&snapshot, scope)?;
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

    fn validate_export_snapshot(
        snapshot: &WorkflowExportSnapshot,
        scope: ExportScope,
    ) -> ServiceResult<()> {
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
                if matches!(scope, ExportScope::SingleWorkflow)
                    && transition.to_workflow_id != workflow.id
                {
                    continue;
                }
                let target_workflow = snapshot
                    .workflows
                    .iter()
                    .find(|candidate| candidate.id == transition.to_workflow_id)
                    .ok_or_else(|| {
                        ServiceError::invalid_input(format!(
                            "workflow {} transition {} references missing workflow {}",
                            workflow.id, transition.id, transition.to_workflow_id
                        ))
                    })?;
                if let Some(target_step_id) = &transition.target_step_id
                    && !target_workflow
                        .workflow_steps
                        .iter()
                        .any(|step| step.id == *target_step_id)
                {
                    return Err(ServiceError::invalid_input(format!(
                        "workflow {} transition {} references missing target step {}",
                        workflow.id, transition.id, target_step_id
                    )));
                }
            }
        }

        Ok(())
    }
}
