use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use clap::Args;
use serde::Serialize;
use serde_json::Value;
use vertebrae_core::{
    ServiceError, ServiceResult, Workflow, WorkflowBundleImportResult, WorkflowBundleManifest,
    WorkflowBundleNameConflict, WorkflowService, parse_manifest,
};

const DESTINATION: &str = "active project";
const PREFLIGHT_WARNING: &str = "Dry-run uses read-only backend checks; it does not reserve workflow names or guarantee a later commit.";
const AUTHORITY_WARNING: &str = "Sacrum remains authoritative for project access, graph validation, default effects, and races after preflight.";

#[derive(Debug, Args)]
pub struct WorkflowImportCommand {
    /// Read a versioned workflow bundle from this JSON file.
    #[arg(value_name = "PATH")]
    pub input: PathBuf,

    /// Validate and report the create plan without submitting a mutation.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WorkflowImportPlan {
    workflow_ref: String,
    name: String,
    step_count: usize,
    is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WorkflowImportReport {
    command: &'static str,
    status: &'static str,
    destination: &'static str,
    workflow_count: usize,
    step_count: usize,
    step_edge_count: usize,
    workflow_edge_count: usize,
    create_plan: Vec<WorkflowImportPlan>,
    conflicts: Vec<WorkflowBundleNameConflict>,
    proposed_default: Option<String>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflow_mappings: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step_mappings: Option<BTreeMap<String, BTreeMap<String, String>>>,
}

impl WorkflowImportCommand {
    pub async fn execute(&self, service: &dyn WorkflowService) -> ServiceResult<String> {
        let report = self.run(service).await?;
        Ok(render_human(&report))
    }

    pub async fn execute_json(&self, service: &dyn WorkflowService) -> ServiceResult<Value> {
        let report = self.run(service).await?;
        serde_json::to_value(report).map_err(|error| {
            ServiceError::validation_failed(format!(
                "failed to serialize workflow import report: {error}"
            ))
        })
    }

