use serde_json::Value;

use super::*;
use crate::StepHarness;

const GOLDEN: &str = include_str!("../../tests/fixtures/workflow_bundle.json");
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
    assert!(canonical.contains("\"prompt\":\"\""));
    assert!(canonical.contains("\"handoff\""));
    assert!(canonical.contains("\u{00e9}"));
    let structured = manifest.workflows[1]
        .steps
        .iter()
        .find(|step| step.step_ref == "classify")
        .unwrap();
    assert_eq!(
        structured.config.as_ref().unwrap()["state"]["title"],
        "{{ task.title }}"
    );
    assert!(
        manifest
            .workflows
            .iter()
            .flat_map(|workflow| &workflow.steps)
            .all(|step| step.harness.is_none())
    );
}

#[test]
fn explicit_step_harnesses_round_trip_through_workflow_bundles() {
    for (harness, wire) in [
        (StepHarness::Claude, "claude"),
        (StepHarness::Codex, "codex"),
        (StepHarness::Typesafe, "typesafe"),
    ] {
        let mut manifest = golden();
        let workflow_ref = manifest.workflows[0].workflow_ref.clone();
        let step_ref = manifest.workflows[0].steps[0].step_ref.clone();
        manifest.workflows[0].steps[0].harness = Some(harness);

        let canonical = manifest.canonical_json().unwrap();
        assert!(canonical.contains(&format!("\"harness\":\"{wire}\"")));
        let reparsed = parse_manifest(&canonical).unwrap();
        let round_tripped_step = reparsed
            .workflows
            .iter()
            .find(|workflow| workflow.workflow_ref == workflow_ref)
            .unwrap()
            .steps
            .iter()
            .find(|step| step.step_ref == step_ref)
            .unwrap();
        assert_eq!(round_tripped_step.harness, Some(harness));
        assert_eq!(reparsed, manifest.canonicalize());
    }
}

#[test]
fn workflow_bundle_rejects_unknown_harness_values() {
    let mut json: Value = serde_json::from_str(GOLDEN).unwrap();
    json["workflows"][0]["steps"][0]["harness"] = Value::String("openai".into());
    let error = parse_manifest(&json.to_string()).unwrap_err();
    assert!(error.to_string().contains("harness"), "{error}");
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
    assert_eq!(
        start.config.as_ref().unwrap()["agents"],
        serde_json::json!(["agent-a", "agent-b"])
    );
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
        vec!["start", "route", "finish", "wait", "input", "pause"]
    );
    assert_eq!(
        canonical.workflows[0].steps[0].config.as_ref().unwrap()["agents"],
        serde_json::json!(["agent-a", "agent-b"])
    );
    assert_eq!(
        canonical.workflows[0].steps[0].config.as_ref().unwrap()["skills"],
        serde_json::json!(["build", "verify"])
    );
    let rules = canonical.workflows[0].steps[1].config.as_ref().unwrap()["route_config"]["rules"]
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
fn name_conflicts_are_case_insensitive_and_create_only() {
    let mut bundle = WorkflowBundleManifest::empty();
    bundle
        .workflows
        .push(WorkflowManifest::new("first", "Same"));
    bundle
        .workflows
        .push(WorkflowManifest::new("second", "same"));

    let mut existing = Workflow::new("Existing");
    existing.id = Some("existing-id".to_string());
    bundle
        .workflows
        .push(WorkflowManifest::new("third", "existing"));

    let conflicts = bundle.name_conflicts(&[existing]);
    assert_eq!(conflicts.len(), 2);
    assert_eq!(conflicts[0].workflow_ref, "second");
    assert_eq!(conflicts[1].workflow_ref, "third");
    assert_eq!(
        conflicts[1].existing_workflow_id.as_deref(),
        Some("existing-id")
    );
}

