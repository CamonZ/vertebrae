use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::json;
use uuid::Uuid;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::{
    StepAddress, WorkflowBundleImportResult, WorkflowBundleManifest, WorkflowRef,
};

use crate::api_types::WorkflowBundleImportResponse;
use crate::error::SacrumClientError;
use crate::queries::workflows::IMPORT_WORKFLOW_BUNDLE;

use super::SacrumWorkflowService;

impl SacrumWorkflowService {
    pub async fn import_workflow_bundle(
        &self,
        bundle: WorkflowBundleManifest,
    ) -> ServiceResult<WorkflowBundleImportResult> {
        bundle.validate().map_err(|error| {
            ServiceError::invalid_input(format!("workflow bundle validation failed: {error}"))
        })?;

        // Sacrum's Json scalar expects one JSON-encoded string, preserving the
        // manifest's nested metadata and step configuration as JSON objects.
        let encoded_bundle = serde_json::to_string(&bundle).map_err(|error| {
            ServiceError::invalid_input(format!("could not encode workflow bundle: {error}"))
        })?;

        let response: WorkflowBundleImportResponse = self
            .client
            .execute(
                IMPORT_WORKFLOW_BUNDLE,
                json!({
                    "project_id": self.client.project_id(),
                    "bundle": encoded_bundle,
                }),
                "importWorkflowBundle",
            )
            .await
            .map_err(map_import_client_error)?;

        validate_import_response(&bundle, response)
    }
}

fn map_import_client_error(error: SacrumClientError) -> ServiceError {
    match error {
        SacrumClientError::HttpError(error) => ServiceError::network_error(format!(
            "workflow bundle import transport failed; outcome is uncertain: {error}"
        )),
        SacrumClientError::ApiError { status, message } => ServiceError::api_error(
            status,
            format!("workflow bundle import rejected by Sacrum: {message}"),
        ),
        SacrumClientError::GraphqlError { messages, .. } => ServiceError::invalid_input(format!(
            "workflow bundle import rejected by Sacrum: {}",
            messages.join("; ")
        )),
        SacrumClientError::ConfigError(message) => ServiceError::config_error(message),
        SacrumClientError::SerializationError(error) => ServiceError::invalid_input(format!(
            "workflow bundle import response could not be decoded: {error}"
        )),
    }
}

