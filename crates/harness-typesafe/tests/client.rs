use std::collections::BTreeMap;

use serde_json::{Value, json};
use vertebrae_harness_typesafe::{
    Answer, ChoiceAnswer, ChoiceCriteria, DEFAULT_MODEL, NoulAnswer, Question, ScoreAnswer,
    SystemOneRequest, SystemOneResponse, TypeSafeClientConfig, TypeSafeError, Usage,
    validate_response,
};

fn request() -> SystemOneRequest {
    SystemOneRequest::new(
        json!({"ticket": {"title": "Export fails", "body": "The export button is broken."}}),
        BTreeMap::from([
            (
                "is_urgent".to_string(),
                Question::Noul(vertebrae_harness_typesafe::NoulQuestion::new(
                    "Does this ticket need urgent handling?",
                )),
            ),
            (
                "team".to_string(),
                Question::Choice(vertebrae_harness_typesafe::ChoiceQuestion::new(
                    "Which team should handle this?",
                    BTreeMap::from([
                        ("billing".to_string(), Value::from("Charges and invoices")),
                        ("technical".to_string(), Value::from("Product failures")),
                    ]),
                )),
            ),
            (
                "severity".to_string(),
                Question::Score(vertebrae_harness_typesafe::ScoreQuestion::new(
                    "How severe is this issue?",
                    vec![
                        Value::from("Cosmetic"),
                        Value::from("Degraded but has a workaround"),
                        Value::from("Blocking with no workaround"),
                    ],
                )),
            ),
        ]),
    )
}

#[test]
fn documented_question_fixtures_round_trip() {
    let encoded = serde_json::to_value(request()).unwrap();

    assert_eq!(encoded["state"]["ticket"]["title"], "Export fails");
    assert_eq!(encoded["model"], DEFAULT_MODEL);
    assert_eq!(encoded["questions"]["is_urgent"]["type"], "noul");
    assert_eq!(encoded["questions"]["team"]["type"], "choice");
    assert_eq!(encoded["questions"]["severity"]["type"], "score");

    let decoded: SystemOneRequest = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded, request());
}

#[test]
fn documented_answer_fixtures_round_trip() {
    let response = SystemOneResponse {
        model: DEFAULT_MODEL.to_string(),
        answers: BTreeMap::from([
            (
                "is_urgent".to_string(),
                Answer::Noul(NoulAnswer { noul: 0.92 }),
            ),
            (
                "team".to_string(),
                Answer::Choice(ChoiceAnswer {
                    choice: "technical".to_string(),
                    probabilities: BTreeMap::from([
                        ("billing".to_string(), 0.08),
                        ("technical".to_string(), 0.92),
                    ]),
                    confidence: 0.85,
                }),
            ),
            (
                "severity".to_string(),
                Answer::Score(ScoreAnswer {
                    score: 1.6,
                    legend: BTreeMap::from([
                        ("0".to_string(), "Cosmetic".to_string()),
                        ("1".to_string(), "Degraded but has a workaround".to_string()),
                        ("2".to_string(), "Blocking with no workaround".to_string()),
                    ]),
                    probabilities: BTreeMap::from([
                        ("0".to_string(), 0.05),
                        ("1".to_string(), 0.3),
                        ("2".to_string(), 0.65),
                    ]),
                    confidence: 0.78,
                }),
            ),
        ]),
        usage: Usage {
            input_tokens: 312,
            output_tokens: 48,
        },
        request_id: Some("req-fixture".to_string()),
    };

    let encoded = serde_json::to_value(&response).unwrap();
    assert_eq!(encoded["answers"]["is_urgent"]["noul"], 0.92);
    assert_eq!(
        encoded["answers"]["team"]["probabilities"]["technical"],
        0.92
    );
    assert_eq!(encoded["answers"]["severity"]["score"], 1.6);
    assert!(encoded.get("request_id").is_none());

    let decoded: SystemOneResponse = serde_json::from_value(encoded).unwrap();
    assert_eq!(decoded.request_id, None);
    assert_eq!(decoded.model, response.model);
    assert_eq!(decoded.answers, response.answers);
    assert_eq!(decoded.usage, response.usage);
}

#[test]
fn criteria_aliases_are_usable_with_json_values() {
    let criteria: ChoiceCriteria = BTreeMap::from([("yes".to_string(), json!(null))]);
    let question = Question::choice("Is this applicable?", criteria);
    let encoded = serde_json::to_value(question).unwrap();
    assert_eq!(encoded["criteria"]["yes"], Value::Null);
}

#[test]
fn diagnostics_redact_api_keys() {
    let key = "secret-key";
    assert!(!format!("{:?}", TypeSafeClientConfig::new(key)).contains(key));

    let error = TypeSafeError::ApiError {
        status: 401,
        message: "authentication failed".to_string(),
        request_id: String::new(),
    };
    assert!(!error.to_string().contains(key));
}

#[test]
fn malformed_answer_shapes_are_rejected() {
    let response: SystemOneResponse = serde_json::from_value(json!({
        "model": DEFAULT_MODEL,
        "answers": {
            "is_urgent": {"type": "noul", "noul": 1.2},
            "team": {
                "type": "choice",
                "choice": "technical",
                "probabilities": {"billing": 0.5, "technical": 0.5},
                "confidence": 0.5
            },
            "severity": {
                "type": "score",
                "score": 1.0,
                "legend": {"0": "Cosmetic", "1": "Degraded", "2": "Blocking"},
                "probabilities": {"0": 0.0, "1": 1.0, "2": 0.0},
                "confidence": 1.0
            }
        },
        "usage": {"input_tokens": 1, "output_tokens": 2}
    }))
    .unwrap();

    let error = validate_response(&request(), &response).unwrap_err();
    assert!(matches!(error, TypeSafeError::MalformedResponse(_)));
}
