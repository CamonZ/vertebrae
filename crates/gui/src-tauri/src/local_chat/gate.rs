//! Gate chats: local chats bound to a TaskRun waiting at a `human_input`
//! step. The binding carries the waiting execution's rendered config; it
//! seeds the hidden protocol instructions every harness appends to its
//! developer instructions, and scopes the one `vtb artifact add` command the
//! chat may run without an interactive permission prompt.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Binds a local chat to a waiting `human_input` gate. The chat is identified
/// by `task_run_id` + `step_name`; `execution_id`, `artifact`, `role`, `question`
/// and `output_schema` describe the execution currently waiting there.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatGateBinding {
    pub task_run_id: String,
    pub step_name: String,
    /// The waiting execution the resolution is attached to.
    pub execution_id: String,
    /// Logical name of the artifact that resolves the gate.
    pub artifact: String,
    /// The author's role for the resolving agent; absent uses the generic
    /// gate role.
    #[serde(default)]
    #[specta(optional)]
    pub role: Option<String>,
    /// Rendered gate question; what the user must answer and why.
    #[serde(default)]
    #[specta(optional)]
    pub question: Option<String>,
    /// JSON Schema the resolution must satisfy; absent accepts any JSON.
    #[serde(default)]
    #[specta(optional)]
    pub output_schema: Option<serde_json::Value>,
    /// Present when the run returned to this step after an earlier
    /// resolution, so the waiting execution is a revision.
    #[serde(default)]
    #[specta(optional)]
    pub revision: Option<LocalChatGateRevision>,
}

/// A later visit of a gate: the review rejected the earlier resolution and
/// the route looped back, carrying its reasons as the execution's handoff.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatGateRevision {
    /// 1-based visit of this step in the run; always 2 or more.
    pub attempt: u32,
    /// The waiting execution's handoff: the review's verdict and reasons.
    #[serde(default)]
    #[specta(optional)]
    pub verdict: Option<serde_json::Value>,
}

impl LocalChatGateBinding {
    /// The exact command that attaches a resolution, with `<JSON>` standing
    /// in for the single-quoted body.
    fn submit_command(&self) -> String {
        format!(
            "vtb artifact add {artifact}.json --subject-type step_execution --subject-id {execution} --logical-name {artifact} --body '<JSON>'",
            artifact = self.artifact,
            execution = self.execution_id,
        )
    }

    /// Whether `command` is this gate's submission: `vtb artifact add` for
    /// the bound execution and artifact, with an inline body and no shell
    /// expansion, redirection or command chaining.
    pub(crate) fn allows_command(&self, command: &str) -> bool {
        let Some(words) = shell_words(command) else {
            return false;
        };
        match words.as_slice() {
            [shell, flag, script]
                if matches!(program_name(shell), "sh" | "bash" | "zsh")
                    && matches!(flag.as_str(), "-c" | "-lc") =>
            {
                shell_words(script).is_some_and(|words| self.allows_words(&words))
            }
            _ => self.allows_words(&words),
        }
    }

    fn allows_words(&self, words: &[String]) -> bool {
        let [program, artifact, add, rest @ ..] = words else {
            return false;
        };
        if program_name(program) != "vtb" || artifact != "artifact" || add != "add" {
            return false;
        }
        let mut filename = None;
        let mut body = None;
        let mut subject_type = None;
        let mut subject_id = None;
        let mut logical_name = None;
        let mut args = rest.iter();
        while let Some(arg) = args.next() {
            if arg == "--json" {
                continue;
            }
            let Some(flag) = arg.strip_prefix("--") else {
                if filename.replace(arg).is_some() {
                    return false;
                }
                continue;
            };
            let (name, value) = match flag.split_once('=') {
                Some((name, value)) => (name, value),
                None => match args.next() {
                    Some(value) => (flag, value.as_str()),
                    None => return false,
                },
            };
            let slot = match name {
                "body" => &mut body,
                "subject-type" => &mut subject_type,
                "subject-id" => &mut subject_id,
                "logical-name" => &mut logical_name,
                _ => return false,
            };
            if slot.replace(value).is_some() {
                return false;
            }
        }
        filename.is_some()
            && body.is_some()
            && subject_type == Some("step_execution")
            && subject_id == Some(self.execution_id.as_str())
            && logical_name == Some(self.artifact.as_str())
    }
}