fn validate_import_response(
    bundle: &WorkflowBundleManifest,
    response: WorkflowBundleImportResponse,
) -> ServiceResult<WorkflowBundleImportResult> {
    let expected_workflows: BTreeSet<&str> = bundle
        .workflows
        .iter()
        .map(|workflow| workflow.workflow_ref.as_str())
        .collect();

    if response.workflow_mappings.len() != expected_workflows.len() {
        return Err(protocol_error(format!(
            "expected {} workflow mappings, received {}",
            expected_workflows.len(),
            response.workflow_mappings.len()
        )));
    }

    let mut seen_ids = HashSet::new();
    let mut workflow_mappings = BTreeMap::new();
    for (workflow_ref, id) in response.workflow_mappings {
        if !expected_workflows.contains(workflow_ref.as_str()) {
            return Err(protocol_error(format!(
                "unexpected workflow mapping for ref {workflow_ref:?}"
            )));
        }
        validate_uuid("workflow", workflow_ref.as_str(), &id, &mut seen_ids)?;
        workflow_mappings.insert(workflow_ref, id);
    }

    for workflow_ref in &expected_workflows {
        if !workflow_mappings.contains_key(*workflow_ref) {
            return Err(protocol_error(format!(
                "missing workflow mapping for ref {workflow_ref:?}"
            )));
        }
    }

    let expected_steps: BTreeMap<WorkflowRef, BTreeSet<&str>> = bundle
        .workflows
        .iter()
        .map(|workflow| {
            (
                workflow.workflow_ref.clone(),
                workflow
                    .steps
                    .iter()
                    .map(|step| step.step_ref.as_str())
                    .collect(),
            )
        })
        .collect();

    if response.step_mappings.len() != expected_steps.len() {
        return Err(protocol_error(format!(
            "expected step mappings for {} workflows, received {}",
            expected_steps.len(),
            response.step_mappings.len()
        )));
    }

    let mut step_mappings = BTreeMap::new();
    for (workflow_ref, mappings) in response.step_mappings {
        let Some(expected_refs) = expected_steps.get(&workflow_ref) else {
            return Err(protocol_error(format!(
                "unexpected step mappings for workflow ref {workflow_ref:?}"
            )));
        };

        if mappings.len() != expected_refs.len() {
            return Err(protocol_error(format!(
                "expected {} step mappings for workflow {workflow_ref:?}, received {}",
                expected_refs.len(),
                mappings.len()
            )));
        }

        for (step_ref, id) in mappings {
            if !expected_refs.contains(step_ref.as_str()) {
                return Err(protocol_error(format!(
                    "unexpected step mapping for ref {workflow_ref:?}/{step_ref:?}"
                )));
            }

            validate_uuid(
                "step",
                &format!("{workflow_ref}/{step_ref}"),
                &id,
                &mut seen_ids,
            )?;
            step_mappings.insert(StepAddress::new(workflow_ref.clone(), step_ref), id);
        }

        for step_ref in expected_refs {
            let address = StepAddress::new(workflow_ref.clone(), (*step_ref).to_string());
            if !step_mappings.contains_key(&address) {
                return Err(protocol_error(format!(
                    "missing step mapping for ref {workflow_ref:?}/{step_ref:?}"
                )));
            }
        }
    }

    validate_count(
        "workflow",
        response.workflow_count,
        expected_workflows.len(),
    )?;
    validate_count("step", response.step_count, step_mappings.len())?;
    validate_count(
        "step edge",
        response.step_edge_count,
        bundle.step_edges.len(),
    )?;
    validate_count(
        "workflow edge",
        response.workflow_edge_count,
        bundle.workflow_edges.len(),
    )?;

    Ok(WorkflowBundleImportResult {
        workflow_mappings,
        step_mappings,
        warnings: Vec::new(),
    })
}

fn validate_uuid(
    kind: &str,
    reference: &str,
    id: &str,
    seen_ids: &mut HashSet<String>,
) -> ServiceResult<()> {
    if id.trim().is_empty() {
        return Err(protocol_error(format!(
            "{kind} mapping for {reference:?} has an empty generated ID"
        )));
    }

    Uuid::parse_str(id).map_err(|error| {
        protocol_error(format!(
            "{kind} mapping for {reference:?} has invalid generated UUID {id:?}: {error}"
        ))
    })?;

    if !seen_ids.insert(id.to_string()) {
        return Err(protocol_error(format!(
            "duplicate generated UUID {id:?} in {kind} mappings"
        )));
    }

    Ok(())
}

fn validate_count(kind: &str, actual: Option<usize>, expected: usize) -> ServiceResult<()> {
    if let Some(actual) = actual
        && actual != expected
    {
        return Err(protocol_error(format!(
            "expected {expected} {kind}s, Sacrum reported {actual}"
        )));
    }
    Ok(())
}