    async fn run(&self, service: &dyn WorkflowService) -> ServiceResult<WorkflowImportReport> {
        let bundle = read_bundle(&self.input)?;
        let existing_workflows = service.list_workflows_full().await?;
        let mut report = build_report(&bundle, &existing_workflows, self.dry_run);

        if !report.conflicts.is_empty() {
            return Err(conflict_error(&report));
        }

        if self.dry_run {
            return Ok(report);
        }

        let result = service.import_workflow_bundle(bundle).await?;
        report.status = "committed";
        apply_mappings(&mut report, result);
        Ok(report)
    }
}

fn read_bundle(path: &Path) -> ServiceResult<WorkflowBundleManifest> {
    let contents = fs::read_to_string(path).map_err(|error| {
        ServiceError::invalid_input(format!(
            "failed to read workflow bundle {}: {error}",
            path.display()
        ))
    })?;

    parse_manifest(&contents).map_err(|error| {
        ServiceError::invalid_input(format!(
            "invalid workflow bundle {}: {error}",
            path.display()
        ))
    })
}

fn build_report(
    bundle: &WorkflowBundleManifest,
    existing_workflows: &[Workflow],
    dry_run: bool,
) -> WorkflowImportReport {
    let conflicts = bundle.name_conflicts(existing_workflows);
    let create_plan = bundle
        .workflows
        .iter()
        .map(|workflow| WorkflowImportPlan {
            workflow_ref: workflow.workflow_ref.clone(),
            name: workflow.name.clone(),
            step_count: workflow.steps.len(),
            is_default: workflow.is_default,
        })
        .collect::<Vec<_>>();

    let default_names = bundle
        .workflows
        .iter()
        .filter(|workflow| workflow.is_default)
        .map(|workflow| workflow.name.as_str())
        .collect::<Vec<_>>();
    let proposed_default = (!default_names.is_empty()).then(|| {
        format!(
            "Sacrum will apply default status to: {}",
            default_names.join(", ")
        )
    });

    let mut warnings = vec![AUTHORITY_WARNING.to_string()];
    if dry_run {
        warnings.push(PREFLIGHT_WARNING.to_string());
    }

    WorkflowImportReport {
        command: "workflow import",
        status: if dry_run { "dry-run" } else { "preflighted" },
        destination: DESTINATION,
        workflow_count: bundle.workflows.len(),
        step_count: bundle
            .workflows
            .iter()
            .map(|workflow| workflow.steps.len())
            .sum(),
        step_edge_count: bundle.step_edges.len(),
        workflow_edge_count: bundle.workflow_edges.len(),
        create_plan,
        conflicts,
        proposed_default,
        warnings,
        workflow_mappings: None,
        step_mappings: None,
    }
}

fn conflict_error(report: &WorkflowImportReport) -> ServiceError {
    let details = report
        .conflicts
        .iter()
        .map(|conflict| {
            let existing = conflict
                .existing_workflow_id
                .as_deref()
                .map(|id| format!(" (existing ID {id})"))
                .unwrap_or_default();
            format!(
                "ref {:?} / {:?}: {}{}",
                conflict.workflow_ref, conflict.name, conflict.reason, existing
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    ServiceError::invalid_input(format!(
        "workflow bundle import conflicts under create-only policy: {details}\n{}",
        render_human(report)
    ))
}

fn apply_mappings(report: &mut WorkflowImportReport, result: WorkflowBundleImportResult) {
    report.workflow_mappings = Some(result.workflow_mappings);

    let mut step_mappings: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (address, id) in result.step_mappings {
        step_mappings
            .entry(address.workflow_ref)
            .or_default()
            .insert(address.step_ref, id);
    }
    report.step_mappings = Some(step_mappings);

    for warning in result.warnings {
        if !report.warnings.contains(&warning) {
            report.warnings.push(warning);
        }
    }
}

fn render_human(report: &WorkflowImportReport) -> String {
    let mut output = String::new();
    let title = match report.status {
        "dry-run" => "Workflow bundle import dry-run",
        "committed" => "Workflow bundle import committed",
        _ => "Workflow bundle import",
    };
    writeln!(&mut output, "{title}").expect("writing to String cannot fail");
    writeln!(&mut output, "Destination: {}", report.destination)
        .expect("writing to String cannot fail");
    writeln!(&mut output, "Workflows: {}", report.workflow_count)
        .expect("writing to String cannot fail");
    writeln!(&mut output, "Steps: {}", report.step_count).expect("writing to String cannot fail");
    writeln!(&mut output, "Step edges: {}", report.step_edge_count)
        .expect("writing to String cannot fail");
    writeln!(
        &mut output,
        "Workflow edges: {}",
        report.workflow_edge_count
    )
    .expect("writing to String cannot fail");
    writeln!(&mut output, "Create plan:").expect("writing to String cannot fail");
    for plan in &report.create_plan {
        writeln!(
            &mut output,
            "  - {} ({:?}, {} steps{})",
            plan.workflow_ref,
            plan.name,
            plan.step_count,
            if plan.is_default { ", default" } else { "" }
        )
        .expect("writing to String cannot fail");
    }
    if let Some(default) = &report.proposed_default {
        writeln!(&mut output, "Proposed default: {default}")
            .expect("writing to String cannot fail");
    }
    if report.conflicts.is_empty() {
        writeln!(&mut output, "Conflicts: none").expect("writing to String cannot fail");
    } else {
        writeln!(&mut output, "Conflicts:").expect("writing to String cannot fail");
        for conflict in &report.conflicts {
            let existing = conflict
                .existing_workflow_id
                .as_deref()
                .map(|id| format!(" (existing ID {id})"))
                .unwrap_or_default();
            writeln!(
                &mut output,
                "  - {} / {:?}: {}{}",
                conflict.workflow_ref, conflict.name, conflict.reason, existing
            )
            .expect("writing to String cannot fail");
        }
    }

    if let Some(workflow_mappings) = &report.workflow_mappings {
        writeln!(&mut output, "Workflow mappings:").expect("writing to String cannot fail");
        for (workflow_ref, id) in workflow_mappings {
            writeln!(&mut output, "  {workflow_ref} -> {id}")
                .expect("writing to String cannot fail");
        }
    }
    if let Some(step_mappings) = &report.step_mappings {
        writeln!(&mut output, "Step mappings:").expect("writing to String cannot fail");
        for (workflow_ref, mappings) in step_mappings {
            for (step_ref, id) in mappings {
                writeln!(&mut output, "  {workflow_ref}/{step_ref} -> {id}")
                    .expect("writing to String cannot fail");
            }
        }
    }

    if !report.warnings.is_empty() {
        writeln!(&mut output, "Warnings:").expect("writing to String cannot fail");
        for warning in &report.warnings {
            writeln!(&mut output, "  - {warning}").expect("writing to String cannot fail");
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use vertebrae_core::WorkflowManifest;

    #[derive(Debug, Parser)]
    struct TestCli {
        #[command(flatten)]
        command: WorkflowImportCommand,
    }

    #[test]
    fn parses_input_and_dry_run() {
        let parsed = TestCli::try_parse_from(["test", "bundle.json", "--dry-run"]).unwrap();
        assert_eq!(parsed.command.input, PathBuf::from("bundle.json"));
        assert!(parsed.command.dry_run);
    }

    #[test]
    fn preflight_reports_duplicate_and_existing_names() {
        let mut bundle = WorkflowBundleManifest::empty();
        bundle.workflows = vec![
            WorkflowManifest::new("first", "Same"),
            WorkflowManifest::new("second", "same"),
        ];
        let existing = vec![Workflow {
            id: Some("existing-id".to_string()),
            name: "Same".to_string(),
            description: None,
            initial_step: None,
            metadata: Default::default(),
            order: 0,
            is_default: false,
            kanban_column: None,
            factory_name: None,
            transitions: Vec::new(),
            created_at: None,
            updated_at: None,
        }];

        let report = build_report(&bundle, &existing, true);
        assert_eq!(report.conflicts.len(), 3);
        assert!(
            conflict_error(&report)
                .to_string()
                .contains("create-only policy")
        );
    }

    #[test]
    fn dry_run_report_does_not_contain_generated_mappings() {
        let bundle = WorkflowBundleManifest::empty();
        let report = build_report(&bundle, &[], true);
        let value = serde_json::to_value(report).unwrap();
        assert!(value.get("workflow_mappings").is_none());
        assert!(value.get("step_mappings").is_none());
    }

    #[test]
    fn committed_human_report_includes_mappings_and_warnings() {
        let mut report = build_report(&WorkflowBundleManifest::empty(), &[], false);
        report.status = "committed";
        apply_mappings(
            &mut report,
            WorkflowBundleImportResult {
                workflow_mappings: [("workflow".to_string(), "workflow-id".to_string())]
                    .into_iter()
                    .collect(),
                step_mappings: [(
                    vertebrae_core::StepAddress::new("workflow", "step"),
                    "step-id".to_string(),
                )]
                .into_iter()
                .collect(),
                warnings: vec!["backend warning".to_string()],
            },
        );
        let output = render_human(&report);
        assert!(output.contains("Workflow bundle import committed"));
        assert!(output.contains("workflow -> workflow-id"));
        assert!(output.contains("workflow/step -> step-id"));
        assert!(output.contains("backend warning"));
    }
}