fn program_name(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// Split a POSIX shell command into words, or `None` when the shell would do
/// more than quote removal: expansion, globbing, redirection, pipes,
/// chaining, subshells or comments. Only that subset is safe to approve by
/// inspecting the words.
fn shell_words(command: &str) -> Option<Vec<String>> {
    enum Quote {
        None,
        Single,
        Double,
    }
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote = Quote::None;
    let mut chars = command.trim().chars();
    while let Some(c) = chars.next() {
        match quote {
            Quote::Single => match c {
                '\'' => quote = Quote::None,
                c => word.push(c),
            },
            Quote::Double => match c {
                '"' => quote = Quote::None,
                '\\' => match chars.next()? {
                    escaped @ ('"' | '\\') => word.push(escaped),
                    '$' | '`' | '\n' => return None,
                    other => {
                        word.push('\\');
                        word.push(other);
                    }
                },
                '$' | '`' | '!' => return None,
                c => word.push(c),
            },
            Quote::None => match c {
                ' ' | '\t' => {
                    if in_word {
                        words.push(std::mem::take(&mut word));
                        in_word = false;
                    }
                }
                '\'' => {
                    quote = Quote::Single;
                    in_word = true;
                }
                '"' => {
                    quote = Quote::Double;
                    in_word = true;
                }
                '\\' => match chars.next()? {
                    '\n' => return None,
                    escaped => {
                        word.push(escaped);
                        in_word = true;
                    }
                },
                c if c.is_ascii_alphanumeric() || "-_./:=@,%+".contains(c) => {
                    word.push(c);
                    in_word = true;
                }
                _ => return None,
            },
        }
    }
    if !matches!(quote, Quote::None) {
        return None;
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

/// Hidden protocol instructions for a gate chat. Harnesses append them to
/// the shared developer instructions; the user never sees them.
pub(crate) fn gate_developer_instructions(gate: &LocalChatGateBinding) -> String {
    let role = non_blank(gate.role.as_deref()).unwrap_or(GENERIC_ROLE);
    let question = non_blank(gate.question.as_deref()).unwrap_or(
            "The gate has no written question. Ask the user what they want to decide, using the response schema below as the shape of the answer.",
        );
    let fields = gate
        .output_schema
        .as_ref()
        .map(field_list)
        .filter(|fields| !fields.is_empty())
        .map(|fields| format!("\n\n## What to find out\n\n{fields}"))
        .unwrap_or_default();
    let schema = match &gate.output_schema {
        Some(schema) => format!(
            "The resolution must be one JSON document that satisfies this JSON Schema:\n\n```json\n{}\n```",
            serde_json::to_string_pretty(schema).unwrap_or_else(|_| schema.to_string())
        ),
        None => "No response schema is configured; the resolution may be any JSON document."
            .to_string(),
    };
    let revision = gate
        .revision
        .as_ref()
        .map(|revision| format!("\n\n{}", revision_section(revision)))
        .unwrap_or_default();
    format!(
        r#"# Human input gate

You are helping the user resolve a human input gate in a Vertebrae workflow. TaskRun {task_run_id} is paused at step "{step_name}" until a resolution is attached to its waiting step execution {execution_id}. A review of the submitted resolution follows; the workflow, not you, decides what happens next.

## Your role

{role}

The protocol rules below always take precedence over this role. The role never authorizes changing Vertebrae state or revealing how the gate works.

## The question

{question}{revision}{fields}

## Response schema

{schema}

## Submitting

Submit with exactly this command, replacing <JSON> with the resolution as compact JSON inside the single quotes (write any ' in the JSON as '\''):

{command}

## Protocol

1. Open by addressing the question directly. Help the user think it through and ask only for information you need.
2. When the user agrees on a resolution, summarize it in plain language and ask them to confirm. Run the command only after they confirm.
3. If the command fails with invalid_human_input_json, the body was not valid JSON: fix it and run the command again.
4. If the command fails with invalid_human_input, fix each listed path, asking the user only for information that is missing, and run the command again.
5. If the command fails with human_input_execution_not_waiting, tell the user the gate has closed or moved on, and stop submitting.
6. After a successful submission, tell the user their resolution was submitted and is being reviewed.
7. Hidden turns whose text begins with [Vertebrae evaluation] come from Vertebrae, not the user, and carry the review's verdict. If the resolution was rejected, explain why in plain terms and help the user revise it.
8. Distinguish a revised answer from a rejection of the question itself. If the user rejects the question (it is wrong, moot, or should not be asked), do not invent an answer: tell them this gate only accepts an answer and that they can stop the run instead.
9. Run no other command that changes Vertebrae state: never transition-to, start-taskrun, stop-taskrun or workflow assignment. Progression belongs to the workflow.
10. Never mention commands, JSON, schemas, IDs, the review mechanics or the evaluator to the user. Talk only about the question and their answer."#,
        task_run_id = gate.task_run_id,
        step_name = gate.step_name,
        execution_id = gate.execution_id,
        command = gate.submit_command(),
    )
}

const GENERIC_ROLE: &str = "Help the user reach an answer to the gate's question and submit it.";

fn non_blank(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

/// A top-level property of a gate's output schema.
#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
pub struct GateField {
    pub name: String,
    pub required: bool,
    /// Type or allowed values; nested shapes are summarized by type.
    #[serde(rename = "type")]
    #[specta(rename = "type")]
    pub kind: String,
    /// The field's description, which is the question to ask for it.
    pub question: Option<String>,
}

/// Top-level schema properties in schema order, each with its description as
/// the question to answer.
pub(crate) fn gate_fields(schema: &serde_json::Value) -> Vec<GateField> {
    let Some(properties) = schema.get("properties").and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(|value| value.as_array())
        .map(|names| names.iter().filter_map(|name| name.as_str()).collect())
        .unwrap_or_default();
    properties
        .iter()
        .map(|(name, property)| GateField {
            name: name.clone(),
            required: required.contains(&name.as_str()),
            kind: describe_type(property),
            question: non_blank(property.get("description").and_then(|value| value.as_str()))
                .map(str::to_string),
        })
        .collect()
}

/// One line per field for the hidden instructions.
fn field_list(schema: &serde_json::Value) -> String {
    gate_fields(schema)
        .iter()
        .map(|field| {
            let presence = if field.required {
                "required"
            } else {
                "optional"
            };
            let question = field
                .question
                .as_deref()
                .unwrap_or("no description; ask what this field should hold");
            format!("- {} ({presence}, {}): {question}", field.name, field.kind)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The allowed values of an enum property, else its type; nested objects and
/// arrays are summarized by type, with an object's field names.
fn describe_type(property: &serde_json::Value) -> String {
    if let Some(values) = property.get("enum").and_then(|value| value.as_array()) {
        let values: Vec<String> = values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_string)
            })
            .collect();
        return format!("one of {}", values.join(", "));
    }
    let type_name = match property.get("type") {
        Some(serde_json::Value::String(type_name)) => type_name.clone(),
        Some(serde_json::Value::Array(types)) => types
            .iter()
            .filter_map(|type_name| type_name.as_str())
            .collect::<Vec<_>>()
            .join(" or "),
        _ => return "any value".to_string(),
    };
    match type_name.as_str() {
        "object" => match property
            .get("properties")
            .and_then(|value| value.as_object())
        {
            Some(nested) if !nested.is_empty() => format!(
                "object with {}",
                nested.keys().cloned().collect::<Vec<_>>().join(", ")
            ),
            _ => "object".to_string(),
        },
        "array" => match property.get("items") {
            Some(items) => format!("array of {}", describe_type(items)),
            None => "array".to_string(),
        },
        _ => type_name,
    }
}

fn revision_section(revision: &LocalChatGateRevision) -> String {
    let null_verdict = serde_json::Value::Null;
    let mut verdict_json =
        serde_json::to_string_pretty(revision.verdict.as_ref().unwrap_or(&null_verdict))
            .unwrap_or_else(|_| "{}".into());
    verdict_json = verdict_json.replace('<', "\\u003c");
    let machine_readable = format!(
        "<vertebrae-evaluation attempt=\"{}\">{}</vertebrae-evaluation>",
        revision.attempt, verdict_json
    );
    let verdict = if revision.verdict.is_some() {
        "The review gave the verdict in the machine-readable block above."
    } else {
        "The review gave no reasons."
    };
    format!(
        "## Revision\n\n{machine_readable}\n\nThis is attempt {attempt}. The review rejected the previous resolution and the workflow returned to this gate. {verdict}",
        attempt = revision.attempt,
    )
}

/// A hidden turn that replaces the gate protocol when the waiting execution
/// changes but the run and step continue to use the same chat. On a revision
/// it opens with the review's verdict, so the agent explains the rejection.
pub(crate) fn gate_refresh_turn(gate: &LocalChatGateBinding) -> String {
    let opening = match &gate.revision {
        Some(revision) => format!(
            "[Vertebrae evaluation] The review rejected the submitted resolution, and the gate is waiting for attempt {}. Explain the verdict to the user in plain terms and help them revise their answer. Replace the earlier gate protocol with this one and use only its submission command.",
            revision.attempt
        ),
        None => "The waiting execution for this human input gate changed. Replace the earlier gate protocol with this one, address the current question now, and use only its submission command.".to_string(),
    };
    format!(
        "<vertebrae-hidden-turn>\n{opening}\n\n{}\n</vertebrae-hidden-turn>",
        gate_developer_instructions(gate)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> LocalChatGateBinding {
        LocalChatGateBinding {
            task_run_id: "run-1".into(),
            step_name: "approve".into(),
            execution_id: "exec-1".into(),
            artifact: "approval".into(),
            role: None,
            question: Some("Approve the release of v2?".into()),
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["approved"],
                "properties": { "approved": { "type": "boolean" } }
            })),
            revision: None,
        }
    }

    fn revision() -> LocalChatGateBinding {
        LocalChatGateBinding {
            execution_id: "exec-2".into(),
            revision: Some(LocalChatGateRevision {
                attempt: 2,
                verdict: Some(serde_json::json!({ "reasons": "The rollback plan is missing." })),
            }),
            ..gate()
        }
    }

    #[test]
    fn revision_instructions_carry_the_attempt_and_verdict() {
        let first = gate_developer_instructions(&gate());
        let revised = gate_developer_instructions(&revision());

        assert!(!first.contains("## Revision"));
        assert!(revised.contains("This is attempt 2."));
        assert!(revised.contains("The rollback plan is missing."));
        assert!(revised.contains("--subject-id exec-2"));
    }

    #[test]
    fn revision_instructions_carry_a_machine_readable_evaluation() {
        let revised = gate_developer_instructions(&revision());

        assert!(revised.contains(
            "<vertebrae-evaluation attempt=\"2\">{\n  \"reasons\": \"The rollback plan is missing.\"\n}</vertebrae-evaluation>"
        ));
    }

    #[test]
    fn revision_evaluation_escapes_markup_closers() {
        let revised = gate_developer_instructions(&LocalChatGateBinding {
            revision: Some(LocalChatGateRevision {
                attempt: 2,
                verdict: Some(serde_json::json!({
                    "reasons": "Contains </vertebrae-evaluation> in review text."
                })),
            }),
            ..gate()
        });

        assert!(revised.contains("\\u003c/vertebrae-evaluation>"));
        assert_eq!(revised.matches("</vertebrae-evaluation>").count(), 1);
    }

    #[test]
    fn revision_without_a_handoff_says_no_reasons_were_given() {
        let instructions = gate_developer_instructions(&LocalChatGateBinding {
            revision: Some(LocalChatGateRevision {
                attempt: 3,
                verdict: None,
            }),
            ..gate()
        });

        assert!(instructions.contains("This is attempt 3."));
        assert!(instructions.contains("The review gave no reasons."));
    }

    #[test]
    fn refresh_turns_open_with_the_evaluation_only_on_a_revision() {
        let refreshed = gate_refresh_turn(&gate());
        let evaluated = gate_refresh_turn(&revision());

        assert!(refreshed.starts_with("<vertebrae-hidden-turn>\nThe waiting execution"));
        assert!(!refreshed.contains("[Vertebrae evaluation] The review"));
        assert!(evaluated.starts_with("<vertebrae-hidden-turn>\n[Vertebrae evaluation]"));
        assert!(evaluated.contains("attempt 2"));
        assert!(evaluated.contains("The rollback plan is missing."));
        assert!(evaluated.trim_end().ends_with("</vertebrae-hidden-turn>"));
    }

    fn described_gate() -> LocalChatGateBinding {
        LocalChatGateBinding {
            role: Some("You are a release manager reviewing a ship decision.".into()),
            output_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["approved"],
                "properties": {
                    "approved": { "type": "boolean", "description": "Should v2 ship?" },
                    "notes": { "type": "string" },
                    "channel": { "enum": ["beta", "stable"], "description": "Which channel?" },
                    "checks": {
                        "type": "object",
                        "properties": { "tests": { "type": "boolean" }, "docs": { "type": "boolean" } }
                    }
                }
            })),
            ..gate()
        }
    }

    #[test]
    fn instructions_list_the_schema_fields_in_order_with_their_questions() {
        let instructions = gate_developer_instructions(&described_gate());

        let approved = instructions
            .find("- approved (required, boolean): Should v2 ship?")
            .expect("approved line");
        let notes = instructions
            .find("- notes (optional, string): no description")
            .expect("notes line");
        let channel = instructions
            .find("- channel (optional, one of beta, stable): Which channel?")
            .expect("channel line");
        let checks = instructions
            .find("- checks (optional, object with tests, docs):")
            .expect("checks line");
        assert!(approved < notes && notes < channel && channel < checks);
        assert!(instructions.contains("## What to find out"));
        assert!(instructions.contains("## Response schema"));
    }

    #[test]
    fn instructions_keep_schema_order_not_alphabetical_order() {
        let instructions = gate_developer_instructions(&LocalChatGateBinding {
            output_schema: Some(serde_json::json!({
                "type": "object",
                "properties": { "zeta": { "type": "string" }, "alpha": { "type": "string" } }
            })),
            ..gate()
        });

        assert!(instructions.find("- zeta").unwrap() < instructions.find("- alpha").unwrap());
    }

    #[test]
    fn instructions_use_the_gate_role_and_keep_the_protocol_rules() {
        let instructions = gate_developer_instructions(&described_gate());

        assert!(instructions.contains("## Your role\n\nYou are a release manager"));
        assert!(!instructions.contains(GENERIC_ROLE));
        assert!(instructions.contains("always take precedence over this role"));
        assert!(instructions.contains("never transition-to"));
    }

    #[test]
    fn instructions_use_the_generic_role_and_omit_fields_without_properties() {
        let instructions = gate_developer_instructions(&LocalChatGateBinding {
            role: Some("  ".into()),
            output_schema: None,
            ..gate()
        });

        assert!(instructions.contains(&format!("## Your role\n\n{GENERIC_ROLE}")));
        assert!(!instructions.contains("## What to find out"));
        assert!(instructions.contains("never transition-to"));
    }

    #[test]
    fn refresh_turns_carry_the_new_question_and_field_list() {
        let refreshed = gate_refresh_turn(&LocalChatGateBinding {
            question: Some("Ship v3 instead?".into()),
            ..described_gate()
        });

        assert!(refreshed.contains("Ship v3 instead?"));
        assert!(refreshed.contains("- approved (required, boolean): Should v2 ship?"));
    }

    const SUBMIT: &str = r#"vtb artifact add approval.json --subject-type step_execution --subject-id exec-1 --logical-name approval --body '{"approved":true,"reason":"it'\''s ready; ship it | now"}'"#;

    #[test]
    fn instructions_carry_question_schema_ids_and_exact_command() {
        let instructions = gate_developer_instructions(&gate());

        assert!(instructions.contains("Approve the release of v2?"));
        assert!(instructions.contains(r#""required": ["#));
        assert!(instructions.contains("TaskRun run-1 is paused at step \"approve\""));
        assert!(instructions.contains(
            "vtb artifact add approval.json --subject-type step_execution --subject-id exec-1 --logical-name approval --body '<JSON>'"
        ));
        for code in [
            "invalid_human_input_json",
            "invalid_human_input,",
            "human_input_execution_not_waiting",
            "[Vertebrae evaluation]",
        ] {
            assert!(instructions.contains(code), "missing {code}");
        }
    }

    #[test]
    fn instructions_fall_back_without_question_or_schema() {
        let instructions = gate_developer_instructions(&LocalChatGateBinding {
            question: Some("  ".into()),
            output_schema: None,
            ..gate()
        });

        assert!(instructions.contains("The gate has no written question."));
        assert!(instructions.contains("may be any JSON document"));
    }

    #[test]
    fn allows_the_bound_submission_with_quoted_metacharacters_in_the_body() {
        let gate = gate();

        assert!(gate.allows_command(SUBMIT));
        assert!(gate.allows_command(&format!("{SUBMIT} --json")));
        assert!(gate.allows_command(
            r#"bash -lc "vtb artifact add approval.json --subject-type step_execution --subject-id exec-1 --logical-name approval --body '{\"approved\":true}'""#
        ));
        assert!(gate.allows_command(
            "/usr/local/bin/vtb artifact add r.json --subject-type=step_execution --subject-id=exec-1 --logical-name=approval --body=\"{\\\"approved\\\":false}\""
        ));
    }

    #[test]
    fn rejects_commands_outside_the_bound_submission() {
        let gate = gate();
        let rejected = [
            // Another execution or artifact.
            SUBMIT.replace("exec-1", "exec-2"),
            SUBMIT.replace("--logical-name approval", "--logical-name other"),
            SUBMIT.replace("step_execution", "task"),
            // Missing or duplicated parts.
            SUBMIT.replace("approval.json ", ""),
            SUBMIT.replace("--subject-id exec-1", ""),
            format!("{SUBMIT} --subject-id exec-1"),
            // Flags that read files or add provenance.
            format!("{SUBMIT} --body-file /etc/passwd"),
            format!("{SUBMIT} --metadata '{{}}'"),
            // Shell chaining, expansion and redirection.
            format!("{SUBMIT}; rm -rf ~"),
            format!("{SUBMIT} && vtb transition-to run-1 done"),
            format!("{SUBMIT} | tee out"),
            format!("{SUBMIT} > out"),
            SUBMIT.replace("'{", "\"$(whoami){").replace("}'", "}\""),
            SUBMIT.replace("approval.json", "$HOME.json"),
            SUBMIT.replace("approval.json", "*.json"),
            format!("{SUBMIT} '"),
            // Other commands.
            "vtb transition-to run-1 done".to_string(),
            "vtb artifact delete a1".to_string(),
            "sh -c 'vtb artifact add x.json; rm -rf ~'".to_string(),
        ];
        for command in rejected {
            assert!(!gate.allows_command(&command), "allowed: {command}");
        }
    }
}
