use std::collections::HashSet;

use hegel::{Hegel, Settings, TestCase, generators as gs};
use serde_json::{Value, json};
use vertebrae_harness_core::{
    ControlDecision, ControlRequest, ControlResolution, EventCorrelation, QuestionAnswer,
    ResolutionSource,
};

use crate::{
    SessionConfig,
    protocol::response,
    updates::{permission, permission_response},
};

#[test]
fn config_choices_match_flattened_wire_options() {
    Hegel::new(|tc: TestCase| {
        let mut wire = Vec::new();
        let mut expected = Vec::new();
        for index in 0..tc.draw(gs::integers::<usize>().max_value(12)) {
            let option = |suffix| json!({"value": format!("{index}-{suffix}"), "name":"Choice"});
            match tc.draw(gs::integers::<u8>().max_value(3)) {
                0 => {
                    wire.push(option(0));
                    expected.push(format!("{index}-0"));
                }
                1 => {
                    wire.push(json!({"group":"group", "options":[option(0), option(1)]}));
                    expected.extend([format!("{index}-0"), format!("{index}-1")]);
                }
                2 => wire.push(json!({"options":[]})),
                _ => wire.push(json!({"options":"malformed", "value":null})),
            }
        }
        let mut config = SessionConfig::default();
        let model = |options| json!({"type":"select","category":"model","id":"models","currentValue":"default","options":options});
        // A malformed model selector is dropped as a whole when one entry cannot decode.
        let well_formed: Vec<_> = wire.iter().filter(|item| item["options"] != "malformed").cloned().collect();
        let unknown = json!({"type":"unknown", "id":"model", "options":[{"value":"wrong","name":"Wrong"}]});
        config.replace(&json!({"configOptions":[unknown, model(well_formed), {"type":"select","id":"bad"}]}));
        let snapshot = |config: &SessionConfig| config.choices("model").map(|option| option.value.clone()).collect::<Vec<_>>();
        assert_eq!(snapshot(&config), expected);
        for malformed in [Value::Null, json!({}), json!({"configOptions":wire.len()})] {
            config.replace(&malformed);
            assert_eq!(snapshot(&config), expected);
        }
        if wire.iter().any(|item| item["options"] == "malformed") {
            config.replace(&json!({"configOptions":[model(wire)]}));
            assert!(snapshot(&config).is_empty());
        }
    }).settings(Settings::new().test_cases(60)).run();
}

#[test]
fn permission_options_round_trip_without_ambiguity() {
    Hegel::new(|tc: TestCase| {
        let count = tc.draw(gs::integers::<usize>().max_value(9));
        let warning = "🧪é".repeat(tc.draw(gs::integers::<usize>().max_value(400)));
        let options: Vec<_> = (0..count)
            .map(|index| {
                let id = match tc.draw(gs::integers::<u8>().max_value(5)) {
                    0 => String::new(),
                    1 => "shared".to_string(),
                    _ => format!("id-{index}"),
                };
                let name = match tc.draw(gs::integers::<u8>().max_value(5)) {
                    0 => "　",
                    1 => "Option",
                    2 => "2. Option",
                    _ => "選択",
                };
                (id, name)
            })
            .collect();
        let wire: Vec<_> = options
            .iter()
            .map(|(id, name)| {
                json!({
                    "optionId":id, "name":name, "_meta":{"agy.security.warning":{"message":warning}}
                })
            })
            .collect();
        let request = permission(&json!({"options":wire}), &EventCorrelation::default());
        let valid = count > 0
            && options
                .iter()
                .all(|(id, name)| !id.is_empty() && !name.trim().is_empty())
            && options
                .iter()
                .map(|(id, _)| id)
                .collect::<HashSet<_>>()
                .len()
                == count;
        assert_eq!(request.is_some(), valid);
        let Some(request) = request else { return };
        let ControlRequest::UserQuestion { questions } = &request.request else {
            panic!("expected question")
        };
        let question = &questions[0];
        assert_eq!(
            question
                .options
                .iter()
                .map(|option| &option.label)
                .collect::<HashSet<_>>()
                .len(),
            count
        );
        let reply = |id: &str, matches: bool| {
            permission_response(
                &json!(42),
                &request,
                Some(ControlResolution {
                    request_id: if matches {
                        request.request_id.clone()
                    } else {
                        "unrelated".into()
                    },
                    source: ResolutionSource::Consumer,
                    decision: Some(ControlDecision::QuestionsAnswered(vec![QuestionAnswer {
                        question_id: question.id.clone(),
                        selected_option_ids: vec![id.into()],
                        free_form: None,
                    }])),
                    message: None,
                }),
            )["result"]["outcome"]
                .clone()
        };
        let truncated: String = warning.chars().take(512).collect();
        for (option, (id, _)) in question.options.iter().zip(&options) {
            assert_eq!(option.description.as_deref(), Some(truncated.as_str()));
            assert_eq!(reply(id, true), json!({"outcome":"selected","optionId":id}));
            assert_eq!(reply(id, false), json!({"outcome":"cancelled"}));
        }
        assert_eq!(reply("unadvertised", true), json!({"outcome":"cancelled"}));
    })
    .settings(Settings::new().test_cases(80))
    .run();
}

#[test]
fn rpc_errors_redact_agent_supplied_strings() {
    Hegel::new(|tc: TestCase| {
        let code = tc.draw(gs::integers::<i32>());
        let secret = format!("🔒SECRET-{}🔒", tc.draw(gs::integers::<u64>()));
        for (code, message, expected) in [
            (
                json!(code),
                json!(secret),
                if code == -32000 {
                    "requires authentication".into()
                } else {
                    format!("code {code}")
                },
            ),
            (
                json!(-32000),
                json!(secret),
                "requires authentication".into(),
            ),
            (json!(secret), json!(secret), "invalid error code".into()),
            (
                json!(code),
                json!({"secret":secret}),
                "malformed error message".into(),
            ),
        ] {
            let error = response(
                json!({"error":{"code":code,"message":message,"data":{"secret":secret}}}),
                "session/prompt",
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains(&expected), "{error}");
            assert!(!error.contains(&secret));
        }
    })
    .settings(Settings::new().test_cases(60))
    .run();
}
