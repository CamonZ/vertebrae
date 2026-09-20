use serde_json::Value;

use super::*;

const GOLDEN: &str = include_str!("../../tests/fixtures/workflow_bundle_v1.json");
type ValidationCase = (&'static str, fn(&mut WorkflowBundleManifest), &'static str);

fn golden() -> WorkflowBundleManifest {
    parse_manifest(GOLDEN).expect("golden manifest must be valid")
}

#[test]
fn golden_fixture_round_trips_without_semantic_loss() {
    let manifest = golden();
    let canonical = manifest.canonical_json().unwrap();
    let reparsed = parse_manifest(&canonical).unwrap();
    assert_eq!(reparsed, manifest.canonicalize());
    assert!(canonical.contains("\"prompt\":null"));
    assert!(canonical.contains("\"prompt\":\"\""));
    assert!(canonical.contains("\"handoff\""));
    assert!(canonical.contains("\u{00e9}"));
}

#[test]
fn shuffled_unordered_collections_have_identical_canonical_bytes() {
    let mut shuffled = golden();
    shuffled.workflows.reverse();
    shuffled.step_edges.reverse();
    shuffled.workflow_edges.reverse();
    for workflow in &mut shuffled.workflows {
        workflow.steps.reverse();
    }
    assert_eq!(
        golden().canonical_json().unwrap(),
        shuffled.canonical_json().unwrap()
    );
    let build = shuffled
        .workflows
        .iter()
        .find(|workflow| workflow.workflow_ref == "build")
        .unwrap();
    let start = build
        .steps
        .iter()
        .find(|step| step.step_ref == "start")
        .unwrap();
    assert_eq!(start.agents, vec!["agent-a", "agent-b"]);
}

#[test]
fn canonicalization_uses_display_and_step_order_without_reordering_config_arrays() {
    let canonical = golden().canonicalize();
    assert_eq!(
        canonical
            .workflows
            .iter()
            .map(|workflow| workflow.workflow_ref.as_str())
            .collect::<Vec<_>>(),
        vec!["build", "review"]
    );
    assert_eq!(
        canonical.workflows[0]
            .steps
            .iter()
            .map(|step| step.step_ref.as_str())
            .collect::<Vec<_>>(),
        vec!["start", "route", "finish"]
    );
    assert_eq!(
        canonical.workflows[0].steps[0].agents,
        vec!["agent-a", "agent-b"]
    );
    assert_eq!(
        canonical.workflows[0].steps[0].skills,
        vec!["build", "verify"]
    );
    let rules = canonical.workflows[0].steps[1]
        .route_config
        .as_ref()
        .unwrap()["rules"]
        .as_array()
        .unwrap();
    assert_eq!(rules[0]["id"], "approved");
    assert_eq!(rules[1]["id"], "review");
}

#[test]
fn empty_bundle_and_empty_workflow_are_valid() {
    assert!(WorkflowBundleManifest::empty().validate().is_ok());
    let mut bundle = WorkflowBundleManifest::empty();
    bundle
        .workflows
        .push(WorkflowManifest::new("empty", "Empty"));
    assert!(bundle.validate().is_ok());
}

#[test]
fn validation_failures_are_table_driven_and_actionable() {
    let cases: &[ValidationCase] = &[
        (
            "unsupported version",
            |bundle: &mut WorkflowBundleManifest| bundle.schema_version = 9,
            "schema_version",
        ),
        (
            "duplicate workflow ref",
            |bundle: &mut WorkflowBundleManifest| {
                let workflow = bundle.workflows[0].clone();
                bundle.workflows.push(workflow);
            },
            "workflows[2].workflow_ref",
        ),
        (
            "duplicate step ref",
            |bundle: &mut WorkflowBundleManifest| {
                let step = bundle.workflows[0].steps[0].clone();
                bundle.workflows[0].steps.push(step);
            },
            "steps[3].step_ref",
        ),
        (
            "foreign initial step",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].initial_step = Some(StepAddress::new("review", "review"))
            },
            "initial_step.workflow_ref",
        ),
        (
            "duplicate edge",
            |bundle: &mut WorkflowBundleManifest| {
                let edge = bundle.step_edges[0].clone();
                bundle.step_edges.push(edge);
            },
            "step_edges[4]",
        ),
        (
            "cross-workflow step edge",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.step_edges[0].to.workflow_ref = "review".into()
            },
            "step_edges[0]",
        ),
        (
            "wrong destination workflow",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflow_edges[0]
                    .destination_step
                    .as_mut()
                    .unwrap()
                    .workflow_ref = "build".into()
            },
            "destination_step.workflow_ref",
        ),
        (
            "unresolved route target",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].route_config.as_mut().unwrap()["rules"][0]["transition"]
                    ["step_ref"] = Value::String("missing".into())
            },
            "route_config.rules[0].transition.step_ref",
        ),
        (
            "route target without outgoing edge",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].route_config.as_mut().unwrap()["rules"][0]["transition"]
                    ["step_ref"] = Value::String("start".into())
            },
            "route_config.rules[0].transition.step_ref",
        ),
    ];
    for (name, mutate, path) in cases {
        let mut bundle = golden();
        mutate(&mut bundle);
        let error = bundle.validate().expect_err(name);
        assert!(error.path.contains(path), "{name}: {error}");
    }
}

#[test]
fn malformed_json_types_and_structural_runtime_fields_are_rejected_with_paths() {
    let cases = [
        (r#"{"schema_version":1,"workflows":"nope"}"#, "workflows"),
        (
            r#"{"schema_version":1,"workflows":[{"workflow_ref":"w","name":7}]}"#,
            "workflows[0].name",
        ),
        (
            r#"{"schema_version":1,"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","agents":[false]}]}]}"#,
            "agents[0]",
        ),
        (
            r#"{"schema_version":1,"project_id":"foreign"}"#,
            "project_id",
        ),
        (
            r#"{"schema_version":1,"workflows":[{"workflow_ref":"w","name":"W","inserted_at":"now"}]}"#,
            "inserted_at",
        ),
        (
            r#"{"schema_version":1,"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","verbose_daemon_logging":true}]}]}"#,
            "verbose_daemon_logging",
        ),
    ];
    for (input, path) in cases {
        let error = parse_manifest(input).expect_err(path).to_string();
        assert!(error.contains(path), "expected {path} in {error}");
    }
    assert!(parse_manifest("not json").is_err());
}

#[test]
fn route_symbolization_only_rewrites_known_targets() {
    let config = serde_json::json!({
        "version": 1,
        "rules": [{
            "id": "approved",
            "when": {"value": "00000000-0000-0000-0000-000000000099"},
            "transition": {"type": "intra_workflow", "step_id": "step-id"},
            "handoff": {"id": "00000000-0000-0000-0000-000000000099"}
        }],
        "default": {"transition": {"type": "inter_workflow", "workflow_id": "workflow-id"}}
    });
    let mut refs = RouteTargetRefs::default();
    refs.step_refs.insert("step-id".into(), "finish".into());
    refs.workflow_refs
        .insert("workflow-id".into(), "review".into());
    let converted = symbolize_route_config(&config, &refs).unwrap();
    assert_eq!(converted["rules"][0]["transition"]["step_ref"], "finish");
    assert!(converted["rules"][0]["transition"].get("step_id").is_none());
    assert_eq!(converted["default"]["transition"]["workflow_ref"], "review");
    assert_eq!(
        converted["rules"][0]["when"]["value"],
        config["rules"][0]["when"]["value"]
    );
    assert_eq!(
        converted["rules"][0]["handoff"]["id"],
        config["rules"][0]["handoff"]["id"]
    );
}