fn protocol_error(message: String) -> ServiceError {
    ServiceError::invalid_input(format!(
        "invalid workflow bundle import response: {message}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
    use crate::{GraphqlClient, SacrumWorkflowService};
    use serde_json::Value;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const WORKFLOW_A_ID: &str = "11111111-1111-1111-1111-111111111111";
    const WORKFLOW_B_ID: &str = "22222222-2222-2222-2222-222222222222";
    const STEP_A_ID: &str = "33333333-3333-3333-3333-333333333333";
    const STEP_B_ID: &str = "44444444-4444-4444-4444-444444444444";

    fn service(server_url: &str) -> SacrumWorkflowService {
        SacrumWorkflowService::new(GraphqlClient::new(SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        )))
    }

    fn bundle_with_repeated_step_refs() -> WorkflowBundleManifest {
        let mut bundle = WorkflowBundleManifest::empty();
        let mut first = vertebrae_core::WorkflowManifest::new("first", "First");
        first
            .steps
            .push(vertebrae_core::StepManifest::new("review", "Review"));
        let mut second = vertebrae_core::WorkflowManifest::new("second", "Second");
        second
            .steps
            .push(vertebrae_core::StepManifest::new("review", "Review"));
        bundle.workflows = vec![first, second];
        bundle
    }

    fn import_data() -> Value {
        json!({
            "workflowMappings": {
                "first": WORKFLOW_A_ID,
                "second": WORKFLOW_B_ID
            },
            "stepMappings": {
                "first": {"review": STEP_A_ID},
                "second": {"review": STEP_B_ID}
            },
            "workflowCount": 2,
            "stepCount": 2,
            "stepEdgeCount": 0,
            "workflowEdgeCount": 0
        })
    }

    fn fixture_import_data() -> Value {
        json!({
            "workflowMappings": {
                "build": WORKFLOW_A_ID,
                "review": WORKFLOW_B_ID
            },
            "stepMappings": {
                "build": {
                    "finish": STEP_A_ID,
                    "route": "55555555-5555-5555-5555-555555555555",
                    "start": "66666666-6666-6666-6666-666666666666",
                    "wait": "99999999-9999-9999-9999-999999999999",
                    "input": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "pause": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
                },
                "review": {
                    "done": "77777777-7777-7777-7777-777777777777",
                    "review": "88888888-8888-8888-8888-888888888888"
                }
            },
            "workflowCount": 2,
            "stepCount": 8,
            "stepEdgeCount": 8,
            "workflowEdgeCount": 2
        })
    }

    #[tokio::test]
    async fn sends_one_json_scalar_mutation_and_preserves_bundle_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"importWorkflowBundle": fixture_import_data()}
            })))
            .mount(&server)
            .await;

        let bundle: WorkflowBundleManifest = serde_json::from_str(include_str!(
            "../../../core/tests/fixtures/workflow_bundle_v1.json"
        ))
        .unwrap();
        bundle.validate().unwrap();

        let service = service(&server.uri());
        let result = service
            .import_workflow_bundle(bundle.clone())
            .await
            .unwrap();
        assert_eq!(result.workflow_mappings["build"], WORKFLOW_A_ID);

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let request: Value = serde_json::from_slice(&requests[0].body).unwrap();
        let query = request["query"].as_str().unwrap();
        assert!(query.contains("mutation ImportWorkflowBundle"));
        assert!(query.contains("$bundle: Json!"));
        assert!(query.contains("importWorkflowBundle"));
        assert!(query.contains("projectId: $project_id"));
        assert!(query.contains("workflowMappings"));
        assert!(!query.contains("createWorkflow"));
        assert!(!query.contains("createWorkflowStep"));
        assert_eq!(request["variables"]["project_id"], "test-project");

        let encoded = request["variables"]["bundle"].as_str().unwrap();
        let sent_bundle: Value = serde_json::from_str(encoded).unwrap();
        let original_bundle = serde_json::to_value(bundle).unwrap();
        assert_eq!(sent_bundle, original_bundle);
        assert_eq!(sent_bundle["workflows"][0]["steps"][0]["prompt"], "");
        assert_eq!(
            sent_bundle["workflows"][0]["steps"][1]["prompt"],
            Value::Null
        );
        assert!(sent_bundle["workflows"][0]["metadata"].is_object());
        assert!(sent_bundle["workflows"][0]["steps"][1]["route_config"].is_object());
    }

    #[tokio::test]
    async fn qualifies_repeated_local_step_refs_by_workflow() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"importWorkflowBundle": import_data()}
            })))
            .mount(&server)
            .await;

        let result = service(&server.uri())
            .import_workflow_bundle(bundle_with_repeated_step_refs())
            .await
            .unwrap();

        assert_eq!(
            result.step_mappings[&StepAddress::new("first", "review")],
            STEP_A_ID
        );
        assert_eq!(
            result.step_mappings[&StepAddress::new("second", "review")],
            STEP_B_ID
        );
    }

    #[test]
    fn rejects_missing_duplicate_and_unexpected_mappings() {
        let bundle = bundle_with_repeated_step_refs();
        let missing = WorkflowBundleImportResponse {
            workflow_mappings: BTreeMap::from([(String::from("first"), WORKFLOW_A_ID.into())]),
            step_mappings: BTreeMap::from([(
                String::from("first"),
                BTreeMap::from([(String::from("review"), STEP_A_ID.into())]),
            )]),
            id_mappings: None,
            workflow_count: None,
            step_count: None,
            step_edge_count: None,
            workflow_edge_count: None,
        };
        assert!(validate_import_response(&bundle, missing).is_err());

        let duplicate = WorkflowBundleImportResponse {
            workflow_mappings: BTreeMap::from([
                (String::from("first"), WORKFLOW_A_ID.into()),
                (String::from("second"), WORKFLOW_A_ID.into()),
            ]),
            step_mappings: BTreeMap::from([
                (
                    String::from("first"),
                    BTreeMap::from([(String::from("review"), STEP_A_ID.into())]),
                ),
                (
                    String::from("second"),
                    BTreeMap::from([(String::from("review"), STEP_B_ID.into())]),
                ),
            ]),
            id_mappings: None,
            workflow_count: None,
            step_count: None,
            step_edge_count: None,
            workflow_edge_count: None,
        };
        assert!(validate_import_response(&bundle, duplicate).is_err());

        let unexpected = WorkflowBundleImportResponse {
            workflow_mappings: BTreeMap::from([
                (String::from("first"), WORKFLOW_A_ID.into()),
                (String::from("second"), WORKFLOW_B_ID.into()),
            ]),
            step_mappings: BTreeMap::from([
                (
                    String::from("first"),
                    BTreeMap::from([(String::from("unexpected"), STEP_A_ID.into())]),
                ),
                (
                    String::from("second"),
                    BTreeMap::from([(String::from("review"), STEP_B_ID.into())]),
                ),
            ]),
            id_mappings: None,
            workflow_count: None,
            step_count: None,
            step_edge_count: None,
            workflow_edge_count: None,
        };
        assert!(validate_import_response(&bundle, unexpected).is_err());
    }

    #[tokio::test]
    async fn rejects_graphql_errors_without_treating_partial_data_as_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"importWorkflowBundle": import_data()},
                "errors": [{"message": "validation failed", "path": ["importWorkflowBundle"]}]
            })))
            .mount(&server)
            .await;

        let error = service(&server.uri())
            .import_workflow_bundle(bundle_with_repeated_step_refs())
            .await
            .expect_err("GraphQL errors must not be accepted with partial data");
        assert!(error.to_string().contains("validation failed"));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rejects_invalid_bundle_locally_without_sending_a_request() {
        let server = MockServer::start().await;
        let bundle = WorkflowBundleManifest {
            schema_version: 999,
            ..WorkflowBundleManifest::empty()
        };

        let error = service(&server.uri())
            .import_workflow_bundle(bundle)
            .await
            .expect_err("unsupported schema versions must fail before transport");
        assert!(error.to_string().contains("schema_version"));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn returns_transport_failures_without_retrying() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(503).set_body_string("temporarily unavailable"))
            .mount(&server)
            .await;

        let error = service(&server.uri())
            .import_workflow_bundle(bundle_with_repeated_step_refs())
            .await
            .expect_err("transport failures must be returned");
        assert!(error.to_string().contains("503"));
        assert!(matches!(error, ServiceError::ApiError { status: 503, .. }));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[test]
    fn classifies_transport_errors_as_uncertain_network_failures() {
        let request_error = reqwest::Client::new()
            .get("not a URL")
            .build()
            .expect_err("invalid URL should fail before any request");
        let error = map_import_client_error(SacrumClientError::HttpError(request_error));

        assert!(
            matches!(error, ServiceError::NetworkError(message) if message.contains("uncertain"))
        );
    }
}