#[test]
fn validation_failures_are_table_driven_and_actionable() {
    let cases: &[ValidationCase] = &[
        (
            "duplicate workflow ref",
            |bundle: &mut WorkflowBundleManifest| {
                let workflow = bundle.workflows[0].clone();
                bundle.workflows.push(workflow);
            },
            "workflows[2].workflow_ref",
        ),
        (
            "route step with llm_inference field",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["agents"] =
                    serde_json::json!(["router"]);
            },
            "workflows[0].steps[1].config.agents",
        ),
        (
            "config field on config-less step",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[0].config = Some(serde_json::json!({"version":1}));
            },
            "workflows[0].steps[0].config",
        ),
        (
            "duplicate step ref",
            |bundle: &mut WorkflowBundleManifest| {
                let step = bundle.workflows[0].steps[0].clone();
                bundle.workflows[0].steps.push(step);
            },
            "steps[6].step_ref",
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
            "step_edges[9]",
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
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"]["rules"][0]
                    ["transition"]["step_ref"] = Value::String("missing".into())
            },
            "config.route_config.rules[0].transition.step_ref",
        ),
        (
            "route target without outgoing edge",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"]["rules"][0]
                    ["transition"]["step_ref"] = Value::String("start".into())
            },
            "config.route_config.rules[0].transition.step_ref",
        ),
        (
            "persisted session step_id",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"]["rules"][0]
                    ["session"] = serde_json::json!({"mode": "resume", "step_id": "uuid"})
            },
            "config.route_config.rules[0].session.step_id",
        ),
        (
            "unresolved session step ref",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"]["default"]["session"] =
                    serde_json::json!({"mode": "fork", "step_ref": "missing"})
            },
            "config.route_config.default.session.step_ref",
        ),
        (
            "foreign session step ref",
            |bundle: &mut WorkflowBundleManifest| {
                bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"]["rules"][0]
                    ["session"] = serde_json::json!({"mode": "resume", "step_ref": "review"})
            },
            "config.route_config.rules[0].session.step_ref",
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
fn session_step_ref_may_name_any_step_of_the_route_workflow() {
    let mut bundle = golden();
    let route_config = &mut bundle.workflows[0].steps[1].config.as_mut().unwrap()["route_config"];
    route_config["rules"][0]["session"] =
        serde_json::json!({"mode": "resume", "step_ref": "start"});
    route_config["rules"][1]["session"] = serde_json::json!({"mode": "new"});
    bundle
        .validate()
        .expect("session step_ref need not be an outgoing edge");
    let reparsed = parse_manifest(&bundle.canonical_json().unwrap()).unwrap();
    assert_eq!(reparsed, bundle.canonicalize());
}

#[test]
fn malformed_json_types_and_structural_runtime_fields_are_rejected_with_paths() {
    let cases = [
        (r#"{"schema_version":1}"#, "schema_version"),
        (r#"{"workflows":"nope"}"#, "workflows"),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":7}]}"#,
            "workflows[0].name",
        ),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","goal":null,"step_type":"llm_inference","step_order":0,"persistence_options":null,"config":{"version":1,"agents":[false]}}]}]}"#,
            "config.agents[0]",
        ),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","goal":null,"step_type":"llm_inference","step_order":0,"persistence_options":null,"config":null,"prompt":"flat"}]}]}"#,
            "prompt",
        ),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","goal":null,"step_type":"finish","step_order":0,"persistence_options":null}]}]}"#,
            "steps[0].config",
        ),
        (r#"{"project_id":"foreign"}"#, "project_id"),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":"W","inserted_at":"now"}]}"#,
            "inserted_at",
        ),
        (
            r#"{"workflows":[{"workflow_ref":"w","name":"W","steps":[{"step_ref":"s","name":"S","goal":null,"step_type":"finish","step_order":0,"persistence_options":null,"config":null,"verbose_daemon_logging":true}]}]}"#,
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
            "handoff": {"id": "00000000-0000-0000-0000-000000000099"},
            "session": {"mode": "resume", "step_id": "other-step-id"}
        }, {
            "id": "fresh",
            "when": {"value": true},
            "transition": {"type": "intra_workflow", "step_id": "step-id"},
            "session": {"mode": "new"}
        }],
        "default": {
            "transition": {"type": "inter_workflow", "workflow_id": "workflow-id"},
            "session": {"mode": "fork", "step_id": "step-id"}
        }
    });
    let mut refs = RouteTargetRefs::default();
    refs.step_refs.insert("step-id".into(), "finish".into());
    refs.step_refs
        .insert("other-step-id".into(), "start".into());
    refs.workflow_refs
        .insert("workflow-id".into(), "review".into());
    let converted = symbolize_route_config(&config, &refs).unwrap();
    assert_eq!(converted["rules"][0]["transition"]["step_ref"], "finish");
    assert!(converted["rules"][0]["transition"].get("step_id").is_none());
    assert_eq!(converted["default"]["transition"]["workflow_ref"], "review");
    assert_eq!(
        converted["rules"][0]["session"],
        serde_json::json!({"mode": "resume", "step_ref": "start"})
    );
    assert_eq!(
        converted["rules"][1]["session"],
        config["rules"][1]["session"]
    );
    assert_eq!(
        converted["default"]["session"],
        serde_json::json!({"mode": "fork", "step_ref": "finish"})
    );
    assert_eq!(
        converted["rules"][0]["when"]["value"],
        config["rules"][0]["when"]["value"]
    );
    assert_eq!(
        converted["rules"][0]["handoff"]["id"],
        config["rules"][0]["handoff"]["id"]
    );
}
